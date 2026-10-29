# Python Package Format

This document specifies how a dsh-mloader Python plugin is packaged. It covers what a package contains, the archive formats a package may use, and how the loader installs, updates and removes one. The WebAssembly backend is out of scope: a WebAssembly plugin is a directory, not an archive.

A Python plugin package is a zip archive. The archive holds one plugin manifest and the Python code that manifest names. The loader extracts the archive before it loads anything, so the archive is a transport format and never the directory the plugin runs from. The manifest decides the entry point, which means the archive layout and the manifest cannot disagree.

## 1. Package contents

A package holds these entries at the archive root:

| Entry | Required | Meaning |
| --- | --- | --- |
| `mloader.plugin.json` | yes | The plugin manifest, specified in [`../ABI-unified.md`](../ABI-unified.md) section 2.1. |
| The entry file | yes | The file named by the manifest `entry` field. |
| One module directory | optional | The modules the entry file imports, in the multi module layout. |

The entry file carries any legal Python file name, because the manifest names it. `entry.py` is the conventional name, and `plugin.py` is accepted as well. Pick one and set `entry` to the same name: the loader resolves `entry` against the extracted plugin directory and never guesses a file name.

A package without a module directory is a single file plugin:

```plaintext
mloader.plugin.json
entry.py
```

A package with one module directory is a multi module plugin:

```plaintext
mloader.plugin.json
entry.py
plugin_id/__init__.py
plugin_id/module.py
plugin_id/utils.py
```

The entry file stays at the archive root in both layouts. The loader puts the directory of the entry file on the import path and loads that file as a top level module named `dsh_user_plugin`, so a module directory beside the entry file is importable by name and a module directory anywhere else is not.

The entry file therefore imports the module directory by its absolute name:

```python
from dsh_mloader_sdk import plugin, tool
from plugin_id.module import add


@plugin
def apply(ctx) -> None:
    pass


@tool("add", "Add two numbers.")
def add_tool(a: int, b: int) -> int:
    return add(a, b)
```

A relative import such as `from .module import add` fails with `attempted relative import with no known parent package`, because the entry file is not loaded as part of a package. The `@tool` decorator takes the tool name as its first positional argument and the description as its second; a call that supplies only the description fails at import time.

The module directory name must be a legal Python module name. It does not have to equal the plugin id: an id such as `my-plugin` is valid while the module directory must then be `my_plugin` or another name without a hyphen. The name the entry file imports is the name the directory carries, and the manifest does not record it.

### 1.1 What the archive root may hold

The archive root holds the manifest, the entry file and at most one module directory. It holds no second plugin: a manifest below the archive root describes nothing, so the loader does not extract the directory that contains it and reports a warning during installation.

Sub packages below the module directory are allowed. A module directory may carry `sub/__init__.py` and `sub/deep.py` like any Python package, and the entry file reaches them through the same absolute import.

A package whose root holds no `mloader.plugin.json` is invalid. The loader rejects it before it extracts anything, and an installed directory with no manifest at its root is not a plugin, so discovery skips it.

## 2. Package formats

A package is always a zip archive. These suffixes are supported:

| Suffix | Meaning |
| --- | --- |
| `.zip` | An ordinary zip archive. |
| `.mloader.pack` | The standard dsh-mloader package. The payload is the same zip archive under a dedicated suffix. |
| `.pyz` | A package that is also an executable Python application. |

The suffix selects no behavior inside the payload: the three formats carry the same archive and the same layout rules.

A `.pyz` file produced by `python3 -m zipapp` may begin with a shebang line, so the zip payload does not start at the first byte. A reader locates the payload from the end of central directory record and does not assume that the archive begins at offset 0.

The loader never executes a package file. Running a `.pyz` as an application is the responsibility of the user, and a `__main__.py` inside the archive is unrelated to the entry point the manifest names.

## 3. Installation, updates and removal

The contents of a package are extracted before the loader can load them. The loader never imports code from inside an archive, so an archive that is present but not installed contributes no plugin.

For a profile named `web`, a package whose manifest sets `"id": "test"` extracts to this directory:

```plaintext
~/.dsh/profiles/web/mloader/plugins/test
```

The directory name is the plugin id from the manifest, not the file name of the archive. An archive named `anything.mloader.pack` whose manifest sets `"id": "test"` installs as `test`, because the plugin id comes from the manifest and the directory name is only a convention that follows it.

The archive file stays where the user put it. The loader reads it and never modifies or moves it.

### 3.1 The install index

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

### 3.2 Updates

Installing a newer package over an existing plugin is how a plugin is updated. Before it extracts anything, the loader compares the MD5 of the new archive with `packageMd5` in the installed index.

| Case | Behavior |
| --- | --- |
| The MD5 differs | The installed plugin directory moves to the trash, and the new package extracts in its place. |
| The MD5 matches | The archive is byte identical to the installed one. The loader asks for a second confirmation before it reinstalls. |

The comparison is over the archive file as bytes, so an archive repacked from identical content carries a different MD5 whenever the zip metadata differs, which is what a rebuild does. A repacked archive is therefore treated as a new version even when the plugin source did not change.

The trash is the platform trash directory when the environment provides one. When it does not, the installed directory moves under `$TMPDIR` instead, and that location does not survive a reboot. An update replaces the previous installation, so the trash is a recovery window and not a rollback point.

When the installed index carries `fileMd5`, the loader verifies the files on disk first. A file that no longer matches was edited after installation, which means the user owns that change. The loader then names the changed files, warns, and asks for a second confirmation before it replaces the directory.

### 3.3 Removal

A plugin is removed by deleting its directory under `mloader/plugins`, or by moving it to the trash. The loader offers the same operation and asks for a second confirmation first. Removing a plugin never touches the archive it was installed from, so the same archive installs it again.

### 3.4 Extraction safety

A package is untrusted input, so the loader validates every archive entry before it writes a byte:

- An entry with an absolute path is rejected.
- An entry whose path escapes the plugin directory through `..` is rejected.
- A symbolic link entry is rejected.
- An archive that exceeds the limit on entry count or on unpacked size is rejected.

A rejected package leaves no partial plugin directory behind.

## 4. Version compatibility

`schemaVersion` versions the index format, not the plugin and not the ABI. A loader that reads an index whose `schemaVersion` is higher than the version it knows refuses to update that plugin and reports the version it found, so an older loader never overwrites an installation that a newer loader made.

The manifest schema is versioned separately. A package whose manifest violates that schema is rejected at installation, before anything is extracted.
