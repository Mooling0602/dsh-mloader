# dsh-mloader WebAssembly 核心 ABI v1

[English](WasmABI.md) | 简体中文

本文是 WebAssembly 插件及托管它的 worker 的规范契约。共享契约见 [ABI-unified](../ABI-unified.zh.md)：清单 schema、发现、能力白名单、操作载荷、生命周期、安全模型和安装布局。本文规定 WebAssembly 特有的部分。

协议版本是 1。修改导出、请求或结果的形状，或修改声明对象，都是契约变更。

## 目录

- [1. 必需导出](#1-必需导出)
- [2. 请求与结果约定](#2-请求与结果约定)
- [3. 声明](#3-声明)
- [4. WASI 模块](#4-wasi-模块)
- [5. worker 隔离与截止时间](#5-worker-隔离与截止时间)
- [6. 后端不支持的内容](#6-后端不支持的内容)

## 1. 必需导出

核心 ABI 只依赖 WebAssembly 核心规范。插件要工作并不需要 WASI。

| 导出 | 签名 | 用途 |
| --- | --- | --- |
| `memory` | memory | 用于请求和结果缓冲区的线性内存。 |
| `mloader_alloc` | `(len: i32) -> i32` | 分配缓冲区并返回指针。 |
| `mloader_free` | `(ptr: i32, len: i32) -> void` | 释放缓冲区。 |
| `mloader_call` | `(ptr: i32, len: i32) -> i32` | 处理一个请求并返回结果字节长度。 |
| `mloader_result_ptr` | `() -> i32` | 返回结果缓冲区的指针。 |
| `mloader_abi_version` | `() -> i32` | 报告本模块实现的核心 ABI 版本。 |

模块必须报告 `1`，即本宿主实现的核心 ABI 版本。缺少任何一个导出、报告非整数版本或报告其他值的模块都无法初始化，插件会被标记为 `failed`。清单没有 ABI 版本字段，导出是权威值。

WASI reactor 模块还会导出 `_initialize`，worker 会在版本检查之前调用它。第 4 节规定它何时运行。它不属于六个核心导出。

实现这些导出的只含源码的 Rust 示例位于 dsh-mloader 仓库的 `seeds/wasm-mloader/`。加载器不会安装它，使用前需要自行构建。

清单的 `entry` 字段指定 `.wasm` 文件，按清单目录解析。通过 `targets` 选择产物是尚未实现的包格式目标契约；[Package](Package.zh.md) 第 1 节规定了该字段。worker 读取这个文件、编译并实例化它。

## 2. 请求与结果约定

- 请求是 UTF-8 JSON 对象 `{"op": "...", "payload": {...}}`。宿主用 `mloader_alloc` 分配 `len` 字节，写入请求，然后调用 `mloader_call`。
- 插件把回复写成 UTF-8 JSON 文本放进结果缓冲区，并从 `mloader_call` 返回字节长度。宿主从 `mloader_result_ptr()` 读取结果。
- 插件必须写 `{"ok": true, "result": ...}` 或 `{"ok": false, "error": {"message": "..."}}` 之一。`ok` 为 `false` 的回复会让调用失败，不是合法 JSON 的回复也会让调用失败。
- 宿主在 `mloader_call` 返回后对请求缓冲区调用 `mloader_free(ptr, len)`。结果缓冲区归插件所有，必须保持有效直到下一个请求。
- 回复里的 JSON 无效会让调用失败，不会让宿主崩溃。

操作和载荷形状是 [ABI-unified](../ABI-unified.zh.md) 第 4.2 节规定的共享形状。WebAssembly 后端使用其中三个：

| 操作 | 载荷 | 回复 `result` |
| --- | --- | --- |
| `apply` | `inject` | 第 3 节的声明对象。 |
| `tool.call` | `tool`, `args` | 处理器返回的 JSON 值。 |
| `event` | `event`, 投影后的 `args` 数组 | 处理器返回值。 |

没有 `boot` 请求。初始化是第 5 节的 worker 握手。没有 `dispose` 请求。停止插件会终止 worker。

## 3. 声明

`apply` 回复在它的 `result` 对象里声明插件能力：

```json
{"ok": true, "result": {"tools": [], "events": []}}
```

- `tools` 的每一项是 [ABI-unified](../ABI-unified.zh.md) 第 3.2 节规定的工具对象。`events` 的每个名字必须在第 3.3 节的白名单里。
- 加载器在自己的上下文上执行真正的注册，并记录到插件的账本。
- 加载器拒绝的声明会让 apply 握手失败，插件被标记为 `failed`。
- 后端没有入站请求通道。模块不能发送 `tools.register`、`events.on`、`logger.log` 或 `effect.register`，核心 ABI 也没有提供让它主动发起消息的途径。
- 没有日志通道，也没有清理通道。清单的 `capabilities` 对象是声明性元数据，不会增加通道。

## 4. WASI 模块

WASI 不属于受支持的契约。

- 导入 `wasi_snapshot_preview1` 的模块会用最小的 preview1 提供者实例化：没有预打开目录，没有环境变量，没有参数，退出处理不会终止宿主。
- worker 支持两种启动形态。命令模块导出 `_start`，它在初始化时运行一次，可能调用 `proc_exit`。reactor 模块导出 `_initialize`，宿主会在 ABI 版本检查之前、以及任何其他导出函数之前调用它。
- reactor 钩子不专属于 WASI。导入 WASI 的模块通过 WASI 提供者初始化，没有导入的模块则直接调用 `_initialize`。面向 `wasm32-wasip1` 构建的 libc 模块属于第二种。
- reactor 运行时可能在其导出函数先于 `_initialize` 运行时陷入 trap。用 `-buildmode=c-shared` 和 `//go:wasmexport` 构建的 Go `wasip1` 模块就是 reactor，需要走 reactor 路径。
- Go `wasip1` 命令模块使用命令模型：`_start` 可能调用 `proc_exit`，所以初始化之后再调用属于不受支持的行为。
- 不导入任何 WASI 函数的模块不需要启动形态。面向 `wasm32-unknown-unknown` 构建的 Rust、C 或 Zig 直接导出核心 ABI。
- v1 不包含自定义宿主导入。导入 WASI preview1 命名空间之外任何东西的模块都会实例化失败。

## 5. worker 隔离与截止时间

- 模块永远不在宿主主线程上运行。V8 没有 fuel 计量，也没有中断 WebAssembly 执行的 API，所以带无限循环的同步调用会让主线程永久冻结，连超时计时器也一起冻结。每个实例都运行在 `worker_threads` worker 里。
- 宿主启动 worker，worker 编译并实例化模块，然后检查必需导出。reactor 接着通过 `_initialize` 初始化，导入 WASI 时经由 WASI 提供者，没有导入时直接调用；版本检查在初始化之后运行，因为 reactor 运行时在其导出函数先于初始化运行时会陷入 trap。命令模块的版本检查在 `_start` 之前，这样针对其他 ABI 形态编写的模块永远不会执行初始化代码。之后 worker 发送 `ready`。失败时发送 `init-error`，插件被标记为 `failed`。只有 `ready` 代表启动成功。
- 模块初始化受清单的 `timeouts.startupMs` 约束，时间从 worker 启动算起，直到 `ready` 握手完成；编译、实例化、reactor 初始化和版本检查共享这个预算。`_start` 或 `_initialize` 超过该时间时，worker 会被终止，插件会被标记为 `failed`，所以死循环的初始化不会让插件停在 `loaded`。
- worker 以 `resourceLimits.maxOldGenerationSizeMb` 为 256 MB 运行。这个值只限制 worker 的 JavaScript 堆；WebAssembly 线性内存属于外部内存，不受加载器限制，所以只应运行可信模块。
- apply 握手使用清单的 `timeouts.startupMs`，每次 `tool.call` 或 `event` 投递使用 `timeouts.callMs`。超时后宿主让所有未决调用失败、终止 worker，并上报一次原因为 `timeout` 的失败，因为终止 worker 是停止死循环实例的唯一机制。因此超时的调用会结束插件实例：它的注册被撤销，记录变为 `failed`；这一点与 Python 后端不同，后者进程会继续存活。
- 宿主在终止 worker 前清掉 worker 句柄，所以迟到的回复或退出事件不能完成已经失败的调用，也不能重复上报失败。
- apply 之后的 worker 退出、worker 报错事件或调用截止时间会让所有未决调用失败，并通过后端的崩溃回调上报恰好一次失败，原因分别为 `exit`、`error` 或 `timeout`。apply 完成前到达的失败通过被拒绝的启动 Promise 交给加载器，加载器主动请求的停止不算失败。加载器撤销插件的注册、清空实例并把记录标记为 `failed`；`reload` 或 `enable` 会启动新的 worker，不会自动重启插件。
- 后端在执行声明的注册之后会检查 worker 是否仍然存活。worker 在 apply 握手期间退出会让 apply 失败，所以插件不会在 worker 已死的情况下被记录为 `applied`。
- worker 不能同步回调宿主，因为宿主导入无法跨线程返回。v1 基于声明，所以这不损失能力。
- 传给 worker 的参数会被投影成纯数据，因为 `postMessage` 使用结构化克隆，遇到 `AbortSignal` 这类宿主对象会抛错。[ABI-unified](../ABI-unified.zh.md) 第 3.4 节的投影适用。
- 后端默认关闭。必须在 WebAssembly 插件启动前把加载器选项 `wasm.enabled` 设为 `true`；操作者参考见 [CONTEXT](../../CONTEXT.md)。

## 6. 后端不支持的内容

- **没有日志通道。** 模块在导入 WASI 时把诊断写到 WASI stderr，没有 `ctx.logger` 的等价物。
- **没有清理注册。** 停止插件会终止 worker，之后不会运行任何插件代码。
- **没有文件系统和网络访问。** WASI 实例化时没有预打开目录，没有环境，没有参数。
- **没有 WASI preview1 命名空间之外的自定义宿主导入。**
- **没有从插件同步回调宿主的途径。**
- **没有在 Go `wasip1` 命令模块的 `_start` 调用 `proc_exit` 之后再调用它的支持。**
