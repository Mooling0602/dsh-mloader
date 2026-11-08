# dsh-mloader WebAssembly 包格式

[English](Package.md) | 简体中文

本文规定 dsh-mloader WebAssembly 插件包的布局，即承载一个已编译 WebAssembly 模块的归档。归档容器、解压安全、安装索引、更新、删除、版本兼容性和共用限制见 [Package](../Package.zh.md)。本文补充 WebAssembly 特有的布局，以及单一便携产物带来的限制。

状态：格式已固定，加载器的 Node 安装器通过 `/mloader install` 命令实现它。加载器仍只读取已安装的插件目录；把包手工解压到插件根目录，仍然是一种有效的安装方式。

WebAssembly 模块可跨操作系统和 CPU 架构使用。因此一个包携带一个模块，没有平台元数据，也没有按宿主划分的目录或选择产物的步骤。清单用 `entry` 指定这个模块，与以目录安装的插件完全相同。

## 目录

- [1. 包内容](#1-包内容)
- [2. 便携产物](#2-便携产物)
- [3. 构建包](#3-构建包)
- [4. 安装包](#4-安装包)
- [5. WebAssembly 特有的限制](#5-webassembly-特有的限制)

## 1. 包内容

格式在归档根定义这些条目：

| 条目 | 必需 | 含义 |
| --- | --- | --- |
| `mloader.plugin.json` | 是 | 插件清单，见 [ABI-unified](../ABI-unified.zh.md) 第 2.1 节。 |
| 入口文件 | 是 | 清单 `entry` 字段指定的 WebAssembly 模块。 |
| `.mloader.index.json` | 否 | 打包者提前发布的逐文件校验和，见 [Package](../Package.zh.md) 第 4.1 节。 |

最小的包携带一份清单和一个模块：

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

- 清单位于归档根。把插件目录本身打包，使归档里出现 `plugin-id/mloader.plugin.json`，会得到无效的包，因为归档根之下的清单不描述任何插件（[Package](../Package.zh.md) 第 2 节）。
- 入口文件是归档根的一个文件。因此包里的 `entry` 是裸文件名，永远不是带分隔符的路径。
- 入口文件按约定使用 `.wasm` 后缀。清单是权威，格式的任何部分都不猜测文件名。
- 清单指定的入口在归档里不存在时，这个包无效。
- 模块旁边可以放其他文件，例如许可证或法务声明。模块无法读取它们，因为 ABI 不授予文件系统访问（[WasmABI](WasmABI.zh.md) 第 4 节）。

### 1.1 清单要求

清单就是 [ABI-unified](../ABI-unified.zh.md) 第 2.1 节的共享清单。包设置这些字段，其余字段使用共享默认值：

| 字段 | 必需 | 含义 |
| --- | --- | --- |
| `id` | 是 | 插件 id。它也决定安装目录名和第 3 节的约定文件名。 |
| `backend` | 是 | `"wasm"`。 |
| `entry` | 是 | 模块文件名，相对于归档根。 |
| `version` | 否 | 发布版本。第 3 节在约定文件名中使用它；加载器把它当作信息性字段。 |

- 清单没有平台字段，也没有目标列表。格式没有需要按宿主选择的东西。
- `env` 会被 WebAssembly 后端忽略，`capabilities` 是声明性元数据，与共享清单表格的说明完全相同。

## 2. 便携产物

- 包只定义一个 WebAssembly 模块，这个模块在所有受支持的宿主上运行。没有按宿主划分的目录，也没有备用产物。
- 模块是 WebAssembly 二进制。它必须满足 [WasmABI](WasmABI.zh.md) 第 1 节的核心 ABI：`memory` 导出和五个函数，且 `mloader_abi_version` 报告 `1`。它可以导入 [WasmABI](WasmABI.zh.md) 第 4 节规定的 WASI preview1 函数，不能导入其他任何内容。
- 可移植性取决于模块和宿主引擎，而不是操作系统或 CPU 架构。宿主引擎支持模块用到的 WebAssembly 特性、且模块只导入 [WasmABI](WasmABI.zh.md) 第 1 节和第 4 节允许的内容时，同一份模块才能在每个受支持的宿主上运行。加载器要求 Node.js 20 或更高版本，所以要在每个受支持宿主上加载的模块，只应使用最低支持版本提供的特性。需要缺失特性或导入上述范围之外内容的模块会在实例化时失败并把插件标记为 `failed`；格式不会回退到另一个产物。
- 归档只是传输格式。解压后的插件目录持有模块，加载器按该目录解析 `entry`，与以目录安装的插件完全相同。
- 加载器在发现阶段不编译、也不校验模块。worker 在插件启动时编译、实例化并检查它；编译、实例化或版本检查失败会把插件标记为 `failed`（[WasmABI](WasmABI.zh.md) 第 5 节）。

## 3. 构建包

任何 zip 写入器都能生成合法的包。从插件目录构建的常规做法如下：

```sh
cd my-plugin
zip -r ../plugin-id-v0.1.0.mloader.pack mloader.plugin.json plugin.wasm
```

- 清单和模块位于归档根。清单 `entry` 与归档里的文件名完全一致。
- 约定文件名是 `<plugin-id>-v<version>.mloader.pack`。文件名只是约定，加载器从不解析它，清单才是权威（[Package](../Package.zh.md) 第 1 节）。
- 发布归档只构建一次并分发这个文件。重新打包相同内容会改变 MD5，因为 zip 元数据变了，结果会被当作新版本（[Package](../Package.zh.md) 第 4.2 节）。
- 不要包含构建缓存、source map、中间目标文件或第二个模块。模块无法读取它们，格式也不会选择或加载另一个模块。
- WebAssembly 包不可执行。不要加 shebang 或 `__main__.py`，也不要使用 `.pyz` 后缀。
- 打包者可以在归档里附带带 `fileMd5` 的 `.mloader.index.json`，提前发布逐文件校验和（[Package](../Package.zh.md) 第 4.1 节）。

## 4. 安装包

dsh 运行期间，加载器的 `/mloader install` 命令可以一步安装 WebAssembly 包：

```sh
/mloader install plugin-id-v0.1.0.mloader.pack
```

命令按 [Package](../Package.zh.md) 的共用规则校验归档，把它解压到 `<profile>/mloader/plugins/<plugin-id>`，并写入安装索引。在替换相同归档或替换安装后文件被改动的目录之前，它会请求二次确认；运行 `/mloader ok`、`/mloader confirm`，或再次执行同一命令来确认。已加载的 WebAssembly 插件在更新成功后会自动重新加载。

命令按归档原样安装，从不编译或检查模块，所以无效模块在插件启动时才被发现，与以目录安装的行为一致。

## 5. WebAssembly 特有的限制

- **所有宿主共用一个产物。** WebAssembly 模块可跨操作系统和 CPU 架构使用，所以包从不按平台拆分。没有平台选择，没有按宿主划分的目录，也没有备用产物。
- **没有原生库。** 包只携带 WebAssembly 模块。`.dll` 或 `.so` 这类原生共享库不是 WebAssembly 模块，任何后端都不会加载它。
- **安装时不检查产物。** 格式不读取模块来校验它。编译、实例化和 ABI 版本检查在 worker 启动时进行，不匹配会把插件标记为 `failed`。
- **没有 WASI 预打开目录、没有网络、没有环境。** 执行契约见 [WasmABI](WasmABI.zh.md) 第 4 节。
- **没有可执行归档。** `.pyz` 是 Python 约定；WebAssembly 包永远是数据。
- **没有依赖契约。** 共享格式不携带依赖声明，WebAssembly 包也不能增加一个（[Package](../Package.zh.md) 第 6 节）。
- **WebAssembly 后端默认启用。** 操作者把 `wasm.enabled` 设为 `false` 后，WebAssembly 插件不会启动（[CONTEXT](../../CONTEXT.md)）。
