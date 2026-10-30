# dsh-mloader

English | [简体中文](README.zh.md)

Multi-runtime plugin loader for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It is one ordinary Cordis plugin that hosts plugins written in Python and WebAssembly. The hosted plugins are not dsh plugins: they have no dsh plugin entry of their own. In a web profile, the dsh Plugins page shows them in an External plugins section on the dsh-mloader bundle detail page. The name means multi-runtime loader, and the leading m also matches the author's GitHub handle initial.

[![dsh-badge](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
[![license-lgpl-3.0-badge](https://img.shields.io/github/license/Mooling0602/dsh-mloader?style=flat-square)](https://github.com/Mooling0602/dsh-mloader/blob/main/LICENSE)

## Install

```bash
dsh plugin --profile web add github:Mooling0602/dsh-mloader
```

Pin a release tag if you prefer to upgrade deliberately:

```bash
dsh plugin --profile web add github:Mooling0602/dsh-mloader#v0.1.0
```

Restart dsh after installing. The loader needs no configuration, and dsh adds the package to `dsh.profile.bundles` by itself. The package ships built JavaScript and has no runtime dependencies, so installation needs no compiler step. Python plugins need Python 3.10 or later and `uv` on `PATH`.

The defaults are already correct. To change one, override the same id in the profile's `cordis.patch.yml`; [Configuration](#configuration) below says what each key does.

To uninstall:

```bash
dsh plugin --profile web remove dsh-mloader
```

Uninstalling the loader does not delete the plugins installed under the profile.

## First success

After the restart the loader prints one `[mloader]` line per lifecycle event in the terminal that runs dsh. A fresh profile also receives the bundled example plugin:

```sh
[mloader] seeded: hello-mloader
[mloader] mounted hello-mloader (python, tools: hello_add, hello_mloader)
[mloader] ready: 1 plugin(s) mounted
```

Ask the model to call `hello_mloader` or `hello_add`, or type `/mloader`. The example is maintained by the loader: every start replaces the installed copy, and the id `hello-mloader` is reserved for it.

## Where plugins go

Each plugin lives in its own directory under the profile:

```plaintext
~/.dsh/profiles/<profile>/mloader/plugins/<plugin-id>/
```

A plugin directory contains a `mloader.plugin.json` manifest and its entry file. Copy the directory in while dsh runs: the loader watches the plugin roots, so a directory that appears is mounted and one that is deleted is unmounted, both without a restart. After editing the files of an installed plugin, run `/mloader reload <plugin-id>`. The loader finds the current profile through dsh, so no path configuration is needed. Python plugins need Python 3.10 or later. The WASM backend is disabled by default; see [CONTEXT](CONTEXT.md) to enable it. Watching is on by default; see [Configuration](#configuration) to turn it off, and a plugin added to the directory then needs a restart.

## Python dependencies

All Python plugins of a profile share one virtual environment at `~/.dsh/profiles/<profile>/mloader/.venv`. The loader normally creates it with uv on the first Python plugin and starts each plugin with that environment. Declare third party packages in `pyproject.toml` under `[project].dependencies`; a `requirements.txt` is also accepted. When both files are present, pyproject wins for a package both name, and the requirements only entries are merged into the installed pyproject. A plugin that ships only `requirements.txt` uses Python's venv module and pip instead, with a warning. Python version selection and per-plugin environments are not supported, so plugins share one dependency set.

The loader installs the Python SDK into that environment and provides the `dsh-mloader-sdk` command. Activate the environment to use it:

```sh
source ~/.dsh/profiles/<profile>/mloader/.venv/bin/activate
dsh-mloader-sdk --help
dsh-mloader-sdk install ./my-plugin.mloader.pack
```

The command derives the profile from the environment path. [Python package](docs/python-sdk/Package.md) section 6 is the full command reference.

## Inspect and switch plugins

Two surfaces read the same snapshot:

| Who | How |
| --- | --- |
| You | the `/mloader` command |
| The model | the `mloader_status` tool |

`/mloader` lists every plugin, `/mloader <plugin-id>` shows one, and `/mloader load <plugin-id>`, `/mloader unload <plugin-id>` and `/mloader reload <plugin-id>` change one at runtime. Loading only works for a plugin that is already installed under the profile.

In a web profile, the dsh-mloader bundle detail page on the dsh Plugins page has an External plugins section with one switch per hosted plugin. A switch takes effect immediately and lasts for the running dsh only: it never edits the plugin directory, and every plugin returns to the state its manifest declares after a restart. A plugin must already be installed under the profile plugin directory to appear there; the switch does not install anything.

## Configuration

The defaults are already correct. To change one, target the `dsh-mloader` id in the profile's `cordis.patch.yml` and restart dsh:

```yaml
- id: dsh-mloader
  config:
    console: false
```

Every key is optional. The default column is what dsh-mloader uses when you leave the key out, so the only reason to set one is that your situation differs from it:

| Key | Default | What it controls |
| --- | --- | --- |
| `roots` | `[]` | Extra directories to scan for plugin directories, on top of the profile one. |
| `profilePlugins` | `true` | Whether `<profile>/mloader/plugins` is scanned. `false` scans only `roots` and disables the shared Python environment unless `profileDir` is set. |
| `profileDir` | detected | Overrides the profile directory the loader resolves through dsh, which is otherwise detected. For tests. |
| `autoEnable` | `true` | Whether installed plugins start with dsh. `false` leaves them discovered until you load one. |
| `pythonBin` | `python3` | The base Python interpreter used to create the shared environment. Python plugins run in that environment. |
| `enablePyc` | `false` | Whether Python keeps the bytecode cache it writes beside a plugin. Off means a reload always runs the code on disk, so turning it on trades that for a faster start. |
| `statusTool` | `true` | Whether the `mloader_status` tool is registered for the model. |
| `command` | `true` | The `/mloader` command: `true` for the default name, a string for a custom name, `false` to disable it. |
| `seedExamples` | `true` | Whether the bundled example is released and refreshed in the profile on every start. |
| `console` | `true` | Terminal output: `true` for lifecycle lines, `'verbose'` for scan detail as well, `false` for silence. |
| `watch` | `true` | Whether plugin directories added or removed while dsh runs are mounted or unmounted without a restart. |
| `wasm.enabled` | `false` | Whether the WebAssembly backend is enabled. |

The shape of each value, the bytecode cache trade-off and the restart checklist are in [CONTEXT](CONTEXT.md).

## Documentation

- [docs/ABI-unified](docs/ABI-unified.md): the shared contract for third-party plugin authors, including the manifest schema, the capability whitelist, the RPC protocol, the lifecycle, the backend interface, the security model and the installation layout.
- [docs/python-sdk/PyABI](docs/python-sdk/PyABI.md): the Python backend contract, including the SDK import, the two registration styles, result schema inference and the process transport.
- [docs/wasm/WasmABI](docs/wasm/WasmABI.md): the WebAssembly core ABI, including the required exports, the declaration object and the worker deadlines.
- [docs/Package](docs/Package.md): the archive format and installation rules shared by both backends. The Python backend implements them; the WebAssembly backend remains a target contract.
- [docs/python-sdk/Package](docs/python-sdk/Package.md): the Python package layout, dependencies, shared environment and command line.
- [docs/wasm/Package](docs/wasm/Package.md): the WebAssembly package targets and directory layout, specified as a target contract.
- [CONTEXT](CONTEXT.md): technical detail for maintainers, including the build and artifact policy, configuration defaults, test recipes and the restart checklist.
- [dsh-mloader-python-sdk](https://github.com/Mooling0602/dsh-mloader-python-sdk): the Python SDK package, a mirror of `src/runtime/python_sdk/` with the packaging metadata and tests.

## License

LGPL-3.0-only. External plugins loaded by the loader are independent works and may use any license. The Python runtime under `src/runtime/python_sdk/` is additionally MIT licensed. See [NOTICE](NOTICE).
