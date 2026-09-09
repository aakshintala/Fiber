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

## Build from source

You need [Zig 0.16.0 or later](https://ziglang.org/download/).

```bash
git clone https://github.com/aakshintala/Fiber.git
cd Fiber
zig build -Doptimize=ReleaseSafe
```

The binary is written to `zig-out/bin/fiber`.

There is no installer and no upgrade path yet. `fiber upgrade` reports that no
release source is configured and exits with an error.

## Sign in

Fiber reaches a model through an eligible ChatGPT subscription, using OpenAI
Codex OAuth:

```bash
./zig-out/bin/fiber auth login codex
```

Your session is stored at `~/.fiber/chatgpt-auth.json` and refreshed when
needed.

## Choose a model

Fiber has no built-in default model, so you pick one. List what your account
can reach:

```bash
./zig-out/bin/fiber models
```

Choose one with `/model` in the interactive shell and Fiber remembers it. For a
single command, pass `--model <id>` or set `FIBER_MODEL`.

## Run it

Start Fiber from the project you want to work on:

```bash
cd your_project
/path/to/Fiber/zig-out/bin/fiber
```

The current directory becomes the workspace. Type a prompt to begin.

For a single request without the interactive shell:

```bash
fiber ask "explain the changes in this repository"
```

These examples write `fiber` for brevity. Until installation exists, use the
path to the binary you built.

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
