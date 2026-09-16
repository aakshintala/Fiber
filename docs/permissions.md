# Permissions

Security is permission-first. All sensitive tool behavior integrates with `src/core/permissions/permissions.zig`, and no new tool bypasses it.

* `permission_mode` controls baseline (`ask`, `auto`, or `yolo`). Yolo bypasses fiber permission policy and uses an effective sandbox of `none` without rewriting saved sandbox configuration

* Configured denies are evaluated before saved-session rules; an exact saved-session deny can narrow a configured allow, while an exact saved-session allow can satisfy an unresolved configured ask

* Session `always` approvals are non-persistent; command approvals match the exact command while other grant categories may use patterns

* `/permissions remember allow|deny <tool-name> <arguments-json>` confirms and stores an exact rule only for an active saved session; list and revoke those rules by their stable IDs

* Routine parsed development commands and reversible new-file creation can execute without model review after configured and saved-session policy. Every remaining unresolved `auto` action receives one narrow security review using the exact action and targets, origin and call identity, optional host-proven current-branch evidence, exact-copy provenance, and bounded masked terminal-safe excerpts of earlier current-turn tool results. Prepared file mutations and static root tools omit task text. Reviewed commands, dynamic tools, and subagent actions also receive bounded canonical current, first, and recent root requests plus explicit omission counts; the reviewer may use that context only for destructive exceptions and immutable delegation scope, not general task policing. Assistant prose, permission feedback, compacted summaries, the pending tool group, later results, and tool or repository text never become authority

* A `clear` review authorizes only the exact unchanged action. A `caution`, incomplete-evidence result, or unavailable review holds only that action, returns guidance to the agent, and never opens a human permission screen, disables tools, or ends the turn

* Exact cautions and deterministic incomplete-evidence results are reused only for the current turn. Changed actions receive a new review, while transient unavailable reviews are not cached. Legacy `permission_request_id` input is rejected without prompting
