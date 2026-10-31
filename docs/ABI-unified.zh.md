# dsh-mloader 统一插件 ABI v1

[English](ABI-unified.md) | 简体中文

本文是加载器、其后端和每个外部插件共享的规范契约。加载器和后端实现它；第三方插件可以依赖它。这里的陈述是要求，不是建议。

配套文档规定各后端的契约和包格式：

- [python-sdk/PyABI](python-sdk/PyABI.zh.md) 规定 Python 运行时包、两种注册风格、结果 schema 推断和子进程传输。
- [wasm/WasmABI](wasm/WasmABI.zh.md) 规定 WebAssembly 核心 ABI 和 worker 隔离。
- [Package](Package.zh.md) 规定两种后端共用的归档格式和安装规则。Python 后端通过运行时命令行实现它；WebAssembly 后端仍是目标契约。
- [python-sdk/Package](python-sdk/Package.zh.md) 和 [wasm/Package](wasm/Package.zh.md) 规定各后端的包布局。

当前线上协议是版本 1。修改帧形状、清单字段或能力白名单都是契约变更；跨越进程或线程边界的变更需要提升协议版本。

基线：dsh `0.2.1-rc.3`，Cordis `4.0.5`。

操作者配置和实现细节不属于本契约。它们在 [CONTEXT](../CONTEXT.md) 中。面向用户的说明在 [README](../README.zh.md) 中。

## 目录

- [0. 设计公理](#0-设计公理)
- [1. 结构](#1-结构)
- [2. 插件声明](#2-插件声明)
- [3. ctx 能力白名单](#3-ctx-能力白名单)
- [4. RPC 协议](#4-rpc-协议)
- [5. 生命周期与归属](#5-生命周期与归属)
- [6. 后端接口](#6-后端接口)
- [7. 安全模型](#7-安全模型)
- [8. 安装布局](#8-安装布局)
- [9. v1 不做什么](#9-v1-不做什么)

## 0. 设计公理

1. **加载器是普通的 Cordis 插件。** 它不修改 dsh 加载器、bundle 机制或 `import()`，也不替换任何已有插件。
2. **外部插件不是 Cordis 插件。** 它不创建 Cordis 插件实体、fiber 节点或每插件 `ctx` 作用域，也永远不会出现在 dsh 插件列表里。它通过本文的协议发送注册意图，加载器在自己的 `ctx` 上执行真正的注册。
3. **能力面是白名单，不是透传。** 只有第 3 节的四个操作可达。其他所有 `ctx` 设施按设计都不可用。
4. **注册可撤销。** 插件引起的每个注册都属于该插件的账本，并在插件卸载时撤销。
5. **外部代码永远不占用宿主主线程。** Python 运行在子进程里，WebAssembly 运行在 worker 线程里，宿主继续自己的执行链，不等待插件。

公理 2 的后果是明确的：外部插件没有每插件 `ctx` 隔离，不能通过 Cordis `inject` 解析宿主服务，在插件管理里也没有条目。正是这个取舍让托管非 Cordis 代码成为可能。

## 1. 结构

```plaintext
dsh main process (Node, Cordis)
|
+-- Cordis container (unchanged)
|
+-- dsh-mloader                    one ordinary Cordis plugin, apply(ctx)
     |
     +-- Discovery                scans roots for mloader.plugin.json
     +-- Lifecycle                startup, reload, unload
     +-- BackendHost              one backend instance per plugin:
     |                            Python child process or WebAssembly worker thread
     |
     +-- for each plugin:
          PluginRegistrar         not a Cordis plugin, only a registration ledger
               |
               +-- registers on the loader's own ctx:
                    ctx.tools.register(...)  dsh sees a loader tool
                    ctx.on(event, ...)       dsh sees a loader listener
```

外部插件发送声明，不发送对象。加载器校验每个声明，并在自己的上下文上把它变成真正的注册。外部插件没有 `ctx.plugin()` 调用，也没有 fiber 节点。

这些声明产生的工具名、事件订阅和日志条目对 dsh 的可见程度，与加载器自己注册时完全相同。账本记住哪个注册属于哪个外部插件，所以卸载一个插件只撤销它自己的注册。

## 2. 插件声明

### 2.1 清单：`mloader.plugin.json`

清单是插件身份和后端选择的权威来源。它位于插件根，指定入口文件或平台目标。

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "backend": "python",
  "entry": "plugin.py",
  "enabled": true,
  "inject": [],
  "capabilities": { "tools": true, "events": true, "logger": true, "effect": true },
  "timeouts": { "startupMs": 10000, "callMs": 30000 },
  "env": {}
}
```

| 字段 | 必需 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- | --- |
| `id` | 是 | 字符串 | 无 | 插件标识符，`^[a-z0-9][a-z0-9_-]{0,31}$`。也是日志使用的命名空间。 |
| `name` | 否 | 字符串 | `id` | 人类可读名称。 |
| `version` | 否 | 字符串 | `"0.0.0"` | 信息性版本字符串。带 `targets` 的清单必须使用 Semantic Versioning 2.0.0 字符串。 |
| `backend` | 是 | `"python"` 或 `"wasm"` | 无 | 选择托管插件的后端。 |
| `entry` | 条件必需 | 字符串 | 无 | 相对于清单目录的入口文件路径。会解析为绝对路径。`targets` 不存在时必需，`targets` 存在时必须不存在。 |
| `targets` | 条件必需 | 数组 | 无 | WebAssembly 包目标，见 [wasm/Package](wasm/Package.zh.md) 第 1 节。只对 `"backend": "wasm"` 有效。可安装的 WebAssembly 包需要它，以目录安装的插件没有它。带 `targets` 的清单没有顶层 `entry`。 |
| `enabled` | 否 | 布尔 | `true` | 为 `false` 时插件会被发现并报告，但不启动。 |
| `inject` | 否 | 字符串数组 | `[]` | 在启动载荷中转发给插件的元数据。不授予能力，也不解析宿主服务。 |
| `capabilities` | 否 | 对象 | 全 `true` | 开关 `tools`、`events`、`logger` 和 `effect`。它们是声明性元数据：v1 不强制执行，所以设为 `false` 只表示意图。强制边界是第 3 节的注册操作白名单和第 3.3 节的事件白名单。 |
| `timeouts.startupMs` | 否 | 数字 | `10000` | 启动握手的截止时间，单位毫秒。 |
| `timeouts.callMs` | 否 | 数字 | `30000` | 一次工具调用或一次事件投递的截止时间，单位毫秒。 |
| `env` | 否 | 对象 | `{}` | Python 子进程的额外环境变量。值会转成字符串。WebAssembly 后端忽略。 |

`hello-mloader` 这个 id 专供随包示例使用。只有目录中带有 `.mloader.builtin.json`，且其中 id 匹配、`source` 为 `dsh-mloader` 时，发现过程才接受这个 id；带保留 id 而没有有效标记的清单会被拒绝。

未列出的字段会被忽略，不会到达插件。

`targets` 是面向可安装 WebAssembly 包的目标契约。加载器目前不会从归档安装 WebAssembly 插件，以目录安装的 WebAssembly 插件继续使用 `entry`。

### 2.2 发现

加载器扫描每个配置的根目录，寻找 `mloader.plugin.json`：

- 根目录本身可以是插件目录，也可以包含插件目录。两种布局都会扫描。
- 只有目录会被当作插件目录。根目录里的清单和每个插件子目录里的清单都是候选；扫描后按 `id` 排序。
- 根目录不可读、JSON 非法、缺少必需字段，或 id/backend 非法，都会为该清单产生一个错误。其他清单仍然加载。
- 重复插件 id 是后一个清单的错误。扫描顺序里第一个清单获胜，因为两条记录会争夺同一批注册。
- 入口路径按清单目录解析。后端有工作目录时，会以该目录启动实例，所以插件可以相对它解析自己的资源文件。

加载器运行期间会监听根目录。出现的插件目录按启动时相同的规则被发现并启动，消失的目录被卸载且注册被撤销。这只适用于目录集合：写入已安装插件的清单或入口文件，在插件重新加载前不会生效。操作者用 `watch: false` 关闭监听，关闭期间新增的目录需要重启。

### 2.3 声明能力

外部插件通过其后端的通道到达能力面。第 3 节的四个操作就是全部能力面，后端实现其通道支持的子集。Python 后端在 apply 期间或之后把每个操作作为请求帧发送（[`PyABI 第 6 节`](python-sdk/PyABI.zh.md#6-进程传输与握手)），所以四个都支持。WebAssembly 后端没有入站通道：它把工具和事件声明作为 apply 结果返回，没有日志或清理操作（[`WasmABI 第 3 节`](wasm/WasmABI.zh.md#3-声明)）。加载器按第 3 节校验每个声明，并记录到插件的账本，无论它由哪条通道送达。

## 3. ctx 能力白名单

### 3.1 四个操作

| # | RPC 操作 | 语义 |
| --- | --- | --- |
| 1 | `tools.register` | 在加载器的上下文上注册工具。 |
| 2 | `events.on` | 订阅一个白名单事件。 |
| 3 | `logger.log` | 单向日志通知。不等待回复。 |
| 4 | `effect.register` | 注册一个在插件卸载时运行的清理函数。 |

Python SDK 把这些操作暴露为 `ctx.tools.register`、`ctx.on`、`ctx.logger` 和 `ctx.effect.register`（[`PyABI 第 3.4 节`](python-sdk/PyABI.zh.md#34-上下文接口)）。Python 后端支持全部四个。WebAssembly 后端只支持工具和事件声明；第 2.3 节说明它如何投递。

其他都不可达。`ctx.session`、`ctx.llm`、`ctx.subprocess`、`ctx.commands` 和任意 `ctx.*` 透传都不属于契约，插件无法取得它们。

斜杠命令故意不提供给外部插件。命令是全局命名空间里面向人的条目，让任何外部插件注册都会污染用户的命令列表。加载器自己的 `/mloader` 命令是加载器作为普通 Cordis 插件做出的注册，不是提供给插件的能力。

### 3.2 工具注册

`tools.register` 接受一个 `tool` 对象：

| 字段 | 必需 | 含义 |
| --- | --- | --- |
| `name` | 是 | 必须匹配 `^[A-Za-z0-9_-]{1,64}$`。 |
| `description` | 是 | 非空的人类可读描述。 |
| `parameters` | 否 | 第 3.5 节子集的输入 schema。默认空对象 schema。 |
| `output` | 否 | 第 3.5 节子集的结果 schema。默认带 `additionalProperties: true` 的对象 schema。 |
| `timeoutMs` | 否 | 正数的每次调用超时，单位毫秒。不替换清单的 `callMs` 截止时间。 |

加载器在自己的上下文上注册准备好的定义：

- 同一插件内重复的工具名会被拒绝。
- dsh 已注册的名字会被工具注册表拒绝，注册失败。
- `output.render` 不能跨越插件边界，所以加载器重建它。渲染器把返回的 JSON 值变成文本块。
- 工具结果必须可 JSON 序列化。处理器异常会变成工具错误，不会杀死进程。

### 3.3 事件订阅

唯一可订阅的事件是：

| 事件 | 触发时机 |
| --- | --- |
| `tools/execute` | 工具被分派。 |
| `tools/pre-execute` | 工具即将执行。 |
| `tools/post-execute` | 工具已执行。 |
| `tools/result` | 产生工具结果。 |
| `tools/change` | 工具集变化。 |
| `agent/status` | agent 状态变化。 |
| `agent/created` | agent 被创建。 |
| `agent/disposed` | agent 被销毁。 |
| `session/created` | 会话被创建。 |
| `session/disposed` | 会话被销毁。 |

- 订阅列表之外的事件会被拒绝，拒绝消息会列出白名单。
- 每个插件每个事件只能订阅一次。重复订阅会被拒绝。
- 订阅是观察性的。处理器返回值不改变宿主执行或工具结果，无论插件是否答复，宿主链都会前进。
- 处理器必须迅速返回，不能等待宿主。宿主异步投递事件，但阻塞的处理器可能延迟插件进程中的后续工作。日志是单向通知，在处理器里是安全的。
- Python 处理器的位置参数个数：零个时调用 `handler()`，一个时传入首个参数（如果存在），多个或包含可变位置参数时传入所有参数。缺少必需参数会产生处理器错误。
- 没有订阅处理器的事件以 null 结果确认。

### 3.4 事件载荷投影

跨越进程或线程边界的每个参数都会先投影成纯数据。投影把循环、函数和宿主对象替换为标记，并把深度限制为 6、数组限制为 100 个元素、对象键限制为 100、字符串限制为 4000 个字符。标记是 `[Circular]`、`[Function]`、`[MaxDepth]`、`[Unreadable]` 和 `[Truncated]`。`AbortSignal` 变成 `{ "$type": "AbortSignal", "aborted": true|false, "reason": ... }`；只有宿主信号带 reason 时才出现 reason。`Error` 变成 `{ "$type": <name>, "message": ... }`。

对于 `tools/execute`、`tools/pre-execute`、`tools/post-execute`、`tools/result` 和 `tools/change`，第一个参数是活的宿主执行对象。它被投影成这个稳定形状：

```jsonc
{
  "$type": "ToolExecution",
  "callId": "...",
  "rootCallId": "...",     // when present
  "name": "bash",
  "parent": "...",         // when present
  "token": "...",          // when present
  "arguments": { "command": "ls" },
  "agent": { "id": "...", "name": "...", "kind": "...", "label": "..." },
  "aborted": false
}
```

只从 agent 复制标量 `id`、`name`、`kind` 和 `label`；agent 树永远不会暴露。可选字段只在宿主值有时出现。

### 3.5 JSON Schema 子集

工具参数和工具输出使用 harness 接受的受限 schema 子集：

- **约束关键字：** `type`、`oneOf`、`properties`、`required`、`additionalProperties`、`items`、`enum`、`const`。
- **注解关键字：** `description`、`title`、`default`、`examples`。
- **类型：** `object`、`array`、`string`、`number`、`integer`、`boolean`、`null`。
- schema 节点必须是对象。节点不能同时声明 `type` 和 `oneOf`。
- `properties`、`items` 和 `oneOf` 会递归遍历，循环 schema 会被拒绝。

其他内容都会被拒绝，包括 `format`、`minimum`、`maximum`、`pattern`、`$ref`、`anyOf`、`allOf`、`not`、`patternProperties` 和 `definitions`。加载器在注册前校验，并报告插件 id、工具名和 schema 路径，所以违规是可归因的。

## 4. RPC 协议

下面的操作名和载荷形状由所有后端共享。帧封套是 Python 后端对它们的封装（[`PyABI 第 6 节`](python-sdk/PyABI.zh.md#6-进程传输与握手)）；WebAssembly 后端在自己的请求和结果缓冲区里携带同样的操作，没有这个封套（[`WasmABI 第 2 节`](wasm/WasmABI.zh.md#2-请求与结果约定)）。

### 4.1 帧

每个帧都带 `"v": 1`。请求标识符按 `id` 匹配；两个方向的标识符相互独立。

宿主到插件的请求：

```json
{"v":1,"id":1,"op":"boot","payload":{"pluginId":"my-plugin","manifest":{"id":"my-plugin","name":"My Plugin","version":"1.0.0","inject":[]}}}
{"v":1,"id":2,"op":"apply","payload":{"inject":[]}}
{"v":1,"id":3,"op":"tool.call","payload":{"tool":"greet","args":{"who":"world"}}}
{"v":1,"id":4,"op":"event","payload":{"event":"tools/execute","args":[{"$type":"ToolExecution","name":"bash"}]}}
{"v":1,"id":5,"op":"dispose","payload":{"reason":"loader unload"}}
```

插件到宿主的请求：

```json
{"v":1,"id":101,"op":"tools.register","payload":{"tool":{"name":"greet","description":"Greet one person.","parameters":{"type":"object"}}}}
{"v":1,"id":102,"op":"events.on","payload":{"event":"tools/execute"}}
{"v":1,"id":103,"op":"logger.log","payload":{"level":"info","message":"ready","data":{}},"notification":true}
{"v":1,"id":104,"op":"effect.register","payload":{"label":"cleanup"}}
```

任一方向的回复：

```json
{"v":1,"id":1,"ok":true,"result":{}}
{"v":1,"id":1,"ok":false,"error":{"message":"reason","kind":"timeout|transport"}}
```

`logger.log` 帧带 `"notification": true`。它永远不收到回复，处理失败只会被记录。

`kind` 字段只出现在宿主生成的失败上：截止时间到期时是 `timeout`，帧无法送达时是 `transport`。插件产生的拒绝只带 `message`。

通知帧会被处理，永远不答复。每个请求帧恰好收到一个回复。未知 id 的回复和既不是请求也不是回复的帧会被记录并忽略；两者都不打扰通道。

### 4.2 操作

宿主载荷：

| 操作 | 载荷 | 回复结果 |
| --- | --- | --- |
| `boot` | `pluginId`、带 `id`、`name`、`version`、`inject` 的 `manifest` | Python：`pluginId`、`python` 版本。 |
| `apply` | `inject` | `tools`：排序后的已注册工具名；`events`：排序后的已订阅事件名。 |
| `tool.call` | `tool`、`args` | 处理器返回的 JSON 值。 |
| `event` | `event`、投影后的 `args` 数组 | 处理器返回值。 |
| `dispose` | `reason` | 清理运行后为 `disposed: true`；进程随后退出。 |

插件载荷：

| 操作 | 载荷 |
| --- | --- |
| `tools.register` | 第 3.2 节定义的 `tool` 对象。 |
| `events.on` | 白名单里的 `event` 名。 |
| `logger.log` | `level`（`debug`、`info`、`warn` 或 `error`）、`message`、可选的 `data`。 |
| `effect.register` | `label`。 |

这些列表之外的操作会以 `ok:false` 拒绝，并带一条列出白名单的错误消息。

WebAssembly 后端没有入站请求通道，所以不发送任何插件载荷操作。它改为在 apply 结果里返回 `tools` 和 `events`。它只被 `apply`、`tool.call` 和 `event` 驱动：初始化是 worker 的 `ready` 握手，停止路径终止 worker，没有 `dispose` 帧（[`WasmABI 第 3 节`](wasm/WasmABI.zh.md#3-声明)、[`WasmABI 第 5 节`](wasm/WasmABI.zh.md#5-worker-隔离与截止时间)）。

### 4.3 截止时间与失败

| 情况 | 行为 |
| --- | --- |
| `boot` 或 `apply` 超过 `startupMs`（默认 10000 ms） | 加载器停止后端，把插件标记为 `failed`，其他插件不受影响。 |
| `tool.call` 或事件投递超过 `callMs`（默认 30000 ms） | 调用返回错误。实例随后怎样处理取决于后端：Python 进程继续存活（[`PyABI 第 7 节`](python-sdk/PyABI.zh.md#7-截止时间与失败)），WebAssembly worker 被终止（[`WasmABI 第 5 节`](wasm/WasmABI.zh.md#5-worker-隔离与截止时间)）。 |
| 后端崩溃 | 插件的注册被撤销，状态变为 `failed`。dsh 和其他插件继续运行。 |
| 插件请求非法 | 以 `ok:false` 拒绝，插件可以看到拒绝。 |
| 请求无法送达 | 立即以 `transport` 错误失败，而不是等待截止时间。 |

两个截止时间来自清单：`timeouts.startupMs` 覆盖 `boot` 和 `apply`，`timeouts.callMs` 覆盖 `tool.call` 和事件投递。后端用其隔离边界提供的机制执行截止时间；后端文档规定该机制。

## 5. 生命周期与归属

```plaintext
discovered -> loaded -> applied -> disposed
                   |
                   +-> failed
     +-> disabled
```

| 状态 | 含义 |
| --- | --- |
| `discovered` | 清单被接受。插件未启动，例如因为 `autoEnable` 为 `false`。 |
| `loaded` | 后端实例已创建，启动握手进行中。 |
| `applied` | 握手完成，插件的注册生效。 |
| `disabled` | 插件未启动：清单说 `enabled: false`，或 WebAssembly 后端被禁用。 |
| `failed` | 发生启动、apply 或运行时失败。注册被撤销。 |
| `disposed` | 插件已卸载，账本已关闭。 |

- 每个注册按所有者记录在插件的账本里。卸载插件会按逆序撤销它的注册；重新加载也会在启动新实例前做同样的事。
- 账本关闭后尝试的注册会立即被销毁，而不是悬空。
- 对不是 `applied` 的插件调用工具会失败，错误会指出当前状态。
- `reload` 撤销账本，停止后端实例并启动新实例。新实例重新加载插件，所以模块级状态不会跨重新加载保留。
- 崩溃的插件变成 `failed`，不会自动重启。操作者可以通过加载器可选的 `mloader` 服务重新加载它，或重启 dsh。
- 加载器运行期间目录被删除的插件变成 `disposed`，不再列出。运行期间创建的目录走与启动时相同的启动路径，包括 `enabled: false` 和 `autoEnable: false` 规则。

## 6. 后端接口

一个后端只托管一个外部插件。后端种类来自 `manifest.backend`。加载器为每个插件构造一个实例，并通过这个接口驱动它，接口在 `src/types.ts` 里以结构化方式声明：

```ts
interface BackendInstance {
  readonly spec: PluginSpec

  /** Create the process or worker and complete the boot handshake. */
  start(): Promise<unknown>

  /** Install the callback for registration requests. Optional: the WebAssembly
      backend declares its registrations as the apply result instead. */
  setInboundHandler?(
    handler: (op: string, payload: Record<string, unknown>) => Promise<unknown>,
  ): void

  /** Deliver apply and return the registrations the plugin declared. */
  apply(registrar: RegistrarHandle): Promise<{ tools?: string[]; events?: string[] } | undefined>

  /** Call one tool registered by this plugin. */
  callTool(name: string, args: unknown, signal?: unknown): Promise<unknown>

  /** Deliver one host event. */
  dispatchEvent(event: string, args: unknown[]): Promise<unknown>

  /** Stop the instance, killing it if it does not stop in time. */
  stop(reason?: string): Promise<void>
}

interface RegistrarHandle {
  handle(op: string, payload?: Record<string, unknown>): Promise<unknown>
}
```

两个后端满足同一契约。它们的物理差异是：

| 方面 | Python 后端 | WebAssembly 后端 |
| --- | --- | --- |
| 边界 | 操作系统进程 | 宿主进程内的 worker 线程 |
| 传输 | 通过 `stdin` 和 `stdout` 的 NDJSON | `postMessage` 和共享线性内存 |
| 注册通道 | 插件在 `apply` 期间通过 `setInboundHandler` 发送请求 | 插件把声明作为 `apply` 结果返回 |
| 超时执行 | 请求截止时间；启动超时时杀死进程 | 终止 worker |
| 同步宿主回调 | 原则上可能，SDK 不使用 | 不可能；worker 不能跨线程回调 |

后端必须永远不让插件代码占用宿主主线程，启动失败时必须回收它创建的进程或 worker，并且必须通过让未决调用失败来暴露崩溃，以便加载器撤销插件的注册。

## 7. 安全模型

| 维度 | Python 子进程 | WebAssembly worker 线程 |
| --- | --- | --- |
| 隔离边界 | 操作系统进程 | 同一地址空间内的线程 |
| 文件系统 | 默认完全访问 | 无访问（没有 WASI 预打开目录） |
| 网络 | 默认允许 | 无访问 |
| 崩溃隔离 | 进程级；宿主不受影响 | 线程级；宿主不受影响 |
| 无限循环 | 启动期间的循环会在启动超时被杀；调用期间的循环会让该调用失败，进程继续存活 | 调用截止时间会终止 worker；初始化循环没有截止时间（[`WasmABI 第 5 节`](wasm/WasmABI.zh.md#5-worker-隔离与截止时间)） |
| 内存限制 | 加载器不施加 | `maxOldGenerationSizeMb` 为 256 |
| 环境 | 已清理；清单 `env` 随后应用 | 不适用 |

Python 沙箱是进程隔离，不是权限隔离。Python 插件可以读写文件、打开网络连接，所以只应运行可信插件。WebAssembly 隔离阻止挂起阻塞宿主，也阻止主动 IO，但它不是防止模块内存破坏的安全边界。只应运行可信插件。

环境清理减少意外的凭据继承；它不是插件无法通过读文件绕过的安全控制。

崩溃或挂起的插件不能把 dsh 带崩。其他插件和宿主继续运行。崩溃会撤销插件的注册并把它标记为 `failed`；超过截止时间的调用在调用方失败。后端文档说明实例随后怎样处理。

## 8. 安装布局

外部插件安装在 profile 下，不在加载器包内：

```plaintext
~/.dsh/profiles/<profile>/
  cordis.patch.yml
  package.json
  mloader/
    .venv/                 共享 Python 环境，用 uv 或 venv 模块创建
    plugins/
      <plugin-id>/
        mloader.plugin.json
        plugin.py
        pyproject.toml     可选的 Python 依赖
      <other-plugin>/
        mloader.plugin.json
        hello.wasm
```

目录名只是约定。插件 id 来自清单，不来自目录名。

插件通过把它的目录放进一个插件根目录来安装。Python 包可以用运行时命令行从归档安装；命令见 [python-sdk/Package](python-sdk/Package.zh.md) 第 6 节，加载器本身从不读取归档。加载器管理共享环境时，一个 profile 的 Python 插件都在该环境中运行，所以需要隔离依赖集合的插件不受支持。[Package](Package.zh.md) 的包格式对 Python 已实现，对 WebAssembly 仍是目标契约。

profile 的 `node_modules` 不是受支持的安装位置。它归包管理器所有，`pnpm install` 或 `pnpm prune` 可以重建它，所以手工放在那里的插件不稳定。

### 8.1 根目录解析

`roots` 接受三种形式：

| 形式 | 解析方式 |
| --- | --- |
| `~/.dsh/...` | 开头的 `~` 展开为主目录。 |
| `./x` 或 `x` | 按 profile 目录解析；没有探测到 profile 时按当前工作目录解析。 |
| `/abs/path` | 原样使用。 |

除非 `profilePlugins` 为 `false`，否则在知道 profile 时把 `<profile>/mloader/plugins` 追加为最后一个根目录。重复根目录会被移除，所以再次列出 profile 目录不会让插件加载两次。

profile 目录从 `ctx.baseUrl` 探测，dsh 把它设为包含活动 `cordis.yml` 的目录的文件 URL。如果它不可用，加载器回退到 `DSH_PROFILE_DIR`，然后是 `DSH_HOME` 和 `DSH_PROFILE`，最后扫描 `~/.dsh/profiles`，且只在恰好一个候选看起来像 profile 时成功。一个目录同时有 `package.json` 和 `cordis.yml` 才算 profile。没有探测到 profile 时，加载器发出警告，只使用显式根目录。

### 8.2 随包示例

探测到 profile 且 `seedExamples` 为 `true` 时，加载器在启动时、发现之前，把随包示例 `seed/hello-mloader/` 复制到 `<profile>/mloader/plugins/`。每次启动都会用随包副本替换已安装副本，包括读者添加的文件；副本携带 `.mloader.builtin.json`，它正是保留 id 的准入标记。`seedExamples: false` 不执行任何文件系统操作。

不要对持有插件的 profile 运行 `dsh --from-default-profile`：该命令会删除整个 profile 目录，包括 `mloader/plugins`。

加载器配置是操作者材料。键参考在 [CONTEXT](../CONTEXT.md)，打包的默认层是 `cordis.patch.yml`。

### 8.3 操作界面

dsh-mloader 为运行 dsh 的人提供三个操作界面：

- dsh 插件页面上的 External plugins 区块，列出被托管的插件并在运行时开关它们；
- `/mloader` 下的 HTTP 路由，向浏览器半边提供插件列表、运行时开关和加载器配置；
- `/mloader` 斜杠命令组。

它们属于 dsh-mloader 内部，不是外部插件 ABI 的一部分。外部插件不能调用它们，不能在它们上面注册，也不能依赖它们的请求或响应形状。浏览器区块和 HTTP 路由只在 web profile 存在；非 web 的 dsh profile 会挂载加载器并托管插件，但没有它们；斜杠命令只在可选的 commands 服务可用时存在。

## 9. v1 不做什么

1. 不替换 Cordis、不修改 dsh 加载器，也不碰 bundle 机制。
2. 不支持外部插件之间调用、服务注册表，或 Cordis 风格的 `inject` 宿主服务解析。
3. 不提供 Python 权限沙箱。Python 插件只有进程隔离。
4. 不持久化插件状态。插件每次启动都会重新发现并挂载。
5. 不支持插件 UI 或客户端半边。
6. 不允许 WebAssembly 插件同步回调宿主。
7. 不向外部插件暴露斜杠命令或第 3 节白名单之外的任何能力。
8. 默认不启用 WebAssembly 后端，也不随包提供 WebAssembly 示例。
9. 不自动重启崩溃的插件。
10. 不监听已安装插件内部的文件。清单或入口文件变化只有在重新加载或重启后才生效。
11. 不给 Python 插件单独的环境，也不选择 Python 版本。同一个 profile 的所有 Python 插件共用一个由配置解释器创建的环境。
12. 不自行从归档安装包。Python 运行时命令行负责这项安装。
