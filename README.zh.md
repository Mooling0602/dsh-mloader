# dsh-mloader

[English](README.md) | 简体中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的多运行时插件加载器。它本身是一个普通的 Cordis 插件，用来托管用 Python 和 WebAssembly 写的插件。被托管的外部插件不是 dsh 插件：它们没有自己的 dsh 插件条目。在 web profile 下，dsh 的插件页面会在 dsh-mloader bundle 的详情页里用「外部插件」区块列出它们。名字的含义是多运行时加载器，开头的 m 也可理解为作者 GitHub 用户名的首字母。

[![dsh-badge](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
[![license-lgpl-3.0-badge](https://img.shields.io/github/license/Mooling0602/dsh-mloader?style=flat-square)](https://github.com/Mooling0602/dsh-mloader/blob/main/LICENSE)

## 安装

```bash
dsh plugin --profile web add github:Mooling0602/dsh-mloader
```

如果希望手动决定升级时机，可以锁定一个发布标签：

```bash
dsh plugin --profile web add github:Mooling0602/dsh-mloader#v0.1.0
```

安装完成后重启 dsh。加载器不需要配置，dsh 会自己把这个包加进 `dsh.profile.bundles`。包内已经带有构建好的 JavaScript，且没有运行时依赖，所以安装过程不需要编译。Python 插件需要 Python 3.10 或更高版本，并且 PATH 内需要能找到 `uv`。

默认值就是可用的。想改某一项时，在 profile 的 `cordis.patch.yml` 里用同一个 id 覆盖即可；下面「配置」一节说明每个键的作用。

卸载：

```bash
dsh plugin --profile web remove dsh-mloader
```

卸载加载器不会删掉已经装在 profile 里的插件。

## 第一次跑通

重启后，运行 dsh 的终端里会为每个生命周期事件打印一行 `[mloader]` 开头的消息。全新的 profile 还会收到随包自带的示例插件：

```sh
[mloader] seeded: hello-mloader
[mloader] mounted hello-mloader (python, tools: hello_add, hello_mloader)
[mloader] ready: 1 plugin(s) mounted
```

之后让模型调用 `hello_mloader` 或 `hello_add`，或者直接输入 `/mloader`。这个示例就是 profile 里的普通插件目录，可以修改，也可以删除。

## 插件放在哪里

每个插件放在 profile 下自己的目录里：

```plaintext
~/.dsh/profiles/<profile>/mloader/plugins/<plugin-id>/
```

插件目录里包含一个 `mloader.plugin.json` 清单文件和入口文件。dsh 运行期间把目录复制进去即可：加载器会监听插件根目录，新出现的目录自动挂载，被删除的目录自动卸载，都不用重启。改完已装插件的文件后，用 `/mloader reload <plugin-id>` 重新加载。加载器通过 dsh 定位当前 profile，所以不需要配置任何路径。Python 插件需要 Python 3.10 或更高版本。WASM 后端默认关闭，开启方法见 [CONTEXT](CONTEXT.md)。监听默认开启，关掉的方法见[配置](#配置)，关掉之后新增插件需要重启 dsh。

## Python 依赖

同一个 profile 下的所有 Python 插件共用一个虚拟环境：`~/.dsh/profiles/<profile>/mloader/.venv`。加载器通常在第一个 Python 插件启动时用 uv 创建它，之后用这个环境启动每个插件。第三方包声明在 `pyproject.toml` 的 `[project].dependencies` 中；也支持 `requirements.txt`。两个文件同时存在时，同一个包以 pyproject 为准，只有 requirements.txt 才有的条目会在安装时合并进 pyproject。只带 `requirements.txt` 的插件改用 Python 的 venv 模块和 pip 安装，并给出警告。暂不支持选择 Python 版本，也不支持按插件隔离环境，所以插件共享同一套依赖。

加载器会把 Python SDK 安装进这个环境，并提供 `dsh-mloader-sdk` 命令。激活环境后就能使用：

```sh
source ~/.dsh/profiles/<profile>/mloader/.venv/bin/activate
dsh-mloader-sdk --help
dsh-mloader-sdk install ./my-plugin.mloader.pack
```

命令会从环境路径推导 profile。完整命令参考见 [Python 包](docs/python-sdk/Package.zh.md) 第 6 节。

## 查看与切换插件

两个入口读取同一份快照：

| 谁 | 怎么用 |
| --- | --- |
| 你 | `/mloader` 命令 |
| 模型 | `mloader_status` 工具 |

`/mloader` 列出全部插件，`/mloader <plugin-id>` 查看单个插件，`/mloader load <plugin-id>`、`/mloader unload <plugin-id>` 和 `/mloader reload <plugin-id>` 在运行时切换插件。只有已经装在 profile 里的插件才能被加载。

在 web profile 下，dsh 的插件页面里 dsh-mloader bundle 的详情页有一个「外部插件」区块，每个被托管的插件对应一个开关。开关立即生效，只在当前运行的 dsh 进程里有效：它不会修改插件目录，重启后每个插件都会回到清单文件声明的状态。插件必须先装在 profile 的插件目录里才会出现在这个区块里，开关本身不会安装任何东西。

## 配置

默认值就是可用的。想改某一项时，在 profile 的 `cordis.patch.yml` 里指定 `dsh-mloader` 这个 id，然后重启 dsh：

```yaml
- id: dsh-mloader
  config:
    console: false
```

每个键都可以省略。「默认」列就是省略该键时 dsh-mloader 采用的值，所以只有你的情况和它不一样时才需要设置：

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `roots` | `[]` | 在 profile 目录之外额外扫描的插件根目录。 |
| `profilePlugins` | `true` | 是否扫描 `<profile>/mloader/plugins`。设为 `false` 时只扫描 `roots`，并且除非设置了 `profileDir`，否则不启用共享 Python 环境。 |
| `profileDir` | 自动探测 | 覆盖加载器通过 dsh 解析到的 profile 目录，不设置时自动探测。用于测试。 |
| `autoEnable` | `true` | 已安装的插件是否随 dsh 启动。`false` 时插件保持发现状态，需要手动加载。 |
| `pythonBin` | `python3` | 用来创建共享环境的基础 Python 解释器。Python 插件在该环境中运行。 |
| `enablePyc` | `false` | 是否保留 Python 写在插件旁边的字节码缓存。关闭时每次重新加载都执行磁盘上的代码，开启则是用这个保证换取更快的启动。 |
| `statusTool` | `true` | 是否为模型注册 `mloader_status` 工具。 |
| `command` | `true` | `/mloader` 命令：`true` 用默认名，字符串为自定义名，`false` 关闭。 |
| `seedExamples` | `true` | 首次启动时是否把随包的示例释放到 profile 里。 |
| `console` | `true` | 终端输出：`true` 只打印生命周期行，`'verbose'` 连扫描细节一起打印，`false` 静默。 |
| `watch` | `true` | dsh 运行期间新增或删除的插件目录是否免重启自动挂载和卸载。 |
| `wasm.enabled` | `false` | 是否启用 WebAssembly 后端。 |

每项取值的格式、字节码缓存的取舍和重启验收清单见 [CONTEXT](CONTEXT.md)。

## 文档

- [docs/ABI-unified](docs/ABI-unified.zh.md)：面向第三方插件作者的共享契约，包括清单格式、能力白名单、RPC 协议、生命周期、后端接口、安全模型和安装布局。
- [docs/python-sdk/PyABI](docs/python-sdk/PyABI.zh.md)：Python 后端契约，包括 SDK 导入方式、两种注册风格、结果 schema 推断和进程传输。
- [docs/wasm/WasmABI](docs/wasm/WasmABI.zh.md)：WebAssembly 核心 ABI，包括必需导出、声明对象和 worker 超时。
- [docs/Package](docs/Package.zh.md)：两种后端共用的归档格式与安装规则。Python 后端已经实现，WebAssembly 后端仍是目标契约。
- [docs/python-sdk/Package](docs/python-sdk/Package.zh.md)：Python 插件包布局、依赖、共享环境和命令行。
- [docs/wasm/Package](docs/wasm/Package.zh.md)：WebAssembly 插件包的目标元数据与目录布局，目标契约。
- [CONTEXT](CONTEXT.md)：面向维护者的技术细节，包括构建与产物策略、配置默认值、测试方法和重启验收清单。
- [dsh-mloader-python-sdk](https://github.com/Mooling0602/dsh-mloader-python-sdk)：Python SDK 包，是 `src/runtime/python_sdk/` 的镜像，带打包元数据和测试。

## 许可证

LGPL-3.0-only。由加载器托管的外部插件是独立作品，可以选择任何许可证。`src/runtime/python_sdk/` 下的 Python 运行时额外采用 MIT 许可证。详见 [NOTICE](NOTICE)。
