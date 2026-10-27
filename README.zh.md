# dsh-mloader

[English](README.md) | 简体中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的多运行时插件加载器。
它本身是一个普通的 Cordis 插件，用来托管用 Python 和 WebAssembly 写的插件。
被托管的外部插件不是 dsh 插件：它们没有自己的 dsh 插件条目。在 web profile 下，
dsh 的插件页面会在 dsh-mloader bundle 的详情页里用「外部插件」区块列出它们。
名字的含义是多运行时加载器，开头的 m 也可理解为作者 GitHub 用户名的首字母。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
[![](https://img.shields.io/github/license/Mooling0602/dsh-mloader?style=flat-square)](https://github.com/Mooling0602/dsh-mloader/blob/main/LICENSE)

## 安装

```bash
dsh plugin --profile web add github:Mooling0602/dsh-mloader
```

如果希望手动决定升级时机，可以锁定一个发布标签：

```bash
dsh plugin --profile web add github:Mooling0602/dsh-mloader#v0.1.0
```

安装完成后重启 dsh。加载器不需要配置，dsh 会自己把这个包加进
`dsh.profile.bundles`。包内已经带有构建好的 JavaScript，且没有运行时依赖，
所以安装过程不需要编译。

默认值就是可用的。想改某一项时，在 profile 的 `cordis.patch.yml` 里用同一个 id
覆盖即可；完整的配置项说明见 [CONTEXT.md](CONTEXT.md)。

卸载：

```bash
dsh plugin --profile web remove dsh-mloader
```

卸载加载器不会删掉已经装在 profile 里的插件。

## 第一次跑通

重启后，运行 dsh 的终端里会为每个生命周期事件打印一行 `[mloader]` 开头的消息。
全新的 profile 还会收到随包自带的示例插件：

```
[mloader] seeded: hello-mloader
[mloader] mounted hello-mloader (python, tools: hello_add, hello_mloader)
[mloader] ready: 1 plugin(s) mounted
```

之后让模型调用 `hello_mloader` 或 `hello_add`，或者直接输入 `/mloader`。
这个示例就是 profile 里的普通插件目录，可以修改，也可以删除。

## 插件放在哪里

每个插件放在 profile 下自己的目录里：

```
~/.dsh/profiles/<profile>/mloader/plugins/<plugin-id>/
```

插件目录里包含一个 `mloader.plugin.json` 清单文件和入口文件。dsh 运行期间把目录复制进去即可：
加载器会监听插件根目录，新出现的目录自动挂载，被删除的目录自动卸载，都不用重启。改完已装插件的
文件后，用 `/mloader reload <plugin-id>` 重新加载。加载器通过 dsh 定位当前 profile，所以不需要
配置任何路径。Python 插件需要 Python 3.10 或更高版本。WASM 后端默认关闭，开启方法见
[CONTEXT.md](CONTEXT.md)。监听默认开启；在 profile 的 `cordis.patch.yml` 里给 `dsh-mloader`
这个 id 设置 `watch: false` 可以关掉，关掉之后新增插件需要重启 dsh。

## 查看与切换插件

两个入口读取同一份快照：

| 谁 | 怎么用 |
|---|---|
| 你 | `/mloader` 命令 |
| 模型 | `mloader_status` 工具 |

`/mloader` 列出全部插件，`/mloader <plugin-id>` 查看单个插件，
`/mloader load <plugin-id>`、`/mloader unload <plugin-id>` 和
`/mloader reload <plugin-id>` 在运行时切换插件。只有已经装在 profile 里的插件才能被加载。

在 web profile 下，dsh 的插件页面里 dsh-mloader bundle 的详情页有一个「外部插件」
区块，每个被托管的插件对应一个开关。开关立即生效，只在当前运行的 dsh 进程里有效：它不会修改插件目录，
重启后每个插件都会回到清单文件声明的状态。插件必须先装在 profile 的插件目录里才会出现在
这个区块里，开关本身不会安装任何东西。

## 文档

- [docs/ABI.md](docs/ABI.md)：面向第三方插件作者的规范契约，包括清单格式、
  Python SDK 的导入方式、能力白名单、RPC 协议、生命周期、后端接口和 WebAssembly ABI。
- [CONTEXT.md](CONTEXT.md)：面向维护者的技术细节，包括构建与产物策略、配置默认值、
  测试方法和重启验收清单。
- [dsh-mloader-python-sdk](https://github.com/Mooling0602/dsh-mloader-python-sdk)：
  Python SDK 包，是 `src/runtime/python_sdk/` 的镜像，带打包元数据和测试。

## 许可证

LGPL-3.0-only。由加载器托管的外部插件是独立作品，可以选择任何许可证。
`src/runtime/python_sdk/` 下的 Python 运行时额外采用 MIT 许可证。详见 [NOTICE](NOTICE)。
