# dsh-mloader ABI 契约 v1

> 本文件是**唯一权威契约**。码头宿主、Python 后端、WASM 后端、插件作者都必须遵守。
> 基线：dsh `0.2.1-rc.3` / Cordis `4.0.5`。

---

## 0. 设计公理

1. **码头本身是一个普通 Cordis 插件。** 它不修改 dsh 的 Loader YAML、bundle 机制、`import()`，
   也不替换任何既有插件。
2. **被托管的外部插件不是 Cordis 插件，也不产生任何 Cordis 插件实体。**
   它们**不会**出现在 dsh 的插件列表里，**不**新增 Cordis fiber 节点，**不**拥有自己的 `ctx` 作用域。
   它们只是"一组注册意图"，通过 NDJSON RPC 发给码头，由码头**在自己的 `ctx` 上**落成真实 dsh 能力。
3. **能力面是白名单，不是透传。** 未在 §3 列出的 `ctx.*` 一律不可达。这保证 Cordis 的服务边界不被打破。
4. **注册可撤销。** 插件对宿主的每次注册都按 owner 记账，卸载时整体撤销。
5. **宿主主线程绝不被外部代码占用。** 事件监听器必须同步把执行链传下去（`next()`），
   外部插件的事件分发一律 fire-and-forget。详见 §3.1 的事故记录。

> **代价（必须承认）**：因为不产生 Cordis 插件实体，外部插件**没有** per-plugin 的
> `ctx` 隔离，也**不能**用 `inject` 自动解析依赖 —— `inject` 由码头手动解析。
> 这是刻意的取舍：插件挂在码头下面，而不是变成 dsh 的 Cordis 插件。

---

## 1. 三层结构

```
dsh 主进程 (Node / Cordis)
│
├─ Cordis 容器 …… 完全不动
│
└─ dsh-mloader            ← 一个普通 Cordis 插件 (apply(ctx))
     │
     ├─ Discovery        扫描 roots 下的 mloader.plugin.json
     ├─ Lifecycle        enable / disable / reload / unload
     ├─ BackendHost      每个外部插件 = 一个"后端实例"（Python 子进程 或 WASM worker 线程）
     │
     └─ for each plugin:
          PluginRegistrar  ← 不是 Cordis 插件！只是一份"注册账本"
                 │
                 └─ 在**码头的 ctx 上**注册真实能力：
                      ctx.tools.register(...)   → dsh 看到的是码头的工具
                      ctx.on(event, listener)   → dsh 看到的是码头的监听器
```

**关键**：外部插件**不产生 Cordis 插件对象**，dsh 侧完全看不到它们。
dsh 看到的是码头注册的工具和监听器；码头的账本记住"哪一条注册属于哪个外部插件"，
卸载某个外部插件时只撤销它那部分注册。

### 1.1 注册意图接口

外部插件通过 NDJSON RPC 发来的是**声明**，不是插件对象：

```jsonc
// 插件 → 码头
{ "op": "tools.register", "payload": { "tool": { "name": "py_greet", "description": "...",
                                                 "parameters": { /* JSON Schema */ } } } }
{ "op": "events.on",      "payload": { "event": "tools/execute" } }
{ "op": "logger.log",     "payload": { "level": "info", "message": "..." } }   // 单向通知
{ "op": "effect.register", "payload": { "label": "cleanup" } }
```

码头的 `PluginRegistrar.handle(op, payload)` 校验后落成真实注册，并返回结果。
**没有** `TranslatedPlugin` 对象，**没有** `ctx.plugin()` 调用，**没有** fiber 节点。

---

## 2. 插件声明格式

**两者都支持**（用户决策）。两种风格可混用，`apply()` 风格优先。

### 2.1 风格 A：Cordis 对齐式（推荐）

插件导出 `apply(ctx)`，在内部做注册。

```python
# plugin.py
NAME = "py-hello"
INJECT = ["tools"]          # 可选

def apply(ctx):
    ctx.logger.info("py-hello 已挂载")

    @ctx.tools.register(
        name="py_greet",
        description="向某人问好",
        parameters={"type": "object",
                    "properties": {"who": {"type": "string"}},
                    "required": ["who"]},
    )
    def py_greet(args):
        return {"text": f"你好，{args['who']}！"}

    @ctx.on("tools/execute")
    def observe(exec, next):
        ctx.logger.info("工具被执行:", exec.get("name"))
        return next()
```

### 2.2 风格 B：声明式

插件只声明元数据 + 工具表，码头主动注册。

```python
# plugin.py
NAME = "py-decl"

TOOLS = [
    {
        "name": "py_add",
        "description": "两数相加",
        "parameters": {"type": "object",
                       "properties": {"a": {"type": "number"}, "b": {"type": "number"}},
                       "required": ["a", "b"]},
        "handler": lambda args: {"sum": args["a"] + args["b"]},
    },
]
```

### 2.3 manifest：`mloader.plugin.json`

同目录的 `mloader.plugin.json` 是**发现与身份的权威来源**；`plugin.py` 的 `NAME` 可省略。

```json
{
  "id": "py-hello",
  "name": "Python Hello",
  "version": "1.0.0",
  "backend": "python",
  "entry": "plugin.py",
  "enabled": true,
  "inject": ["tools"],
  "capabilities": { "tools": true, "events": true, "logger": true },
  "timeouts": { "startupMs": 10000, "callMs": 30000 },
  "env": { "PYTHONUNBUFFERED": "1" }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 插件唯一标识，`^[a-z0-9][a-z0-9_-]{0,31}$`；也是命名空间前缀 |
| `name` | ✅ | 人类可读名 |
| `version` | | 语义化版本 |
| `backend` | ✅ | `python` \| `wasm` |
| `entry` | ✅ | 相对 manifest 的入口文件 |
| `enabled` | | 默认 `true` |
| `inject` | | 与 Cordis `inject` 同义 |
| `capabilities` | | 能力开关，默认按后端能力全开 |
| `timeouts.startupMs` | | 默认 10000 |
| `timeouts.callMs` | | 默认 30000 |
| `env` | | 仅 Python；附加环境变量 |

---

## 3. ctx 能力映射（白名单）

JS 侧真实 API ↔ 插件侧 RPC 操作。**v1 只有这四组。**

| # | JS 侧真实 API | RPC 操作 | 语义 |
|---|---|---|---|
| 1 | `ctx.tools.register(def)` | `tools.register` | 注册工具，返回 disposer |
| 2 | `ctx.on(event, fn)` | `events.on` | 订阅事件，返回 disposer |
| 3 | `ctx.logger.{debug,info,warn,error}` | `logger.log` | 单向日志 |
| 4 | `ctx.effect(fn)` | `effect.register` | 注册带清理的副作用 |

> **不可达**：`ctx.session`、`ctx.llm`、`ctx.subprocess`、任意其他 `ctx.*` 透传。
> 需要更多能力时扩这张表，而不是开透传。

### 3.0 一个容易混淆的边界：命令**不**对外开放

外部插件只能声明上表四组。**斜杠命令（`ctx.commands.register`）不在白名单里**，
也**不应**加进白名单 —— 原因：

- 命令是**面向人的入口**，占的是全局命名空间。让任意外部插件注册命令，
  等于让它们污染用户的 `/` 补全列表。
- 工具名有 `dsh-mloader` 自己的命名空间约束（不会和 dsh 内置重名冲突，
  因为 dsh 会拒绝重名注册），而命令是抢占式的。

**码头自己**用 `ctx.commands.register` 注册了 `/mloader-status` —— 这是码头作为
普通 Cordis 插件行使自己的能力，和外部插件无关。它也不在 `inject` 里声明
`commands`（声明了会让整个码头在缺少该服务时起不来），而是运行时 `ctx.get('commands')`
探测，缺失就跳过并记 debug 日志。

### 3.1 事件白名单

插件可订阅的事件必须是**只读或瀑布**语义，且不涉及凭据。v1 白名单：

```
tools/execute          触发: 每次工具分发
tools/pre-execute      触发: 工具执行前（可拦截）
tools/post-execute     触发: 工具执行后
tools/result           触发: 最终结果观察
tools/change           触发: 工具集变化
agent/status           触发: agent 状态变化
session/created        触发: 会话创建
session/disposed       触发: 会话销毁
agent/created          触发: agent 创建
agent/disposed         触发: agent 销毁
```

**未在白名单内的事件订阅直接被拒绝**，并在日志中记录。

#### ⚠️ waterfall 语义与死锁陷阱（2026-10-26 事故）

`tools/execute` / `tools/pre-execute` / `tools/post-execute` 属于 **Cordis waterfall 事件**。
读 `cordis/lib/index.js` 的 `waterfall()` 实现可知：

```js
const next = () => (cbs.shift() ?? inner)(...args)   // 最后一个参数是 next
```

即：监听器**必须调用 `next()` 并把它的返回值返回**，否则后续监听器和真正的工具执行体
都不会运行 —— 工具执行链直接断掉（返回 `undefined`）。

**事故经过**：最初把 listener 写成 `async (...args) => await dispatchEvent(...)`。
宿主阻塞在「等插件事件回包」上，而插件在事件处理器里调 `ctx.logger.debug`
又同步等宿主回包 → **永久互等** → 占满 tools 通道 → dsh 所有工具调用
（含 `bash`、`read`）全部超时，只能重启恢复。

**现行规则**（`src/registrar.js` 的 `#subscribeEvent`）：

1. 插件分发 **fire-and-forget**，绝不 `await`，绝不让它决定主链路进度；
2. **同步**调用 `next()` 传递执行链，保证工具执行不受影响；
3. Python 侧 `ctx.logger` 改为**单向通知**（`notification: true`，不等回包）。

由 `test/waterfall.mjs`（10 项）和 `test/reentrancy.mjs` 逐条断言。

### 3.2 JSON Schema 硬约束（重要）

dsh 的工具 schema 只接受一个**受限 JSON Schema 子集**：
`type / oneOf / properties / required / additionalProperties / items / enum / const` + 注解
（`description` / `title` / `default` / `examples`）。

**不支持** `format`、`minimum`、`maximum`、`pattern`、`$ref`、`anyOf`、`allOf`、`not`、
`patternProperties`、`definitions` 等。

码头在注册前会做**预校验**：违反子集直接抛错并指明插件 id，不把错误留给 dsh 的
`assertSupportedJsonSchema` 去炸。这是最容易踩的坑。

---

## 4. RPC 协议

### 4.1 Python 后端：NDJSON over stdio

- **帧格式**：一行一个 JSON，`\n` 结尾。**不是** LSP 的 `Content-Length`。
- **stdout 是协议通道**：插件里任何 `print()` 都会污染，必须用 `ctx.logger` 或写 stderr。
- 必须设 `PYTHONUNBUFFERED=1`。
- 进程**常驻**（不是每次调用起新进程），崩溃由码头决定是否重启。

### 4.2 消息形状

**宿主 → 插件**

```json
{"v":1,"id":1,"op":"boot","payload":{"pluginId":"py-hello","manifest":{...}}}
{"v":1,"id":2,"op":"apply","payload":{"inject":["tools"]}}
{"v":1,"id":3,"op":"tool.call","payload":{"tool":"py_greet","args":{"who":"世界"}}}
{"v":1,"id":4,"op":"event","payload":{"event":"tools/execute","args":[...]}}
{"v":1,"id":5,"op":"dispose","payload":{}}
```

**插件 → 宿主（请求）**

```json
{"v":1,"id":101,"op":"tools.register","payload":{"tool":{...}}}
{"v":1,"id":102,"op":"events.on","payload":{"event":"tools/execute"}}
{"v":1,"id":103,"op":"logger.log","payload":{"level":"info","message":"...","data":{}}}
{"v":1,"id":104,"op":"effect.register","payload":{}}
{"v":1,"id":105,"op":"ready","payload":{}}
```

**插件 → 宿主（应答）**

```json
{"v":1,"id":1,"ok":true,"result":{...}}
{"v":1,"id":1,"ok":false,"error":{"message":"...","kind":"user|internal|timeout"}}
```

### 4.3 时序

```
宿主                        Python 插件
 │  spawn                       │
 │──── boot ───────────────────▶│  加载模块，校验 manifest
 │◀───────────── ready ─────────│
 │──── apply ──────────────────▶│  调用 apply(ctx) 或注册 TOOLS
 │◀── tools.register (id 101) ──│
 │──── ack(101) ───────────────▶│
 │◀── events.on (id 102) ───────│
 │──── ack(102) ───────────────▶│
 │──── apply ack ──────────────▶│
 │                              │
 │──── tool.call ──────────────▶│
 │◀──── result ─────────────────│
```

**注册是双向的**：插件发起注册请求，宿主执行真实注册并把 disposer 记账到该插件的 owner 账本上。

### 4.4 超时与故障

| 情况 | 行为 |
|---|---|
| `boot` 超时（`startupMs`） | 杀进程，插件标记 `failed`，不拖垮其他插件 |
| `tool.call` 超时（`callMs`） | 返回 `isError: true` 的工具错误（**不杀进程**） |
| 插件进程崩溃 | 该插件的所有注册被撤销；按 `restart` 策略决定是否重启 |
| 插件 `os._exit()` | 同上，宿主存活 |
| 注册请求格式非法 | 拒绝并回 `ok:false`，插件可感知 |

---

## 5. 生命周期与所有权

```
discovered → loaded → applied → (enabled ⇄ disabled) → disposed
```

- **每次注册按 owner 记账**：`pluginId → [disposer...]`。
- `disable` = 撤销全部注册 + 停止 RPC 应答（插件对象留在 Cordis 上但无能力）。
- `dispose/unload` = 撤销全部注册 + 杀进程 + `ctx.dispose()` 卸载 Cordis 插件。
- **热重载三步**（缺一不可，否则静默失败）：
  1. 清 `sys.modules` 中的插件模块
  2. 撤销该 owner 的全部注册
  3. **删 `.pyc`**（CPython 的 pyc 校验只看 mtime + size，同秒改写会命中 stale pyc）

---

## 6. 后端抽象

两个后端实现同一接口，码头不关心差异。

```ts
interface Backend {
  readonly kind: 'python' | 'wasm'

  /** 启动插件实例，完成 boot/ready 握手 */
  start(spec: PluginSpec): Promise<BackendInstance>
}

interface BackendInstance {
  readonly pluginId: string

  /** 投递 apply，返回插件侧发起的全部注册意图 */
  apply(ctxBridge: CtxBridge): Promise<RegisterIntent[]>

  /** 调用一个由该插件注册的工具 */
  callTool(name: string, args: unknown, signal: AbortSignal): Promise<unknown>

  /** 投递一个事件给插件 */
  dispatchEvent(event: string, args: unknown[]): Promise<void>

  /** 优雅关闭；超时则强杀 */
  stop(reason: string): Promise<void>

  /** 能力探测，用于 capabilities 校验 */
  readonly capabilities: { tools: boolean; events: boolean; logger: boolean; effect: boolean }
}
```

**物理差异**：
- Python：**有进程边界**，走 NDJSON，天然异步、天然隔离。
- WASM：**独立 worker 线程**，走 postMessage + 内存 JSON 交换，超时靠 `worker.terminate()`。

> ⚠️ **重要教训（2026-10-26 事故）**
>
> 最初的设计让 WASM 在**主线程同进程同步执行**。这被证明是严重错误：
> V8 没有 fuel metering，也没有中断 wasm 执行的 API，所以一次死循环就会永久
> 阻塞 dsh 主线程 —— 连 `setTimeout` 超时定时器都跑不到，整个 dsh 卡死，所有
> 工具调用（包括 bash）全部超时。
>
> 现在 WASM 一律运行在 `worker_threads` 里。主线程只负责 `postMessage` 和
> 超时定时器，超时到就 `worker.terminate()`（唯一能真正杀掉死循环的手段）。
> 该行为由 `test/wasm-safety.mjs` 用真实的死循环 wasm 插件逐条断言。
>
> 代价：wasm 插件**不能同步回调宿主**（host import 跨线程无法同步返回）。
> v1 协议本来就是「apply 返回声明、宿主负责注册」，因此功能不受影响。
>
> 另：WASM 后端**默认关闭**，必须显式 `config.wasm.enabled = true` 才会加载。

---

## 7. WASM 通用 ABI（core-wasm，不依赖 WASI）

为兼容"任意能编译到 wasm 的语言"，ABI 只依赖最小核心：

### 7.1 必须导出

| 导出 | 签名 | 说明 |
|---|---|---|
| `memory` | memory | 线性内存 |
| `dsh_alloc` | `(len: i32) -> ptr: i32` | 分配缓冲区 |
| `dsh_free` | `(ptr: i32, len: i32) -> void` | 释放缓冲区 |
| `dsh_call` | `(ptr: i32, len: i32) -> i32` | 接收 JSON 请求，返回结果长度 |
| `dsh_result_ptr` | `() -> i32` | 返回结果缓冲区指针 |

### 7.2 约定

- 请求/响应都是 **UTF-8 JSON**，进出线性内存。
- `dsh_call` 返回后，结果在 `dsh_result_ptr()` 处，长度 = 返回值。
- 宿主读完结果后调用 `dsh_free`。
- **不要求 WASI**：插件若需要 IO/时间/随机，走宿主 host import（`dsh.*` 命名空间）。

### 7.3 为什么不用 WASI

`node:wasi` 每次启动都打印 "WASI is an experimental feature" 警告，且把插件暴露给完整
文件系统与网络——与"默认拒绝"的安全模型相反。core-wasm ABI 让宿主精确控制每项能力。

---

## 8. 安全模型

| 维度 | Python 子进程 | WASM worker 线程 |
|---|---|---|
| 隔离边界 | 操作系统进程 | 线程（同一进程地址空间） |
| 文件系统 | 默认可全盘访问（**危险，v1 不做限制**） | 默认不可访问 |
| 网络 | 默认可联网 | 默认不可访问 |
| 崩溃隔离 | 进程级，宿主不受影响 | 线程级，宿主不受影响 |
| 死循环 | 超时后杀子进程 | 超时后 `worker.terminate()` 杀线程 |
| 内存上限 | 无（子进程各算各的） | `resourceLimits.maxOldGenerationSizeMb = 256` |
| 环境变量 | 剔除 `KEY`/`PASSWORD`/`SECRET`/`TOKEN` 与 `DSH_*` | 不适用 |

> **诚实声明**：v1 的 Python 沙箱是"进程隔离"，**不是**"权限隔离"。插件能读写文件、
> 能发网络请求。只应运行可信插件。真正的权限沙箱属于后续版本。
>
> WASM 的隔离是"线程隔离"：能防止死循环拖垮宿主、能防止主动 IO（无 WASI preopens），
> 但**不是安全边界** —— 恶意 wasm 理论上可以做内存破坏类攻击。同样只应运行可信插件。

### 8.1 崩溃必须止于码头（三条硬约束）

外部插件写错了不能拖垮 dsh。以下每一条都对应一次真实事故，改动这块前请先读：

**① 子进程的 stdin 必须有 `'error'` 监听器**

```
fatal uncaught exception: Error: write EPIPE
    at Socket._write (node:internal/streams/writable:1183:8)
    at #write (src/backends/python.js)
```

根因不是"写入失败"，而是**没人监听**：子进程退出后往它 stdin 写会触发**异步**
`'error'` 事件，EventEmitter 找不到监听器就升级成 uncaught exception，直接杀掉 dsh。

`try/catch` 挡不住 —— 那是同步异常，EPIPE 是异步的。必须显式
`child.stdin.on('error', ...)`，并在出错后置 `stdinBroken` 避免后续写入反复报错。

**② 启动失败必须自己回收进程**

`start()` 里 boot 超时后如果直接 `throw`，已经 spawn 的 Python 进程就成了孤儿：
没人持有句柄，卸载也不会碰到它。所以 `start()` 失败路径要显式强杀（`#killNow`），
`#start` 的 catch 里再兜一次 `instance.stop()`。

**③ 外部插件的启动不能阻塞 `apply()`**

Cordis 的语义是：fiber 还在执行 `apply()` 时调用 `dispose()`，它会
`while (this.inertia) await this.inertia` —— **先等 apply 返回**，之后才跑 effect 清理。
所以 `apply()` 里如果 `await manager.boot()`，只要有一个插件在 apply 里卡死
（`time.sleep(600)`），卸载就得干等满 `startupMs`（默认 10 秒）。

实测：`await manager.boot()` 时 dispose 耗时 **10346ms**；改为后台启动后降到 **10ms**。

因此 `apply()` 发起 boot 后立即返回，插件在后台陆续就绪。这带来一个副作用：
`apply()` 返回时插件可能还没 applied —— 这是可接受的，工具是调用时查表，
`mloader_status` 会如实报告每个插件当前状态。

`teardown()` 里会 `abortStartup()` + 等 `bootTask` 收尾，再逐个回收实例。

---

## 9. 目录布局

### 9.1 正式安装位置：`<profile>/mloader/plugins/<plugin-id>`

插件装进 profile，不装在码头包目录里：

```
~/.dsh/profiles/<profile>/
└─ mloader/
   └─ plugins/                    ← 插件领地（自动成为 roots 之一）
      ├─ py-hello/
      │   ├─ mloader.plugin.json
      │   └─ plugin.py
      └─ wasm-hello/
          ├─ mloader.plugin.json
          └─ hello.wasm
```

**为什么不放 `profiles/<profile>/node_modules`**：那里归包管理器管。
`pnpm install` / `pnpm prune` 会按 lockfile 重建依赖树，手放进去的插件迟早被清掉。
`mloader/plugins` 是码头自己的领地，dsh 和 pnpm 都不会碰。

**为什么是 `mloader/plugins` 而不是直接 `mloader`**：给码头留出同级空间放未来的
日志/锁/清单，同时插件目录保持"整个删掉也能重建"的纯粹性。

### 9.2 roots 的解析规则

`roots` 支持三种写法：

| 写法 | 解析 |
|---|---|
| `~/.dsh/...` | 展开 home |
| `./x` 或 `x` | 相对 profile 目录（探测不到则用 cwd） |
| `/abs/path` | 原样 |

**并且**，除非 `profilePlugins: false`，`<profile>/mloader/plugins` 会被自动追加
（自动去重，重复写不会导致插件被加载两次）。

### 9.3 ⚠️ profile 目录探测（踩过两次的坑）

这一块直接决定"装完能不能用"，踩过两个坑，都记录在此。

#### 坑一：`DSH_PROFILE_DIR` 在真实 dsh 进程里不存在

`DSH_PROFILE_DIR` **不是**所有宿主进程都有 —— 它由 `dsh-shell-env` 包注入给
bash 工具。实测真实 dsh 主进程的 `/proc/<pid>/environ` 里
**一个 `DSH_*` 变量都没有**（`DSH_HOME` / `DSH_PROFILE` / `DSH_PROFILE_DIR` 全无），
`cwd` 是 `$HOME`。

如果只认 `DSH_PROFILE_DIR`，后果是：**码头正常启动、0 个插件、工具全部消失，
日志一个字都没有**。这个静默失败真实发生过一次。

#### 坑二：`import.meta.url` 反推不可靠

曾考虑用本模块的 `import.meta.url` 反推 profile 目录。但 `link:` 安装时
Node 解析到的是符号链接的**真实路径**（在 workspace 里），根本不含 profile。
只有 `github:` / registry 安装才落在 `<profile>/node_modules/` 下 ——
依赖安装方式的做法不能当基础。

#### 正确来源：`ctx.baseUrl`

dsh-app-boot 的 `boot()` 里有一行：

```js
ctx.baseUrl = pathToFileURL(dirname(absoluteConfigPath)).href + "/";
```

`absoluteConfigPath` 是 profile 下 `cordis.yml` 的绝对路径，所以
**`ctx.baseUrl` 就是当前 profile 目录的 file URL**。它由 dsh 主动设置，
不依赖环境变量，也不依赖安装方式 —— 这是"装完即用"的地基。

`resolveProfileDir()` 按可靠性依次回退：

1. 显式 `config.profileDir`（测试用）
2. **`ctx.baseUrl`** → 校验该目录确实有 `package.json` + `cordis.yml` 才接受
3. `DSH_PROFILE_DIR`
4. `DSH_HOME` + `DSH_PROFILE` → `${DSH_HOME}/profiles/${DSH_PROFILE}`（注意 **profiles 是复数**）
5. `~/.dsh/profiles/` 下按目录特征探测，**仅在恰好只有一个候选时**采用
6. 都不行 → `undefined`，**并打一条 warn**（不再静默）

> **多 profile 时第 5 步故意不猜**：猜错比返回 `undefined` 更糟，
> 会把插件读自/装进错误的地方。实测本机 4 个 profile 并存时，
> 无 `baseUrl` 无环境变量 → 返回 `undefined`（正确行为）。
>
> 因为第 2 步已经足够可靠，**生产配置不需要再写 `roots`** —— `roots: []` 即可。

### 9.4 ⚠️ profile 会被 dsh 整个删除的场景

`dsh --from-default-profile <template>` 会**删除整个 profile 目录**后重建
（源码 `profile-boot` 注释原文：*"only then is any previous target directory,
including its dependencies and user patch, deleted"*）。

所以**不要**对装着插件的 profile 用这个命令。它删的不只是配置，
还包括 `mloader/plugins` 里的插件本体。

### 9.5 内置示例的释放（seed）

码头首次启动时把包内 `seed/<plugin-id>/` 复制到 `<profile>/mloader/plugins/`，
供用户参考代码。这发生在 `manager.boot()` **之前**，所以第一次启动就能加载。

行为契约（实现见 `src/seed.js`，测试见 `test/seed.mjs`）：

| 场景 | 行为 |
|---|---|
| 目标目录不存在 | 复制整个示例目录 |
| 目标目录已存在（哪怕只有一个同名目录） | **整体跳过**，不合并、不覆盖 |
| 复制过程中出错 | 记一条 `warn`，继续启动，不影响其他示例和插件 |
| `seedExamples: false` | 完全不做文件系统操作 |
| 探测不到 profile 目录 | 不释放（不往别人的目录里塞东西） |

**「绝不覆盖」是硬约束**：用户很可能已经把示例改成自己的插件了。
任何形式的"增量更新"都会毁掉用户的改动，所以只做「存在即跳过」。

包内示例只放**纯文本**（Python 示例约 7 KB）。WASM 示例含 4.4 MB 的
`hello.wasm`，不放进 `seed/` 也不进版本库，避免拖累安装体积。

> **v1 不提供 WASM 的默认示例**。WASM 后端默认关闭，也没有随包释放的
> wasm 示例插件。等 WASM 那条路径的实测覆盖补够了再补示例 —— 现在放一个
> 默认关闭、用户打不开的示例，只会造成困惑。
>
> 需要 WASM 参考实现时，看 `test/plugins/wasm-hello/`（含 `main.go` 源码）。

### 9.6 码头的 Cordis config

```yaml
- id: dsh-mloader
  name: dsh-mloader
  config:
    roots: []               # 留空也行（profilePlugins 会自动加 profile 目录）
    profilePlugins: true    # 自动追加 <profile>/mloader/plugins
    autoEnable: true
    restartOnCrash: false
    pythonBin: python3
    statusTool: true        # 注册 mloader_status 工具（模型调用）
    statusCommand: true     # 注册 /mloader-status 命令（用户调用）
    seedExamples: true      # 首次启动释放内置示例（绝不覆盖用户改动）
    console: true           # 终端输出：true / 'verbose' / false
    # WASM 默认关闭；确认要跑 wasm 插件时才打开
    wasm:
      enabled: false
```

`console` 取值：

| 值 | 行为 |
|---|---|
| `true`（默认） | 只报生命周期节点：挂载 / 卸载 / 崩溃 / 跳过 / 失败 |
| `'verbose'` | 额外报扫描细节（插件根路径、发现几个插件） |
| `false` | 完全静默（连生命周期也不打） |

`statusCommand` 取值：

| 值 | 行为 |
|---|---|
| `true`（默认） | 注册 `/mloader-status` |
| `false` | 不注册命令 |
| `"<name>"` | 用自定义命令名（不含 `/`，须匹配 `/^[a-z][a-z0-9_-]*$/`） |

> 命令名用**连字符**（`mloader-status`）而非下划线，是为了和**工具名**
> `mloader_status` 在视觉上区分：`/` 开头的是命令（给人），下划线的是工具（给模型）。
> dsh 的命令正则 `/^[a-z][a-z0-9_-]*$/` 两者都接受。

#### 为什么终端输出要单独走 console

**`ctx.logger` 不会输出到终端。** 这是实测结论，也是 `src/console.js` 存在的唯一理由：

| 调用 | 终端 |
|---|---|
| `root.logger.info('x')` | 无输出 |
| `root.logger.warn('x')` | 无输出 |
| `console.log('x')` | 有输出 |

原因在实现里：

- Cordis 的 `LoggerService`（`cordis/lib/index.js`）构造时只注册一个把消息
  `push` 进内存环形缓冲区（`bufferSize = 1000`）的 exporter，没有终端 sink。
- dsh-app-boot 在 `boot()` 里额外注册的 exporter 也只有
  `export: ({...}) => { if (type === 'warn' || type === 'error') startupLogs.push(...) }`
  —— 收集起来供启动失败时诊断回放，同样不打印。

所以想在 `dsh web` 命令行里看到码头动静，**必须**显式写 console。这不是绕开
框架，而是这个框架里唯一的出口；本机其它插件也这么做
（`@tencent-connect/dsh-qqbot` 用 `console.log('[im-qqbot] Bot ready! ...')`）。

因此码头维护**两条通道**：

| 通道 | 去向 | 内容 | 谁看 |
|---|---|---|---|
| `ctx.logger` | 内存缓冲区 | 每条注册/撤销的细节 | 排障、`mloader_status` |
| `src/console.js` | 终端 | 只报生命周期节点 | 用户，一眼看清装了什么 |

两条通道**不重复**：终端只放生命周期，细节仍只进 logger。这样既不会因为
"日志没人看"而丢掉诊断信息，也不会让终端被注册细节刷屏。

**写失败必须吞掉**：`console.js` 的每次写入都包在 try/catch 里。终端管道
被关时 `process.stdout.write` 会抛 `EPIPE` —— 之前正是这类未捕获异常把
dsh 整个打挂过（详见 §8.1）。用 `console.log` 而非直接写 stdout，也是因为
Node 对前者有兜底。

---

## 10. v1 不做的事（明确边界）

1. 不替换 Cordis、不改 dsh Loader、不碰 bundle。
2. 不支持插件间直接调用（无 Service 注册 / 无 inject 解析到其他外部插件）。
3. 不做 Python 权限沙箱（只有进程隔离）。
4. 不持久化插件状态（重启即重新发现与挂载）。
5. 不支持插件 UI/Client half。
6. WASM 插件不能同步回调宿主（worker 线程限制，v1 的声明式模型不需要）。
