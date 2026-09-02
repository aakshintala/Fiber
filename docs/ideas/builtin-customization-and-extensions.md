# Builtin customization and extensions

Status: idea under discussion

Priority: after OpenCode Go support and the Fiber product transition

Last updated: September 1, 2026

## Decision summary

Decide whether Fiber needs generic executable extensions or only a supported way to customize builtin tools.

Do not assume that Databricks or OpenCode requires an extension runtime. Both can use native provider support. Start with builtin customization if it meets the concrete user need. Add executable extensions only when customization cannot express a required use case.

## The decision

The two product directions have different costs.

### Customize builtin tools

Fiber could let users configure selected parts of tools that Fiber already owns. Examples may include:

- names and descriptions shown to the model
- default arguments
- bounded command templates
- availability by workspace or permission mode
- provider and model metadata overrides

Fiber would continue to own execution, validation, permissions, output limits, cancellation, and session recording.

This option keeps the product native and uses the existing security boundary. It is the preferred starting point if it covers real use cases.

### Load generic executable extensions

A generic extension system could add providers, tools, hooks, slash commands, or metadata through a versioned host API.

This option creates a new product surface. It needs:

- an extension manifest and stable API version
- installation, update, pinning, disable, and inspection flows
- capability grants tied to extension identity and version
- isolation, memory limits, execution budgets, and cancellation
- bounded host-call inputs and outputs
- structured errors with extension identity and source location
- provenance and trust policy
- cross-platform packaging and release support

A script runtime is not a security boundary by itself. Fiber must mediate filesystem, network, process, environment, credential, and session access.

## Keep native ownership deep

Whichever direction we choose, Fiber should continue to own:

- HTTP, TLS, streaming decoders, retries, and backoff
- cancellation and rate-limit handling
- permission decisions
- credential storage and refresh
- filesystem and process access
- session persistence
- resource accounting
- validation of model-facing tool schemas and results

Customization or extensions should describe bounded policy. They should not duplicate security-sensitive or concurrent runtime behavior.

## Questions that should drive the choice

Choose generic extensions only after a concrete use case answers these questions:

- What must users add that builtin configuration cannot express?
- Does the code need network, filesystem, process, or credential access?
- Must third-party code run inside Fiber rather than through MCP?
- Why cannot an external ACP or MCP process own the behavior?
- How will users install and trust the code?
- What compatibility promise must Fiber make to extension authors?
- What startup, binary-size, and memory cost is acceptable?

One real extension should define the first API. Do not publish a broad host surface for hypothetical providers, tools, hooks, and commands at once.

## If generic extensions become necessary

Start with the narrowest extension type that solves the demonstrated need. Prefer declarative registration and native protocol adapters over low-level callbacks.

A minimal manifest may need:

```toml
id = "example"
version = "0.1.0"
fiber_api = "1"
entrypoint = "main.lua"
capabilities = ["tool.register"]
```

This is illustrative. Do not settle the directory layout, language, or capability vocabulary before choosing the first use case.

Each executable extension should run in an isolated runtime instance. It should receive only declared host capabilities. Fiber should reject unsupported API versions with a clear error.

## Runtime candidates are conditional

Compare runtimes only if Fiber chooses executable in-process extensions.

### Lua 5.4

Lua is small, mature, portable C, and designed for embedding. A custom allocator can account for memory. Debug hooks can enforce execution budgets.

Fiber would need to construct the sandbox, omit unsafe libraries, and test interruption behavior.

### Luau

Luau adds gradual typing and sandbox-oriented runtime features. It provides separate environments and an interruption mechanism.

Its C++ implementation may add build, binary-size, and maintenance costs. Types help only if Fiber also provides useful API definitions and diagnostics.

### Other runtimes

QuickJS, Wren, and WebAssembly remain possible but have no clear advantage for the first use case. Full Python, Ruby, Node.js, and V8 runtimes conflict with Fiber's size, startup, and packaging goals.

If Lua and Luau remain candidates, measure them with the same workload:

- ReleaseSafe binary-size increase
- cold startup time
- idle memory for one and 10 runtimes
- load and compile time
- host-call and value-conversion cost
- cancellation latency
- CPU and memory limit enforcement
- error and stack-trace quality
- macOS and Linux build complexity

Do not choose from advertised minimum runtime sizes.

## Suggested decision sequence

1. List the first concrete customization requests.
2. Test whether builtin configuration, MCP, ACP, or skills already cover them.
3. Add the smallest builtin customization that closes a real gap.
4. Record any requirement that still needs in-process executable code.
5. Design one narrow extension interface only if such a requirement remains.
6. Compare runtimes only after the interface and workload are known.

## Success criteria

This idea produces a useful decision when:

- the first user need is concrete and testable
- existing ACP, MCP, skills, and builtin configuration have been considered
- the chosen solution adds no broader execution surface than required
- security and resource limits are part of the contract
- any extension API starts with one demonstrated implementation

## Open decisions

We still need to decide:

- which builtin tool properties users need to customize
- whether customization is global, workspace-specific, or session-specific
- whether custom tools should be external MCP servers instead
- whether any provider needs in-process extension policy
- whether project-local executable extensions are acceptable
- how extension signatures and provenance would work
- whether extensions could depend on other extensions
- whether a later WebAssembly runtime should support binary extensions

## Research sources

- [Open Responses](https://www.openresponses.org/)
- [Lua 5.4 reference manual](https://www.lua.org/manual/5.4/manual.html)
- [Luau sandboxing](https://luau.org/sandbox/)
- [Luau C API](https://luau.org/api/)
- [QuickJS documentation](https://bellard.org/quickjs/quickjs.html)
- [Wren embedding guide](https://wren.io/embedding/)
