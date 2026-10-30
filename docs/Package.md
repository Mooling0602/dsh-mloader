# dsh-mloader package format

English | [简体中文](Package.zh.md)

This document specifies the archive that carries an installable dsh-mloader plugin and the installation, update and removal rules that every package shares. It applies to Python packages and to WebAssembly packages. The backend-specific layout is in [python-sdk/Package](python-sdk/Package.md) and [wasm/Package](wasm/Package.md).

Status: target contract. The loader does not install a plugin from an archive; a plugin is a directory under a plugin root. This document fixes the archive and installation shape before the implementation lands, so a packager and the loader agree on one form from the start.

A package is a zip archive. It holds one plugin manifest at the archive root and the files that manifest names. The loader extracts the archive before it loads anything, so the archive is a transport format and never the directory the plugin runs from. The manifest decides the backend, the entry point and the platform targets, which means the archive layout and the manifest cannot disagree.

## Contents

- [1. Archive file name](#1-archive-file-name)
- [2. Archive root](#2-archive-root)
- [3. Extraction safety](#3-extraction-safety)
- [4. Installation, updates and removal](#4-installation-updates-and-removal)
- [5. Version compatibility](#5-version-compatibility)
- [6. Limits of the format](#6-limits-of-the-format)
- [7. Packager checklist](#7-packager-checklist)

## 1. Archive file name

The file name of a package is a convention for humans. The loader never parses it, never validates it and never derives the plugin identity, the version or the platform from it. Any legal file name works, and a package that follows no naming convention installs exactly like one that does.

The conventional suffixes are `.mloader.pack` and `.zip`. The loader identifies a package by its content, not by its suffix, so a package with another suffix, or with no suffix at all, is still a package when its bytes are a zip archive.

A WebAssembly package is never an executable application. It must not begin with a shebang line and must not contain a `__main__.py` at its root, and the loader rejects an archive that does. A Python package may be a `.pyz` ([python-sdk/Package](python-sdk/Package.md) section 2), but the loader still only extracts it and never executes it.

A file name that names a platform, a compiler or a version is informative only. The manifest is the only authority for the plugin id, the version, the backend and the platform targets.

## 2. Archive root

- The archive root holds exactly one `mloader.plugin.json`. A manifest below the root does not describe a second plugin: the loader does not extract the directory that contains it and reports a warning.
- The manifest is validated before the loader extracts anything. A package whose root has no manifest, or whose manifest violates the schema, is rejected without creating a plugin directory.
- The backend layout rules apply on top of this section. They are specified in [python-sdk/Package](python-sdk/Package.md) and [wasm/Package](wasm/Package.md).

## 3. Extraction safety

A package is untrusted input, so the loader validates every archive entry before it writes a byte:

- An entry with an absolute path is rejected.
- An entry whose path escapes the plugin directory through `..` is rejected.
- A symbolic link entry is rejected.
- An archive that exceeds the limit on entry count or on unpacked size is rejected.

A rejected package leaves no partial plugin directory behind.

## 4. Installation, updates and removal

The contents of a package are extracted before the loader can load them. The loader never imports code from inside an archive, so an archive that is present but not installed contributes no plugin.

For a profile named `web`, a package whose manifest sets `"id": "test"` extracts to this directory:

```plaintext
~/.dsh/profiles/web/mloader/plugins/test
```

The directory name is the plugin id from the manifest. The archive file name is never used, because the plugin id comes from the manifest and the directory name is only a convention that follows it.

The archive file stays where the user put it. The loader reads it and never modifies or moves it.

### 4.1 The install index

The loader writes `.mloader.index.json` into the extracted plugin directory. It records what was installed:

| Field | Type | Meaning |
| --- | --- | --- |
| `schemaVersion` | integer | Version of this index format. The current version is `1`. |
| `id` | string | Plugin id, equal to the manifest `id`. |
| `installedAt` | string | ISO 8601 timestamp of the first installation. |
| `updatedAt` | string | ISO 8601 timestamp of the most recent installation or update. |
| `packageFile` | string | File name of the archive the plugin was installed from. |
| `packageMd5` | string | Lowercase hexadecimal MD5 of the archive file. |
| `fileMd5` | object | Map from a path relative to the plugin directory to the lowercase hexadecimal MD5 of that file. |

`fileMd5` covers the files the archive provided. The index never lists itself, because it is written after the extraction finished.

A packager may ship a `.mloader.index.json` in the archive to publish per file checksums ahead of installation. Such an index may set `schemaVersion`, `id` and `fileMd5`, and must not set `installedAt`, `updatedAt`, `packageFile` or `packageMd5`, because those describe an installation that the packager did not perform. When the archive carries one, the loader keeps its `fileMd5` and fills the installation fields itself, so a field the loader owns always wins over the archived value.

### 4.2 Updates

Installing a newer package over an existing plugin is how a plugin is updated. Before it extracts anything, the loader compares the MD5 of the new archive with `packageMd5` in the installed index.

| Case | Behavior |
| --- | --- |
| The MD5 differs | The installed plugin directory moves to the trash, and the new package extracts in its place. |
| The MD5 matches | The archive is byte identical to the installed one. The loader asks for a second confirmation before it reinstalls. |

The comparison is over the archive file as bytes, so an archive repacked from identical content carries a different MD5 whenever the zip metadata differs, which is what a rebuild does. A repacked archive is therefore treated as a new version even when the plugin source did not change.

The trash is the platform trash directory when the environment provides one. When it does not, the installed directory moves under `$TMPDIR` instead, and that location does not survive a reboot. An update replaces the previous installation, so the trash is a recovery window and not a rollback point.

When the installed index carries `fileMd5`, the loader verifies the files on disk first. A file that no longer matches was edited after installation, which means the user owns that change. The loader then names the changed files, warns, and asks for a second confirmation before it replaces the directory.

### 4.3 Removal

A plugin is removed by deleting its directory under `mloader/plugins`, or by moving it to the trash. The loader offers the same operation and asks for a second confirmation first. Removing a plugin never touches the archive it was installed from, so the same archive installs it again.

## 5. Version compatibility

`schemaVersion` versions the index format, not the plugin and not the ABI. A loader that reads an index whose `schemaVersion` is higher than the version it knows refuses to update that plugin and reports the version it found, so an older loader never overwrites an installation that a newer loader made.

The manifest schema is versioned separately. A package whose manifest violates that schema is rejected at installation, before anything is extracted.

## 6. Limits of the format

- **No signature and no publisher identity.** `packageMd5` detects that the archive changed. It does not authenticate who built it, and the loader has no trust store. Install a package only from a source you trust.
- **No dependency resolution.** The archive carries only the files the packager includes. A package cannot declare a dependency for the loader to install.
- **No install hook.** Installation never executes plugin code, so a package cannot run a setup step, import a module or call a function.
- **No rollback.** An update moves the previous directory to the trash. The trash is a recovery window, not a rollback point.
- **No partial install.** A rejected package leaves no plugin directory behind.
- **One plugin per archive.** A second manifest below the archive root is not a plugin and is not extracted as one.

## 7. Packager checklist

- The manifest is at the archive root.
- The archive carries one plugin and satisfies the backend layout rules of [python-sdk/Package](python-sdk/Package.md) or [wasm/Package](wasm/Package.md).
- Build the release archive once and distribute that file. Repacking identical content changes the MD5 because the zip metadata changes, and the loader treats the result as a new version.
- A packager may include a `.mloader.index.json` with `fileMd5` to publish per file checksums ahead of installation. Section 4.1 states the fields a shipped index may set.
