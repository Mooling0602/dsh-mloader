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
| `dsh_alloc` | `(len: i32) -> i32` | 分配缓冲区并返回指针。 |
| `dsh_free` | `(ptr: i32, len: i32) -> void` | 释放缓冲区。 |
| `dsh_call` | `(ptr: i32, len: i32) -> i32` | 处理一个请求并返回结果字节长度。 |
| `dsh_result_ptr` | `() -> i32` | 返回结果缓冲区的指针。 |

缺少任何一个导出的模块都无法初始化，插件会被标记为 `failed`。

清单的 `entry` 字段指定 `.wasm` 文件，按清单目录解析。通过 `targets` 选择产物是尚未实现的包格式目标契约；[Package](Package.zh.md) 第 1 节规定了该字段。worker 读取这个文件、编译并实例化它。

## 2. 请求与结果约定

- 请求是 UTF-8 JSON 对象 `{"op": "...", "payload": {...}}`。宿主用 `dsh_alloc` 分配 `len` 字节，写入请求，然后调用 `dsh_call`。
- 插件把回复写成 UTF-8 JSON 文本放进结果缓冲区，并从 `dsh_call` 返回字节长度。宿主从 `dsh_result_ptr()` 读取结果。
- 插件必须写 `{"ok": true, "result": ...}` 或 `{"ok": false, "error": {"message": "..."}}` 之一。`ok` 为 `false` 的回复会让调用失败，不是合法 JSON 的回复也会让调用失败。
- 宿主在 `dsh_call` 返回后对请求缓冲区调用 `dsh_free(ptr, len)`。结果缓冲区归插件所有，必须保持有效直到下一个请求。
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

- 导入 `wasi_snapshot_preview1` 的模块会用最小的 preview1 提供者实例化：没有预打开目录，没有环境变量，没有参数，退出处理不会终止宿主。如果模块导出 `_start`，它会在初始化时被调用一次。
- Go `wasip1` 模块使用命令模型：`_start` 可能调用 `proc_exit`，所以初始化之后再调用属于不受支持的行为。
- reactor 风格的模块是受支持的形态，例如面向 `wasm32-unknown-unknown` 构建的 Rust、C 或 Zig。
- v1 不包含自定义宿主导入。导入 WASI preview1 命名空间之外任何东西的模块都会实例化失败。

## 5. worker 隔离与截止时间

- 模块永远不在宿主主线程上运行。V8 没有 fuel 计量，也没有中断 WebAssembly 执行的 API，所以带无限循环的同步调用会让主线程永久冻结，连超时计时器也一起冻结。每个实例都运行在 `worker_threads` worker 里。
- 宿主启动 worker，worker 编译并实例化模块，检查必需导出，在 WASI 提供 `_start` 时调用它，然后发送 `ready`。失败时发送 `init-error`，插件被标记为 `failed`。只有 `ready` 代表启动成功。
- 模块初始化没有自己的截止时间。`_start` 永不返回的模块永远不会发送 `ready`，插件会一直停在 `loaded`，直到被卸载或 dsh 重启。worker 仍然可以被终止，所以死循环的初始化不会阻塞宿主线程。
- worker 以 `resourceLimits.maxOldGenerationSizeMb` 为 256 MB 运行。
- apply 握手使用清单的 `timeouts.startupMs`，每次 `tool.call` 或 `event` 投递使用 `timeouts.callMs`。超时后宿主终止 worker，因为终止是停止死循环实例的唯一机制。因此超时的调用会结束插件实例，这一点与 Python 后端不同，后者进程会继续存活。
- 宿主在终止 worker 前清掉 worker 句柄，所以迟到的回复不能完成已经失败的调用。
- worker 退出或报错会让所有未决调用被拒绝。`stop()` 终止 worker。
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
