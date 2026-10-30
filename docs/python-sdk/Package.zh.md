# dsh-mloader Python 包格式

[English](Package.md) | 简体中文

本文规定 dsh-mloader Python 插件包的布局。归档容器、解压安全、安装索引、更新、删除、版本兼容性和共用限制见 [Package](../Package.zh.md)。本文补充 Python 特有的布局和构建规则。

状态：Python 运行时的命令行已经实现本文。加载器不会从归档安装插件；它读取插件根目录下的插件目录。第 6 节规定的命令行负责把目录打包成包，并把包安装进 profile，因此打包者和加载器按同一种形式对齐。

一个 Python 包携带一份清单和清单指定的 Python 代码。清单设置 `"backend": "python"`，并用 `entry` 指定入口文件。加载器会先解压归档再加载内容，所以归档只是传输格式，永远不是插件运行的目录。

## 1. 包内容

包在归档根放这些条目：

| 条目 | 必需 | 含义 |
| --- | --- | --- |
| `mloader.plugin.json` | 是 | 插件清单，见 [ABI-unified](../ABI-unified.zh.md) 第 2.1 节。 |
| 入口文件 | 是 | 清单 `entry` 字段指定的文件。 |
| 一个模块目录 | 可选 | 入口文件导入的模块，用于多模块布局。 |
| `pyproject.toml` | 可选 | 第三方 PyPI 依赖，写在 `[project]` 表里。第 4 节说明安装方式。 |
| `requirements.txt` | 可选 | 额外依赖。第 4 节说明合并方式和保留条件。 |

入口文件可以使用任何合法的 Python 文件名，因为清单会指定它。`entry.py` 是约定名，`plugin.py` 也接受。选一个并把 `entry` 设成同一个名字：加载器会把 `entry` 解析到解压后的插件目录，从不猜文件名。

没有模块目录的包是单文件插件：

```plaintext
mloader.plugin.json
entry.py
```

带一个模块目录的包是多模块插件：

```plaintext
mloader.plugin.json
entry.py
plugin_id/__init__.py
plugin_id/module.py
plugin_id/utils.py
```

两种布局下入口文件都留在归档根。导入语义见 [PyABI](PyABI.zh.md) 第 2 节：入口文件所在目录在导入路径上，所以入口旁边的模块目录可以用绝对名导入，放在别处的模块目录则不行。

因此，入口文件用绝对名导入模块目录：

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

相对导入如 `from .module import add` 会失败，因为入口文件不是作为包的一部分加载的；[PyABI](PyABI.zh.md) 第 2 节说明了原因。`@tool` 装饰器把工具名作为第一个位置参数、描述作为第二个；只给描述会在导入时失败。

模块目录名必须是合法的 Python 模块名。它不必等于插件 id：id 可以是 `my-plugin`，而模块目录必须叫 `my_plugin` 或其他不含连字符的名字。入口文件导入的名字就是目录携带的名字，清单不记录它。

包可以携带 `pyproject.toml`、`requirements.txt` 或两者。它们只声明依赖。没有 `[project]` 表的 pyproject 文件会在安装时被拒绝，因为声明没有确定的位置。

### 1.1 归档根可以放什么

归档根放清单、入口文件、至多一个模块目录，以及第 1 节的可选依赖文件。它不放第二个插件：归档根之下的清单什么都描述不了，所以加载器不会解压包含它的目录，并在安装时报告警告。

模块目录之下允许子包。模块目录可以像普通 Python 包一样带 `sub/__init__.py` 和 `sub/deep.py`，入口文件通过同样的绝对导入到达它们。

根下没有 `mloader.plugin.json` 的包无效。加载器在解压任何内容之前拒绝它，根下没有清单的已安装目录也不是插件，发现过程会跳过它。

## 2. Python 包归档

Python 包是 zip 归档。约定的后缀是 `.mloader.pack` 和 `.zip`。与 WebAssembly 包不同，Python 包还可以是 `.pyz`，即同时是可执行 Python 应用的 zip 归档。

`python3 -m zipapp` 生成的 `.pyz` 可以以 shebang 行开头，所以 zip 载荷不从第一个字节开始。读取器从中央目录结束记录定位载荷，不假设归档从偏移 0 开始。

加载器从不执行包文件。把 `.pyz` 当应用运行是用户的责任，归档里的 `__main__.py` 与清单指定的入口无关。

归档文件名不携带含义。名为 `anything.mloader.pack` 的 Python 包和没有后缀的包，只要字节是带合法清单的 zip 归档，安装方式完全相同；[Package](../Package.zh.md) 第 1 节说明了这条规则。

## 3. 构建 Python 包

任何 zip 写入器都能生成合法的包。归档在根放第 1 节的条目。从插件目录构建的常规做法如下：

```sh
cd my-plugin
zip -r ../my-plugin.mloader.pack mloader.plugin.json entry.py plugin_id
```

- 清单必须在归档根。把插件目录本身打包，使归档里出现 `my-plugin/mloader.plugin.json`，会得到无效的包。
- 排除 `__pycache__` 和 `*.pyc`。它们与解释器和平台相关，加载器从不需要它们。
- 后缀不改变载荷。`.mloader.pack`、`.zip` 和 `.pyz` 携带同一个归档。
- 重新打包相同内容会改变 MD5，因为 zip 元数据变了，加载器会把结果当作新版本。发布归档只构建一次并分发这个文件（[Package](../Package.zh.md) 第 4.2 节）。
- 打包者可以在归档里附带带 `fileMd5` 的 `.mloader.index.json`，提前发布逐文件校验和（[Package](../Package.zh.md) 第 4.1 节）。

运行时命令行构建同样的归档、校验布局并写入校验和索引：

```sh
python3 src/runtime/python_sdk/run_cli.py pack ./my-plugin
```

`pack` 排除 `__pycache__`、`*.pyc`、`.venv` 和已有的 `.mloader.index.json`，并自己写入索引。用其他 zip 写入器构建的包仍然有效。

## 4. 依赖

插件可以在 `pyproject.toml`、`requirements.txt` 或两者中声明第三方 PyPI 包。运行时把它们安装进第 5 节的共享 profile 环境；除非插件自己选择，否则不把依赖放进插件目录。

插件作者也应使用 uv 管理源码项目，使 `pyproject.toml` 里的依赖范围与 uv 解析出的集合一致。

`pyproject.toml` 必须带 `[project]` 表。运行时读取 `[project].dependencies`，即 PEP 508 需求字符串列表。它不读取可选依赖组、依赖组、Poetry 表或任何其他声明。

`requirements.txt` 按行读取。以 `-` 开头的行是选项，会被忽略。空行和注释会被跳过。环境标记和 extras 保留。

包同时携带两个文件时，同一个包名以 `pyproject.toml` 为准。包名在规范化后比较：转小写，并把连续的 `.`、`_` 和 `-` 折叠成 `-`。`pyproject.toml` 已经声明的需求不会再次安装，即使 requirements 文件给出不同的版本范围。只有 requirements.txt 才有的条目会追加到已安装 `pyproject.toml` 的 `[project].dependencies` 中，`requirements.txt` 不解压。因此已安装目录用一个文件记录完整的依赖集合，之后的重新安装不需要 requirements 文件也能读取。

包只携带 `requirements.txt` 时，该文件会解压并保留。它的包用共享环境的 pip 安装，运行时会报告警告，因为 uv 是受支持的依赖管理器。包两个文件都不携带时，不安装依赖，运行时仍会创建共享环境。

不支持 `requires-python`。运行时会报告警告并忽略它，因为 Python 版本选择尚未实现。因此需要不同解释器的声明无法被满足。

插件的依赖集合在共享环境中解析。两个插件需要同一个包的不兼容版本时无法同时满足。需要隔离环境的包不受本文格式支持。

安装依赖可能执行该依赖自己的构建后端。那是第三方包代码，不是插件入口文件；信任判断与直接安装该依赖相同。

## 5. 共享环境

同一个 profile 的所有 Python 插件运行在同一个虚拟环境中：

```plaintext
~/.dsh/profiles/<profile>/mloader/.venv
```

环境通常由 `pythonBin` 指定的解释器用 `uv venv --seed` 创建，触发时机是第一个 Python 插件启动或第一个包安装。`PATH` 内必须能找到 `uv`；带 `pyproject.toml` 的插件没有它就无法准备。之后环境会被复用，只要解释器还在，就不再参考 `pythonBin`。

环境是有意共享的：加载器安装在单个 profile 里，该 profile 的插件共享它的环境。只有 requirements.txt 的包可以用 `python -m venv` 创建环境，第 4 节说明了这一点，环境仍然是共享的。

加载器会把本运行时包的副本安装进环境，并把 `dsh-mloader-sdk` 命令写入环境的二进制目录。因此激活环境后既有解释器，也有打包命令。

加载器用环境解释器启动插件，并设置 `VIRTUAL_ENV` 和环境自己的 `PATH` 条目，所以插件启动的子进程使用同一套包。插件不会得到自己的环境。

不选择 Python 版本。环境继承 `pythonBin` 的版本，插件不能要求不同的版本。

加载器在启动每个 Python 插件前调用命令行。第一次调用创建环境；之后的调用安装单个插件的依赖集合。

## 6. 命令行

运行时提供命令行，用来打包插件目录、安装或更新包、删除已安装插件，以及准备共享环境。先激活 profile 的环境：

```sh
source ~/.dsh/profiles/<profile>/mloader/.venv/bin/activate
dsh-mloader-sdk --help
dsh-mloader-sdk install ./my-plugin.mloader.pack
```

Windows 下的激活脚本是 `<profile>/mloader/.venv/Scripts/activate`。命令会从环境路径推导 profile，所以 `--profile` 可以省略；显式传入时仍然以它为准。

脚本在加载器包内的 `src/runtime/python_sdk/run_cli.py`。在加载器仓库里这样调用：

```sh
python3 src/runtime/python_sdk/run_cli.py <command>
```

dsh-mloader 已经安装进某个 profile 时，包根目录是 `<profile>/node_modules/dsh-mloader`。link 安装会让这个路径指向源码仓库。通过已安装路径调用同一个脚本：

```sh
PROFILE="$HOME/.dsh/profiles/web"
CLI="$PROFILE/node_modules/dsh-mloader/src/runtime/python_sdk/run_cli.py"
python3 "$CLI" install ./my-plugin.mloader.pack --profile "$PROFILE"
```

命令在 dsh 之外运行，而且可能存在多个 profile，所以要通过 `--profile` 指定。如果从 SDK 发行版安装，则改用 `python -m dsh_mloader_sdk`。

| 命令 | 作用 |
| --- | --- |
| `pack <plugin-dir> [-o <archive>] [--force]` | 校验目录并写出带校验和索引的包。 |
| `install <archive> [--profile <dir>] [--plugins-dir <dir>] [--python <bin>] [--force]` | 解压到 `<profile>/mloader/plugins/<plugin-id>`，合并 requirements，准备环境并写入安装索引。 |
| `remove <plugin-id> [--profile <dir>] [--plugins-dir <dir>] --yes` | 把已安装目录移到回收站。 |
| `env ensure [--profile <dir>] [--python <bin>]` | 环境缺失时创建共享环境。 |
| `env sync --profile <dir> --plugin <dir> [--python <bin>]` | 按需创建环境并安装单个插件的依赖。 |

`install` 更新已有插件。只有新目录完整后，旧目录才会移到回收站，所以安装失败会保留上一次安装。不加 `--force` 时，MD5 与已安装包相同的归档会被拒绝，安装后被改动的文件也会阻止更新。`--force` 同时确认这两种情况。安装索引是 `.mloader.index.json`，格式见 [Package](../Package.zh.md) 第 4.1 节。

`remove` 和更新会把旧目录移到平台回收站；平台没有回收站时移到 `$TMPDIR` 下。

加载器从不自行运行 `pack` 或 `install`。它在启动 Python 插件前运行 `env sync`，并读取已经安装的插件目录。

## 7. Python 特有的限制

- **Python 3.10 或更高版本。** 插件在由 `pythonBin` 创建的共享环境中运行，归档只携带打包者放进去的文件。
- **没有 Python 版本选择。** 环境继承 `pythonBin` 指定的解释器；`requires-python` 声明会被忽略并报告警告。
- **一个共享环境。** 同一个 profile 的所有 Python 插件共用一个环境。需要隔离依赖集合的插件不受支持。
- **没有平台目标。** `targets` 是 WebAssembly 包字段；Python 清单不能设置它。Python 代码不会按操作系统或 CPU 架构由包格式选择。
- **原生扩展是插件的责任。** 扩展模块只有在匹配解释器 ABI 和平台时才能导入。包格式不校验这一点，所以需要它的插件要在文档里声明要求。
- **安装时不执行归档。** `.pyz` 在用户运行时可以是可执行的，但安装器只解压它，从不执行归档。
