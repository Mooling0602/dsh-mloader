# CONTEXT.md

Technical detail for agents and maintainers. This is the place to look for the parts of the system that are too specific, too brittle or too long to belong in `README.md`, and the place to record them.

`AGENTS.md` holds coding conventions and development rules only. `README.md` is for ordinary users and stays short. Documentation for third-party plugin authors belongs in `docs/` and stays rigorous.

This file is meant to be loaded whole by an agent that needs the working model of the system in one place. It therefore reproduces a fact that also lives in `docs/ABI.md`, in `AGENTS.md` or in `README.md` whenever the second copy saves the reader another file, and it carries detail those documents leave out because their own audience does not need it. Reproduction here is deliberate and not a defect, so a change updates the copy in this file even when the authoritative statement lives elsewhere. Section 7 records which document owns which material.

## Contents

- [1. How to use this document](#1-how-to-use-this-document)
- [2. Architecture axioms](#2-architecture-axioms)
- [3. Repository map](#3-repository-map)
- [4. Commands and testing](#4-commands-and-testing)
- [5. Pitfalls the code already paid for](#5-pitfalls-the-code-already-paid-for)
- [6. External-plugin author constraints](#6-external-plugin-author-constraints)
- [7. Documentation layers](#7-documentation-layers)

## 1. How to use this document

- Hard technical facts live here, not inline in `AGENTS.md` and not in `README.md`.
- When a change alters behaviour, an invariant, a protocol or a workaround, update this file in the same change. A stale section here is worse than no section.
- Keep it dense and factual. No marketing, no tutorial tone.
- A change to the plugin ABI updates [`docs/ABI.md`](docs/ABI.md) first.

## 2. Architecture axioms

The loader reconciles two facts that do not fit together: dsh loads only Cordis plugins through `import()`, and Python or WebAssembly code cannot be a Cordis plugin. Every rule in the code and in the documentation follows from these axioms.

1. **The loader is an ordinary Cordis plugin.** dsh mounts it from the profile bundle patch. It does not change the dsh loader, the bundle mechanism or `import()`, and it replaces no existing plugin.
2. **Hosted external plugins are not Cordis plugins.** They create no Cordis plugin entity, no fiber node and no per-plugin `ctx` scope, and they never appear in a dsh plugin list. They send registration intents over a private RPC protocol; the loader performs the real registrations on its own `ctx`.
3. **The capability surface is a whitelist, not a passthrough.** Only the four operations listed in `docs/ABI.md` §3 are reachable from a plugin. A new capability is added to the whitelist deliberately and never by exposing a `ctx` object.
4. **Registrations are owned and revocable.** Every registration a plugin causes is recorded in that plugin's ledger and revoked in reverse order when the plugin unloads. The loader owns the whole lifecycle of its plugins.
5. **The host main thread is never occupied by external code.** Python runs in a child process, WebAssembly runs in a worker thread, and event dispatch to a plugin is fire-and-forget while the host execution chain advances synchronously.
6. **`apply()` does not wait for plugin startup.** The loader starts plugin boot in the background and returns, and it watches its Cordis fiber to abort a startup that is still in flight when teardown begins.
7. **The ABI is versioned.** The RPC protocol has an explicit protocol version, and the manifest schema and the WebAssembly core ABI are normative in `docs/ABI.md`. Wire shapes change only with a protocol version bump.

The cost of axiom 2 is deliberate: an external plugin has no per-plugin `ctx` isolation, cannot use Cordis `inject` to resolve services and does not appear in plugin management. The loader may show a plugin's state on its own operator surfaces, but that does not make the plugin a dsh plugin entry. That cost is the reason the loader can host non-Cordis code at all.

## 3. Repository map

### Loader source

```
src/
  index.ts                 Cordis plugin entry and PluginManager
  contract.ts              constants: event whitelist, JSON Schema subset validator,
                           lifecycle states, profile and roots resolution
  discovery.ts             scan plugin roots for mloader.plugin.json
  registrar.ts             per-plugin registration ledger and host tool factory
  serialize.ts             projection of live host objects into transportable data
  seed.ts                  release of the bundled example into the profile
  watch.ts                 recursive watch on the plugin roots, debounced callback
  console.ts               terminal output channel, separate from ctx.logger
  http.ts                  optional operator HTTP routes behind the web server
  types.ts                 structural types of the host surface and plugin boundary
  backends/
    python.ts              Python child process and NDJSON transport
    wasm.ts                WebAssembly host side: worker lifecycle and timeouts
    wasm-worker.ts         WebAssembly instance, runs on its own thread
  client/
    core.ts                browser half: the External plugins section
  runtime/
    python_sdk/            canonical Python runtime package, import dsh_mloader_sdk
  tools/status.ts          mloader_status tool and the shared status formatter
  commands/mloader.ts      /mloader command group, called by the user
scripts/build-client.mjs   deterministic build of the committed client bundle
client.js                  committed generated browser bundle
tsconfig.client.json       compiler configuration for src/client
seed/hello-mloader/        bundled example plugin: manifest and plugin.py
test/                      16 self-contained suites and their fixtures
docs/ABI.md                normative plugin contract
```

Top level files: `AGENTS.md` (rules), `CONTEXT.md` (this file), `README.md` and `README.zh.md` (users), `NOTICE` (copyright and license mapping), `LICENSE`, `COPYING` and `COPYING.LESSER` (license texts), `package.json` (package metadata and scripts), `pnpm-lock.yaml`, `tsconfig.json` (host compiler configuration), `tsconfig.client.json` (browser half compiler configuration), `client.js` (generated browser bundle), `cordis.patch.yml` (default loader configuration), `scripts/` (maintainer build scripts), `.markdownlint.json` (Markdown lint policy) and `.gitignore`. The `.build/` intermediate directory is ignored.

The test tree holds the suites directly under `test/`, the Python and WebAssembly test plugins under `test/plugins/`, fault injection plugins under `test/fixtures/`, the reentrancy fixture under `test/deadlock/reentrant/` and the event projection fixture under `test/exec-payload/exec-observer/`.

`.markdownlint.json` records the line wrapping policy that section 7 of `AGENTS.md` states as a rule. It disables `MD013`, which counts the characters in a line, because a paragraph is one complete line with no width limit. It sets `siblings_only` on `MD024`, which permits two headings with the same text when they have different parents while a duplicate among siblings is still an error. Both repositories carry the same file, so a checkout lints to the same expectations as the published copy.

The Python SDK is a flat package. Its content is the directory `src/runtime/python_sdk/`: `__init__.py`, `launch.py`, `channel.py`, `context.py`, `errors.py`, `runtime.py`, `version.py`, `py.typed` and `LICENSE`. There is no nested package directory inside it.

### Build and artifact policy

- The source of the loader is TypeScript under `src/`. `pnpm build` runs the host `tsc -p tsconfig.json` with `outDir` set to `src`, so each host `.ts` source emits a `.js` artifact beside it, and then runs `node scripts/build-client.mjs`, which writes the committed `client.js` bundle from `src/client/core.ts`.
- The committed `.js` files are the build output dsh loads: `package.json` points `main` and `exports["."]` at `src/index.js`, and the package ships `src/` as-is.
- The `.js` artifacts stay in the repository until release artifacts exist, because a dsh installation blocks `prepare` scripts and therefore cannot run a build step. A release that starts shipping prebuilt artifacts can drop them from git; until then, every source change includes the regenerated `.js` files.
- Never edit or document a generated `.js` file. Change the `.ts` file, run `pnpm build`, and commit the result. The WASM backend resolves the worker path from the compiled `src/backends/wasm.js` to `wasm-worker.js` beside it, so the emit layout is part of the runtime behavior.
- TypeScript and `@types/node` are development-only dependencies. There is no runtime dependency and no `prepare` script, so installing from git does not need a compiler.
- `pnpm check` runs `tsc -p tsconfig.json --noEmit` and `tsc -p tsconfig.client.json --noEmit`, so both the host and the browser half are type checked.
- The package requires Node.js 20 or later (`engines.node`). Python plugins require Python 3.10 or later.

### Browser half

- The browser half is the External plugins section on the dsh Plugins page. Its source is `src/client/core.ts`, TypeScript with no imports and no JSX. The bundle wrapper in `scripts/build-client.mjs` supplies React, the client primitives and the client services, so the module stays a single compiled file.
- The bundle requires React and `@deepseek-ai/dsh-client-ui-primitives`. Both are platform seeds of the web shell's module table, so the plugin declares no extra module edge. The section renders with the same primitives the Plugins page uses: `Switch`, `StateDot`, `PluginArtworkDefault` and `Button`.
- The section mirrors the page's component list. The head carries the title and a count line (`共 n 个`, then the states that occur), and each row carries a 40px artwork frame, the plugin name, its id and backend plus tool count, a state dot with the localized lifecycle state, and the switch at the end. Spacing, type sizes and hairlines follow the page's own section column.
- The section sits directly under the bundle's component rows. The slot renders after the page's source facts, so the section carries `order: 1` and the stylesheet it installs puts `[data-plugin-source]` at `order: 2` on the dsh-mloader page. Both are flex items of the page's section column, and the slot outlet is `display: contents`, so the order applies without touching the page's DOM or React tree.
- `client.js` at the repository root is a committed generated artifact. Its header says the file is generated. Never edit it by hand; change `src/client/core.ts` and run `pnpm build`.
- The build is deterministic: the same source produces the same bytes, so `client.js` changes only when its source or the build script changes. The `.build/` intermediate output is ignored by git.
- `package.json` declares the bundle through `exports["./client"]` and `dsh.client` (`platform: "web"` plus the `ui-plugin-manager`, `ui-slots` and `locale` client services to inject), and `files` includes `client.js`. Only the web client module system loads the bundle; the host plugin works without it.

### Python runtime package

- The Python runtime is written in Python, not TypeScript, so it lives under `src/runtime/` rather than `src/` proper. `src/runtime/` is reserved for language code that is not JavaScript or TypeScript.
- The canonical source is `src/runtime/python_sdk/`. It is a flat package with import name `dsh_mloader_sdk`, standard library only, requiring Python 3.10 or later, and additionally licensed MIT while the repository stays LGPL-3.0-only.
- The loader starts a plugin with `<pythonBin> -u <repo>/src/runtime/python_sdk/launch.py <absolute plugin entry>`, with the plugin base directory as `cwd`. The Python backend derives the `launch.py` path from its own compiled location under `src/backends/`, passes the absolute `spec.entry`, and starts the child in `spec.baseDir`. `launch.py` loads the package by path and registers it in `sys.modules`, so `from dsh_mloader_sdk import plugin` resolves to the copy shipped beside `launch.py`, never to an installed package of the same name.
- `launch.py` reconfigures the three standard streams to UTF-8 before it touches the protocol, because the backend encodes requests and decodes both output streams as UTF-8 regardless of the child environment. `stdin` decodes undecodable bytes to the replacement character, which yields a line the runtime skips, and both output streams escape a character UTF-8 cannot carry, which keeps a frame parseable. The setting survives `PYTHONIOENCODING` and an ASCII locale with the UTF-8 mode off.
- The package is not installable by itself: it has no `pyproject.toml`. Packaging metadata belongs to the separate SDK repository.

### Generated SDK copy

The repository `dsh-mloader-python-sdk` (distribution name `dsh-mloader-sdk`, import module `dsh_mloader_sdk`) is a generated copy of `src/runtime/python_sdk/`. A maintainer copies the file set manually from `src/runtime/python_sdk/` into the SDK repository's `src/dsh-mloader-sdk/`. The copy may lag behind this repository; the two trees must be identical when a release is prepared.

The SDK repository owns everything that is packaging rather than runtime code:

```
dsh-mloader-python-sdk/
  pyproject.toml           setuptools metadata, package dir src/dsh-mloader-sdk
  uv.lock                  uv lockfile
  README.md                SDK documentation
  LICENSE                  MIT license text
  src/dsh-mloader-sdk/     the generated copy of src/runtime/python_sdk/
  tests/support.py         shared test helpers
  tests/test_public_api.py
  tests/test_context_namespaces.py
  tests/test_registration.py
  tests/test_protocol_roundtrip.py
```

The wheel built by the SDK repository includes `py.typed` and the MIT `LICENSE` as package data.

### Profile side

```
~/.dsh/profiles/<profile>/
  cordis.patch.yml         loader overrides, only when defaults are changed
  package.json             dsh.profile.bundles lists dsh-mloader
  mloader/
    plugins/               installed external plugins, discovered automatically
```

The workspace holds code and the profile holds configuration and plugins. Changing the loader code never touches the profile. Installing a plugin never touches the loader package directory.

## 4. Commands and testing

### Install, inspect and remove

```bash
# install from GitHub into the web profile
dsh plugin --profile web add github:Mooling0602/dsh-mloader

# development install from a checkout
dsh plugin --profile web add link:$PWD

# remove
dsh plugin --profile web remove dsh-mloader

# confirm the package landed in the effective config
dsh --profile web --dump-config | grep -A 12 'id: dsh-mloader'
```

`dsh plugin` forwards its arguments to pnpm inside the profile directory, and dsh adds the package to `dsh.profile.bundles` because the package declares `dsh.bundle.patch`. No manual edit of the profile is needed. Removing the loader does not remove the plugins under `<profile>/mloader/plugins`.

### Build

```bash
pnpm install
pnpm build        # host tsc, then the deterministic client bundle build
pnpm check        # type check the host and the browser half without emitting
```

Tests import the emitted `.js` artifacts and the committed `client.js`, so run `pnpm build` after any source change before running a suite.

### Test setup and run

The suites that mount the loader import `@deepseek-ai/cordis`, and the loader and command suites also use `@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-commands`, so all three must be resolvable from this checkout's `node_modules/@deepseek-ai`. An installed dsh provides them inside its own `node_modules/@deepseek-ai`; a harness source checkout provides the same packages as `vendor/cordis`, `packages/core/tools` and `packages/interaction/commands`. Link whichever layout applies:

```bash
mkdir -p node_modules/@deepseek-ai
ln -sfn <dsh install>/node_modules/@deepseek-ai/cordis node_modules/@deepseek-ai/cordis
ln -sfn <dsh install>/node_modules/@deepseek-ai/dsh-tools node_modules/@deepseek-ai/dsh-tools
ln -sfn <dsh install>/node_modules/@deepseek-ai/dsh-commands node_modules/@deepseek-ai/dsh-commands
```

Each suite is a standalone script that prints its own pass or fail summary:

```bash
node test/integration.mjs
node test/edge-cases.mjs
# ...
```

Run one or two suites per command. Each takes a few seconds, and leaving an interactive tool call waiting longer than the harness allows hides the result.

### Test matrix

| Suite | Assertions | Covers | Needs `.wasm` |
|---|---|---|---|
| `integration.mjs` | 23 | Python end to end on a real Cordis context and a real tool runtime | no |
| `edge-cases.mjs` | 17 | schema pre-validation, event whitelist, crash isolation, unload cleanup | no |
| `dual-backend.mjs` | 19 | Python and WebAssembly plugins in one loader | yes, otherwise skips |
| `wasm-safety.mjs` | 13 | a looping WebAssembly plugin does not block the host thread | yes, otherwise skips |
| `waterfall.mjs` | 10 | tool execution chain is not blocked by event listeners | no |
| `reentrancy.mjs` | 13 | a real Python subprocess survives reentrant event delivery | no |
| `exec-payload.mjs` | 43 | host exec objects cross the process boundary safely; tools stay usable after a dirty payload | no |
| `command.mjs` | 72 | the `/mloader` command group on a real command runtime: list, detail, load, unload, reload, usage and reserved words | no |
| `profile-install.mjs` | 37 | profile path resolution and plugin loading, including `ctx.baseUrl` | no |
| `seed.mjs` | 28 | bundled example release, including never overwriting user changes | no |
| `crash-safety.mjs` | 10 | EPIPE, orphan process and unload hang resistance | no |
| `console.mjs` | 19 | terminal output levels and write failure tolerance | no |
| `plugin-toggle.mjs` | 62 | runtime switches through the operator routes: real load and unload, manual enable of a manifest-disabled plugin, crash recovery, route removal and the non-web compatibility case | no |
| `client-bundle.mjs` | 20 | generated bundle, slot identity, zh and en dictionaries, placement stylesheet, detail page subject gating, rendering states and switch requests | no |
| `hot-refresh.mjs` | 32 | mounting a plugin directory installed at runtime, unmounting a deleted one, no reload on a file edit, recovery from a directory caught mid copy, bounded retry of a broken one, disabled and `autoEnable: false` policy, missing root, `watch: false` and watcher shutdown on teardown | no |
| `output-inference.mjs` | 20 | result schema derived from a return annotation on both registration styles, the mapping table, explicit `output` precedence, and the host default for an absent, `Any` or unresolvable annotation | no |
| `encoding.mjs` | 4 | UTF-8 standard streams survive a manifest that sets `PYTHONIOENCODING` to ASCII, for a non-ASCII value and for a stray non-ASCII diagnostic | no |
| `bytecode.mjs` | 4 | no `__pycache__` under the default, and one under `enablePyc: true` | no |

The baseline is 446 assertions across 18 suites, 32 of them requiring a compiled `.wasm` fixture. A run without the two binaries reports 414 assertions passed and skips the two WebAssembly suites. Skipping is an environment gap, not a pass: those suites verify that a looping WebAssembly plugin cannot block the host, which is a safety property.

### WebAssembly fixtures

`.wasm` files are not committed (see `.gitignore`). Compile the two fixtures before running the WebAssembly suites:

```bash
cd test/plugins/wasm-hello && GOOS=wasip1 GOARCH=wasm go build -o hello.wasm .
cd test/fixtures/wasm-loop && GOOS=wasip1 GOARCH=wasm go build -o loop.wasm .
```

`dual-backend.mjs` and `wasm-safety.mjs` skip cleanly when the binaries are missing. A skipped suite means the property it asserts is unverified in that environment, not that it passed.

### Prepare the Python SDK copy for a release

Copy the whole file set of `src/runtime/python_sdk/` into the SDK repository's `src/dsh-mloader-sdk/`, replacing the previous copy. This is a manual maintainer step. Then verify the copy from the SDK repository root:

```bash
uv sync
uv run python -m unittest discover -s tests
uv run python -c "import dsh_mloader_sdk; print(dsh_mloader_sdk.__version__)"
uv build --wheel                     # contains every runtime file, py.typed and LICENSE
diff -r <dsh-mloader checkout>/src/runtime/python_sdk src/dsh-mloader-sdk
```

The `diff` must report no difference. Both trees must be identical when a release is prepared; a stale file in either tree is a release defect.

### Loader configuration reference

The defaults are defined in `src/index.ts` and repeated in `cordis.patch.yml`. A profile overrides a value with the same plugin id in its own `cordis.patch.yml`. The configuration belongs to the operator; third-party plugin authors do not set it.

| Key | Default | Meaning |
|---|---|---|
| `roots` | `[]` | Extra plugin root directories. Leave empty; the profile plugin directory is discovered automatically. |
| `profilePlugins` | `true` | Append `<profile>/mloader/plugins` to the roots. Set to `false` to use only explicit roots. |
| `profileDir` | `undefined` | Override the detected profile directory. Intended for tests, never for production. |
| `autoEnable` | `true` | Start every plugin whose manifest has `enabled: true`. When `false`, plugins stay `discovered`. |
| `pythonBin` | `"python3"` | Python interpreter used for Python plugins. |
| `enablePyc` | `false` | Keep the `__pycache__` directory a Python plugin writes when the interpreter loads its entry file. It is off by default, so a reload always runs the code currently on disk. Enabling it trades that guarantee for a faster start. |
| `statusTool` | `true` | Register the `mloader_status` tool for the model. |
| `command` | `true` | Register the `/mloader` command group. `false` disables it; a string sets a custom command name matching `^[a-z][a-z0-9_-]*$`. |
| `seedExamples` | `true` | Release the bundled example into the profile plugin directory on first start. |
| `console` | `true` | Terminal output: `true` for lifecycle events, `'verbose'` for scan detail, `false` for silence. |
| `watch` | `true` | Mount a plugin directory installed while the loader runs and unmount one that is deleted. `false` installs no watcher, so a new plugin needs a restart. |
| `wasm.enabled` | `false` | Enable the WebAssembly backend. It is off by default. |

`command` and `statusTool` are independent switches. The command also needs the optional `commands` service; when that service is absent the loader skips the command and keeps mounting plugins.

### The bytecode cache (`enablePyc`)

The Python backend starts one child process per plugin. CPython caches the compiled entry file beside it in `__pycache__` and decides whether a cache entry still matches the source by the source mtime in whole seconds plus the source size. Neither input changes when an edit keeps the file the same length and lands inside the same second, which is easy to hit when two equal length literals are swapped or a value is retyped in place. A reload then starts a child that loads the previous code and reports success, so the failure is silent.

`enablePyc` therefore defaults to `false`, and the backend spawns the child with `PYTHONDONTWRITEBYTECODE=1`. No cache directory is written, so nothing can go stale and a reload always runs the code on disk. An operator who prefers a faster start sets `enablePyc: true`, which restores the cache and with it the chance that a reload runs a stale entry. The switch governs writing only: a cache directory left behind by an earlier run is still read, so clearing `__pycache__` is a manual step when the switch is turned back on.
### Restart handoff checklist

A code change to the loader needs a dsh restart before it takes effect. Ask the operator to restart, and check the following after the restart.

1. **Loader mounted.** The `dsh web` terminal shows `[mloader]` lifecycle lines. With the bundled example on a fresh profile:
   ```
   [mloader] seeded: hello-mloader
   [mloader] mounted hello-mloader (python, tools: hello_add, hello_mloader)
   [mloader] ready: 1 plugin(s) mounted
   ```
   No `[mloader]` line means `console` is off, or no plugin root was found. The loader warns in the latter case with `profile directory not detected; <profile>/mloader/plugins was skipped` or `no plugin roots configured`.
2. **Operator surfaces agree.** `/mloader` lists the same plugins as the `mloader_status` tool, each with backend, state, tools and events. The dsh-mloader bundle detail page on the dsh Plugins page shows the External plugins section, and a switch changes the plugin state immediately.
3. **External plugins stay invisible.** The plugin tools exist, but the hosted plugins do not appear in the dsh plugin management list and have no Cordis fiber.
4. **Deadlock regression.** The bundled example subscribes to `tools/execute` and logs from the handler. Call any tool several times: every call returns promptly. A hang here means the event dispatch or one-way logging rule was broken.
5. **One process per Python plugin.** `ps -ef | grep launch.py` shows one process per applied Python plugin, owned by the dsh process.
6. **Hot refresh.** Copy a plugin directory into `<profile>/mloader/plugins` while dsh runs. The terminal prints `[mloader] rescan added 1 and removed 0 plugin(s)` and the mount line for the new plugin, and its tools appear without a restart. Delete the directory again: the terminal prints `[mloader] unloaded <id>` and the tools are revoked. With `watch: false` neither line appears.
7. **Crash isolation.** Kill one plugin process. Its tools fail with a tool error, the other plugins keep working, dsh stays up, and the killed plugin reports `failed` in the status output.
8. **Rollback.** Set `disabled: true` under the `dsh-mloader` id in the profile's `cordis.patch.yml` and restart, or run `dsh plugin --profile web remove dsh-mloader`. Plugins under `<profile>/mloader/plugins` stay on disk either way.

## 5. Pitfalls the code already paid for

Each rule below has a concrete failure behind it. The rule is what must hold now; the failure explains why the rule is not optional.

### 5.1 Data crossing a process or thread boundary

- **Project host objects into pure data before they leave the host.** A `tools/*` event carries a live execution object whose `agent` field contains a reference cycle through `ctx`, fiber and scope, and whose `signal` field is a host `AbortSignal`. `JSON.stringify` throws on the cycle, and `postMessage` throws `DataCloneError` on the signal. `serialize.ts` owns the projection: cycles become `[Circular]`, functions become `[Function]`, an `AbortSignal` becomes `{ $type: 'AbortSignal', aborted, reason? }`, and depth, key count, array length and string length are capped.
- **Give the tool execution events a dedicated projection.** The first argument of `tools/execute`, `tools/pre-execute`, `tools/post-execute`, `tools/result` and `tools/change` is projected by `projectToolExecution()` into the stable shape documented in `docs/ABI.md` §3.4. Do not hand the plugin the whole agent tree.
- **A serialization failure may drop one frame and nothing else.** Serialization and the stream write are separate `try` blocks. A frame that cannot be serialized is lost with a warning; it must not mark the channel broken. Only a real write failure marks the channel broken and stops further writes.
- **A request that was never written fails immediately.** `#request` resolves with a `kind: 'transport'` error when the frame could not be delivered, so the caller does not wait the full call timeout for a reply that cannot arrive.

### 5.2 Event dispatch and the execution chain

- **The waterfall listener must call `next()` synchronously and return its result.** Cordis waterfall events pass `next` as the last listener argument, and the chain stops at a listener that does not call it. The tool execution body then never runs and the tool result becomes `undefined`.
- **Plugin dispatch is fire-and-forget and never awaited by the listener.** Awaiting a plugin reply from the listener blocks the host's execution chain on the plugin. The listener starts the dispatch and continues the chain synchronously.
- **A plugin event handler must not wait for the host.** The host is busy delivering the event and is not reading further requests from that plugin, so a synchronous host request from inside a handler deadlocks both sides. Handler work must be short and must not block.
- **Python logging is a one-way notification.** The Python runtime sends `logger.log` with `notification: true` and does not wait for a reply, so logging is safe from inside an event handler. A synchronous logger request is a deadlock.
- **A disposed or disabled plugin still advances the chain.** Its listener calls `next()` and returns the result; it just does not dispatch anything.
- **An effect registered by a plugin is anchored on the loader's context.** Unloading the loader therefore also runs that plugin's cleanup, not only unloading the plugin itself.

### 5.3 Child process edge cases

- **The child's stdin needs an `'error'` listener before the first write.** When the child exits, writing to its stdin emits an asynchronous `'error'` event, and an EventEmitter without a listener raises it as an uncaught exception that kills dsh. A synchronous `try/catch` does not catch it. The listener sets `stdinBroken` and records the failure; later writes are dropped instead of repeating the error.
- **A failed startup must reap the process it spawned.** `start()` kills the child on a boot timeout or handshake failure, and the caller's failure path calls `stop()` again. Otherwise the spawned process is orphaned: no handle owns it and unloading the loader never reaches it.
- **Attach the backend instance to the ledger before awaiting startup.** Teardown must be able to stop the instance at any moment, including while `start()` is still waiting for a slow plugin. Construct, attach, then await.
- **Kill escalation is SIGTERM, a bounded wait of 2000 ms, then SIGKILL.** The timer must not keep the Node process alive.
- **`stop()` is idempotent and has a fixed order.** It fails every pending request first, sends `dispose` with a 1000 ms deadline, ends the child's stdin, and then escalates to the kill path. Calling it twice, or calling it on a dead child, must not throw.
- **Requests and notifications are handled differently.** A notification such as `logger.log` is processed and never answered. Every request frame receives exactly one reply. A reply for an unknown id and an unrecognized frame are logged and ignored; neither may disturb the channel.
- **`stdout` is the protocol channel.** A plugin's stray `print()` corrupts the frame stream. The host tolerates and logs non-protocol lines instead of failing the plugin, but plugin authors must use `ctx.logger` or `stderr` for diagnostics. `stderr` is forwarded to the loader logger.
- **A tool call timeout does not kill the process.** The tool returns an error result and the plugin stays alive. A boot timeout is different: the plugin is killed and marked `failed`, and the other plugins are unaffected.
- **A crashed process revokes its registrations and is not restarted.** The crash handler disposes the plugin's ledger and marks it `failed`. The host and the other plugins continue. An operator can reload the plugin through the optional `mloader` service (`reload(id)`) or restart dsh; the loader never restarts it on its own.

### 5.4 Loader startup and shutdown

- **`apply()` must not await plugin boot.** Cordis waits for `apply()` to return before it runs the fiber's disposal, so a blocked boot blocks teardown for the whole startup timeout. The loader starts boot as a background task and returns, and the plugin status surfaces the progress (`loaded`, `applied`, `failed`).
- **Teardown must abort an in-flight startup.** The loader listens for a fiber state change away from active on `internal/status` and the teardown effect, and calls `abortStartup()`; that fails in-flight requests so the background boot task finishes quickly. Teardown then awaits the boot task and iterates the records again, because boot may have created a record after teardown began.
- **The abort path must be installed before boot starts.** The `internal/status` listener and the effect that calls `abortStartup()` are registered before the boot task is created. A cleanup registered later cannot run early enough to interrupt a startup that is already waiting.
- **The active fiber state is not exported as a runtime enum.** Cordis exposes the state only as a number, so the loader compares the literal `2` and keeps that value in one named constant. Do not spell the number out at each use.
- **Unload ordering is registrations first, backend second.** Disposing the ledger is immediately visible to dsh; stopping the backend may take a moment, and a failing stop is a warning, not a failure of the unload.
- **Reload prints `reloading <id>` and then the mount line, not an unload line.** A reload stops and starts in one step, so a separate unload line would describe something that did not happen.

### 5.4a Watching the plugin roots

- **The watch covers the set of plugin directories, not their contents.** A plugin directory that appears is admitted by the same policy as boot, and one that disappears is unloaded. Editing a manifest or an entry file leaves the running plugin alone, because `fs.watch` reports a write as a `change` event while a directory is created or removed with a `rename` event; the watcher reacts only to `rename` and only for a directory entry. Reloading after an edit stays an explicit `/mloader reload`.
- **One recursive watcher per root.** Node 24 implements `recursive: true` with one inotify watch per directory inside the root, so the kernel cost grows with the number of plugin directories. Each watcher is unref'd, so a watcher never keeps the process alive on its own.
- **A missing root is watched through its nearest existing ancestor.** The ancestor can be any number of levels up, and it also reports the creation of every directory between the ancestor and the root. The file system root itself is refused, because watching it would watch everything.
- **`watch()` throw and the `error` event are both handled.** In this environment `/proc/sys/fs/inotify/max_user_watches` is not readable (SELinux), so the limit cannot be checked in advance. A refused watch is a warning line and no watching, and an `error` event from an open watcher closes that watcher instead of leaving a broken handle.
- **Rescans are serialised and debounced.** The watcher collects events for 300 ms before it calls back, and a callback that arrives during a running rescan queues exactly one follow-up. Without the gate two rescans would race in `records` and could start the same plugin twice.
- **The first rescan waits for boot.** `apply()` returns before boot finished, so a change during boot would diff against a `records` map that is still filling. The rescan awaits the boot task first, and boot itself handles a directory that arrived before it scanned.
- **Bytecode and VCS directories are filtered out.** A Python plugin writes `__pycache__` under its own directory while it starts, and the watcher must not treat that as a plugin directory appearing or disappearing. `.git`, `node_modules` and files ending in `.pyc` or `.pyo` are ignored for the same reason.
- **A start that fails as the directory appears is retried with a fixed budget.** A directory copy creates the manifest before it writes the entry file, so the first start can fail on a file that arrives a moment later. The rescan path retries that plugin after 750 ms, re-reading the manifest, and stops after three attempts with `giving up on <id> after 3 retries`. The budget is per plugin id and is cleared by a successful start, so a plugin that is genuinely broken stays `failed` instead of being started in a loop.
- **Teardown closes the watcher.** `teardown()` closes the handle before it stops the records, and a callback that still fires afterwards returns immediately because `disposed` and `aborted` are set. No rescan outlives the loader.
- **`watch: false` installs no watcher at all.** The setting is read once at mount, so the whole mechanism is absent rather than idle, and the suites that mutate a plugin root after mount keep their deterministic behaviour.

### 5.5 Profile and plugin root resolution

- **`ctx.baseUrl` is the authoritative profile source.** dsh sets it in `dsh-app-boot` to the file URL of the directory that contains the active `cordis.yml`, which is the profile directory. A candidate from `baseUrl` is accepted only when the directory contains both `package.json` and `cordis.yml`.
- **Environment variables are fallback sources at best.** `DSH_PROFILE_DIR` is injected for shell tools and is absent from the dsh main process environment; `DSH_HOME` and `DSH_PROFILE` may also be absent. Never rely on them as the primary source.
- **`import.meta.url` cannot locate the profile.** A `link:` install resolves to the real workspace path, which contains no profile. Only registry or GitHub installs land under the profile's `node_modules`, so the install method cannot be the basis of the detection.
- **The detection order is explicit `profileDir`, `ctx.baseUrl`, `DSH_PROFILE_DIR`, `DSH_HOME` plus `DSH_PROFILE`, then a single-candidate scan of `~/.dsh/profiles/`.** The last step refuses to guess when more than one candidate exists, because a wrong guess would read plugins from, or write them into, the wrong profile.
- **Undetected profile is a warning, never silence.** The loader warns and skips the profile plugin directory, because the alternative is a loader that starts, mounts nothing and says nothing.
- **No plugin root is a warning and a clean return.** With no root at all there is nothing to host, so the loader says so and stops rather than failing.
- **Roots accept `~`, relative and absolute paths.** Relative roots resolve against the profile directory, falling back to `cwd` when no profile was detected. The profile plugin directory is appended as a root unless `profilePlugins: false`, and duplicates are removed so a repeated root cannot load a plugin twice.
- **`dsh --from-default-profile` deletes the profile directory**, including `mloader/plugins` and everything in it. Never run it against a profile that holds plugins the operator wants to keep.

### 5.6 Terminal output and logging

- **`ctx.logger` does not print to the terminal.** Cordis `LoggerService` keeps messages in an in-memory ring buffer, and the dsh boot exporter only collects warn and error into startup logs for diagnostic replay. Terminal output must go through `console.ts`, which is the reason that channel exists. The terminal is not an alternative to logging: detailed diagnosis still goes to `ctx.logger`.
- **The two channels do not duplicate each other.** The terminal shows lifecycle events (mount, unload, crash, skip, failure). Registration detail stays in the logger.
- **Every terminal write is guarded.** A closed terminal pipe raises `EPIPE` from `process.stdout.write`; an uncaught write failure must never take dsh down. Writes go through `console.log` inside `try/catch`.
- **`NODE_ENV=test` silences terminal output** so suites can assert on captured output without depending on the terminal.
- **`console: 'verbose'` adds scan detail; `console: false` silences everything.** `true` is the default and reports lifecycle events only.

### 5.7 WebAssembly isolation

- **WebAssembly code never runs on the host main thread.** V8 has no fuel metering and no API to interrupt WebAssembly execution, so a synchronous call with an infinite loop freezes the main thread permanently, including the timeout timer. Every instance runs in a `worker_threads` worker, and the host kills the worker on timeout.
- **The timeout path terminates the worker.** `worker.terminate()` is the only mechanism that actually stops a looping instance. The timeout clears the worker handle before terminating, so a late reply cannot resolve a call that already failed.
- **Worker failure fails the calls that are pending.** A missing required export fails initialization through the `init-error` reply, and a worker exit rejects every pending call. `stop()` terminates the worker.
- **The worker handshake is `ready` or `init-error`.** The host resolves startup only on `ready`, so a module that fails to compile or instantiate becomes a failed plugin rather than a hung startup.
- **The worker has a memory limit.** `resourceLimits.maxOldGenerationSizeMb` is set to 256 MB.
- **The worker cannot call back into the host synchronously**, because a host import cannot return across threads. The v1 protocol is declaration based, so this costs no capability.
- **Arguments to a worker are projected too.** `postMessage` uses structured clone, which throws on host objects such as `AbortSignal`; the same projection as the Python backend applies.
- **The WebAssembly backend is opt-in.** It loads only when `wasm.enabled` is `true`, because failure injection coverage on that path is incomplete.

### 5.8 Discovery and registration

- **Discovery never throws.** A bad manifest or an unreadable root produces an error entry and a warning; the other plugins still load. Plugins are sorted by id so the order is stable across runs.
- **Every registration lands on the loader's context.** dsh therefore attributes the hosted plugin's tools and listeners to dsh-mloader, not to the plugin. That attribution is the reason the plugin stays invisible in plugin management.
- **Duplicate plugin ids are a discovery error.** The first manifest in scan order wins and the duplicate is reported, because two records would fight over the same registrations.
- **A root may itself be a plugin directory**, not only a directory of plugin directories. Both layouts are scanned.
- **The manifest is the identity authority.** `id` must match `^[a-z0-9][a-z0-9_-]{0,31}$`; `backend` and `entry` are required and validated; `name` falls back to `id`, `version` to `0.0.0`, `enabled` to `true`, timeouts to 10000 and 30000 ms, and the capability switches to on. `inject` is forwarded to the plugin process as metadata and grants nothing.
- **Capability switches are declared metadata, not enforcement.** The `capabilities` object carries `tools`, `events`, `logger` and `effect`, all defaulting to `true`. Nothing in v1 rejects a registration because a switch is `false`. The enforced boundaries are the registration operation whitelist and the event whitelist.
- **A tool needs a name, a description and a valid schema.** The name matches `^[A-Za-z0-9_-]{1,64}$`, the description must be non-empty, and a duplicate tool name or a duplicate event subscription within one plugin is rejected.
- **The loader pre-validates the JSON Schema subset.** dsh accepts only a restricted subset, and its own error names the keyword without naming the plugin or tool. The loader validates first and reports the plugin id, tool name and offending path. `format`, `minimum`, `pattern`, `$ref`, `anyOf`, `allOf` and similar keywords are rejected.
- **`output.render` is rebuilt on the host side.** Functions cannot cross the plugin boundary, so the plugin declares `output.schema` and the loader supplies a renderer that turns the returned JSON value into a text block.
- **The Python runtime infers `output` from the return annotation.** The host validates a result against the declared schema and the default schema describes an object, so a handler returning a bare string or number would fail after it ran. Both registration styles call `_output_schema_from_annotation`, which reads the annotation once at registration and sends no `output` when the annotation is absent, is `Any`, fails to resolve, or names no expressible type. An explicit `output` argument wins. The mapping table lives in `docs/ABI.md` §2.8.
- **Unknown operations and events are rejected by name.** The rejection lists the whitelist so a plugin author can see what is allowed.
- **Every registration goes through the ledger.** The ledger is the only path to a host registration. It revokes in reverse order, a registration that races ledger closure is revoked immediately instead of hanging around, and one failing disposer must not stop the remaining ones.

### 5.9 Plugin lifecycle details

- **A manifest with `enabled: false` is discovered and skipped.** The record is created in state `disabled` so the operator surfaces can report it.
- **`autoEnable: false` leaves plugins in `discovered`** without starting them.
- **Reload stops the old backend before it starts a new one.** Two backend instances never run for the same plugin id. The new Python process imports the plugin module again, so module level state does not survive a reload.
- **The seed never overwrites anything.** If the destination directory exists, the example is skipped as a whole. Merging or updating would destroy the edits the user made to the example, which is the advertised way to start a plugin.
- **The seed runs before plugin discovery.** The released example is loaded in the same startup, so a fresh install has a working tool without a second restart.
- **Seed and plugin failures are warnings, not fatal.** A read-only profile, a full disk or an unreadable bundled seed directory must not stop the loader from hosting the plugins that are already there. The bundled seed directory is `<repo>/seed`.
- **A released example must pass discovery like any other plugin.** Release is not a privilege: if the example's manifest is invalid, discovery reports it and the loader continues.
- **The seed is skipped when no profile directory is known.** The loader does not write into a directory it cannot identify as the active profile.
- **`mloader_status` and the `/mloader` list share one formatter.** Both call `buildStatus` and `format` from `tools/status.ts`; a change to one surface updates the other by construction. A list query returns `{ count, plugins, byBackend, byState }`; the model's tool also accepts an id and then returns `{ plugin }` rather than `{ plugins }`, and the formatter must accept both shapes. A snapshot carries `id`, `name`, `version`, `backend`, `state`, `tools`, `events` and `registrations`, plus `error` only when the plugin has failed.
- **The command service is optional.** The loader does not inject `commands`; it probes `ctx.get('commands')` at runtime and skips command registration with a debug log when the service is missing. A missing command must never prevent plugin mounting.
- **The command is one command group named `/mloader`.** The default command name matches `^[a-z][a-z0-9_-]*$`. An invalid configured name is a warning and the command is not registered. A user input error in the handler becomes a `{ kind: 'error' }` command result instead of a thrown exception.
- **The command forms are fixed.** `/mloader` and `/mloader status` list every known plugin through the shared formatter. `/mloader <id>` renders a detail block with `Plugin <id>:`, `Name:`, `Version:`, `Backend:`, `State: <state> (loaded|not loaded)`, `Tools:` (or `none`), `Events:` (or `none`), `Registrations:` and, when present, an `Error:` line. `/mloader load <id>`, `/mloader unload <id>` and `/mloader reload <id>` request the lifecycle transition; loading an already loaded plugin and unloading a plugin that is not loaded succeed with a short message and do not call the manager. Unknown ids return `Unknown plugin "<id>".`; `help`, malformed input and a missing id return the usage text. The reserved words `status`, `help`, `load`, `unload` and `reload` win over a plugin id of the same name.
- **The list output format is fixed by the formatter.** No plugins renders `No external plugins are managed by dsh-mloader.` A list starts with `<n> external plugin(s):` followed by a blank line, and each plugin line is `- <id> (<backend>, <state>)` with optional ` tools=[a, b]` and ` events=[x, y]` suffixes. A plugin error appears on its own line as `  error: <message>`.
- **`ctx.provide('mloader', ...)` exposes `list`, `enable`, `disable`, `setEnabled`, `reload` and `unload`** for the operator surfaces and for tests. dsh itself does not need it, and it is not part of the external plugin contract. The structural context type does not promise `provide`, so the call is guarded.

### 5.10 Operator surfaces and the browser half

- **The operator surfaces are not plugin capabilities.** The External plugins section on the Plugins page, the two HTTP routes under `/mloader` and the `/mloader` command are internal to dsh-mloader. An external plugin cannot call them, register on them or rely on them; they must stay out of the external plugin ABI.
- **The web surfaces are optional.** The loader's only required service is `tools`. The HTTP routes register through the optional `ctx.inject(['webServer'], ...)` path, so a harness without a web server leaves the injected scope pending and the loader unaffected: no error, no warning and no failed fiber. The no-web-server case is covered by `test/plugin-toggle.mjs`, and the loader suites run without a web server.
- **The browser bundle owns one slot registration.** The section registers on the `plugins.detail.section` slot with entry name `plugins.detail.section`, id `mloader-external-plugins`, order 10 and locale namespace `mloader`. It renders only when the open detail page subject is the `dsh-mloader` bundle (`subject.kind === 'bundle'` and `subject.pkg.name === 'dsh-mloader'`); another bundle, a row subject or a missing subject renders nothing. `client.js` is built from `src/client/core.ts` and receives React, the client primitives and the client services through the bundle wrapper. The section renders itself directly under the bundle's component rows by carrying `order: 1` and by installing a scoped rule that keeps `[data-plugin-source]` at `order: 2`; both are flex items of the page's section column.
- **A switch is runtime state, not configuration.** A row uses the page's component row form: artwork frame, name, id and backend plus tool count, a state dot with the localized lifecycle state, and an accessible switch at the end. The switch reads as on for `applied` and `loaded`, and as off for `disabled`, `failed` and `discovered`; an off switch is clickable to start the plugin. Switching off disposes the plugin's registrations first and then stops its backend. Switching on creates a fresh registrar and starts a fresh backend. Nothing is written to disk, so a toggle lasts only for the running dsh process and the manifest stays authoritative after a restart.
- **The switch may override startup policy.** A plugin skipped because the manifest says `enabled: false`, or left `discovered` because `autoEnable` is `false`, can still be started from the operator surfaces. A plugin must already be installed under the profile plugin roots to appear and be loadable; the operator surfaces never install a plugin.
- **The two HTTP routes are fixed and guarded.** `GET /mloader/plugins` returns `{"plugins": snapshot[]}`. `POST /mloader/plugins/toggle` takes `{"id": string, "enabled": boolean}` and returns `{"plugin": snapshot}`. Both answer with content type `application/json; charset=utf-8`. Error statuses:
  - `400` for a malformed or incomplete body,
  - `404` for an unknown plugin id,
  - `409` when enabling a WebAssembly plugin while `wasm.enabled` is not `true`,
  - `413` for a body above 64 KiB,
  - `405` for a wrong method,
  - `500` with `error` and the current `plugin` snapshot when the start fails; the record stays `failed`.
  Route failures are logged and answered from inside the route, and route registration is removed with the injected web server scope.
- **The internal service is not an external API.** `ctx.provide('mloader', ...)` is an operator surface for loader-side code, not a capability of external plugins. The structural context type does not promise `provide`, so the call is guarded.

## 6. External-plugin author constraints

- **The plugin is not a Cordis plugin.** It has no `ctx` beyond the four namespaces, no service injection and no place in plugin management. The loader hosts it and the harness never sees it, so a plugin cannot register a service, cannot inject one, cannot add a plugin entry to the host and cannot observe the loader's own lifecycle.
- **Only four capabilities exist:** tool registration, event subscription, one-way logging and cleanup registration. Slash commands are not available to external plugins, and neither is anything on the host context that the four namespaces do not expose.
- **Only the event whitelist can be subscribed.** The list is in `docs/ABI.md` §3.3. Subscribing to a name outside it fails the registration rather than registering a listener that never fires.
- **Tool parameters use the restricted JSON Schema subset.** Unsupported keywords make registration fail. The subset and its validation rules are in `docs/ABI.md` §2 and are enforced in `src/contract.ts`.
- **An event handler must return immediately and must not wait for the host.** Logging is the only host call that is safe from inside a handler. The host dispatches with a timeout, so a handler that blocks is a handler that gets cut off.
- **`stdout` belongs to the protocol.** Use `ctx.logger` or `stderr` for diagnostics. A stray write to `stdout` corrupts a frame and is read as a protocol error rather than as output.
- **Tool results must be JSON serializable.** A raised exception becomes a tool error and leaves the process alive. A result the projection cannot represent is rejected at the call, again without killing the child.
- **A WebAssembly plugin exports the five core symbols** and must not depend on host imports beyond what `docs/ABI.md` §7 declares. The WebAssembly backend stays off unless `wasm.enabled` is turned on.
- **Operator surfaces are not plugin capabilities.** The Plugins-page switches, the two HTTP routes and the `/mloader` command belong to dsh-mloader; an external plugin cannot call or rely on them. They may also change without notice, because they are not part of the ABI.
- **Plugins are independent works.** The loader license does not apply to them, and the loader places no requirement on how a plugin is licensed.

## 7. Documentation layers

See section 4 of `AGENTS.md` for the rule that governs where documentation goes. In short:

| File | Audience | Character |
|---|---|---|
| `README.md`, `README.zh.md` | users of the plugin | short, plain, task-oriented |
| `docs/` | third-party plugin authors | precise, normative, ABI-grade |
| `AGENTS.md` | AI coding agents and maintainers | rules only |
| `CONTEXT.md` | agents and maintainers | dense technical detail |
