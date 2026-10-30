# dsh-mloader Python 包格式

[English](Package.md) | 简体中文

本文规定 dsh-mloader Python 插件包的布局。归档容器、解压安全、安装索引、更新、删除、版本兼容性和共用限制见 [Package](../Package.zh.md)。本文补充 Python 特有的布局和构建规则。

状态：目标契约。加载器目前不会从归档安装插件；插件是插件根目录下的一个目录。共享归档规则和本布局在实现落地前先固定下来。

一个 Python 包携带一份清单和清单指定的 Python 代码。清单设置 `"backend": "python"`，并用 `entry` 指定入口文件。加载器会先解压归档再加载内容，所以归档只是传输格式，永远不是插件运行的目录。

## 1. 包内容

包在归档根放这些条目：

| 条目 | 必需 | 含义 |
| --- | --- | --- |
| `mloader.plugin.json` | 是 | 插件清单，见 [ABI-unified](../ABI-unified.zh.md) 第 2.1 节。 |
| 入口文件 | 是 | 清单 `entry` 字段指定的文件。 |
| 一个模块目录 | 可选 | 入口文件导入的模块，用于多模块布局。 |

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

### 1.1 归档根可以放什么

归档根放清单、入口文件和至多一个模块目录。它不放第二个插件：归档根之下的清单什么都描述不了，所以加载器不会解压包含它的目录，并在安装时报告警告。

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

## 4. Python 特有的限制

- **Python 3.10 或更高版本。** 插件运行在 `pythonBin` 指定的解释器上，归档只携带打包者放进去的文件。
- **没有依赖解析。** 导入第三方包的插件要么在文档里声明这个要求，要么把代码放进自己的模块目录。归档不能声明一个让加载器去安装的依赖（[Package](../Package.zh.md) 第 6 节）。
- **没有平台目标。** `targets` 是 WebAssembly 包字段；Python 清单不能设置它。Python 代码不会按操作系统或 CPU 架构由包格式选择。
- **原生扩展是插件的责任。** 扩展模块只有在匹配解释器 ABI 和平台时才能导入。包格式不校验这一点，所以需要它的插件要在文档里声明要求。
- **安装时不执行归档。** `.pyz` 在用户运行时可以是可执行的，但加载器只解压它，从不执行归档。
