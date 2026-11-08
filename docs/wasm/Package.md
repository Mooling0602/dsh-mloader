# dsh-mloader WebAssembly package format

English | [简体中文](Package.zh.md)

This document specifies the layout of a dsh-mloader WebAssembly plugin package, the archive that carries one compiled WebAssembly module. The archive container, extraction safety, install index, updates, removal, version compatibility and the shared limits are specified in [Package](../Package.md). This document adds the WebAssembly-specific layout and the limits that follow from one portable artifact.

Status: the format is fixed. No installer implements it yet, so the loader still reads an installed plugin directory only. Extracting a package into a plugin root installs the plugin by hand, and the archive rules in [Package](../Package.md) describe the install, update and removal behavior an installer implements.

A WebAssembly module is portable across operating systems and CPU architectures. A package therefore carries one module and has no platform metadata, no per-host directory and no artifact selection step. The manifest names the module with `entry`, the same way a directory-installed plugin does.

## Contents

- [1. Package contents](#1-package-contents)
- [2. The portable artifact](#2-the-portable-artifact)
- [3. Building a package](#3-building-a-package)
- [4. WebAssembly-specific limits](#4-webassembly-specific-limits)

## 1. Package contents

The format defines these entries at the archive root:

| Entry | Required | Meaning |
| --- | --- | --- |
| `mloader.plugin.json` | yes | The plugin manifest, specified in [ABI-unified](../ABI-unified.md) section 2.1. |
| The entry file | yes | The WebAssembly module named by the manifest `entry` field. |
| `.mloader.index.json` | no | Optional per file checksums published by the packager, specified in [Package](../Package.md) section 4.1. |

A minimal package carries a manifest and one module:

```json
{
  "id": "plugin-id",
  "name": "Plugin",
  "version": "0.1.0",
  "backend": "wasm",
  "entry": "plugin.wasm"
}
```

```plaintext
mloader.plugin.json
plugin.wasm
```

- The manifest is at the archive root. Packing the plugin directory itself, so that the archive holds `plugin-id/mloader.plugin.json`, produces an invalid package, because a manifest below the archive root describes no plugin ([Package](../Package.md) section 2).
- The entry file is a file at the archive root. In a package, `entry` is therefore a bare file name and never a path with a separator.
- The entry file carries the `.wasm` suffix by convention. The manifest is the authority, and no part of the format guesses a file name.
- A manifest that names an entry the archive does not hold is an invalid package.
- Other files may sit beside the module, including a license or a notice. The module cannot read them, because the ABI grants no file system access ([WasmABI](WasmABI.md) section 4).

### 1.1 Manifest requirements

The manifest is the shared manifest of [ABI-unified](../ABI-unified.md) section 2.1. A package sets these fields, and the shared defaults apply to the rest:

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Plugin id. It also names the installed directory and the file name convention of section 3. |
| `backend` | yes | `"wasm"`. |
| `entry` | yes | File name of the module, relative to the archive root. |
| `version` | no | Release version. Section 3 uses it in the conventional file name; the loader treats it as informational. |

- The manifest carries no platform field and no target list. The format has nothing to select per host.
- `env` is ignored by the WebAssembly backend, and `capabilities` is declared metadata, exactly as the shared manifest table states.

## 2. The portable artifact

- The package defines one WebAssembly module, and that module runs on every supported host. There is no per-host directory and no fallback artifact.
- The module is a WebAssembly binary. It must satisfy the core ABI of [WasmABI](WasmABI.md) section 1: the `memory` export and the five functions, with `mloader_abi_version` reporting `1`. It may import the WASI preview1 functions of [WasmABI](WasmABI.md) section 4, and it imports nothing else.
- Portability is a property of the module and the host engine, not of the operating system or the CPU architecture. The same module runs on every supported host when the host engine supports the WebAssembly features the module uses and the module imports only what [WasmABI](WasmABI.md) sections 1 and 4 allow. Because the loader requires Node.js 20 or later, a module that must load on every supported host uses only the features of the minimum supported Node.js version. A module that needs a missing feature or an import outside those sections fails at instantiation and marks the plugin `failed`; the format does not fall back to another artifact.
- The archive is transport. The extracted plugin directory holds the module, and the loader resolves `entry` against that directory, exactly as for a directory-installed plugin.
- The loader does not compile or validate the module at discovery. The worker compiles, instantiates and checks it when the plugin starts, and a module that fails compilation, instantiation or the version check marks the plugin `failed` ([WasmABI](WasmABI.md) section 5).

## 3. Building a package

Any zip writer produces a valid package. A conventional build from a plugin directory looks like this:

```sh
cd my-plugin
zip -r ../plugin-id-v0.1.0.mloader.pack mloader.plugin.json plugin.wasm
```

- The manifest and the module are at the archive root. The manifest `entry` matches the file name in the archive exactly.
- The conventional file name is `<plugin-id>-v<version>.mloader.pack`. The name is a convention, the loader never parses it, and the manifest is the authority ([Package](../Package.md) section 1).
- Build the release archive once and distribute that file. Repacking identical content changes the MD5, because the zip metadata changes, and the result is treated as a new version ([Package](../Package.md) section 4.2).
- Do not include build caches, source maps, intermediate object files or a second module. The module cannot read them, and nothing in the format selects or loads another module.
- A WebAssembly package is not executable. Do not add a shebang or a `__main__.py`, and do not use the `.pyz` suffix.
- A packager may include a `.mloader.index.json` with `fileMd5` to publish per file checksums ahead of installation ([Package](../Package.md) section 4.1).

## 4. WebAssembly-specific limits

- **One artifact for every host.** A WebAssembly module is portable across operating systems and CPU architectures, so a package is never split per platform. There is no platform selection, no per-host directory and no fallback artifact.
- **No native library.** A package carries a WebAssembly module only. A native shared library such as a `.dll` or a `.so` file is not a WebAssembly module, and no backend loads one.
- **No artifact inspection at installation.** The format does not read the module to verify it. Compilation, instantiation and the ABI version check happen when the worker starts, and a mismatch marks the plugin `failed`.
- **No WASI preopens, no network and no environment.** The execution contract is in [WasmABI](WasmABI.md) section 4.
- **No executable archive.** `.pyz` is a Python convention; a WebAssembly package is always data.
- **No dependency contract.** The shared format carries no dependency declaration, and a WebAssembly package cannot add one ([Package](../Package.md) section 6).
- **The WebAssembly backend is off by default.** The operator sets `wasm.enabled` to `true` before a WebAssembly plugin starts ([CONTEXT](../../CONTEXT.md)).
