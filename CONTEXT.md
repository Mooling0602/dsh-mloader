# CONTEXT.md

Technical detail for agents and maintainers. This is the place to look for the parts of the system that are too specific, too brittle or too long to belong in `README.md`, and the place to record them.

`AGENTS.md` holds coding conventions and development rules only. `README.md` is for ordinary users and stays short. Documentation for third-party plugin authors belongs in `docs/` and stays rigorous.

This file is meant to be loaded whole by an agent that needs the working model of the system in one place. It therefore reproduces a fact that also lives in `docs/`, in `AGENTS.md` or in `README.md` whenever the second copy saves the reader another file, and it carries detail those documents leave out because their own audience does not need it. Reproduction here is deliberate and not a defect, so a change updates the copy in this file even when the authoritative statement lives elsewhere. Section 7 records which document owns which material.

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
- A change to the plugin ABI updates the owning document under `docs/` first: the shared contract in `docs/ABI-unified.md`, the Python backend contract in `docs/python-sdk/PyABI.md`, the WebAssembly contract in `docs/wasm/WasmABI.md`, the shared package rules in `docs/Package.md`, and the backend package layouts in `docs/python-sdk/Package.md` and `docs/wasm/Package.md`.

## 2. Architecture axioms

The loader reconciles two facts that do not fit together: dsh loads only Cordis plugins through `import()`, and Python or WebAssembly code cannot be a Cordis plugin. Every rule in the code and in the documentation follows from these axioms.

1. **The loader is an ordinary Cordis plugin.** dsh mounts it from the profile bundle patch. It does not change the dsh loader, the bundle mechanism or `import()`, and it replaces no existing plugin.
2. **Hosted external plugins are not Cordis plugins.** They create no Cordis plugin entity, no fiber node and no per-plugin `ctx` scope, and they never appear in a dsh plugin list. They send registration intents over a private RPC protocol; the loader performs the real registrations on its own `ctx`.
3. **The capability surface is a whitelist, not a passthrough.** Only the five operations listed in `docs/ABI-unified.md` §3 are reachable from a plugin. A new capability is added to the whitelist deliberately and never by exposing a `ctx` object.
4. **Registrations are owned and revocable.** Every registration a plugin causes is recorded in that plugin's ledger and revoked in reverse order when the plugin unloads. The loader owns the whole lifecycle of its plugins.
5. **The host main thread is never occupied by external code.** Python runs in a child process, WebAssembly runs in a worker thread, and event dispatch to a plugin is fire-and-forget while the host execution chain advances synchronously.
6. **`apply()` does not wait for plugin startup.** The loader starts plugin boot in the background and returns, and it watches its Cordis fiber to abort a startup that is still in flight when teardown begins.
7. **The ABI is versioned.** The RPC protocol has an explicit protocol version. The manifest schema is normative in `docs/ABI-unified.md`, and each backend contract is normative in its own document under `docs/`. Wire shapes change only with a protocol version bump.

The cost of axiom 2 is deliberate: an external plugin has no per-plugin `ctx` isolation, cannot use Cordis `inject` to resolve services and does not appear in plugin management. The loader may show a plugin's state on its own operator surfaces, but that does not make the plugin a dsh plugin entry. That cost is the reason the loader can host non-Cordis code at all.

## 3. Repository map

### Loader source

```plaintext
src/
  index.ts                 Cordis plugin entry and PluginManager
  contract.ts              constants: event whitelist, JSON Schema subset validator,
                           lifecycle states, profile and roots resolution
  discovery.ts             scan plugin roots for mloader.plugin.json
  registrar.ts             per-plugin registration ledger and host tool factory
  serialize.ts             projection of live host objects into transportable data
  seed.ts                  release and refresh of complete Python examples in the profile
  watch.ts                 recursive watch on the plugin roots, debounced callback
  console.ts               terminal output channel, separate from ctx.logger
  http.ts                  optional operator HTTP routes behind the web server
  config-editor.ts         profile configuration projection and revision-checked edits
  types.ts                 structural types of the host surface and plugin boundary
  python-env.ts            shared profile virtual environment bridge, calls the Python CLI
  backends/
    python.ts              Python child process and NDJSON transport
    wasm.ts                WebAssembly host side: worker lifecycle and timeouts
    wasm-worker.ts         WebAssembly instance, runs on its own thread
  client/
    core.ts                browser half: the External plugins section
  runtime/
    python_sdk/            canonical Python runtime package and packaging command line
  tools/status.ts          mloader_status tool and the shared status formatter
  tools/manage.ts          model-facing plugin detail and lifecycle tools
  commands/mloader.ts      /mloader command group and shared lifecycle operations
scripts/build-client.mjs   deterministic build of the committed client bundle
client.js                  committed generated browser bundle
locale/en.json             title and description the Plugins page renders
locale/zh.json             Simplified Chinese copy of the same two fields
tsconfig.client.json       compiler configuration for src/client
seeds/hello-mloader/       released Python example: manifest, plugin.py and built-in marker
seeds/wasm-mloader/        source-only Rust WebAssembly example and build script
test/                      standalone suites and their fixtures
docs/ABI-unified.md        shared plugin contract
docs/Package.md             shared package format and install rules, implemented for Python
docs/python-sdk/PyABI.md   Python backend contract and SDK
docs/python-sdk/Package.md Python package layout, dependencies and command line
docs/wasm/WasmABI.md       WebAssembly core ABI
docs/wasm/Package.md       WebAssembly package targets and layout
```

Each document under `docs/` has a Simplified Chinese counterpart at the same path with a `.zh.md` suffix. Each pair carries a language selector at the top that links to the other.

Top level files: `AGENTS.md` (rules), `CONTEXT.md` (this file), `README.md` and `README.zh.md` (users), `NOTICE` (copyright and license mapping), `LICENSE`, `COPYING` and `COPYING.LESSER` (license texts), `package.json` (package metadata and scripts), `pnpm-lock.yaml`, `tsconfig.json` (host compiler configuration), `tsconfig.client.json` (browser half compiler configuration), `client.js` (generated browser bundle), `locale/` (the title and description the Plugins page renders, per language), `cordis.patch.yml` (default loader configuration), `scripts/` (maintainer build scripts), `.markdownlint.json` (Markdown lint policy) and `.gitignore`. The `.build/` intermediate directory is ignored.

The test tree holds the suites directly under `test/`, the Python test plugins under `test/plugins/`, the fault injection and WebAssembly command fixtures under `test/fixtures/`, the reentrancy fixture under `test/deadlock/reentrant/` and the event projection fixture under `test/exec-payload/exec-observer/`. The source-only WebAssembly example lives under `seeds/wasm-mloader/`, not under the test tree.

`.markdownlint.json` records the line wrapping policy that section 7 of `AGENTS.md` states as a rule. It disables `MD013`, which counts the characters in a line, because a paragraph is one complete line with no width limit. It sets `siblings_only` on `MD024`, which permits two headings with the same text when they have different parents while a duplicate among siblings is still an error. Both repositories carry the same file, so a checkout lints to the same expectations as the published copy.

The Python SDK is a flat package. Its content is the directory `src/runtime/python_sdk/`: `__init__.py`, `launch.py`, `channel.py`, `context.py`, `stdio.py`, `errors.py`, `runtime.py`, `version.py`, `dependencies.py`, `environment.py`, `packaging.py`, `trash.py`, `cli.py`, `__main__.py`, `run_cli.py`, `py.typed` and `LICENSE`. There is no nested package directory inside it.

### Build and artifact policy

- The source of the loader is TypeScript under `src/`. `pnpm build` runs the host `tsc -p tsconfig.json` with `outDir` set to `src`, so each host `.ts` source emits a `.js` artifact beside it, and then runs `node scripts/build-client.mjs`, which writes the committed `client.js` bundle from `src/client/core.ts`.
- The committed `.js` files are the build output dsh loads: `package.json` points `main` and `exports["."]` at `src/index.js`, and the package ships `src/` as-is.
- The `.js` artifacts stay in the repository until release artifacts exist, because a dsh installation blocks `prepare` scripts and therefore cannot run a build step. A release that starts shipping prebuilt artifacts can drop them from git; until then, every source change includes the regenerated `.js` files.
- Never edit or document a generated `.js` file. Change the `.ts` file, run `pnpm build`, and commit the result. The WASM backend resolves the worker path from the compiled `src/backends/wasm.js` to `wasm-worker.js` beside it, so the emit layout is part of the runtime behavior.
- TypeScript and `@types/node` are development-only dependencies. There is no runtime dependency and no `prepare` script, so installing from git does not need a compiler.
- `pnpm check` runs `tsc -p tsconfig.json --noEmit` and `tsc -p tsconfig.client.json --noEmit`, so both the host and the browser half are type checked.
- The package requires Node.js 20 or later (`engines.node`). Python plugins require Python 3.10 or later. The shared Python environment requires `uv` on `PATH`; a requirements only plugin can fall back to the venv module.

### Browser half

- The browser half provides the External plugins section and the loader component configuration page on the dsh Plugins page. Its source is `src/client/core.ts`, TypeScript with no imports and no JSX. The bundle wrapper in `scripts/build-client.mjs` supplies React, the client primitives and the client services, so the module stays a single compiled file.
- The bundle requires React and `@deepseek-ai/dsh-client-ui-primitives`. Both are platform seeds of the web shell's module table, so the plugin declares no extra module edge. The section renders with the same primitives the Plugins page uses: `Switch`, `StateDot`, `PluginArtworkDefault` and `Button`.
- The section mirrors the page's component list. The head carries the title and a count line (`共 n 个`, then the states that occur), and each row carries a 40px artwork frame, the plugin name, its id and backend plus tool count, a state dot with the localized lifecycle state, and the switch at the end. Spacing, type sizes and hairlines follow the page's own section column.
- The section is the bundle's own configuration, drawn between the bundle's description and its component rows. The entry registers on the `plugins.bundle.config` slot under the key `dsh-mloader`, which is what confines it to this bundle's page, so the component takes the page's `{ view: 'page' }` owner props and carries no subject check of its own.
- `client.js` at the repository root is a committed generated artifact. Its header says the file is generated. Never edit it by hand; change `src/client/core.ts` and run `pnpm build`.
- The build is deterministic: the same source produces the same bytes, so `client.js` changes only when its source or the build script changes. The `.build/` intermediate output is ignored by git.
- `package.json` declares the bundle through `exports["./client"]` and `dsh.client` (`platform: "web"` plus the `ui-plugin-manager`, `ui-slots` and `locale` client services to inject), and `files` includes `client.js`. Only the web client module system loads the bundle; the host plugin works without it.
- The Plugins page shows the package title and description from `locale/en.json` and `locale/zh.json`, not from `package.json`'s `description`. The host reads `<name>/locale/en.json` through the package exports as the discovery entry, then resolves every other `.json` in that directory through the same exports. A package without the locale resources therefore renders no description at all, and one without the `./package.json` export loses the manifest fallback for a field no dictionary supplies. Both files carry a `meta.title` and a `meta.description`, and the host rejects the whole read when either is present but not a non-empty string. `files` ships `locale/*.json`, so a packed install carries what the exports point at.

### Python runtime package

- The Python runtime is written in Python, not TypeScript, so it lives under `src/runtime/` rather than `src/` proper. `src/runtime/` is reserved for language code that is not JavaScript or TypeScript.
- The canonical source is `src/runtime/python_sdk/`. It is a flat package with import name `dsh_mloader_sdk`, standard library only, requiring Python 3.10 or later, and additionally licensed MIT while the repository stays LGPL-3.0-only. An entry function can annotate its context parameter as `Context` for static completion; the package-level `ctx` proxy exposes the same type to static tools while retaining late-bound runtime behavior. Registration without an installed host channel raises `HostUnavailable`, and logging without a channel drops the entry.
- The loader starts a plugin with the shared profile interpreter, `<profile>/mloader/.venv/bin/python -u <repo>/src/runtime/python_sdk/launch.py <absolute plugin entry>`, with the plugin base directory as `cwd`. The Python backend derives the `launch.py` path from its own compiled location under `src/backends/`, passes the absolute `spec.entry`, and starts the child in `spec.baseDir`. When no profile is known the backend uses `pythonBin` and does no environment management. `launch.py` loads the package by path and registers it in `sys.modules`, so `from dsh_mloader_sdk import plugin` resolves to the copy shipped beside `launch.py`, never to an installed package of the same name.
- `launch.py` reconfigures the three standard streams to UTF-8 before it touches the protocol, because the backend encodes requests and decodes both output streams as UTF-8 regardless of the child environment. `stdin` decodes undecodable bytes to the replacement character, which yields a line the runtime skips, and both output streams escape a character UTF-8 cannot carry, which keeps a frame parseable. The setting survives `PYTHONIOENCODING` and an ASCII locale with the UTF-8 mode off.
- The package has no `pyproject.toml` of its own. The loader installs a copy into the profile environment through a generated wheel and writes the `dsh-mloader-sdk` console script; the separate SDK repository still owns distribution metadata. The packaging command line is standard library only and runs from the loader copy through `run_cli.py`, or from the installed copy through `dsh-mloader-sdk` and `python -m dsh_mloader_sdk`.
- `src/python-env.ts` runs the command line before each Python plugin starts: `<interpreter> -u <runtime>/run_cli.py env sync --profile <profile> --plugin <plugin-dir> --python <pythonBin> --json`, where the interpreter is the shared environment Python when it exists and `pythonBin` otherwise. The result carries the environment interpreter, the management mode (`uv`, `python-venv` or `none`), the dependency list and the warnings. The loader passes the interpreter to the backend and logs the warnings against the plugin id.
- The environment is shared by every Python plugin of a profile. `uv` creates it at `<profile>/mloader/.venv` with `uv venv --seed`; a plugin with `pyproject.toml` has its `[project].dependencies` installed with `uv pip install`. `requirements.txt` entries that pyproject does not name are added in memory for the install. A package installed by the CLI has them merged into its installed `pyproject.toml`, and the file is not extracted. A plugin with only `requirements.txt` creates the environment with `python -m venv` and installs with the venv pip, and the loader warns. `requires-python` is reported and ignored because version selection is not implemented.
- The environment is profile scoped and opt-in with the profile root: when `profilePlugins` is `false` and `profileDir` is not set, the loader uses `pythonBin` directly. This keeps the isolated suites from touching the real profile.
- The environment also holds the runtime package. `ensure_shared_venv` builds a wheel from `src/runtime/python_sdk/`, installs it with the venv pip and checks a source fingerprint carried in the wheel version, so a loader update replaces the installed copy. Activation provides the `dsh-mloader-sdk` command, which derives the profile from `<profile>/mloader/.venv`.

### Generated SDK copy

The repository `dsh-mloader-python-sdk` (distribution name `dsh-mloader-sdk`, import module `dsh_mloader_sdk`) is a generated copy of `src/runtime/python_sdk/`. A maintainer copies the file set manually from `src/runtime/python_sdk/` into the SDK repository's `src/dsh-mloader-sdk/`. The copy may lag behind this repository; the two trees must be identical when a release is prepared.

The SDK repository owns everything that is packaging rather than runtime code:

```plaintext
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

The wheel built by the SDK repository includes `py.typed` and the MIT `LICENSE` as package data. The generated copy also carries the packaging command line, so the distribution can expose `python -m dsh_mloader_sdk` after installation.

### Profile side

```plaintext
~/.dsh/profiles/<profile>/
  cordis.patch.yml         loader overrides, only when defaults are changed
  package.json             dsh.profile.bundles lists dsh-mloader
  mloader/
    .venv/                 shared Python environment and the dsh-mloader-sdk command
    plugins/               installed external plugins, discovered automatically
      <plugin-id>/         optional pyproject.toml declares its PyPI dependencies
```

The workspace holds code and the profile holds configuration and plugins. Changing the loader code never touches the profile. Installing a plugin never touches the loader package directory. The shared environment belongs to the profile and is not part of the loader package.

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

### Python plugin packages

The loader installs the Python SDK into `<profile>/mloader/.venv` and writes the `dsh-mloader-sdk` command. Activate the environment to use it:

```bash
source ~/.dsh/profiles/web/mloader/.venv/bin/activate
dsh-mloader-sdk pack ./my-plugin
dsh-mloader-sdk install ./my-plugin-0.1.0.mloader.pack
dsh-mloader-sdk remove my-plugin --yes
```

The command derives the profile from the environment path, so `--profile` is optional; it still selects another profile when supplied. The same commands are available from a checkout through `python3 src/runtime/python_sdk/run_cli.py`, and from an installed package through `<profile>/node_modules/dsh-mloader/src/runtime/python_sdk/run_cli.py`.

`install` writes the directory the loader discovers, merges requirements into pyproject, prepares the shared environment and writes `.mloader.index.json`. It never runs the plugin entry. `--force` confirms a reinstall of the same archive or of a directory whose files changed after installation. `uv` must be on `PATH`; a requirements only package may create the environment with `python -m venv` and reports a warning.

### Build

```bash
pnpm install
pnpm build        # host tsc, then the deterministic client bundle build
pnpm check        # type check the host and the browser half without emitting
```

Tests import the emitted `.js` artifacts and the committed `client.js`, so run `pnpm build` after any source change before running a suite. `scripts/python_sdk/init_env.sh` uses `uv` to create or reuse `src/runtime/python_sdk/.venv` and install `ty`, `ruff` and `docformatter`. `scripts/python_sdk/check_code.sh` checks the canonical Python SDK with those tools. The check and format scripts activate the SDK environment when present, and otherwise use tools from `PATH`. `scripts/python_sdk/format_code.sh` checks the combined docformatter and Ruff format output without modifying the source; pass `--apply` to format it in place. Both scripts resolve the repository root from their own location. The checks and formatting exclude `.venv`, and the format check does not copy it into its temporary tree.

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

| Suite | Covers | Needs `.wasm` |
| --- | --- | --- |
| `integration.mjs` | Python end to end on a real Cordis context and a real tool runtime | no |
| `edge-cases.mjs` | schema pre-validation, event whitelist, crash isolation, unload cleanup | no |
| `dual-backend.mjs` | Python and WebAssembly plugins in one loader, using the built `seeds/wasm-mloader` example | yes, otherwise skips |
| `wasm-safety.mjs` | a looping WebAssembly plugin does not block the host thread, times out into a failed record with its registrations revoked, and can be reloaded or re-enabled | yes, otherwise skips |
| `wasm-failure.mjs` | backend level failure convergence: a deadline fails every pending call, a worker exit and error are reported once, an intentional stop stays silent, and a worker death during apply fails the apply | yes, otherwise skips |
| `wasm-abi.mjs` | in-memory modules: ABI version 1 is accepted, a mismatched version and a missing version export are rejected | no |
| `wasm-reactor.mjs` | in-memory WASI reactor: `_initialize` runs before the version check, and the version check still rejects a mismatched version after initialization | no |
| `wasm-init-deadline.mjs` | in-memory module: initialization exceeding the startup timeout terminates the worker and marks the plugin failed | no |
| `waterfall.mjs` | tool execution chain is not blocked by event listeners | no |
| `reentrancy.mjs` | a real Python subprocess survives reentrant event delivery | no |
| `exec-payload.mjs` | host exec objects cross the process boundary safely; tools stay usable after a dirty payload | no |
| `command.mjs` | the `/mloader` command group on a real command runtime: list, detail, load, unload, reload, usage and reserved words | no |
| `command-plugin.mjs` | external plugin command nodes: Python registration, candidate fallback and the retreat rule, absent service degradation, the Python command deadline, WebAssembly declaration and `command.call`, failure convergence after a WebAssembly command timeout, ledger revocation and the status output | Python always; WebAssembly needs the command fixture |
| `profile-install.mjs` | profile path resolution and plugin loading, including `ctx.baseUrl` | no |
| `seed.mjs` | bundled Python example release and refresh, source-only wasm exclusion, reserved id enforcement and the built-in marker | no |
| `crash-safety.mjs` | EPIPE, orphan process and unload hang resistance | no |
| `console.mjs` | terminal output levels and write failure tolerance | no |
| `plugin-toggle.mjs` | runtime switches through the operator routes: real load and unload, manual enable of a manifest-disabled plugin, crash recovery, route removal and the non-web compatibility case | no |
| `client-bundle.mjs` | generated bundle, slot key, zh and en dictionaries, rendering states and switch requests | no |
| `hot-refresh.mjs` | mounting a plugin directory installed at runtime, unmounting a deleted one, no reload on a file edit, recovery from a directory caught mid copy, bounded retry of a broken one, disabled and `autoEnable: false` policy, missing root, `watch: false` and watcher shutdown on teardown | no |
| `fiber-status.mjs` | a sibling Cordis fiber transition leaves the hosted plugins applied and callable, and disposing the loader still removes them | no |
| `output-inference.mjs` | result schema derived from a return annotation on both registration styles, the mapping table, explicit `output` precedence, and the host default for an absent, `Any` or unresolvable annotation | no |
| `encoding.mjs` | UTF-8 standard streams survive a manifest that sets `PYTHONIOENCODING` to ASCII, for a non-ASCII value and for a non-ASCII write to the detached standard output | no |
| `bytecode.mjs` | no `__pycache__` under the default, and one under `enablePyc: true` | no |
| `package-meta.mjs` | the locale files, their `meta.title` and `meta.description`, the exports that expose them and the `files` entry that ships them | no |
| `python-package.mjs` | pack, install, requirements merge, install index, update confirmation, trash removal, the Python 3.10 TOML fallback, the requirements only venv path and unsafe archive rejection | no |
| `python-env.mjs` | shared profile environment, installed SDK console script, uv requirement, venv module fallback, and the loader starting a plugin with the shared interpreter | no |
| `config-editor.mjs` | Configuration projection, validation and revision conflicts | no |
| `manage-tools.mjs` | Model-facing management tools, configuration gating and lifecycle | no |
| `shell-path.mjs` | Child process PATH configuration | no |
| `python-runtime-state.mjs` | Python runtime behavior when the host channel is unavailable | no |
| `python-logging.mjs` | standard stream isolation: every direct output route is discarded, stdin is detached, and only `ctx.logger` reaches the loader logger, including from a cleanup | no |
| `python-sdk-scripts.mjs` | Python SDK maintenance scripts and virtual environment exclusion | no |

The suites use different assertion and test runners, so their counts are not aggregated. The WebAssembly suites skip when their compiled fixtures are absent, except `wasm-abi.mjs`, `wasm-reactor.mjs` and `wasm-init-deadline.mjs`, which build their modules in memory and always run. A skip is an environment gap, not a pass.

### WebAssembly fixtures

`.wasm` files are not committed (see `.gitignore`). Compile the three fixtures before running the suites that need them; `wasm-abi.mjs`, `wasm-reactor.mjs` and `wasm-init-deadline.mjs` build their modules in memory and need no fixture:

```bash
./seeds/wasm-mloader/build.sh
./test/fixtures/wasm-loop/build.sh
./test/fixtures/wasm-command/build.sh
```

The WebAssembly example in `dual-backend.mjs` is the compiled `seeds/wasm-mloader` example; build it with `./seeds/wasm-mloader/build.sh` (Rust `wasm32-unknown-unknown` target and a working wasm linker required). The loop fixture is a Go `wasip1` reactor built with `./test/fixtures/wasm-loop/build.sh`, which passes `-buildmode=c-shared`. The command fixture is a Go `wasip1` reactor built with `./test/fixtures/wasm-command/build.sh`; it declares two command nodes and answers `command.call`. `dual-backend.mjs`, `wasm-safety.mjs`, `wasm-failure.mjs` and the WebAssembly section of `command-plugin.mjs` skip cleanly when their binaries are missing. A skipped suite means the property it asserts is unverified in that environment, not that it passed.

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
| --- | --- | --- |
| `roots` | `[]` | Extra plugin root directories. Leave empty; the profile plugin directory is discovered automatically. |
| `profilePlugins` | `true` | Append `<profile>/mloader/plugins` to the roots. Set to `false` to use only explicit roots; the shared Python environment is then disabled unless `profileDir` is set. |
| `profileDir` | `undefined` | Override the detected profile directory. Intended for tests, never for production. |
| `autoEnable` | `true` | Start every plugin whose manifest has `enabled: true`. When `false`, plugins stay `discovered`. |
| `pythonBin` | `"python3"` | Base interpreter used to create the shared profile environment. Python plugins run with the environment interpreter; this value is not consulted again while that interpreter exists. |
| `shellPath` | `[]` | Array of literal directory paths prepended in order to the inherited PATH for Python environment setup and Python plugin processes. Paths are not expanded, so use an absolute path instead of `~`. The shared virtual environment's executable directory precedes these entries in plugin processes, and a manifest `env` PATH overrides the resulting PATH. The host process PATH is unchanged. |
| `enablePyc` | `false` | Keep the `__pycache__` directory a Python plugin writes when the interpreter loads its entry file. It is off by default, so a reload always runs the code currently on disk. Enabling it trades that guarantee for a faster start. |
| `statusTool` | `true` | Register the status and management tools for the model. |
| `command` | `true` | Register the `/mloader` command group. `false` disables it; a string sets a custom command name matching `^[a-z][a-z0-9_-]*$`. |
| `seedExamples` | `true` | Release and refresh the bundled complete Python example in the profile plugin directory on every start. Source-only examples are not released. |
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

   ```sh
   [mloader] seeded: hello-mloader
   [mloader] mounted hello-mloader (python, tools: hello_add, hello_mloader)
   [mloader] ready: 1 plugin(s) mounted
   ```

   A later start logs `[mloader] refreshed: hello-mloader` instead of `seeded` because the installed copy is replaced. No `[mloader]` line means `console` is off, or no plugin root was found. The loader warns in the latter case with `profile directory not detected; <profile>/mloader/plugins was skipped` or `no plugin roots configured`.

2. **Operator surfaces agree.** `/mloader` lists the same plugins as the `mloader_status` tool, each with backend, state, tools and events. The dsh-mloader bundle detail page on the dsh Plugins page shows the External plugins section, and a switch changes the plugin state immediately.

3. **External plugins stay invisible.** The plugin tools exist, but the hosted plugins do not appear in the dsh plugin management list and have no Cordis fiber.

4. **Deadlock regression.** The bundled example subscribes to `tools/execute` and logs from the handler. Call any tool several times: every call returns promptly. A hang here means the event dispatch or one-way logging rule was broken.

5. **One process per Python plugin, in the shared environment.** `ps -ef | grep launch.py` shows one process per applied Python plugin, owned by the dsh process, and its command line starts with `<profile>/mloader/.venv/bin/python`. The first Python plugin creates `<profile>/mloader/.venv`. A Python plugin that fails before its process starts reports the environment error in its `failed` state.

6. **Hot refresh.** Copy a plugin directory into `<profile>/mloader/plugins` while dsh runs. The terminal prints `[mloader] rescan added 1 and removed 0 plugin(s)` and the mount line for the new plugin, and its tools appear without a restart. Delete the directory again: the terminal prints `[mloader] unloaded <id>` and the tools are revoked. With `watch: false` neither line appears.

7. **Crash isolation.** Kill one plugin process. Its tools fail with a tool error, the other plugins keep working, dsh stays up, and the killed plugin reports `failed` in the status output.

8. **Rollback.** Set `disabled: true` under the `dsh-mloader` id in the profile's `cordis.patch.yml` and restart, or run `dsh plugin --profile web remove dsh-mloader`. Plugins under `<profile>/mloader/plugins` stay on disk either way.

## 5. Pitfalls the code already paid for

Each rule below has a concrete failure behind it. The rule is what must hold now; the failure explains why the rule is not optional.

### 5.1 Data crossing a process or thread boundary

- **Project host objects into pure data before they leave the host.** A `tools/*` event carries a live execution object whose `agent` field contains a reference cycle through `ctx`, fiber and scope, and whose `signal` field is a host `AbortSignal`. `JSON.stringify` throws on the cycle, and `postMessage` throws `DataCloneError` on the signal. `serialize.ts` owns the projection: cycles become `[Circular]`, functions become `[Function]`, an `AbortSignal` becomes `{ $type: 'AbortSignal', aborted, reason? }`, and depth, key count, array length and string length are capped.
- **Give the tool execution events a dedicated projection.** The first argument of `tools/execute`, `tools/pre-execute`, `tools/post-execute`, `tools/result` and `tools/change` is projected by `projectToolExecution()` into the stable shape documented in `docs/ABI-unified.md` §3.4. Do not hand the plugin the whole agent tree.
- **A serialization failure may drop one frame and nothing else.** Serialization and the stream write are separate `try` blocks. A frame that cannot be serialized is lost with a warning; it must not mark the channel broken. Only a real write failure marks the channel broken and stops further writes.
- **A request that was never written fails immediately.** `#request` resolves with a `kind: 'transport'` error when the frame could not be delivered, so the caller does not wait the full call timeout for a reply that cannot arrive.

### 5.2 Event dispatch and the execution chain

- **The waterfall listener must call `next()` synchronously and return its result.** Cordis waterfall events pass `next` as the last listener argument, and the chain stops at a listener that does not call it. The tool execution body then never runs and the tool result becomes `undefined`.
- **Plugin dispatch is fire-and-forget and never awaited by the listener.** Awaiting a plugin reply from the listener blocks the host's execution chain on the plugin. The listener starts the dispatch and continues the chain synchronously.
- **A plugin event handler must not wait for the host.** The host dispatches asynchronously and can handle inbound requests, but a blocking handler can delay later work in the plugin process. Handler work must be short and must not block.
- **Python logging is a one-way notification.** The Python runtime sends `logger.log` with `notification: true` and does not wait for a reply, so logging is safe from inside an event handler and from a cleanup during dispose. The notification does not block on a host reply.
- **A disposed or disabled plugin still advances the chain.** Its listener calls `next()` and returns the result; it just does not dispatch anything.
- **An effect registered by a plugin is anchored on the loader's context.** Unloading the loader therefore also runs that plugin's cleanup, not only unloading the plugin itself.

### 5.3 Child process edge cases

- **The child's stdin needs an `'error'` listener before the first write.** When the child exits, writing to its stdin emits an asynchronous `'error'` event, and an EventEmitter without a listener raises it as an uncaught exception that kills dsh. A synchronous `try/catch` does not catch it. The listener sets `stdinBroken` and records the failure; later writes are dropped instead of repeating the error.
- **A failed startup must reap the process it spawned.** `start()` kills the child on a boot timeout or handshake failure, and the caller's failure path calls `stop()` again. Otherwise the spawned process is orphaned: no handle owns it and unloading the loader never reaches it.
- **Attach the backend instance to the ledger before awaiting startup.** Teardown must be able to stop the instance at any moment, including while `start()` is still waiting for a slow plugin. Construct, attach, then await.
- **Kill escalation is SIGTERM, a bounded wait of 2000 ms, then SIGKILL.** The timer must not keep the Node process alive.
- **`stop()` is idempotent and has a fixed order.** It fails every pending request first, sends `dispose` with a 1000 ms deadline, ends the child's stdin, and then escalates to the kill path. Calling it twice, or calling it on a dead child, must not throw.
- **Requests and notifications are handled differently.** A notification such as `logger.log` is processed and never answered. Every request frame receives exactly one reply. A reply for an unknown id and an unrecognized frame are logged and ignored; neither may disturb the channel.
- **The plugin process standard streams are detached from the plugin.** Before the plugin module loads, the Python runtime duplicates descriptors 0, 1 and 2 into private streams and points the originals at the null device, including the `sys` streams and their `__stdin__`, `__stdout__` and `__stderr__` aliases. A plugin's `print`, `sys.stderr`, `logging`, `warnings`, `os.write` and inherited child descriptors therefore write to the null device; only `ctx.logger` reaches the loader logger. The host still logs and skips a non-protocol stdout line instead of failing the plugin, which is a defence for a process that bypasses the runtime, not a supported output route.
- **A tool call timeout does not kill the process.** The tool returns an error result and the plugin stays alive. A boot timeout is different: the plugin is killed and marked `failed`, and the other plugins are unaffected.
- **A crashed process revokes its registrations and is not restarted.** The crash handler disposes the plugin's ledger and marks it `failed`. The host and the other plugins continue. An operator can reload the plugin through the optional `mloader` service (`reload(id)`) or restart dsh; the loader never restarts it on its own.

### 5.4 Loader startup and shutdown

- **`apply()` must not await plugin boot.** Cordis waits for `apply()` to return before it runs the fiber's disposal, so a blocked boot blocks teardown for the whole startup timeout. The loader starts boot as a background task and returns, and the plugin status surfaces the progress (`loaded`, `applied`, `failed`).
- **Teardown must abort an in-flight startup.** The loader listens for a fiber state change away from active on `internal/status` and the teardown effect, and calls `abortStartup()`; that fails in-flight requests so the background boot task finishes quickly. Teardown then awaits the boot task and iterates the records again, because boot may have created a record after teardown began.
- **`internal/status` is delivered to every listener, so the fiber is compared by identity.** Cordis carries no listener filter on this event, and a sibling fiber leaving the active state would otherwise read as this loader unloading. The listener ignores an event whose `fiber` argument is not `ctx.fiber`; without that check one unrelated plugin restart calls `abortStartup()` and stops every hosted plugin while the loader stays applied.
- **The abort path must be installed before boot starts.** The `internal/status` listener and the effect that calls `abortStartup()` are registered before the boot task is created. A cleanup registered later cannot run early enough to interrupt a startup that is already waiting.
- **The active fiber state is not exported as a runtime enum.** Cordis exposes the state only as a number, so the loader compares the literal `2` and keeps that value in one named constant. Do not spell the number out at each use.
- **Unload ordering is registrations first, backend second.** Disposing the ledger is immediately visible to dsh; stopping the backend may take a moment, and a failing stop is a warning, not a failure of the unload. The backend keeps its inbound handler installed until the dispose reply, and a disposed ledger still accepts `logger.log`, so a cleanup can log while its ledger is already closed.
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
