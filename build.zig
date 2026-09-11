const std = @import("std");

const PgsoArtifact = enum {
    fiber,
    file_index,
    ui_activity,
    approval_review,
};

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    requireSupportedTarget(target.result);
    const optimize = b.standardOptimizeOption(.{});
    const pgso_artifact = b.option(
        PgsoArtifact,
        "pgso-artifact",
        "Emit ReleaseSafe LLVM bitcode for one PGO/PGSO artifact",
    );
    const git_commit = readGitCommit(b);
    const app_version = readAppVersion(b);

    const build_options = b.addOptions();
    build_options.addOption([]const u8, "git_commit", git_commit);
    build_options.addOption([]const u8, "app_version", app_version);
    build_options.addOption([]const u8, "update_channel", "stable");

    const exe = b.addExecutable(.{
        .name = "fiber",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
            .stack_check = false,
            .stack_protector = false,
            .omit_frame_pointer = true,
            .unwind_tables = .none,
            .error_tracing = false,
            .strip = optimize != .Debug,
        }),
    });
    exe.root_module.addImport("build_options", build_options.createModule());

    b.installArtifact(exe);

    const run_cmd = b.addRunArtifact(exe);
    run_cmd.step.dependOn(b.getInstallStep());
    if (b.args) |args| {
        run_cmd.addArgs(args);
    }

    const run_step = b.step("run", "Run fiber");
    run_step.dependOn(&run_cmd.step);

    const exe_tests = b.addTest(.{
        .root_module = exe.root_module,
    });
    const run_exe_tests = b.addRunArtifact(exe_tests);
    run_exe_tests.step.dependOn(b.getInstallStep());
    run_exe_tests.setEnvironmentVariable(
        "FIBER_TEST_PRODUCT_EXE",
        b.getInstallPath(.bin, "fiber"),
    );

    const test_step = b.step("test", "Run tests");
    test_step.dependOn(&run_exe_tests.step);

    const mcp_test_exports = b.createModule(.{
        .root_source_file = b.path("src/mcp_test_exports.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    mcp_test_exports.addImport("build_options", build_options.createModule());
    const json_schema_corpus = b.addExecutable(.{
        .name = "json-schema-corpus",
        .root_module = b.createModule(.{
            .root_source_file = b.path("tests/json-schema/corpus_runner.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        }),
    });
    json_schema_corpus.root_module.addImport(
        "mcp_test_exports",
        mcp_test_exports,
    );
    json_schema_corpus.root_module.addImport(
        "json_schema",
        b.createModule(.{
            .root_source_file = b.path("src/core/mcp/json_schema.zig"),
            .target = target,
            .optimize = optimize,
        }),
    );
    const run_json_schema_corpus = b.addRunArtifact(json_schema_corpus);
    if (b.args) |args| run_json_schema_corpus.addArgs(args);
    const json_schema_corpus_step = b.step(
        "run-json-schema-corpus",
        "Run the pinned JSON Schema Test Suite corpus",
    );
    json_schema_corpus_step.dependOn(&run_json_schema_corpus.step);

    const mcp_dispatcher_e2e = b.addExecutable(.{
        .name = "mcp-stdio-dispatcher-driver",
        .root_module = b.createModule(.{
            .root_source_file = b.path(
                "tests/e2e/fixtures/mcp-stdio-dispatcher-driver.zig",
            ),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        }),
    });
    mcp_dispatcher_e2e.root_module.addImport(
        "mcp_test_exports",
        mcp_test_exports,
    );
    const run_mcp_dispatcher_e2e = b.addRunArtifact(mcp_dispatcher_e2e);
    if (b.args) |args| run_mcp_dispatcher_e2e.addArgs(args);
    const mcp_dispatcher_e2e_step = b.step(
        "run-mcp-stdio-dispatcher-e2e",
        "Run the MCP stdio dispatcher E2E driver",
    );
    mcp_dispatcher_e2e_step.dependOn(&run_mcp_dispatcher_e2e.step);

    // --- file_index search benchmark ---
    const benchmark_exports_mod = b.createModule(.{
        .root_source_file = b.path("src/benchmark_exports.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    const file_index_bench = b.addExecutable(.{
        .name = "file-index-bench",
        .root_module = b.createModule(.{
            .root_source_file = b.path("benchmarks/file_index_bench.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        }),
    });
    file_index_bench.root_module.addImport("file_index", benchmark_exports_mod);
    const install_bench = b.addInstallArtifact(file_index_bench, .{});
    const bench_step = b.step("bench-file-index", "Build file_index search benchmark");
    bench_step.dependOn(&install_bench.step);

    const run_bench = b.addRunArtifact(file_index_bench);
    run_bench.step.dependOn(&install_bench.step);
    if (b.args) |args| run_bench.addArgs(args);
    const run_bench_step = b.step("run-bench-file-index", "Build and run file_index search benchmark");
    run_bench_step.dependOn(&run_bench.step);

    // --- UI activity progress benchmark ---
    const ui_activity_bench = b.addExecutable(.{
        .name = "ui-activity-progress-bench",
        .root_module = b.createModule(.{
            .root_source_file = b.path("benchmarks/activity_progress.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        }),
    });
    ui_activity_bench.root_module.addImport(
        "benchmark_exports",
        benchmark_exports_mod,
    );
    const install_ui_activity_bench = b.addInstallArtifact(ui_activity_bench, .{});
    const ui_activity_bench_step = b.step(
        "bench-ui-activity",
        "Build the UI activity progress benchmark",
    );
    ui_activity_bench_step.dependOn(&install_ui_activity_bench.step);

    const run_ui_activity_bench = b.addRunArtifact(ui_activity_bench);
    run_ui_activity_bench.step.dependOn(&install_ui_activity_bench.step);
    const run_ui_activity_bench_step = b.step(
        "run-bench-ui-activity",
        "Build and run the UI activity progress benchmark",
    );
    run_ui_activity_bench_step.dependOn(&run_ui_activity_bench.step);

    const ui_activity_bench_tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("benchmarks/activity_progress.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    ui_activity_bench_tests.root_module.addImport(
        "benchmark_exports",
        benchmark_exports_mod,
    );
    const run_ui_activity_bench_tests = b.addRunArtifact(ui_activity_bench_tests);
    test_step.dependOn(&run_ui_activity_bench_tests.step);
    const test_ui_activity_bench_step = b.step(
        "test-ui-activity-benchmark",
        "Run UI activity benchmark policy tests",
    );
    test_ui_activity_bench_step.dependOn(&run_ui_activity_bench_tests.step);

    // --- file-diff approval review benchmark ---
    const approval_review_bench = b.addExecutable(.{
        .name = "approval-review-bench",
        .root_module = b.createModule(.{
            .root_source_file = b.path("benchmarks/approval_review.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        }),
    });
    approval_review_bench.root_module.addImport(
        "benchmark_exports",
        benchmark_exports_mod,
    );
    const install_approval_review_bench = b.addInstallArtifact(
        approval_review_bench,
        .{},
    );
    const approval_review_bench_step = b.step(
        "bench-approval-review",
        "Build the file-diff approval review benchmark",
    );
    approval_review_bench_step.dependOn(&install_approval_review_bench.step);

    const run_approval_review_bench = b.addRunArtifact(approval_review_bench);
    run_approval_review_bench.step.dependOn(&install_approval_review_bench.step);
    if (b.args) |args| run_approval_review_bench.addArgs(args);
    const run_approval_review_bench_step = b.step(
        "run-bench-approval-review",
        "Build and run the file-diff approval review benchmark",
    );
    run_approval_review_bench_step.dependOn(&run_approval_review_bench.step);

    const approval_review_bench_tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("benchmarks/approval_review.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    approval_review_bench_tests.root_module.addImport(
        "benchmark_exports",
        benchmark_exports_mod,
    );
    const run_approval_review_bench_tests = b.addRunArtifact(
        approval_review_bench_tests,
    );
    const test_approval_review_bench_step = b.step(
        "test-approval-review-benchmark",
        "Run file-diff approval review benchmark qualification tests",
    );
    test_approval_review_bench_step.dependOn(
        &run_approval_review_bench_tests.step,
    );

    const pgso_ir_step = b.step(
        "pgso-ir",
        "Emit selected ReleaseSafe LLVM bitcode for PGO/PGSO qualification",
    );
    if (pgso_artifact) |artifact| {
        const selected: *std.Build.Step.Compile = switch (artifact) {
            .fiber => exe,
            .file_index => file_index_bench,
            .ui_activity => ui_activity_bench,
            .approval_review => approval_review_bench,
        };
        const output_name = switch (artifact) {
            .fiber => "pgso/fiber.bc",
            .file_index => "pgso/file-index.bc",
            .ui_activity => "pgso/ui-activity.bc",
            .approval_review => "pgso/approval-review.bc",
        };
        const install_ir = b.addInstallFile(
            selected.getEmittedLlvmBc(),
            output_name,
        );
        pgso_ir_step.dependOn(&install_ir.step);
    } else {
        const missing_artifact = b.addFail(
            "pgso-ir requires -Dpgso-artifact",
        );
        pgso_ir_step.dependOn(&missing_artifact.step);
    }
}

/// Fiber supports macOS arm64, Linux x86_64, and Linux arm64 only. Mirrors the
/// runtime allowlist in `src/core/upgrade/upgrade_helpers.zig`.
fn requireSupportedTarget(t: std.Target) void {
    const supported = switch (t.os.tag) {
        .macos => t.cpu.arch == .aarch64,
        .linux => t.cpu.arch == .x86_64 or t.cpu.arch == .aarch64,
        else => false,
    };
    if (!supported) std.process.fatal(
        "unsupported target {s}-{s}: fiber supports aarch64-macos, x86_64-linux, and aarch64-linux only",
        .{ @tagName(t.cpu.arch), @tagName(t.os.tag) },
    );
}

fn readGitCommit(b: *std.Build) []const u8 {
    var code: u8 = 0;
    const out = b.runAllowFail(
        &.{ "git", "rev-parse", "--short=12", "HEAD" },
        &code,
        .ignore,
    ) catch return "unknown";
    if (code != 0) return "unknown";
    const trimmed = std.mem.trim(u8, out, " \t\r\n");
    return b.allocator.dupe(u8, trimmed) catch "unknown";
}

fn readAppVersion(b: *std.Build) []const u8 {
    const bytes = std.Io.Dir.cwd().readFileAlloc(b.graph.io, "src/main.zig", b.allocator, .limited(1024 * 1024)) catch
        @panic("could not read src/main.zig to resolve app version");
    defer b.allocator.free(bytes);

    const prefix = "pub const version = \"";
    const start = (std.mem.find(u8, bytes, prefix) orelse
        @panic("could not find pub const version in src/main.zig")) + prefix.len;
    const end_rel = std.mem.findScalar(u8, bytes[start..], '"') orelse
        @panic("could not parse pub const version in src/main.zig");
    return b.allocator.dupe(u8, bytes[start .. start + end_rel]) catch
        @panic("could not allocate app version");
}
