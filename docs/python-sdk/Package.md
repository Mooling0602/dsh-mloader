# dsh-mloader Python package format

English | [简体中文](Package.zh.md)

This document specifies the layout of a dsh-mloader Python plugin package. The archive container, extraction safety, install index, updates, removal, version compatibility and the shared limits are specified in [Package](../Package.md). This document adds the Python-specific layout and build rules.

Status: target contract. The loader does not install a plugin from an archive; a plugin is a directory under a plugin root. The shared archive rules and this layout are fixed before the implementation lands.

A Python package holds one manifest and the Python code that manifest names. The manifest sets `"backend": "python"` and names the entry file with `entry`. The loader extracts the archive before it loads anything, so the archive is a transport format and never the directory the plugin runs from.

## 1. Package contents

A package holds these entries at the archive root:

| Entry | Required | Meaning |
| --- | --- | --- |
| `mloader.plugin.json` | yes | The plugin manifest, specified in [ABI-unified](../ABI-unified.md) section 2.1. |
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

The entry file stays at the archive root in both layouts. Its import semantics are specified in [PyABI](PyABI.md) section 2: the directory of the entry file is on the import path, so a module directory beside the entry file is importable by its absolute name and a module directory anywhere else is not.

The entry file therefore imports the module directory by its absolute name:

```python
from dsh_mloader_sdk import plugin, tool
from plugin_id.module import add


@plugin
def apply(ctx) -> None:
    pass


@tool(
    "add",
    "Add two numbers.",
    parameters={
        "type": "object",
        "properties": {"a": {"type": "number"}, "b": {"type": "number"}},
        "required": ["a", "b"],
        "additionalProperties": False,
    },
)
def add_tool(args) -> int:
    return add(args["a"], args["b"])
```

A relative import such as `from .module import add` fails, because the entry file is not loaded as part of a package; [PyABI](PyABI.md) section 2 states why. The `@tool` decorator takes the tool name as its first positional argument and the description as its second; a call that supplies only the description fails at import time.

The module directory name must be a legal Python module name. It does not have to equal the plugin id: an id such as `my-plugin` is valid while the module directory must then be `my_plugin` or another name without a hyphen. The name the entry file imports is the name the directory carries, and the manifest does not record it.

### 1.1 What the archive root may hold

The archive root holds the manifest, the entry file and at most one module directory. It holds no second plugin: a manifest below the archive root describes nothing, so the loader does not extract the directory that contains it and reports a warning during installation.

Sub packages below the module directory are allowed. A module directory may carry `sub/__init__.py` and `sub/deep.py` like any Python package, and the entry file reaches them through the same absolute import.

A package whose root holds no `mloader.plugin.json` is invalid. The loader rejects it before it extracts anything, and an installed directory with no manifest at its root is not a plugin, so discovery skips it.

## 2. Python package archives

A Python package is a zip archive. The conventional suffixes are `.mloader.pack` and `.zip`. Unlike a WebAssembly package, a Python package may also be a `.pyz`, a zip archive that is also an executable Python application.

A `.pyz` file produced by `python3 -m zipapp` may begin with a shebang line, so the zip payload does not start at the first byte. A reader locates the payload from the end of central directory record and does not assume that the archive begins at offset 0.

The loader never executes a package file. Running a `.pyz` as an application is the responsibility of the user, and a `__main__.py` inside the archive is unrelated to the entry point the manifest names.

The archive file name carries no meaning. A Python package named `anything.mloader.pack` and a package with no suffix install the same way when their bytes are a zip archive with a valid manifest; [Package](../Package.md) section 1 states the rule.

## 3. Building a Python package

Any zip writer produces a valid package. The archive holds the entries of section 1 at its root. A conventional build from a plugin directory looks like this:

```sh
cd my-plugin
zip -r ../my-plugin.mloader.pack mloader.plugin.json entry.py plugin_id
```

- The manifest must be at the archive root. Packing the plugin directory itself, so that the archive holds `my-plugin/mloader.plugin.json`, produces an invalid package.
- Exclude `__pycache__` and `*.pyc`. They are interpreter and platform specific and the loader never needs them.
- The suffix changes nothing about the payload. `.mloader.pack`, `.zip` and `.pyz` carry the same archive.
- Repacking identical content changes the MD5, because the zip metadata changes, and the loader treats the result as a new version. Build the release archive once and distribute that file ([Package](../Package.md) section 4.2).
- A packager may include a `.mloader.index.json` with `fileMd5` to publish per file checksums ahead of installation ([Package](../Package.md) section 4.1).

## 4. Python-specific limits

- **Python 3.10 or later.** The plugin runs on the interpreter named by `pythonBin`, and the archive carries only the files the packager includes.
- **No dependency resolution.** A plugin that imports a third party package either documents that requirement or vendors the code inside its module directory. The archive cannot declare a dependency for the loader to install ([Package](../Package.md) section 6).
- **No platform targets.** `targets` is a WebAssembly package field; a Python manifest must not set it. Python code is not selected per operating system or CPU architecture by the package format.
- **Native extensions are the plugin's responsibility.** An extension module is importable only when it matches the interpreter ABI and the platform. The package format does not verify that, so a plugin that needs one documents the requirement.
- **No executable archive at install time.** A `.pyz` may be executable when the user runs it, but the loader only extracts it and never executes the archive.
