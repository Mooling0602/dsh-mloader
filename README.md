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

Restart dsh after installing. The loader needs no configuration, and dsh adds the package to `dsh.profile.bundles` by itself. The package ships built JavaScript and has no runtime dependencies, so installation needs no compiler step.

The defaults are already correct. To change one, override the same id in the profile's `cordis.patch.yml`; the full key reference is in [CONTEXT.md](CONTEXT.md).

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

Ask the model to call `hello_mloader` or `hello_add`, or type `/mloader`. The example is a normal plugin directory in the profile, so you can edit it or delete it.

## Where plugins go

Each plugin lives in its own directory under the profile:

```plaintext
~/.dsh/profiles/<profile>/mloader/plugins/<plugin-id>/
```

A plugin directory contains a `mloader.plugin.json` manifest and its entry file. Copy the directory in while dsh runs: the loader watches the plugin roots, so a directory that appears is mounted and one that is deleted is unmounted, both without a restart. After editing the files of an installed plugin, run `/mloader reload <plugin-id>`. The loader finds the current profile through dsh, so no path configuration is needed. Python plugins need Python 3.10 or later. The WASM backend is disabled by default; see [CONTEXT.md](CONTEXT.md) to enable it. Watching is on by default. Set `watch: false` for the `dsh-mloader` id in the profile's `cordis.patch.yml` to turn it off, and a plugin added to the directory then needs a restart.

## Inspect and switch plugins

Two surfaces read the same snapshot:

| Who | How |
| --- | --- |
| You | the `/mloader` command |
| The model | the `mloader_status` tool |

`/mloader` lists every plugin, `/mloader <plugin-id>` shows one, and `/mloader load <plugin-id>`, `/mloader unload <plugin-id>` and `/mloader reload <plugin-id>` change one at runtime. Loading only works for a plugin that is already installed under the profile.

In a web profile, the dsh-mloader bundle detail page on the dsh Plugins page has an External plugins section with one switch per hosted plugin. A switch takes effect immediately and lasts for the running dsh only: it never edits the plugin directory, and every plugin returns to the state its manifest declares after a restart. A plugin must already be installed under the profile plugin directory to appear there; the switch does not install anything.

## Documentation

- [docs/ABI.md](docs/ABI.md): the normative contract for third-party plugin authors, including the manifest schema, the Python SDK import, the capability whitelist, the RPC protocol, the lifecycle, the backend interface and the WebAssembly ABI.
- [CONTEXT.md](CONTEXT.md): technical detail for maintainers, including the build and artifact policy, configuration defaults, test recipes and the restart checklist.
- [dsh-mloader-python-sdk](https://github.com/Mooling0602/dsh-mloader-python-sdk): the Python SDK package, a mirror of `src/runtime/python_sdk/` with the packaging metadata and tests.

## License

LGPL-3.0-only. External plugins loaded by the loader are independent works and may use any license. The Python runtime under `src/runtime/python_sdk/` is additionally MIT licensed. See [NOTICE](NOTICE).
