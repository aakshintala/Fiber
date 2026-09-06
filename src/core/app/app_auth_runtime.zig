const std = @import("std");
const debug_trace = @import("../shared/debug_trace.zig");
const host = @import("../hosts/host.zig");
const runtime_profile = @import("../hosts/runtime_profile.zig");
const io_mod = @import("../shared/io.zig");
const credentials = @import("../auth/credentials.zig");
const auth_runtime = @import("../auth/auth_runtime.zig");
const chatgpt_oauth = @import("../auth/chatgpt_oauth.zig");
const provider_catalog = @import("../auth/provider_catalog.zig");
const model_provider = @import("../config/model_provider.zig");
const provider_runtime = @import("provider_runtime.zig");
const types = @import("../shared/types.zig");

fn oauthAuthEnabled(comptime App: type) bool {
    return runtime_profile.allows(App, .native_auth);
}

pub fn Runtime(comptime App: type) type {
    return struct {
        fn ensurePromptCredential(app: *App) !bool {
            if (comptime provider_runtime.supported(App) and
                @hasDecl(@TypeOf(app.auth), "selectForProvider"))
            {
                const provider = provider_runtime.provider(app);
                const route_change = app.auth.selectForProvider(app.alloc, provider) catch |err| switch (err) {
                    error.OutOfMemory => return err,
                    else => return recoverCredentialFailure(app, .chatgpt_subscription, err),
                };
                if (route_change) |changed| {
                    applyCredentialChange(app, changed);
                } else if (!model_provider.authorizesCredential(provider, app.auth.credentialSource())) {
                    try app.writeDomainNotice(.{
                        .topic = "auth",
                        .tone = .warning,
                        .body = credentials.missing_chatgpt_interactive_credential_message,
                    }, true);
                    app.shell.render_requests.request(.footer);
                    return false;
                }
            }
            if (app.auth.credentialSource() != null) return true;

            const auth_view = app.auth.view();
            if (auth_view.onboarding_skipped) {
                try app.writeDomainNotice(.{
                    .topic = "auth",
                    .tone = .@"error",
                    .body = credentials.missing_chatgpt_interactive_credential_message,
                }, true);
            } else if (!app.auth.pickerView().active) {
                try app.auth.refreshSourceInventory(app.alloc);
                app.auth.openOnboardingPicker();
            }
            app.shell.render_requests.request(.footer);
            return false;
        }

        pub fn runLoginCommand(app: *App) !void {
            if (comptime !oauthAuthEnabled(App)) {
                try app.writeDomainNotice(.{
                    .topic = "auth",
                    .tone = .warning,
                    .body = "Authentication is owned by the embedding host for this session.",
                }, true);
                return;
            }
            switch (app.auth.beginSourceInventoryRefresh(app.alloc, .{
                .provider = provider_runtime.provider(app),
            })) {
                .started => {},
                .busy => try writeAuthNotice(app, .{
                    .topic = "auth",
                    .tone = .warning,
                    .body = "Authentication inventory refresh is already in progress.",
                }),
                .failed => try writeAuthNotice(app, .{
                    .topic = "auth",
                    .tone = .@"error",
                    .body = "Authentication sources could not be checked. The picker remains closed.",
                }),
            }
        }

        pub fn runLogoutCommand(app: *App, target: []const u8) !void {
            if (comptime !oauthAuthEnabled(App)) {
                try app.writeDomainNotice(.{
                    .topic = "auth",
                    .tone = .warning,
                    .body = "Authentication is owned by the embedding host for this session.",
                }, true);
                return;
            }
            const trimmed = std.mem.trim(u8, target, " \t\r\n");
            if (trimmed.len > 0 and !std.ascii.eqlIgnoreCase(trimmed, "codex")) {
                try writeAuthNotice(app, .{
                    .topic = "auth",
                    .tone = .warning,
                    .body = "Usage: /logout [codex]",
                });
                return;
            }
            try app.flushBeforeBlockingExternalWork();
            const outcome = chatgpt_oauth.logout() catch {
                try writeAuthNotice(app, .{
                    .topic = "auth",
                    .tone = .@"error",
                    .body = "Could not durably sign out of Codex. The current source is unchanged.",
                });
                return;
            };
            const changed = if (comptime @hasDecl(@TypeOf(app.auth), "reconcileAfterChatGptLogout"))
                try app.auth.reconcileAfterChatGptLogout(app.alloc)
            else
                false;
            applyCredentialChange(app, changed);
            try writeAuthNotice(app, switch (outcome) {
                .deleted => .{ .topic = "auth", .tone = .neutral, .body = "Signed out of Codex." },
                .missing => .{ .topic = "auth", .tone = .neutral, .body = "No Codex login session found." },
                .deleted_not_durable => .{ .topic = "auth", .tone = .warning, .body = "Signed out of Codex, but could not confirm the profile directory update." },
            });
        }

        pub fn collectSourceInventoryFacts(app: *App) !void {
            const result = app.auth.takeSourceInventoryRefresh() orelse return;
            switch (result) {
                .ready => |action| {
                    app.auth.openPickerForProvider(action.provider);
                    app.shell.render_requests.request(.footer);
                },
                .failed => {
                    try writeAuthNotice(app, .{
                        .topic = "auth",
                        .tone = .@"error",
                        .body = "Authentication sources could not be checked. The picker was not opened with stale data.",
                    });
                },
            }
        }

        pub fn applyPickerChoice(app: *App, choice: auth_runtime.Choice) !void {
            if (comptime !oauthAuthEnabled(App)) {
                try app.writeDomainNotice(.{
                    .topic = "auth",
                    .tone = .warning,
                    .body = "Browser authentication is supplied by the embedding host.",
                }, true);
                return;
            }
            switch (choice) {
                .source => |source| try applySourceChoice(app, source),
                .action => |action| switch (action) {
                    .connections => unreachable,
                    .chatgpt_login => try beginChatGptSignIn(app),
                },
            }
        }

        pub fn routeAuthPickerByte(app: *App, byte: u8) !bool {
            if (app.auth.signInEntryActive()) {
                switch (byte) {
                    3, 4 => _ = app.auth.popPickerStage(),
                    '\r', '\n' => try openSignInBrowser(app),
                    else => {},
                }
                app.shell.render_requests.request(.footer);
                return true;
            }
            return false;
        }

        pub fn routeAuthPickerEscapeAction(app: *App, action: anytype) bool {
            if (!app.auth.signInEntryActive()) return false;
            return switch (action) {
                .escape, .remapped_byte => false,
                else => true,
            };
        }

        pub fn collectSignInFacts(app: *App) !void {
            if (comptime !oauthAuthEnabled(App)) return;
            app.auth.pulseSignIn(app.alloc);
            switch (app.auth.pollSignInTransition(app.alloc)) {
                .none => {},
                .cancelled => app.shell.render_requests.request(.footer),
                .failed => |err| {
                    debug_trace.logf("auth", "login failed source=chatgpt_subscription err={s}", .{@errorName(err)});
                    _ = app.auth.popPickerStage();
                    try writeLoginError(app, err);
                },
                .succeeded => |completed| {
                    var owned = completed;
                    defer owned.deinit(app.alloc);
                    switch (owned) {
                        .chatgpt => {
                            try finishSubscriptionSignIn(app);
                        },
                    }
                },
            }
        }

        fn finishSubscriptionSignIn(app: *App) !void {
            try app.auth.refreshSourceInventory(app.alloc);
            if (!try selectCredentialSource(app, .chatgpt_subscription)) {
                _ = app.auth.popPickerStage();
                try writeAuthNotice(app, .{
                    .topic = "auth",
                    .tone = .@"error",
                    .body = "Signed in, but the Codex subscription credential could not be loaded.",
                });
                return;
            }
            app.auth.closePicker();
            try writeAuthNotice(app, .{
                .topic = "auth",
                .tone = .neutral,
                .body = "Signed in with Codex.",
            });
        }

        fn applySourceChoice(app: *App, source: credentials.Source) !void {
            const body = try std.fmt.allocPrint(
                app.alloc,
                "Switched credential to {s}.",
                .{credentials.sourceLabel(source)},
            );
            defer app.alloc.free(body);

            if (!try selectCredentialSource(app, source)) {
                try app.writeDomainNotice(.{
                    .topic = "auth",
                    .tone = .warning,
                    .body = "That credential is no longer available. The current source is unchanged.",
                }, true);
                return;
            }

            try app.writeDomainNotice(.{
                .topic = "auth",
                .tone = .neutral,
                .body = body,
            }, true);
        }

        fn beginChatGptSignIn(app: *App) !void {
            try app.flushBeforeBlockingExternalWork();
            const started = app.auth.openChatGptSignInPickerFromRoot(app.alloc);
            if (started catch |err| {
                debug_trace.logf("auth", "ChatGPT login failed err={s}", .{@errorName(err)});
                try writeLoginError(app, err);
                return;
            }) {
                app.shell.render_requests.request(.footer);
                if (io_mod.getenv("FIBER_NO_OPEN_BROWSER") == null) try openSignInBrowser(app);
            }
        }

        fn openSignInBrowser(app: *App) !void {
            const url = (try app.auth.signInBrowserUrlAlloc(app.alloc)) orelse return;
            defer app.alloc.free(url);
            if (!try app.urlOpener().open(app.alloc, url)) {
                debug_trace.logf("auth", "login browser launcher failed", .{});
            }
        }

        pub fn selectCredentialSource(app: *App, source: credentials.Source) !bool {
            const changed = (try app.auth.selectSource(app.alloc, source)) orelse return false;
            applyCredentialChange(app, changed);
            return true;
        }

        pub fn admitPromptCredential(app: *App) !bool {
            if (comptime !oauthAuthEnabled(App)) {
                if (app.auth.apiKey() != null) return true;
                try app.writeDomainNotice(.{
                    .topic = "auth",
                    .tone = .warning,
                    .body = "Missing FIBER_API_KEY. Supply it through createFxTerminal().",
                }, true);
                return false;
            }
            if (!try ensurePromptCredential(app)) return false;
            return preparePromptCredential(app);
        }

        fn preparePromptCredential(app: *App) !bool {
            for (0..2) |_| {
                refreshSubscriptionCredentialIfNeeded(app) catch |err| switch (err) {
                    error.OutOfMemory => return err,
                    else => return recoverCredentialFailure(app, .chatgpt_subscription, err),
                };
                if (app.auth.gatewayCredential() != null) return true;
            }
            return recoverCredentialFailure(app, .chatgpt_subscription, error.CredentialRefreshUnavailable);
        }

        fn refreshSubscriptionCredentialIfNeeded(app: *App) !void {
            const source = app.auth.credentialSource() orelse return;
            if (!credentials.sourceRefreshable(source)) return;
            if (!app.auth.credentialNeedsRefresh()) return;
            const resolution = try credentials.resolveForProvider(
                app.alloc,
                app.auth.oauthTransport(),
                .refresh_if_needed,
                .codex,
            );
            var credential = resolution.credential orelse {
                if (app.auth.credentialNeedsRefresh()) return error.CredentialRefreshUnavailable;
                return;
            };
            defer credential.deinit(app.alloc);
            _ = app.auth.adoptCredential(app.alloc, &credential);
        }

        fn recoverCredentialFailure(app: *App, source: credentials.Source, err: anyerror) !bool {
            debug_trace.logf("auth", "prompt credential refresh failed source={t} err={s}", .{ source, @errorName(err) });
            if (app.auth.credentialSource() == source) app.auth.recordCredentialRefreshFailure(source);
            try app.auth.refreshSourceInventory(app.alloc);
            app.auth.openPickerForProvider(provider_runtime.provider(app));
            const failure = auth_runtime.FailureSnapshot{
                .source = source,
                .reason = .credential_refresh_failed,
            };
            const failure_text = try failure.renderText(app.alloc);
            defer app.alloc.free(failure_text);
            const recovery = try std.fmt.allocPrint(
                app.alloc,
                "{s}.\nChoose another source below.",
                .{failure_text},
            );
            defer app.alloc.free(recovery);
            try app.writeDomainNotice(.{
                .topic = "auth",
                .tone = .@"error",
                .body = recovery,
            }, true);
            app.shell.render_requests.request(.footer);
            return false;
        }

        fn applyCredentialChange(app: *App, changed: bool) void {
            if (!changed) return;
            app.model_cache.reset();
            if (comptime @hasDecl(App, "startModelCacheWarmup")) {
                app.startModelCacheWarmup();
            }
        }

        fn writeLoginError(app: *App, err: anyerror) !void {
            const notice: types.SemanticNotice = switch (err) {
                error.ChatGptAuthorizationFailed => .{ .topic = "auth", .tone = .@"error", .body = "Codex sign-in was denied. The current credential is unchanged." },
                error.ChatGptLoginTimedOut, error.LoginTimedOut => .{ .topic = "auth", .tone = .warning, .body = "Codex sign-in expired. The current credential is unchanged; run /login to try again." },
                else => .{ .topic = "auth", .tone = .@"error", .body = "Codex sign-in failed. The current credential is unchanged." },
            };
            try writeAuthNotice(app, notice);
        }

        fn writeAuthNotice(app: *App, notice: types.SemanticNotice) !void {
            try app.writeDomainNotice(notice, true);
            app.shell.render_requests.request(.first_frame);
            try app.flushBeforeBlockingExternalWork();
        }
    };
}
