# dsh-mloader WebAssembly 包格式

[English](Package.md) | 简体中文

本文规定 dsh-mloader WebAssembly 插件包的布局。归档容器、解压安全、安装索引、更新、删除、版本兼容性和共用限制见 [Package](../Package.zh.md)。本文补充 WebAssembly 特有的目标元数据、平台选择和目录布局。

状态：目标契约。加载器目前不会从归档安装插件；WebAssembly 插件是携带 `.wasm` 入口的目录。共享归档规则和本布局在实现落地前先固定下来。

WebAssembly 包是 zip 归档。它在归档根放一份清单和一个或多个编译好的 WebAssembly 产物。产物是按平台构建的，所以清单把宿主的操作系统和 CPU 架构映射到对应的产物。

## 目录

- [1. 目标元数据](#1-目标元数据)
- [2. 平台选择](#2-平台选择)
- [3. 单架构包](#3-单架构包)
- [4. 多架构包](#4-多架构包)
- [5. 构建 WebAssembly 包](#5-构建-webassembly-包)
- [6. WebAssembly 特有的限制](#6-webassembly-特有的限制)

## 1. 目标元数据

WebAssembly 包在 `mloader.plugin.json` 里增加一个 `targets` 数组。存在 `targets` 时没有顶层 `entry` 字段。

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

| 字段 | 必需 | 类型 | 含义 |
| --- | --- | --- | --- |
| `targets` | 是 | 数组 | 一个或多个目标。至少需要一个。 |
| `targets[].os` | 是 | 字符串 | `windows`、`linux`、`darwin` 或 `android`。 |
| `targets[].arch` | 是 | 字符串 | `x64` 或 `aarch64`；接受 `amd64` 和 `arm64` 别名。 |
| `targets[].compiler` | 否 | 字符串 | 仅作信息。语言或编译器名，如 `gcc` 或 `msvc`。不参与选择。 |
| `targets[].entry` | 是 | 字符串 | 产物路径，相对于归档根。 |
| `version` | 是 | 字符串 | 插件的语义化版本。 |

- `targets` 只对 `"backend": "wasm"` 有效。设置它的 Python 清单会被拒绝。
- 带 `targets` 的清单没有顶层 `entry`。两者同时出现会被拒绝。
- 数组至少包含一个目标，且没有两个目标规范化后得到相同的操作系统和架构对。
- `version` 必须是合法的 Semantic Versioning 2.0.0 字符串。一般清单的默认值 `0.0.0` 合法，但包应设置自己的发布版本。
- `os` 和 `arch` 值是小写且区分大小写。比较前会规范化 `arch` 别名：`amd64` 变成 `x64`，`arm64` 变成 `aarch64`。
- 不在受支持 `os` 或 `arch` 集合里的值只会产生警告，不是清单错误。该目标仍是合法目标；第 2 节说明选择时如何处理它。
- `compiler` 仅作信息。它不影响选择，加载器也不会把它和构建工具比较。
- 加载器不检查产物来核实声明的操作系统或架构。元数据就是契约；不兼容的产物会在实例化时失败。

## 2. 平台选择

加载器为当前宿主选择一个目标：

| 宿主来源 | 规范值 |
| --- | --- |
| `process.platform` `win32` | `windows` |
| `process.platform` `linux` | `linux` |
| `process.platform` `darwin` | `darwin` |
| `process.platform` `android` | `android` |
| `process.arch` `x64` | `x64` |
| `process.arch` `arm64` | `aarch64` |

- 目标的规范化 `os` 和 `arch` 等于宿主值时，该目标被选中。
- 恰好一个目标匹配时，加载器使用它的 `entry`，忽略其他产物。
- 没有目标匹配且包只有一个目标时，加载器使用该目标并记录警告。这让平台值未被识别的包仍可加载，符合第 1 节的要求。
- 没有目标匹配且包有两个或更多目标时，插件处于 `disabled`，并记录一条警告，列出宿主值和可用目标。它不是 `failed`，因为包是合法的，只是不面向这个宿主。
- 多于一个目标匹配时，清单无效，因为两个目标规范化到了相同的操作系统和架构对。
- 在 Termux 上，Node 可能报告 `linux`。加载器把带有 `TERMUX_VERSION`，或 `PREFIX` 位于 `com.termux` 之下的进程视为 `android`，并优先选择 `android` 目标而不是 `linux` 目标。
- 表中没有的宿主值没有规范值。它遵循同样的规则：单目标包加载并警告，多目标包无匹配时 `disabled`。

## 3. 单架构包

恰好一个目标的包是单架构包。它的约定文件名是：

```plaintext
<plugin-id>-<os>-<arch>-[compiler]-v<semver>.mloader.pack
```

示例：

```plaintext
plugin-id-linux-x64-gcc-v0.1.0.mloader.pack
plugin-id-windows-aarch64-v0.1.0.zip
```

- `<plugin-id>` 是清单 `id`，`<os>` 和 `<arch>` 是目标值，`[compiler]` 可选，`<semver>` 是清单 `version` 加上 `v` 前缀。
- 文件名只是约定。加载器从不解析它，所以任何合法文件名都可以。清单才是权威。
- `.mloader.pack` 和 `.zip` 是约定后缀。WebAssembly 包永远不是可执行程序。

根布局：

- 归档根放 `mloader.plugin.json` 和目标产物。
- 产物可以直接在归档根，也可以在恰好名为 `<plugin-id>/` 的一个目录里。
- 最多允许一个根目录，名字必须等于插件 id。额外的根目录会被拒绝。
- 入口旁边可以放其他文件，包括额外二进制产物和数据文件。目标 `entry` 指定加载器使用哪一个。
- 入口必须存在，并且位于包根或 `<plugin-id>/` 目录之内。

没有目录的包：

```plaintext
mloader.plugin.json
libname.wasm
```

带插件 id 目录的包：

```plaintext
mloader.plugin.json
plugin-id/libname.wasm
plugin-id/helper.wasm
```

## 4. 多架构包

两个或更多目标的包是多架构包。它的约定文件名省略操作系统、架构和编译器：

```plaintext
<plugin-id>-v<semver>.mloader.pack
```

文件名只是约定；加载器从不解析它。清单 `targets` 数组才是哪些产物存在、放在哪里的权威。

根布局：

- 归档根放 `mloader.plugin.json`。
- 每个目标 `entry` 位于以该目标命名的平台目录之下，采用两种形式之一：
  - `<plugin-id>-<os>/<arch>/<file>`
  - `<plugin-id>-<os>-<arch>/<file>`
- 目录段必须等于规范化后的目标值。`<os>` 段和 `<arch>` 段会与目标的 `os` 和 `arch` 比较。
- 加载器先剥离精确的 `<plugin-id>-` 前缀，再解析平台段。因此含连字符的插件 id 不会产生歧义，平台段从剩余部分解析。
- 入口文件直接在架构目录里。加载器会拒绝再为平台信息增加一层目录的入口路径。
- 每个根目录都必须是被至少一个目标使用的平台目录。未被引用的根目录会被拒绝。
- 多架构包不允许裸 `<plugin-id>/` 目录。那种形式属于单架构布局。
- 两种形式可以跨目标混用，例如一个目标在 `<plugin-id>-windows/x64/` 下，另一个在 `<plugin-id>-linux-x64/` 下。
- 编译器信息不放进平台目录名。它会与插件 id 和架构段产生歧义，所以请使用可选的 `compiler` 字段或文件名。

支持 Windows 和 Linux、每个系统都有 x64 和 aarch64 的包：

```plaintext
mloader.plugin.json
plugin-id-windows/x64/libname.dll
plugin-id-windows/aarch64/libname.dll
plugin-id-linux/x64/libname.so
plugin-id-linux/aarch64/libname.so
```

相同的目标写成组合形式：

```plaintext
mloader.plugin.json
plugin-id-windows-x64/libname.dll
plugin-id-windows-aarch64/libname.dll
plugin-id-linux-x64/libname.so
plugin-id-linux-aarch64/libname.so
```

被拒绝的布局：

```plaintext
plugin-id-windows/windows/libname.dll      # os 目录嵌套了两层
plugin-id-windows/x64/x64/libname.dll      # arch 目录嵌套了两层
plugin-id-windows-x64/x64/libname.dll      # 组合形式又加了一层多余的 arch 目录
plugin-id-windows/libname.dll              # 缺少 arch 目录
plugin-id/linux/x64/libname.wasm           # 裸插件 id 目录不是多目标形式
plugin-id-linux-x64/extra/libname.so       # 入口不在架构目录的直接下层
```

加载器报告出问题的路径并拒绝这个包。它不会加载不完整的布局。

多架构包可以面向一个操作系统的多个架构、多个操作系统的一个架构，或任何其他组合。每个目标彼此独立。

## 5. 构建 WebAssembly 包

为每个目标构建一个产物，然后把清单和平台目录一起打包。

单架构包：

```sh
cd my-plugin
zip -r ../plugin-id-linux-x64-gcc-v0.1.0.mloader.pack mloader.plugin.json plugin-id/libname.wasm
```

多架构包：

```sh
cd my-plugin
zip -r ../plugin-id-v0.1.0.mloader.pack mloader.plugin.json plugin-id-windows plugin-id-linux
```

- 清单留在归档根。把插件目录本身打包会得到无效的包。
- 目标 `entry` 路径相对于归档根，必须与归档里的文件完全一致。
- 发布归档只构建一次。重新打包会改变 MD5，并被当作新版本（[Package](../Package.zh.md) 第 4.2 节）。
- 不要包含构建缓存、source map 或插件不需要的调试产物。
- WebAssembly 包不可执行。不要加 shebang 或 `__main__.py`，也不要使用 `.pyz` 后缀。

## 6. WebAssembly 特有的限制

- **包必须声明目标。** 没有 `targets` 的 WebAssembly 包没有声明哪个产物在哪个平台运行，加载器无法选择。以目录安装的 WebAssembly 插件可以继续使用一般清单的顶层 `entry` 形式；包使用 `targets`。
- **超过一个目标时没有跨平台回退。** 多架构包没有匹配目标时处于 `disabled`，不会用不兼容的产物执行。
- **WebAssembly 后端默认关闭。** 操作者要在 WebAssembly 插件启动前把 `wasm.enabled` 设为 `true`（[CONTEXT](../../CONTEXT.md)）。
- **没有 WASI 预打开目录、没有网络、没有环境。** 执行契约见 [WasmABI](WasmABI.zh.md) 第 4 节。
- **没有可执行归档。** `.pyz` 是 Python 约定；WebAssembly 包永远是数据。
- **不检查产物。** 加载器不读取 WebAssembly 二进制来核实它的目标。元数据就是契约。
