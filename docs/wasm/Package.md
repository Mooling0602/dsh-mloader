# dsh-mloader WebAssembly package format

English | [简体中文](Package.zh.md)

This document specifies the layout of a dsh-mloader WebAssembly plugin package. The archive container, extraction safety, install index, updates, removal, version compatibility and the shared limits are specified in [Package](../Package.md). This document adds the WebAssembly-specific target metadata, platform selection and directory layout.

Status: target contract. The loader does not install a plugin from an archive; a WebAssembly plugin is a directory holding its `.wasm` entry. The shared archive rules and this layout are fixed before the implementation lands.

A WebAssembly package is a zip archive. It holds one manifest at the archive root and one or more compiled WebAssembly artifacts. The artifacts are platform-specific builds, so the manifest maps the host operating system and CPU architecture to the artifact that hosts it.

## Contents

- [1. Target metadata](#1-target-metadata)
- [2. Platform selection](#2-platform-selection)
- [3. Single-architecture package](#3-single-architecture-package)
- [4. Multi-architecture package](#4-multi-architecture-package)
- [5. Building a WebAssembly package](#5-building-a-webassembly-package)
- [6. WebAssembly-specific limits](#6-webassembly-specific-limits)

## 1. Target metadata

A WebAssembly package adds a `targets` array to `mloader.plugin.json`. The top-level `entry` field is absent when `targets` is present.

```json
{
  "id": "plugin-id",
  "name": "Plugin",
  "version": "0.1.0",
  "backend": "wasm",
  "targets": [
    { "os": "windows", "arch": "x64", "compiler": "gcc", "entry": "plugin-id-windows/x64/libname.dll" },
    { "os": "linux", "arch": "x64", "entry": "plugin-id-linux/x64/libname.so" },
    { "os": "linux", "arch": "aarch64", "entry": "plugin-id-linux/aarch64/libname.so" }
  ]
}
```

| Field | Required | Type | Meaning |
| --- | --- | --- | --- |
| `targets` | yes | array | One or more targets. At least one is required. |
| `targets[].os` | yes | string | `windows`, `linux`, `darwin` or `android`. |
| `targets[].arch` | yes | string | `x64` or `aarch64`; `amd64` and `arm64` are accepted aliases. |
| `targets[].compiler` | no | string | Informational. A language or a compiler name such as `gcc` or `msvc`. It selects nothing. |
| `targets[].entry` | yes | string | Path to the artifact, relative to the archive root. |
| `version` | yes | string | Semantic version of the plugin. |

- `targets` is valid only with `"backend": "wasm"`. A Python manifest that sets it is rejected.
- A manifest with `targets` has no top-level `entry`. A manifest with both is rejected.
- The array must contain at least one target, and no two targets may normalize to the same operating system and architecture pair.
- `version` must be a valid Semantic Versioning 2.0.0 string. The general manifest default `0.0.0` is valid, but a package sets its release version.
- The `os` and `arch` values are lowercase and case-sensitive. `arch` aliases normalize to the canonical value before comparison: `amd64` becomes `x64`, and `arm64` becomes `aarch64`.
- A value outside the supported `os` or `arch` set produces a warning, not a manifest error. The target remains a legal target; section 2 states how selection treats it.
- `compiler` is informational. It has no effect on selection, and the loader does not compare it with a build tool.
- The loader does not inspect the artifact to verify the declared operating system or architecture. The metadata is the contract; an incompatible artifact fails when it is instantiated.

## 2. Platform selection

The loader selects one target for the running host:

| Host source | Canonical value |
| --- | --- |
| `process.platform` `win32` | `windows` |
| `process.platform` `linux` | `linux` |
| `process.platform` `darwin` | `darwin` |
| `process.platform` `android` | `android` |
| `process.arch` `x64` | `x64` |
| `process.arch` `arm64` | `aarch64` |

- A target is selected when its normalized `os` and `arch` equal the host values.
- When exactly one target matches, the loader uses its `entry` and ignores the other artifacts.
- When no target matches and the package has exactly one target, the loader uses that target and logs a warning. This keeps a package with an unrecognized platform value loadable, as section 1 requires.
- When no target matches and the package has two or more targets, the plugin is `disabled` with a warning that names the host values and the available targets. It is not `failed`, because the package is valid and simply does not target this host.
- When more than one target matches, the manifest is invalid, because two targets normalized to the same operating system and architecture pair.
- On Termux, Node may report `linux`. The loader treats a process that carries `TERMUX_VERSION`, or a `PREFIX` under `com.termux`, as `android`, and it prefers an `android` target over a `linux` target.
- A host value that is not in the table has no canonical value. It follows the same rule: a single-target package loads with a warning, and a multi-target package with no match is `disabled`.

## 3. Single-architecture package

A package with exactly one target is a single-architecture package. Its conventional file name is:

```plaintext
<plugin-id>-<os>-<arch>-[compiler]-v<semver>.mloader.pack
```

Examples:

```plaintext
plugin-id-linux-x64-gcc-v0.1.0.mloader.pack
plugin-id-windows-aarch64-v0.1.0.zip
```

- `<plugin-id>` is the manifest `id`, `<os>` and `<arch>` are the target values, `[compiler]` is optional, and `<semver>` is the manifest `version` prefixed with `v`.
- The file name is a convention. The loader never parses it, so any legal file name works. The manifest is the authority.
- `.mloader.pack` and `.zip` are the conventional suffixes. A WebAssembly package is never an executable application.

Root layout:

- The archive root holds `mloader.plugin.json` and the target artifact.
- The artifact is either directly at the archive root or inside one directory named exactly `<plugin-id>/`.
- At most one root directory is allowed, and its name must equal the plugin id. An additional root directory is rejected.
- Other files may sit beside the entry, including additional binary artifacts and data files. The target `entry` names the one the loader uses.
- The entry must exist and must lie inside the package root or the `<plugin-id>/` directory.

A package without a directory:

```plaintext
mloader.plugin.json
libname.wasm
```

A package with a plugin id directory:

```plaintext
mloader.plugin.json
plugin-id/libname.wasm
plugin-id/helper.wasm
```

## 4. Multi-architecture package

A package with two or more targets is a multi-architecture package. Its conventional file name omits the operating system, architecture and compiler:

```plaintext
<plugin-id>-v<semver>.mloader.pack
```

The file name is a convention; the loader never parses it. The manifest `targets` array is the authority for which artifacts exist and where they are.

Root layout:

- The archive root holds `mloader.plugin.json`.
- Each target `entry` lies under a platform directory named for its target, in one of two forms:
  - `<plugin-id>-<os>/<arch>/<file>`
  - `<plugin-id>-<os>-<arch>/<file>`
- The directory segments must equal the normalized target values. The `<os>` segment and the `<arch>` segment are compared with the target's `os` and `arch`.
- The loader strips the exact `<plugin-id>-` prefix before it parses the platform segments. A plugin id that contains hyphens therefore remains unambiguous, and the platform segments are parsed from the remainder.
- The entry file is directly inside the architecture directory. The loader rejects an entry path that adds another directory level for platform information.
- Every root directory must be a platform directory used by at least one target. An unreferenced root directory is rejected.
- A bare `<plugin-id>/` directory is not allowed in a multi-architecture package. That form belongs to the single-architecture layout.
- The two forms may be mixed across targets, for example one target under `<plugin-id>-windows/x64/` and another under `<plugin-id>-linux-x64/`.
- Compiler information is not part of a platform directory name. It would be ambiguous with the plugin id and the architecture segments, so use the optional `compiler` field or the file name instead.

A package that supports Windows and Linux, each on x64 and aarch64:

```plaintext
mloader.plugin.json
plugin-id-windows/x64/libname.dll
plugin-id-windows/aarch64/libname.dll
plugin-id-linux/x64/libname.so
plugin-id-linux/aarch64/libname.so
```

The same targets in the combined form:

```plaintext
mloader.plugin.json
plugin-id-windows-x64/libname.dll
plugin-id-windows-aarch64/libname.dll
plugin-id-linux-x64/libname.so
plugin-id-linux-aarch64/libname.so
```

Rejected layouts:

```plaintext
plugin-id-windows/windows/libname.dll      # the os directory is nested twice
plugin-id-windows/x64/x64/libname.dll      # the arch directory is nested twice
plugin-id-windows-x64/x64/libname.dll      # the combined form adds a redundant arch directory
plugin-id-windows/libname.dll              # the arch directory is missing
plugin-id/linux/x64/libname.wasm           # a bare plugin id directory is not a multi-target form
plugin-id-linux-x64/extra/libname.so       # the entry is not directly inside the arch directory
```

The loader reports the offending path and rejects the package. It does not load a partial layout.

A multi-architecture package may target one operating system with several architectures, several operating systems with one architecture, or any other combination. Each target is independent.

## 5. Building a WebAssembly package

Build one artifact per target, then zip the manifest and the platform directories.

A single-architecture package:

```sh
cd my-plugin
zip -r ../plugin-id-linux-x64-gcc-v0.1.0.mloader.pack mloader.plugin.json plugin-id/libname.wasm
```

A multi-architecture package:

```sh
cd my-plugin
zip -r ../plugin-id-v0.1.0.mloader.pack mloader.plugin.json plugin-id-windows plugin-id-linux
```

- The manifest stays at the archive root. Packing the plugin directory itself produces an invalid package.
- The target `entry` paths are relative to the archive root and must match the files in the archive exactly.
- Build the release archive once. Repacking changes the MD5 and is treated as a new version ([Package](../Package.md) section 4.2).
- Do not include build caches, source maps or debug artifacts that the plugin does not need.
- A WebAssembly package is not executable. Do not add a shebang or a `__main__.py`, and do not use the `.pyz` suffix.

## 6. WebAssembly-specific limits

- **A package declares targets.** A WebAssembly package without `targets` does not declare which artifact runs on which platform, so the loader cannot select one. A directory-installed WebAssembly plugin may keep the top-level `entry` form of the general manifest; a package uses `targets`.
- **No cross-platform fallback beyond one target.** A multi-architecture package with no matching target is `disabled`, not executed with an incompatible artifact.
- **The WebAssembly backend is off by default.** The operator sets `wasm.enabled` to `true` before a WebAssembly plugin starts ([CONTEXT](../../CONTEXT.md)).
- **No WASI preopens, no network and no environment.** The execution contract is in [WasmABI](WasmABI.md) section 4.
- **No executable archive.** `.pyz` is a Python convention; a WebAssembly package is always data.
- **No artifact inspection.** The loader does not read the WebAssembly binary to verify its target. The metadata is the contract.
