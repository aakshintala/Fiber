# Fiber Phase 4 — simplification audit, final report

Read-only audit. Nothing in the tree was modified to produce it.

## Method

1. 16 shards of ~15k production lines each, `composer-2.5`, read-only, in parallel.
2. Shard 08 hit the 40-finding cap silently (no `TRUNCATED` line); rerun split in
   two, yielding 82 findings against the capped 40. The split output supersedes it.
3. Mechanical gate: every claim rescored by reading the declaration at its
   `file:line` and counting real references against a test-stripped mirror of the
   tree (each `test "..." {` block cut to its column-0 closing brace).
4. Claims the counter could not settle (2+ references, or an unparseable
   declaration) went to 12 adversarial verifier batches on `gemini-3.5-flash`
   with `requireNonClaude: true` — a different model than produced them, told to
   refute rather than confirm.

## Scale

| | |
|---|---|
| Zig files | 490 |
| Total lines | 580,284 |
| Production lines (test blocks stripped) | 362,634 |
| Inline `test` declarations | 7,289 |
| Raw findings (08 superseded) | 360 |
| Delegated to adversarial verification | 210 |

## Verdicts

| Bucket | Count | Meaning |
|---|---|---|
| DEAD | 90 | zero references beyond the declaration; mechanically verified |
| CONFIRMED | 82 | verifier tried to refute and could not |
| TESTED-ONLY | 61 | deletable, but its only callers are its own tests |
| SINGLE-CALLER | 60 | exactly one caller — inline-the-wrapper candidate, not a deletion |
| REFUTED | 67 | live code; the claim was wrong |

False-positive rate among adversarially verified claims: **67/210 = 31%**.
The mechanical gate and the adversarial pass both earned their place.

## DEAD (90)

### deleted-product — Phase 4 (15)

- `src/core/agent/question_prompt.zig:197` — syncChoicesFrom
- `src/core/agent/question_prompt.zig:209` — append_freeform false-path parameter
- `src/core/agent/runtime/deps.zig:126` — ParentTurnDeliveryAck.discovery_start_offset field
- `src/core/agent/runtime/deps.zig:127` — ParentTurnDeliveryAck.discovery_next_offset field
- `src/core/app/prompt_history_runtime.zig:67` — initializeWithProvider
- `src/core/auth/oauth.zig:118` — requestDeviceAuthorization function
- `src/core/cli/cli_surface.zig:558` — ProviderActivationCaller.provider_command variant
- `src/core/gateway/model_catalog.zig:359` — compareModelCatalogEntries function
- `src/core/gateway/model_catalog.zig:424` — projectPickerModelCatalog function
- `src/core/slash_commands/command_specs.zig:150` — childChatSlashRegistry function
- `src/gateway/agent_request_body.zig:390` — withRequestUserAgent
- `src/ui/footer/picker_presentation.zig:223` — signInProjectedRowIndex manual_code_visible parameter
- `src/ui/footer/picker_presentation.zig:332` — composeSignInPickerRow manual_code_visible parameter
- `src/ui/footer/picker_presentation.zig:333` — composeSignInPickerRow manual_code_mask_count parameter
- `src/ui/footer/picker_presentation.zig:455` — composeApiKeyPickerRow entire function

### always-was — post-transition backlog (75)

- `src/builtins/commands.zig:367` — isExactSlashCommand wrapper
- `src/builtins/tools.zig:859` — isReadOnlyToolName helper
- `src/core/agent/execution_memory.zig:75` — buildNormalMessageExecutionMemory
- `src/core/app/app_entry_runtime.zig:164` — runNoConfigBeforeInteractive
- `src/core/app/app_lifecycle.zig:320` — loadStartupStateForWorkspace
- `src/core/app/app_terminal_runtime.zig:139` — refreshManagedFacts
- `src/core/auth/auth_runtime.zig:490` — refreshSourceInventoryForLogout function
- `src/core/auth/auth_runtime.zig:631` — openSignInPicker function
- `src/core/auth/auth_runtime.zig:635` — openSignInPickerFromRoot duplicate wrapper
- `src/core/auth/auth_runtime.zig:643` — openChatGptSignInPickerForProviderSwitch wrapper
- `src/core/auth/auth_runtime.zig:810` — reselectByPrecedence function
- `src/core/auth/auth_runtime.zig:91` — refreshCredentialToken wrapper function
- `src/core/auth/auth_runtime.zig:921` — unused_local_placeholder constant
- `src/core/auth/oauth.zig:15` — missingGrantedScope function
- `src/core/auth/oauth.zig:176` — refreshToken function
- `src/core/cli/cli_surface.zig:1857` — runPermissionsRuleRemove raw_args parameter
- `src/core/execution/managed_execution_contract.zig:128` — initialPresentation function
- `src/core/execution/managed_execution_contract.zig:144` — cancellationDecision function
- `src/core/execution/managed_execution_contract.zig:206` — toTombstone function
- `src/core/execution/router.zig:107` — executePlannedCommand function
- `src/core/gateway/gateway_provider.zig:146` — catalogEntries method
- `src/core/hosts/native_keychain.zig:263` — loadMcpValueMac test-only wrapper
- `src/core/hosts/native_keychain.zig:452` — storeMcpValueMac test-only wrapper
- `src/core/images/image_attachments.zig:1463` — findEnclosingImagePlaceholder function
- `src/core/images/image_attachments.zig:1478` — imagePlaceholderSpanStartingAt function
- `src/core/images/image_attachments.zig:1486` — imagePlaceholderSpanEndingAt function
- `src/core/images/image_attachments.zig:1635` — writeReviewImageFilePartJson function
- `src/core/input/editor_state.zig:160` — moveHome method
- `src/core/input/editor_state.zig:164` — moveEnd method
- `src/core/input/editor_state.zig:168` — moveLineStart method
- `src/core/input/editor_state.zig:172` — moveLineEnd method
- `src/core/input/gesture_state.zig:14` — ctrlCExitArmedAt accessor
- `src/core/input/gesture_state.zig:22` — escapeClearArmedAt accessor
- `src/core/mcp/elicitation.zig:106` — fn parseModernMcpCapabilities
- `src/core/mcp/elicitation.zig:790` — fn schemaNodeLimit
- `src/core/mcp/features/resources.zig:368` — parseReadOutcome test-only wrapper function
- `src/core/mcp/health.zig:206` — publishCandidate
- `src/core/mcp/json_schema.zig:147` — fn validateSchemaText
- `src/core/mcp/mcp_auth.zig:751` — generatePkce
- `src/core/mcp/mrtr.zig:118` — parseRequestJson
- `src/core/mcp/mrtr.zig:43` — ElicitationMode alias
- `src/core/permissions/permission_prompter.zig:41` — retainGrant method
- `src/core/shared/debug_trace.zig:214` — redactedJsonPreview and JsonKeyPolicy.preserve branch
- `src/core/shared/gateway_error_format.zig:147` — formatMarkedLine function
- `src/core/shared/gateway_error_format.zig:9` — formatSchemaDiagnostic function
- `src/core/shared/message.zig:133` — Request.initWithToolChoice method
- `src/core/skills/skill_runtime.zig:1035` — findSkillByName
- `src/core/skills/skill_runtime.zig:1171` — skill_matches_menu_query
- `src/core/skills/skill_runtime.zig:1185` — skillMenuFilterCount
- `src/core/skills/skill_runtime.zig:1198` — skillMenuActualIndexAt
- `src/core/skills/skill_runtime.zig:1222` — skillMenuSkillAt
- `src/core/skills/skill_runtime.zig:2934` — listSkillsSummary
- `src/core/slash_commands/command_router.zig:282` — parsedIsUnknown test-only helper
- `src/core/subagent/agent_adapter.zig:770` — discardBackgroundUrl fn
- `src/core/subagent/authority.zig:23` — admitChildPermission fn
- `src/core/subagent/tool_host.zig:802` — captureHostAuthority wrapper fn
- `src/core/terminal/client.zig:276` — Runtime.takeCompletion FIFO dequeue API
- `src/core/terminal/client.zig:308` — Runtime.clearTerminalProjection
- `src/core/terminal/shell_resolver.zig:220` — formatInvocationCommand function
- `src/core/terminal/store.zig:2238` — reloadHumanTakeoverAuthorityClaim export
- `src/core/terminal/ui_projection.zig:37` — backgroundStatus function
- `src/core/tooling/tool_dispatch.zig:53` — web_fetch_unavailable_message const
- `src/gateway/agent_request_body.zig:148` — buildGatewayRequiredToolRequestBodyWithOptions
- `src/gateway/agent_request_body.zig:202` — buildGatewayRequiredToolRequestBodyWithMaxOutputTokens
- `src/gateway/agent_request_body.zig:211` — buildGatewayPendingToolReviewRequestBodyWithMaxOutputTokens
- `src/gateway/agent_request_body.zig:49` — buildGatewayRequestBody
- `src/gateway/agent_request_body.zig:665` — formatGatewayRequestShapeSummary
- `src/tools/filesystem/read_file.zig:500` — dispatchWriteFileWithTracker function
- `src/ui/footer/row_text.zig:68` — appendSingleLinePrefixBiasedEllipsized function
- `src/ui/render_engine/assistant_wrap.zig:391` — wrapTranscriptAssistantTextInterruptible
- `src/ui/render_engine/assistant_wrap.zig:463` — wrapLiteralToolOutput non-interruptible wrapper
- `src/ui/render_engine/paint_plan.zig:324` — FooterReservationSource.resize_reflow variant
- `src/ui/render_engine/transcript_blocks.zig:2202` — renderEntriesToFlowBytes family
- `src/ui/transcript/resume_projection.zig:445` — intoRuntime method
- `src/ui/transcript/resume_projection.zig:464` — takePendingDiffs method

## CONFIRMED (82)

### deleted-product — Phase 4 (23)

- `src/core/app/app_commands.zig:8` — unused gateway_provider import
- `src/core/auth/auth_runtime.zig:302` — preferred parameter on loadStatusSnapshotForProvider
- `src/core/auth/credentials.zig:170` — preferred parameter on resolveForProvider
- `src/core/cli/cli_surface.zig:571` — writeProviderActivationError fiber provider branch
- `src/core/cli/cli_surface.zig:581` — activateProviderSelection target parameter
- `src/core/cli/cli_surface.zig:582` — activateProviderSelection caller parameter
- `src/core/execution/command_environment.zig:116` — formatApprovalCommand workspace_clean arm
- `src/core/execution/command_environment.zig:136` — Host.workspace_clean enum variant
- `src/core/execution/command_environment.zig:16` — Environment.workspace_clean union variant
- `src/core/execution/command_runner.zig:626` — executeCommandInEnvironment workspace_clean arm
- `src/core/execution/managed_execution.zig:1425` — dupeEnvironment workspace_clean arm
- `src/core/gateway/model_catalog.zig:292` — web_search_price field
- `src/core/gateway/provider_set.zig:23` — presentation field
- `src/core/hosts/host.zig:149` — nativeForOs wasi process_control guard
- `src/core/session/session_test_controls.zig:7` — logOptions
- `src/core/shared/io.zig:214` — wasi branch in openExistingRegularFileWithPolicy
- `src/core/shared/io.zig:427` — wasi emscripten guard in getenvFromBlock
- `src/main.zig:3223` — hasPosixArgVector wasi arm
- `src/ui/footer/model_menu_presentation.zig:410` — loadedCatalogStatusText state.source read
- `src/ui/footer/picker_presentation.zig:222` — signInProjectedRowIndex source parameter
- `src/ui/footer/picker_presentation.zig:331` — composeSignInPickerRow source parameter
- `src/ui/render_engine/frame_builder.zig:20` — FrameBody.subagent_panel variant
- `src/ui/render_request.zig:10` — Reason.subagent_panel enum variant

### always-was — post-transition backlog (59)

- `src/builtins/commands.zig:314` — matchesTopLevel wrapper
- `src/builtins/commands.zig:322` — renderTopLevelHelpWithStyle wrapper
- `src/builtins/commands.zig:326` — renderTopLevelCommandHelp wrapper
- `src/builtins/commands.zig:330` — topLevelKindFromToken wrapper
- `src/builtins/commands.zig:334` — topLevelUsage wrapper
- `src/builtins/commands.zig:363` — matchesSlashExact wrapper
- `src/builtins/commands.zig:371` — matchedSlashPrefix wrapper
- `src/builtins/commands.zig:375` — renderSlashHelp wrapper
- `src/builtins/commands.zig:379` — renderSlashWelcome wrapper
- `src/builtins/commands.zig:383` — firstSlashCompletion wrapper
- `src/builtins/commands.zig:387` — slashCompletionCount wrapper
- `src/builtins/commands.zig:391` — nthSlashCompletion wrapper
- `src/builtins/commands.zig:395` — nthSlashCompletionLabel wrapper
- `src/builtins/commands.zig:399` — nthSlashCompletionDescription wrapper
- `src/builtins/commands.zig:403` — nthSlashCompletionCategory wrapper
- `src/builtins/commands.zig:407` — slashCompletionHasArgs wrapper
- `src/builtins/commands.zig:411` — argCompletionAnchor re-export
- `src/builtins/commands.zig:412` — argCompletionIndexForLabel re-export
- `src/builtins/commands.zig:413` — permissionsArgCompletionPrefix re-export
- `src/builtins/tools.zig:3` — unused builtin_gateway import
- `src/builtins/tools.zig:877` — toolLabelValue wrapper re-export
- `src/core/app/app_auth_runtime.zig:3` — unused host import
- `src/core/app/app_auth_runtime.zig:9` — unused provider_catalog import
- `src/core/app/app_bootstrap_runtime.zig:10` — unused credentials import
- `src/core/app/app_bootstrap_runtime.zig:218` — refreshChatGptSourceInventory else-if startup branch
- `src/core/app/app_bootstrap_runtime.zig:376` — if (false) keychain startup notice block
- `src/core/app/app_commands.zig:9` — unused host import
- `src/core/app/prompt_history_runtime.zig:188` — displayPath
- `src/core/auth/auth_runtime.zig:69` — FailureSnapshot.renderJson method
- `src/core/auth/chatgpt_session.zig:19` — presence function
- `src/core/auth/credentials.zig:157` — resolve function
- `src/core/auth/oauth.zig:201` — revokeToken function
- `src/core/hooks/hooks.zig:5` — pub const tool imports dead shim
- `src/core/hooks/tool.zig:1` — unused tool re-export shim module
- `src/core/input/editor_state.zig:154` — moveCharacterRight method
- `src/core/mcp/elicitation.zig:157` — RequestState.cancelled variant
- `src/core/mcp/elicitation.zig:161` — Rejection.duplicate variant
- `src/core/mcp/elicitation.zig:174` — Rejection.cancelled variant
- `src/core/mcp/elicitation.zig:185` — decideTransition state parameter
- `src/core/mcp/elicitation.zig:613` — FormSchema.title field
- `src/core/mcp/elicitation.zig:614` — FormSchema.description field
- `src/core/mcp/elicitation.zig:781` — unreachable root title/description assignment
- `src/core/mcp/features/tools.zig:214` — InputRequest and InputRequired re-exports
- `src/core/mcp/features/tools.zig:44` — Error.InvalidInputRequired variant never returned
- `src/core/mcp/mcp_auth_store.zig:134` — Status enum
- `src/core/mcp/mcp_auth_store.zig:267` — fn status
- `src/core/permissions/auto_classifier.zig:329` — ProviderInput.credential_source field
- `src/core/permissions/auto_classifier.zig:361` — Reviewer.disabled
- `src/core/slash_commands/command_specs.zig:704` — argCompletionIndexForLabel function
- `src/core/subagent/authority.zig:51` — HostAuthority.capture wrapper method
- `src/core/subagent/model_contract.zig:44` — Request.agentName method
- `src/tools/skills/install_skill.zig:96` — execute function
- `src/tools/skills/skill.zig:135` — execute function
- `src/ui/footer/compact_command_menu_presentation.zig:195` — composeUsageRow totals binding
- `src/ui/footer/help_menu_presentation.zig:110` — measureBody width parameter
- `src/ui/footer/paint_plan.zig:930` — authPickerQueryCursorColumn cursor branch
- `src/ui/footer/picker_presentation.zig:221` — signInProjectedRowIndex snapshot parameter
- `src/ui/footer/render_input.zig:638` — turnActivityProjection shell parameter
- `src/ui/footer/settings_menu_presentation.zig:141` — measureBrowseBody width parameter

## TESTED-ONLY (61)

### deleted-product — Phase 4 (12)

- `src/builtins/gateway.zig:112` — buildAgentRequest fixture body builder
- `src/builtins/gateway.zig:22` — provider_bundle test-only Codex bundle
- `src/builtins/gateway.zig:254` — toolNameSelected helper
- `src/core/auth/oauth.zig:103` — discover function
- `src/core/gateway/model_catalog.zig:374` — modelProviderRank function
- `src/core/gateway/model_catalog.zig:386` — modelTierRank function
- `src/core/mcp/elicitation.zig:138` — Binding.user_identity optional field
- `src/core/mcp/elicitation.zig:151` — AnswerBinding.user_identity optional field
- `src/core/upgrade/update_target.zig:10` — Channel.parse has no production callers
- `src/gateway/agent_request_body.zig:13` — GatewayCompletion alias
- `src/gateway/agent_request_body.zig:874` — freeGatewayCompletion
- `src/ui/render_engine/frame_layout.zig:81` — BodyMode.subagent_panel variant

### always-was — post-transition backlog (49)

- `src/builtins/hooks.zig:76` — RecordingClient test double struct
- `src/builtins/mcp.zig:1136` — stableEmptyTestEnviron test helper
- `src/builtins/modes.zig:23` — lookup wrapper function
- `src/builtins/tools.zig:881` — toolActivityKind wrapper re-export
- `src/builtins/tools.zig:885` — toolRequiresApproval wrapper re-export
- `src/builtins/tools.zig:889` — toolHasPermissionContract wrapper
- `src/core/execution/managed_execution_contract.zig:123` — Presentation enum
- `src/core/execution/managed_execution_contract.zig:21` — TerminalState enum
- `src/core/execution/managed_execution_contract.zig:48` — Event.backend_lost variant
- `src/core/input/composer_selection.zig:31` — finish method
- `src/core/input/editor_state.zig:148` — moveCharacterLeft method
- `src/core/mcp/elicitation.zig:156` — RequestState.consumed variant
- `src/core/mcp/features/resources.zig:38` — Error.InvalidInputRequired variant never returned
- `src/core/permissions/auto_classifier.zig:331` — ProviderInput.endpoint field
- `src/core/shared/debug_trace.zig:369` — isEnabled function
- `src/core/shared/gateway_error_format.zig:332` — wrapCut helper only used by formatMarkedLine
- `src/core/shared/lexical_relevance.zig:35` — Score struct score and order
- `src/core/skills/skill_runtime.zig:1065` — skillGroupLabel
- `src/core/skills/skill_runtime.zig:234` — SkillSummaryStyles
- `src/core/slash_commands/command_router.zig:311` — TestContext route test harness
- `src/core/slash_commands/command_specs.zig:160` — projectResultV4 identity helper
- `src/core/slash_commands/command_specs.zig:366` — renderSlashHelp function
- `src/core/slash_commands/command_specs.zig:370` — renderSlashWelcome function
- `src/core/slash_commands/command_specs.zig:730` — renderSlashEntries function
- `src/core/subagent/authority.zig:15` — permissionRank helper fn
- `src/core/subagent/model_contract.zig:108` — model_contract.Kind enum
- `src/core/subagent/model_contract.zig:109` — model_contract.Phase enum
- `src/core/subagent/model_contract.zig:110` — model_contract.Snapshot struct
- `src/core/subagent/model_contract.zig:121` — Plan union type
- `src/core/subagent/model_contract.zig:128` — plan scheduling fn
- `src/core/terminal/contracts.zig:1671` — AuthorityGrant.repeated_probes default slice
- `src/core/terminal/host_policy.zig:111` — PendingRequests.cancel method
- `src/core/terminal/recovery.zig:15` — HostEvidence.absent variant
- `src/core/terminal/recovery.zig:6` — RecordEvidence.missing partial corrupt unsupported
- `src/core/terminal/ui_projection.zig:32` — BackgroundStatus struct
- `src/core/workspace/context_contract.zig:369` — contract_name constant
- `src/core/workspace/context_contract.zig:371` — Fragment enum
- `src/core/workspace/context_contract.zig:405` — EntryPoint enum
- `src/core/workspace/context_contract.zig:419` — DriftStatus enum
- `src/core/workspace/context_contract.zig:433` — EntrypointInventory struct
- `src/core/workspace/context_contract.zig:445` — required_fragments table
- `src/gateway/agent_request_body.zig:22` — pending_tool_review_result_text
- `src/gateway/agent_request_body.zig:246` — expandPendingToolReviewMessages
- `src/ui/render_engine/transcript_blocks.zig:414` — wrapAssistantText one-line forwarder
- `src/ui/transcript/painter.zig:1225` — previewTranscriptFlow function
- `src/ui/transcript/resume_projection.zig:47` — ResumeProjection.initEmpty
- `src/ui/transcript/runtime.zig:10529` — previewTranscriptFlow runtime forwarder
- `src/ui/transcript/runtime.zig:9127` — reconstructivePaint runtime forwarder
- `src/ui/transcript/writer.zig:180` — reconstructivePaint function

## SINGLE-CALLER (60)

### deleted-product — Phase 4 (12)

- `src/builtins/context.zig:1977` — buildTurnContextFragmentForHost embed-host branch
- `src/builtins/gateway.zig:188` — buildAgentToolsJson helper
- `src/builtins/gateway.zig:241` — writeDynamicFunctionTool helper
- `src/core/mcp/elicitation.zig:1069` — fn canonicalResponse
- `src/core/mcp/elicitation.zig:173` — Rejection.wrong_user variant
- `src/core/permissions/auto_classifier.zig:15` — gateway_reviewer_model constant
- `src/core/permissions/command_admission.zig:66` — ShellAuthorizationSource.js_host variant
- `src/core/session/session_test_controls.zig:25` — pauseAtRequestedBoundary
- `src/core/slash_commands/command_specs.zig:148` — child_chat_slash_command_count constant
- `src/core/upgrade/upgrade_helpers.zig:69` — fetchTarget channel param always stable
- `src/gateway/agent_request_body.zig:792` — parseGatewayCompletion
- `src/main.zig:464` — web_search_models_path always aliases empty path

### always-was — post-transition backlog (48)

- `src/builtins/commands.zig:301` — top_level_resources empty array
- `src/core/agent/execution_memory.zig:265` — MessageAdapter
- `src/core/app/app_callbacks.zig:49` — preparedDiffPayload passthrough wrapper function
- `src/core/app/app_terminal_runtime.zig:137` — collectFacts empty stub
- `src/core/auth/auth_runtime.zig:923` — probeCredentialSourceForLogout function
- `src/core/execution/managed_execution_contract.zig:132` — CancellationPoint enum
- `src/core/execution/managed_execution_contract.zig:138` — CancellationDecision enum
- `src/core/execution/managed_execution_contract.zig:200` — Tombstone struct
- `src/core/gateway/gateway_provider.zig:151` — adoptOwnedCatalog method
- `src/core/gateway/provider_set.zig:14` — AuthStrategy enum
- `src/core/hosts/host.zig:136` — capabilitiesForTarget wrapper around nativeForOs
- `src/core/input/editor_state.zig:77` — finishSelection method
- `src/core/mcp/elicitation.zig:158` — RequestState.retired variant
- `src/core/mcp/features/tools.zig:708` — requireCompleteResult ignored protocol parameter
- `src/core/permissions/permission_prompter.zig:21` — retain_grant_fn field
- `src/core/shared/gateway_error_format.zig:219` — formatParamPath writeParamPath schemaKindAfter jsonKindName
- `src/core/shell_command/command_effect.zig:185` — PrintfFormatLanguage single-variant enum
- `src/core/shell_command/command_effect.zig:238` — LsSymlinkSemantics single-variant enum
- `src/core/skills/skill_runtime.zig:2938` — listSkillsSummaryStyled
- `src/core/skills/skill_runtime.zig:2976` — writeStyledSourceLabel
- `src/core/slash_commands/command_router.zig:124` — testSlashRegistry test-only helper
- `src/core/slash_commands/command_specs.zig:814` — maxTopLevelResourceLabelWidth helper
- `src/core/slash_commands/command_specs.zig:852` — writeTopLevelResource helper
- `src/core/subagent/agent_adapter.zig:36` — childModelCapabilityResolver pass-through fn
- `src/core/subagent/execution.zig:218` — toolActivityRecorder noop provider
- `src/core/subagent/execution.zig:327` — recordToolActivity noop fn
- `src/core/subagent/model_contract.zig:115` — RejectCode enum
- `src/core/terminal/contracts.zig:13` — max_monitor_definitions constant
- `src/core/terminal/contracts.zig:146` — PersistenceLevel single-variant enum
- `src/core/terminal/store.zig:2011` — hash_monitor_notify legacy hash helper
- `src/core/terminal/store.zig:2023` — hash_monitor_lifetime legacy hash helper
- `src/core/terminal/ui_projection.zig:12` — Row.attachable field
- `src/core/workspace/context_contract.zig:455` — current_inventory table
- `src/core/workspace/context_contract.zig:499` — writeMinimumContractSnapshot
- `src/core/workspace/context_contract.zig:507` — writeEntrypointInventorySnapshot
- `src/core/workspace/context_contract.zig:523` — writeEntrypointLayoutSnapshot
- `src/gateway/agent_request_body.zig:428` — validatePendingToolReviewMessages
- `src/gateway/agent_request_body.zig:57` — buildGatewayRequestBodyWithOptions
- `src/tools/filesystem/glob_files.zig:427` — patternContainsHiddenDirectoryComponent wrapper fn
- `src/tools/filesystem/read_file.zig:434` — write_file_dispatch_tool constant
- `src/tools/filesystem/read_file.zig:484` — allowDecision permission decider
- `src/tools/filesystem/read_file.zig:488` — writeFileArgsJson helper
- `src/tools/skills/skill.zig:140` — executeForSession function
- `src/tools/web/fetch.zig:33` — callWithTransport always uses default transport
- `src/ui/approval_screen.zig:1261` — writeReviewRows single-caller wrapper
- `src/ui/footer/picker_presentation.zig:19` — authPickerQueryCursorColumn entire function
- `src/ui/render_engine/viewport_selection.zig:23` — HardLinePolicy single-variant enum
- `src/ui/transcript/resume_projection.zig:337` — finalizeLivePresentation method

## REFUTED (67)

Not actionable. Listed for completeness in `verify/verdicts.tsv`.

