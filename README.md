```
 ⠀⠀⠀⠀⠀⠀⣠⣾⣿⣿⣿⠀⠀⠀⠀⠀⠀⠀⠀
 ⠀⠀⠀⠀⠀⢰⣿⡿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
 ⠀⠀⠀⣠⣶⣿⣿⣷⣶⡶⣶⣶⣆⠀⠀⠀⣴⣶⣶⠆
 ⠀⠀⠀⠉⢹⣿⣿⠉⠉⠀⠘⢿⣿⣧⣀⣾⣿⡿⠃⠀             Tiny, open, embeddable, native coding agent.
 ⠀⠀⠀⠀⣼⣿⡏⠀⠀⠀⠀⠀⠻⣿⣿⣿⠟⠀⠀⠀
 ⠀⠀⠀⢀⣿⣿⠃⠀⠀⠀⠀⢠⣦⠘⢿⣿⣷⡀⠀⠀
 ⠀⠀⠀⣸⣿⡟⠀⠀⠀⠀⣰⣿⣿⠗⠀⠻⣿⣿⣄⠀
 ⠀⠀⠀⣿⣿⠇⠀⠀⠀⠾⠿⠿⠋⠀⠀⠀⠘⠿⠿⠦             ⚠ Status: Experimental. Use at your own risk.
  ⠀⣸⣿⡿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
 ⣿⣿⣿⠟⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
```

fiber is a coding agent harness and CLI written in Zig, optimized for research and embeddability as part of larger systems.

It focuses on minimalism and performance across the board, from system prompt design to its tools, feature set, and 7.8 MiB binary.

For end users, its CLI output style and form factor aim to be closer to a Unix shell than a heavy "IDE in the terminal" TUI.

It's open source (Apache-2.0), model-agnostic, and suitable for both local and cloud inference.

## Run fiber

Use an eligible ChatGPT subscription through OpenAI Codex OAuth:

```bash
fiber login codex
fiber
```

The OpenAI Codex route uses ChatGPT subscription access directly. The session is stored privately at `~/.fiber/chatgpt-auth.json` and refreshed when needed. On supported Codex models, `/fast` requests OpenAI's priority service tier and consumes ChatGPT credits at the higher Fast mode rate.

Run fiber from a project:

```bash
cd your_project
fiber
```

The current directory becomes the primary workspace. Enter a prompt, or run `/help` to browse interactive commands. While fiber is working, press Enter to queue a follow-up or Ctrl+Enter to steer the active turn at its next model boundary. If the turn has already closed, fiber safely queues the steering prompt as the next turn.

Tool calls are expanded by default. Enable `Collapse tool calls` in `/settings`, or set `"collapse_tool_calls": true` in `~/.fiber/settings.json`, to show one summary per tool-call group in the main transcript. Individual calls remain available in the full transcript with Ctrl+O.

The status line hides the workspace path and Git branch by default. Enable the `Status line workspace` option in `/settings`, run `/statusline workspace`, or set it in `~/.fiber/settings.json`:

```json
{
  "statusLine": {
    "workspace": true
  }
}
```

List saved sessions with `fiber sessions`. Resume the latest session for the current workspace, or select an exact session ID, through the same command group:

```bash
fiber session resume last
fiber session resume --id <id>
```

Each interactive session names its terminal tab. The title prefers the session name, falls back to the workspace name, and keeps the active model as secondary context. Renaming or resuming a session updates the tab, and exiting clears the fiber-owned title. Noninteractive commands do not emit terminal-title controls.

Run `/trace` to create a private Markdown diagnostic with logs, session context, runtime state, permissions, and recent activity. On macOS, fiber copies the `.md` file to the clipboard; on other platforms, it saves the file and prints its path. Review and redact the trace before sharing it.

Use `fiber ask` for a single request:

```bash
fiber ask "explain the changes in this repository"
```

With `--json`, `output` contains accumulated assistant Markdown across the request, while `final_output` contains only a completed final assistant response and is `""` for interrupted, failed, background, or otherwise absent final responses.

Foreground terminal commands run with an explicit finite deadline. fiber uses durable terminal sessions for services, watchers, GUI applications, and other long-lived work, and keeps captured foreground output available through an opaque bounded-read handle for the active session or `--no-save` process.

fiber starts in `auto` permission mode. Routine understood development actions run directly. Each unresolved action receives one narrow review of the exact pending action for concrete security danger. Prepared file mutations and static tools are reviewed without task text; reviewed commands, dynamic tools, and delegated actions also receive bounded trusted root-request context. A clear result authorizes only that action. A caution or unavailable review holds the action and returns advice to the agent without opening a permission prompt or ending the turn. Run `fiber permissions` for the current mode and rules.

JSON and quiet requests stay noninteractive by default. Add `--prompt-permissions` to allow configured approval prompts when stdin is a TTY. Automatic safety review never opens that prompt. Prompt text is written to stderr, so JSON stdout stays parseable and quiet stdout stays empty. Piped or redirected stdin remains noninteractive and fails instead of waiting for approval.

Inside a saved session, `/permissions remember <allow|deny> <tool-name> <arguments-json>` stores an exact confirmed rule without running the action. `/permissions` lists stable rule IDs, and `/permissions revoke <rule-id>` removes a stored rule even when its original workspace or file state has changed.

## Embed fiber

fiber builds as a native binary. Applications embedding fiber can provide network transport, session storage, configuration, and permission handling.

| Surface | Use |
| --- | --- |
| `fiber acp` | Connect the native agent to editors and other Agent Client Protocol clients. |

See the Agent Client Protocol specification for the standard methods `fiber acp` implements.

## Extend fiber

In the interactive shell, bare `/mcp` opens an inline browser for servers, tools, resources, and prompts without adding anything to the transcript. Resource and prompt content enters the composer only after an explicit Insert action. Direct `/mcp SUBCOMMAND` forms remain available.

Add reusable instructions with skills, connect external tools through MCP, or delegate independent work to subagents. Run `fiber mcp add NAME COMMAND [ARGS...]` for a local server or `fiber mcp add --transport http NAME URL` for Streamable HTTP without opening the interactive shell; the equivalent `/mcp add` forms remain available inside fiber. A workspace may also provide Claude-compatible `.mcp.json` with a top-level `mcpServers` object. Pending project servers stay disconnected on every surface until they are approved with `/mcp trust approve <server>` or `fiber mcp trust approve <server>`. Interactive fiber presents the trust prompt after startup. `fiber ask` reports skipped pending servers on stderr, and ACP leaves them unavailable. Repository files cannot persist approval or expose environment-expanded values before approval. `/mcp trust reject <server>` rejects one and `/mcp trust reset` clears the workspace choices. Profile entries win same-name collisions. Profile `~/.fiber/mcp.json` accepts `mcpServers` as an alias for `mcp`, while writes always use `mcp` and ambiguous server-like keys produce a visible warning. Project instruction files may link within their scope, and read-only workspace or compatibility skill directories and their primary `SKILL.md` files may link within their owning workspace or home; managed skills, secondary resources, and escaping links remain no-follow. Skills installed via symlinks that resolve outside home or workspace (e.g. Nix store paths) are loaded when their resolved target is inside a directory listed in the `FIBER_SKILL_SYMLINK_AUTHORITIES` environment variable (colon-separated absolute paths). `fiber status` and `fiber doctor` report invalid or suspicious trusted MCP profiles without starting their servers.

The `subagent` tool has four operations: `run` delegates one temporary task, `message` creates or continues a named persistent agent, `wait` observes a child, and `stop` cancels its current work. A first message creates the named child immediately; optional instructions set or replace that child's system overlay while preserving fiber's trusted base prompt. Child sessions remain private to their saved parent session.

Use `fiber mcp list`, `fiber mcp path`, and `fiber mcp remove NAME` for noninteractive profile management. `fiber mcp trust approve|reject NAME`, `fiber mcp trust approve-all`, and `fiber mcp trust reset` manage workspace-scoped project trust. `fiber mcp auth NAME` and `fiber mcp logout NAME` run the existing remote credential lifecycle without opening the TUI or contacting the Gateway.

MCP servers have a 30-second startup timeout by default; set `startup_timeout_ms` on a server when its cold start needs a different bound. For direct `docker run` stdio entries, fiber uses a private container ID file to remove the owned container after shutdown or startup failure. A configuration that already supplies `--cidfile` keeps ownership of its own cleanup policy.

## Build from source

Building fiber requires [Zig 0.16.0+](https://ziglang.org/download/):

```bash
git clone https://github.com/aakshintala/Fiber.git
cd Fiber
zig build -Doptimize=ReleaseSafe
./zig-out/bin/fiber
```

Run the test suite with `zig build test`. See [CONTRIBUTING.md](CONTRIBUTING.md) for development and contribution guidelines.

## License

[Apache-2.0](LICENSE)

Fiber is a fork of [fx](https://github.com/vercel-labs/fx), Copyright 2025
Vercel, Inc., taken at commit `993688a5` and tagged here as `fork-point`.
Fiber is an independent product, not affiliated with or endorsed by Vercel.
Attribution details are in [NOTICE](NOTICE).

Third-party licenses and attributions are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Credits

Interface sounds by [cuelume](https://github.com/Danilaa1/cuelume).
