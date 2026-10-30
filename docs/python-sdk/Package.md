# dsh-mloader Python package format

English | [简体中文](Package.zh.md)

This document specifies the layout of a dsh-mloader Python plugin package. The archive container, extraction safety, install index, updates, removal, version compatibility and the shared limits are specified in [Package](../Package.md). This document adds the Python-specific layout and build rules.

Status: the Python runtime command line implements this document. The loader does not install a plugin from an archive; it reads a plugin directory under a plugin root. The command line specified in section 6 packs a directory and installs a package into the profile, so a packager and the loader agree on one form.

A Python package holds one manifest and the Python code that manifest names. The manifest sets `"backend": "python"` and names the entry file with `entry`. The loader extracts the archive before it loads anything, so the archive is a transport format and never the directory the plugin runs from.

## 1. Package contents

A package holds these entries at the archive root:

| Entry | Required | Meaning |
| --- | --- | --- |
| `mloader.plugin.json` | yes | The plugin manifest, specified in [ABI-unified](../ABI-unified.md) section 2.1. |
| The entry file | yes | The file named by the manifest `entry` field. |
| One module directory | optional | The modules the entry file imports, in the multi module layout. |
| `pyproject.toml` | optional | Third party PyPI dependencies, in the `[project]` table. Section 4 states how they are installed. |
| `requirements.txt` | optional | Additional requirements. Section 4 states how they are merged and when they are kept. |

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

A package may carry `pyproject.toml`, `requirements.txt` or both. They declare dependencies only. A pyproject file without a `[project]` table is rejected at installation, because the declaration has no defined home.

### 1.1 What the archive root may hold

The archive root holds the manifest, the entry file, at most one module directory, and the optional dependency files of section 1. It holds no second plugin: a manifest below the archive root describes nothing, so the loader does not extract the directory that contains it and reports a warning during installation.

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

The runtime command line builds the same archive, validates the layout and writes the checksum index:

```sh
python3 src/runtime/python_sdk/run_cli.py pack ./my-plugin
```

`pack` excludes `__pycache__`, `*.pyc`, `.venv` and an existing `.mloader.index.json`, and writes the index itself. A package built with another zip writer remains valid.

## 4. Dependencies

A plugin may declare third party PyPI packages in `pyproject.toml`, in `requirements.txt`, or in both. The runtime installs them into the shared profile environment of section 5; a plugin does not vendor a dependency unless it chooses to.

A plugin author should manage the source project with uv, so the dependency ranges in `pyproject.toml` match the set uv resolves.

`pyproject.toml` must carry a `[project]` table. The runtime reads `[project].dependencies`, a list of PEP 508 requirement strings. It does not read optional dependency groups, dependency groups, Poetry tables or any other declaration.

`requirements.txt` is read line by line. A line that starts with `-` is an option and is ignored. Blank lines and comments are skipped. Environment markers and extras are kept.

When a package carries both files, `pyproject.toml` wins for a package name. The names are compared after normalisation: lowercase, with runs of `.`, `_` and `-` folded to `-`. A requirement that `pyproject.toml` already names is not installed again, even when the requirements file gives a different range. The requirements only entries are appended to `[project].dependencies` in the installed `pyproject.toml`, and `requirements.txt` is not extracted. The installed directory therefore records the complete dependency set in one file, and a later reinstall can read it without the requirements file.

When a package carries only `requirements.txt`, the file is extracted and kept. Its packages are installed with the pip of the shared environment, and the runtime reports a warning because uv is the supported dependency manager. When a package carries neither file, no dependency is installed and the runtime still creates the shared environment.

`requires-python` is not supported. The runtime reports a warning and ignores it, because Python version selection is not implemented. A declaration that needs a different interpreter therefore cannot be honoured.

The dependency set of a plugin is resolved in the shared environment. Two plugins that need incompatible versions of the same package cannot both be satisfied. A package that needs an isolated environment is not supported by this format.

Installing a dependency may execute that dependency's own build backend. That is third party package code, not the plugin entry file, and it carries the same trust decision as installing the dependency directly.

## 5. The shared environment

All Python plugins of one profile run in one virtual environment:

```plaintext
~/.dsh/profiles/<profile>/mloader/.venv
```

The environment is normally created from the interpreter named by `pythonBin` with `uv venv --seed`, on the first Python plugin that starts or the first package that is installed. `uv` must be on `PATH`; a plugin with `pyproject.toml` cannot be prepared without it. The environment is reused after that, and `pythonBin` is not consulted again while the interpreter exists.

The environment is shared on purpose: the loader is installed into one profile, and the plugins of that profile share its environment. A requirements only package may create the environment with `python -m venv` instead, which section 4 describes, and the environment is then still shared.

The loader installs a copy of this runtime package into the environment and writes the `dsh-mloader-sdk` command into the environment binary directory. Activating the environment therefore provides the interpreter and the packaging command.

The loader starts the plugin with the environment interpreter and sets `VIRTUAL_ENV` and a `PATH` entry for the environment, so a subprocess the plugin starts uses the same packages. A plugin does not get its own environment.

No Python version is selected. The environment inherits the version of `pythonBin`, and a plugin cannot request a different one.

The loader calls the command line before starting each Python plugin. The first call creates the environment; a later call installs the dependency set of one plugin.

## 6. The command line

The runtime ships a command line that packs a plugin directory, installs or updates a package, removes an installed plugin, and prepares the shared environment. Activate the profile environment first:

```sh
source ~/.dsh/profiles/<profile>/mloader/.venv/bin/activate
dsh-mloader-sdk --help
dsh-mloader-sdk install ./my-plugin.mloader.pack
```

On Windows the activation script is `<profile>/mloader/.venv/Scripts/activate`. The command derives the profile from the environment path, so `--profile` is optional; an explicit value still wins.

The script is inside the loader package at `src/runtime/python_sdk/run_cli.py`. From a loader checkout:

```sh
python3 src/runtime/python_sdk/run_cli.py <command>
```

When dsh-mloader is installed in a profile, the package root is `<profile>/node_modules/dsh-mloader`. A link install points that path at the checkout. Run the same script through the installed path:

```sh
PROFILE="$HOME/.dsh/profiles/web"
CLI="$PROFILE/node_modules/dsh-mloader/src/runtime/python_sdk/run_cli.py"
python3 "$CLI" install ./my-plugin.mloader.pack --profile "$PROFILE"
```

Pass `--profile` because the command line runs outside dsh and more than one profile may exist. `python -m dsh_mloader_sdk` works when the package is installed from the SDK distribution instead.

| Command | What it does |
| --- | --- |
| `pack <plugin-dir> [-o <archive>] [--force]` | Validate the directory and write a package with a checksum index. |
| `install <archive> [--profile <dir>] [--plugins-dir <dir>] [--python <bin>] [--force]` | Extract into `<profile>/mloader/plugins/<plugin-id>`, merge requirements, prepare the environment and write the install index. |
| `remove <plugin-id> [--profile <dir>] [--plugins-dir <dir>] --yes` | Move the installed directory to the trash. |
| `env ensure [--profile <dir>] [--python <bin>]` | Create the shared environment when it is missing. |
| `env sync --profile <dir> --plugin <dir> [--python <bin>]` | Create the environment when needed and install the dependencies of one plugin. |

`install` updates an existing plugin. The old directory moves to the trash only after the new directory is complete, so a failed install leaves the previous installation in place. Without `--force`, an archive whose MD5 equals the installed one is refused, and an installed file that changed after installation blocks the update. `--force` confirms both cases. The install index is `.mloader.index.json`, specified in [Package](../Package.md) section 4.1.

`remove` and an update move the previous directory to the platform trash, or under `$TMPDIR` when the platform provides none.

The loader never runs `pack` or `install` on its own. It runs `env sync` before starting a Python plugin, and reads the plugin directories that are already installed.

## 7. Python-specific limits

- **Python 3.10 or later.** The plugin runs in the shared environment created from `pythonBin`, and the archive carries only the files the packager includes.
- **No Python version selection.** The environment inherits the interpreter named by `pythonBin`; a `requires-python` declaration is ignored with a warning.
- **One shared environment.** All Python plugins of a profile share one environment. A plugin that needs an isolated dependency set is not supported.
- **No platform targets.** `targets` is a WebAssembly package field; a Python manifest must not set it. Python code is not selected per operating system or CPU architecture by the package format.
- **Native extensions are the plugin's responsibility.** An extension module is importable only when it matches the interpreter ABI and the platform. The package format does not verify that, so a plugin that needs one documents the requirement.
- **No executable archive at install time.** A `.pyz` may be executable when the user runs it, but the installer only extracts it and never executes the archive.
