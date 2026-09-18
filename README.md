# Fiber

Fiber is a coding agent you run in your terminal. It is written in Zig and
builds to a single native binary.

Fiber writes into your scrollback instead of taking over the screen. Your
prompts and its replies stay above your last command, so you can scroll back
through them, copy them, and search them like any other terminal output. Fiber
uses the full screen only to review a permission request, show the whole
transcript, or pick from a menu.

Status: experimental. There are no published releases yet, so you build it from
source. Use it at your own risk.

## Install

No Zig toolchain needed. Once GitHub Releases publish (tracked in #48),
this fetches the latest release for your platform (Linux on x86_64 or
arm64, macOS on arm64), verifies its sha256 checksum,
and installs `fiber` into `~/.local/bin`:

```bash
curl -fsSL https://raw.githubusercontent.com/aakshintala/Fiber/main/install.sh | sh
```

To install somewhere else, set `FIBER_INSTALL_DIR`:

```bash
curl -fsSL https://raw.githubusercontent.com/aakshintala/Fiber/main/install.sh | FIBER_INSTALL_DIR=~/bin sh
```

Re-running the installer upgrades to the latest release. If the install
directory is not on `PATH`, it prints the `export PATH=...` line to add.

## Build from source

You need [Zig 0.16.0 or later](https://ziglang.org/download/).

```bash
git clone https://github.com/aakshintala/Fiber.git
cd Fiber
zig build -Doptimize=ReleaseSafe
```

The binary is written to `zig-out/bin/fiber`.

`fiber upgrade` resolves upgrades from GitHub Releases.

## Sign in

Fiber reaches a model through an eligible ChatGPT subscription, using OpenAI
Codex OAuth:

```bash
./zig-out/bin/fiber auth login codex
```

Your session is stored at `~/.fiber/chatgpt-auth.json` and refreshed when
needed.

To point a Fiber process at a private state directory instead of
`~/.fiber` — for example one directory per daemon — set `FIBER_STATE_DIR`
to an absolute path. Sessions, settings, MCP config and credentials,
skills, prompt history, usage, backups, logs, and recordings all live
under that root, and two processes given different roots share nothing.
A relative or empty value fails at startup instead of falling back.

## Choose a model

Fiber has no built-in default model, so you pick one. List what your account
can reach:

```bash
./zig-out/bin/fiber models
```

Set the default without opening the shell:

```bash
./zig-out/bin/fiber models use <id>
```

Or choose one with `/model` in the interactive shell. Either way Fiber
remembers it. With no model set, the shell opens the picker for you.

For a single command, pass `--model <id>` or set `FIBER_MODEL`.

## Configure profiles

Install-time settings live in the profile global layer. Read the effective
value and where it came from:

```bash
./zig-out/bin/fiber config get <key>
```

Write one without opening the shell, for example when provisioning a machine
before first launch:

```bash
./zig-out/bin/fiber config set permission_mode auto
./zig-out/bin/fiber config set auto_upgrade false
```

Settable keys are `model`, `effort`, `permission_mode`, `auto_upgrade`,
`max_agent_steps`, `max_tool_result_bytes`, and `first_call_tool_choice`.
`config set` writes the profile global layer only and never touches the
network: `config set model <id>` checks syntax only (non-empty, no
whitespace). `fiber models use <id>` keeps the catalog-checked path and
warns instead of failing when it cannot reach one. An unset model reads
back as `(unset)` with source `unset`: fiber ships no compiled-in default
model. Both commands accept `--json`.

## Run it

Start Fiber from the project you want to work on:

```bash
cd your_project
/path/to/Fiber/zig-out/bin/fiber
```

The current directory becomes the workspace. Type a prompt to begin.

Ctrl+L clears the inline display while keeping the conversation available in Ctrl+O. It preserves your draft and conversation context; `/clear` starts a fresh conversation instead.
List the agent's running background jobs with `/background`, and stop one
with `/background stop <job-id>`.

For a single request without the interactive shell:

```bash
fiber ask "explain the changes in this repository"
```

With `--json`, the result carries a `context` object: `used_tokens` is the
last response's input plus output tokens (null when that response did not
report both), and `window_tokens` is the model window when known. `fiber
session show --id <id>` and `fiber session show last` report the same object
for the last committed turn of a saved session.

Token usage and spend for one saved session in this workspace:

```bash
fiber usage --session <id>
```

These examples write `fiber` for brevity. With a source build, use the
path to the binary you built instead.

## Terminal colours

The interactive shell uses colour for the few things worth noticing:
error, warning, and success notices and the permission mode in the status bar
(`ask` grey, `auto` amber, `YOLO` red). Every other element stays grey,
and colour never carries meaning on its own.

When background detection guesses wrong, force the theme:

```bash
FIBER_THEME=light ./zig-out/bin/fiber
FIBER_THEME=dark ./zig-out/bin/fiber
```

Any other value is ignored. To turn colour off entirely, set `NO_COLOR`
(to any value, even empty); terminals reporting `TERM=dumb` get the same
behaviour. With colour off, the shell emits no foreground or background
colour, greys included, while bold, dim, italic, underline, and reverse
video stay. The active approval choice keeps its reverse-video marker, so
it stays distinguishable.

## Connect MCP servers

Remote MCP servers are configured in `~/.fiber/mcp.json`:

```json
{"mcp": {"api": {"type": "http", "url": "https://api.example.com/mcp", "oauth": {"callback_port": 3118}}}}
```

`oauth` accepts `resource`, `issuer`, `client_id`, `client_secret_env`,
`client_metadata_url`, `scopes`, and `callback_port`. Set `callback_port`
(1-65535) when the provider requires a pre-registered redirect URI: fiber
listens on that loopback port and advertises
`http://127.0.0.1:<port>/callback`. Without it the callback uses an
ephemeral loopback port. A port that is already in use fails closed with a
message naming the conflict instead of starting authorization.

## Get help

Fiber documents itself. These are the current sources:

- `fiber help` lists the command-line interface
- `fiber <command> --help` explains one command
- `/help` inside the interactive shell lists interactive commands

Reference documentation will live under `docs/` once it is written.

## Contribute

Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, verification, and how to open
a pull request.

## License

[Apache-2.0](LICENSE)

Fiber is a fork of [fx](https://github.com/vercel-labs/fx), Copyright 2025
Vercel, Inc., taken at commit `993688a5` and tagged here as `fork-point`. Fiber
is an independent product. It is not affiliated with or endorsed by Vercel.
Attribution details are in [NOTICE](NOTICE).

Third-party licenses are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Credits

Interface sounds by [cuelume](https://github.com/Danilaa1/cuelume).
