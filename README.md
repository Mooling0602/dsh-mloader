# dsh-mloader

**dsh 的多运行时插件码头** —— multi-runtime loader。

让 dsh 能跑 **Python** 和 **WASM** 插件 —— 而这两种插件本身不是 dsh 插件。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
[![](https://img.shields.io/github/license/Mooling0602/dsh-mloader?style=flat-square)](https://github.com/Mooling0602/dsh-mloader/blob/main/LICENSE)
[![](https://img.shields.io/github/stars/Mooling0602/dsh-mloader?style=flat-square)](https://github.com/Mooling0602/dsh-mloader/stargazers)

| | |
|---|---|
| 仓库 | <https://github.com/Mooling0602/dsh-mloader> |
| 安装 | `dsh plugin --profile web add github:Mooling0602/dsh-mloader` |
| 依赖 | 无（零运行时依赖，不需要构建） |
| 许可 | LGPL-3.0-only（你的插件可以闭源） |

> **名字的由来**：码头属于港口，但船不属于港口。
> 本插件属于 dsh（是普通 Cordis 插件），它托管的外部插件不属于 dsh（不是 Cordis 插件）。
> 一句话就是这个项目的全部架构。

---

## 它解决什么问题

dsh 是 Cordis 架构，"一切都是插件"。但 Cordis 的 loader 只做一件事：`import()` 一个 ESM 模块。
这意味着 **Python 插件在机制上不可能成为 dsh 插件** —— 没有 Python 分支，没有解释器，没有 `.py` 的加载路径。

`dsh-mloader` 的做法是：

```
dsh 主进程
└─ Cordis 容器
     └─ dsh-mloader              ← 唯一的 Cordis 插件（码头）
          ├─ py-hello  (Python 子进程)   ← 不是 Cordis 插件，不出现在插件列表
          ├─ py-decl   (Python 子进程)   ← 同上
          └─ wasm-hello (WASM worker 线程) ← 同上
```

**关键约束**（贯穿整个设计）：

- 外部插件**不是** Cordis 插件，**不产生** Cordis 插件实体，**不出现**在 dsh 的任何插件列表里。
- 它们只是"一组注册意图"，由本插件在自己的 `ctx` 上变成真实 dsh 能力。
- 本插件不替换 dsh 的插件加载层，也不接管已有插件。

---

## 快速开始

### 1. 安装

一行装好（[GitHub 仓库](https://github.com/Mooling0602/dsh-mloader)，不走 npm）：

```bash
dsh plugin --profile web add github:Mooling0602/dsh-mloader
```

`dsh plugin` 只是把参数转发给 profile 目录里的 pnpm，所以等价于：

```bash
cd ~/.dsh/profiles/web
pnpm add github:Mooling0602/dsh-mloader
```

想锁定版本（推荐，避免上游改动影响你）：

```bash
dsh plugin --profile web add github:Mooling0602/dsh-mloader#v0.1.0
```

也可以固定在某个 commit：

```bash
dsh plugin --profile web add github:Mooling0602/dsh-mloader#<commit-sha>
```

> **为什么用 `github:` 而不是包名**：本项目**不发布到 npm**（`private: true`）。
> pnpm 会直接从 GitHub 拉取仓库 tar 包，不需要注册表。
>
> 本包**零运行时依赖**、无 `prepare` 构建脚本，所以从 git 安装不需要编译，
> 也不需要额外装依赖。

从源码开发（改代码即时生效）：

```bash
dsh plugin --profile web add link:/path/to/dsh-mloader
```

装完就**重启 dsh**，不需要再改任何文件 —— 下一节说明为什么。

> **关于 `dsh.profile.bundles`**：装的时候 dsh 会自动把本包加进
> `package.json` 的 `dsh.profile.bundles`（因为本包声明了 `dsh.bundle.patch`），
> 你不需要手动编辑 `package.json`。装完可以用 `dsh --profile web --dump-config`
> 确认 `dsh-mloader` 出现在配置树里。
>
> **卸载**：`dsh plugin --profile web remove dsh-mloader`。
> 已装好的外部插件在 `<profile>/mloader/plugins/` 里，不会被连带删除；
> 要一起清掉就删这个目录。

### 2. 不需要配置

**装完就可以用了。** 本包自带 [`cordis.patch.yml`](cordis.patch.yml)，
dsh 会通过 `package.json` 的 `dsh.bundle.patch` 自动应用它 ——
你**不需要**在自己的 `~/.dsh/profiles/web/cordis.patch.yml` 里写任何东西。

插件放这里就行（目录不存在会自动创建，内置示例首次启动会释放进去）：

```
~/.dsh/profiles/web/mloader/plugins/<plugin-id>/
```

插件目录也是**自动发现**的：码头从 `ctx.baseUrl`（dsh 在启动时设成当前 profile 目录）
定位 profile，**不依赖任何环境变量**，也不需要在配置里写绝对路径 ——
所以同一个配置在多台机器、多个 profile 上都成立。

想改默认行为时才需要在 profile 的 `cordis.patch.yml` 里覆盖（同一个 `id`）：

```yaml
- id: dsh-mloader
  config:
    console: false       # 例如：关掉终端输出
```

**安装后自检**（三秒确认真的生效了）：

```bash
# 1. 配置树里有没有码头
dsh --profile web --dump-config | grep -A 12 'id: dsh-mloader'

# 2. 启动时终端有没有输出（应该能看到 [mloader] 开头的一行行）
dsh --profile web
#   [mloader] 释放内置示例：hello-mloader
#   [mloader] 挂载 hello-mloader（python，工具 hello_add, hello_mloader）
#   [mloader] 码头就绪：1 个插件已挂载

# 3. 插件目录在哪、装了什么
ls ~/.dsh/profiles/web/mloader/plugins/
```

如果**一行 `[mloader]` 都没有**：

- 检查 `console` 是否被覆盖成了 `false`；
- 检查包里是否真被加进了 `dsh.profile.bundles`（第 1 步没输出就说明没有，
  重新执行安装命令即可）；
- 包里没有任何插件是正常状态（此时会打一条 `没有可用的插件根目录` 或
  `没有任何插件挂载成功` 的 warn，不会静默）。

**全部配置项**（都有正确的默认值，通常一个都不用动）：

| 配置 | 默认 | 说明 |
|---|---|---|
| `roots` | `[]` | 额外的插件根目录。正常留空，`<profile>/mloader/plugins` 会自动发现 |
| `profilePlugins` | `true` | 把 `<profile>/mloader/plugins` 自动当插件根。测试时设 `false` |
| `profileDir` | `undefined` | 覆盖 profile 目录。**生产不要设**，仅供测试注入临时 profile |
| `autoEnable` | `true` | 自动启动 `enabled: true` 的插件 |
| `restartOnCrash` | `false` | 插件崩溃后自动重启 |
| `pythonBin` | `python3` | Python 解释器路径 |
| `statusTool` | `true` | 注册 `mloader_status` 工具（给模型用） |
| `statusCommand` | `true` | 注册 `/mloader-status` 命令（给你用）；也可填自定义命令名 |
| `seedExamples` | `true` | 首次启动释放内置示例；CI / 测试设 `false` |
| `console` | `true` | 终端输出。`true`=只报生命周期；`'verbose'`=加报扫描细节；`false`=静默 |
| `wasm.enabled` | `false` | WASM 后端开关。**默认关闭**，见「写一个 WASM 插件」 |

### 3. 安装插件

插件装进 **profile**，不是码头包目录：

```bash
mkdir -p ~/.dsh/profiles/web/mloader/plugins
cp -r /path/to/my-plugin ~/.dsh/profiles/web/mloader/plugins/
```

`~/.dsh/profiles/web/mloader/plugins/` 会被自动当作插件根（`profilePlugins: true`），
**不需要**在 `roots` 里重复声明。

> **为什么不装进 `node_modules`**：那里归包管理器管，`pnpm install` / `pnpm prune`
> 会按 lockfile 重建，手放的插件迟早被清掉。`mloader/plugins` 是码头自己的领地。

> ⚠️ **不要**对装着插件的 profile 执行 `dsh --from-default-profile` ——
> 它会**整个删除 profile 目录**（包括你装好的插件）。详见 ABI §9.4。

### 3.1 内置示例：装好就有东西可看

码头第一次启动时，会把包内自带的示例插件释放到
`~/.dsh/profiles/web/mloader/plugins/hello-mloader/`，作为**可读可改的参考实现**：

```
hello-mloader/
├── mloader.plugin.json   # 元数据：id / backend / entry / 超时
└── plugin.py             # 125 行，带注释，演示注册工具、订阅事件、注册清理
```

释放后立刻可用，无需再重启：

```
hello_mloader   向指定的人问好，并回显码头信息
hello_add       两个数字相加
```

**三条行为保证**：

| 行为 | 说明 |
|---|---|
| **绝不覆盖** | 目录已存在就整体跳过。你改过的 `plugin.py`、新增的笔记文件，一个字节都不会动 |
| **失败不拖垮码头** | 磁盘满、权限不足只会记一条 warn，插件加载照常 |
| **可关闭** | 配置 `seedExamples: false` 完全不碰磁盘（CI / 测试需要） |

想换个干净环境，直接删掉 `hello-mloader/` 即可；下次启动会重新释放。

> 示例的源码在包内 `seed/hello-mloader/`。它是**唯一来源**，
> 装好码头就有，不需要另外下载。


### 4. 重启 dsh

两种方式查看挂载状态：

| 方式 | 谁调用 | 用法 |
|---|---|---|
| **斜杠命令** | **你**（在输入框敲） | `/mloader-status` 或 `/mloader-status py-hello` |
| 工具 | **模型** | 让模型调 `mloader_status` |

两者读同一份数据（`src/tools/status.js` 的 `buildStatus` + `format`），不会漂移。

**命令名为什么用连字符**：dsh 的命令名校验是 `/^[a-z][a-z0-9_-]*$/`，
下划线和连字符都合法。连字符与 dsh 现有命令风格（`/compact`、`/goal`）一致，
且不会和 `mloader_status` 这个**工具名**混淆 —— 命令是 `/` 开头、工具是下划线，一眼分得清。

需要改名或关掉：

```yaml
    statusCommand: false              # 不注册
    statusCommand: my-loader-status   # 用自定义名（必须匹配上面的正则）
```

> 命令依赖 dsh 的 `commands` 服务。该服务是**可选**的：老版本 dsh 没有，或者
> 你关掉了 `dsh-commands` 插件时，码头会跳过命令注册并记一条 debug 日志，
> **不影响插件挂载**。这是刻意的 —— 命令是锦上添花，不该让整个码头起不来。

### 4.1 终端会看到什么

码头装了什么、卸了什么，会直接打印在 `dsh web` 的那个终端里：

```
[mloader] 释放内置示例：hello-mloader
[mloader] 挂载 hello-mloader（python，工具 hello_add, hello_mloader）
[mloader] 挂载 py-decl（python，工具 py_add, py_stats）
[mloader] 挂载 py-hello（python，工具 py_echo, py_greet）
[mloader] 码头就绪：3 个插件已挂载
```

卸载时：

```
[mloader] 码头卸载中，回收 3 个插件…
[mloader] 卸载 hello-mloader
[mloader] 卸载 py-decl
[mloader] 卸载 py-hello
[mloader] 码头已卸载
```

失败和跳过也会说清楚，不会静默吞掉：

```
[mloader] 跳过 wasm-hello（WASM 后端未开启）
[mloader] error: 插件 bad-plugin 加载失败：entry 文件不存在
[mloader] warn: 插件 crashy 的进程退出（code=1 signal=null），已撤销其注册
```

三档详细度：

| `console` | 输出 |
|---|---|
| `true`（默认） | 只报生命周期：挂载 / 卸载 / 崩溃 / 跳过 / 失败 |
| `'verbose'` | 额外报扫描细节（插件根路径、发现几个） |
| `false` | 完全静默 |

> **为什么不用 `ctx.logger` 打印**：dsh 的 `ctx.logger` **不会输出到终端**。
> Cordis 的 `LoggerService` 只把消息 push 进一个内存环形缓冲区（1000 条），
> dsh-app-boot 的 exporter 也只把 warn/error 收进 `startupLogs` 用于诊断回放。
>
> 实测（裸 Cordis）：
>
> ```js
> root.logger.info('x')   // 终端无输出
> root.logger.warn('x')   // 终端无输出
> console.log('x')        // 有输出
> ```
>
> 所以终端输出必须走 console —— 这不是绕开框架，而是这个框架里唯一的出口。
> 本机其它插件也这么做：`@tencent-connect/dsh-qqbot` 就是
> `console.log('[im-qqbot] Bot ready! ...')`。
>
> 码头做成**两条通道**，互不浪费：
>
> | 通道 | 去向 | 内容 |
> |---|---|---|
> | `logger` | 内存缓冲区 | 详细诊断（每条注册/撤销），供 `mloader_status` 与排障 |
> | `console` | 终端 | 只报生命周期节点，一眼看清装了什么 |

---

## 写一个 Python 插件

一个目录，两个文件。

**`mloader.plugin.json`**

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "backend": "python",
  "entry": "plugin.py",
  "enabled": true,
  "timeouts": { "startupMs": 10000, "callMs": 30000 }
}
```

**`plugin.py`** —— 风格 A（对齐 Cordis 的 `apply`）:

```python
from dsh_runtime import plugin

@plugin
def apply(ctx):
    @ctx.tools.register(
        name="greet",
        description="向指定的人问好",
        parameters={
            "type": "object",
            "properties": {"who": {"type": "string"}},
            "required": ["who"],
            "additionalProperties": False,
        },
    )
    def greet(args):
        return {"text": f"你好，{args['who']}！"}

    @ctx.on("tools/execute")
    def on_tool(payload):
        ctx.logger.debug(f"工具执行: {payload}")

    ctx.effect.register("cleanup", lambda: ctx.logger.info("卸载中"))
```

或者**风格 B**（声明式，不写 `apply`）:

```python
from dsh_runtime import tool

TOOLS = []

@tool(
    name="add",
    description="两数相加",
    parameters={
        "type": "object",
        "properties": {"a": {"type": "number"}, "b": {"type": "number"}},
        "required": ["a", "b"],
        "additionalProperties": False,
    },
)
def add(args):
    return {"sum": args["a"] + args["b"]}
```

两种风格可以混用。

### Python 侧可用的 `ctx`

| 能力 | 说明 |
|---|---|
| `ctx.tools.register(...)` | 注册一个工具（装饰器） |
| `ctx.on(event, fn)` | 订阅白名单内的事件 |
| `ctx.logger.info/warn/error/debug` | 写日志到宿主 |
| `ctx.effect.register(label, fn)` | 注册卸载时执行的清理 |

### ⚠️ 工具 schema 的限制

dsh 只接受 JSON Schema 的一个**子集**：

```
type / oneOf / properties / required / additionalProperties / items / enum / const
+ 注解：description / title / default / examples
```

**`format` 会被拒绝**（已实测）。写了会在挂载时被码头拦下并报错，不会污染 dsh。

---

## 写一个 WASM 插件

WASM 插件用 **core-wasm ABI**（见 [docs/ABI.md §7](docs/ABI.md)），需要导出 5 个符号：

| 导出 | 签名 | 作用 |
|---|---|---|
| `memory` | — | 线性内存 |
| `dsh_alloc` | `(size: u32) -> u32` | 分配请求缓冲区，返回指针 |
| `dsh_free` | `(ptr: u32, size: u32) -> void` | 释放 |
| `dsh_call` | `(ptr: u32, len: u32) -> u32` | 处理请求，返回结果字节数 |
| `dsh_result_ptr` | `() -> u32` | 返回结果缓冲区指针 |

宿主把 `{"op": "...", "payload": {...}}` 写进内存后调 `dsh_call`，插件写回 `{"ok": true, "result": {...}}`。

> ⚠️ **WASM 后端默认关闭，v1 也不提供默认示例。**
>
> 开启方式：配置 `wasm: { enabled: true }`。
> 参考实现看 `test/plugins/wasm-hello/`（含 Go 源码 `main.go`），
> 但那不是随包释放的示例，需要自己编译：
>
> ```bash
> cd test/plugins/wasm-hello
> GOOS=wasip1 GOARCH=wasm go build -o hello.wasm .
> ```
>
> **为什么现在不提供默认示例**：WASM 那条路径的故障注入覆盖还不够
> （尤其 Go `wasip1` 的 command 模型，见下方「未验证」一节）。
> 放一个默认关闭、用户打不开的示例只会造成困惑。等覆盖补够了再补示例。

> **实测结论**：Go 编译到 `wasip1` 后，运行时依赖 WASI 做初始化（`_start`）。
> 码头会自动探测模块是否 import `wasi_snapshot_preview1`：
> 有则用 `node:wasi` 提供最小实现（**无文件系统、无网络、无环境变量**），没有则纯 core-wasm 实例化。
>
> Rust 需要 `wasm32-unknown-unknown` target（本机未安装，未实测）。

---

## 安全边界（请如实看待）

| 后端 | 隔离方式 | 实际能力 |
|---|---|---|
| Python | 独立子进程 | 进程隔离。**不是权限隔离**：插件能读写文件、发网络请求。环境变量里的 `*KEY*`/`*TOKEN*`/`*SECRET*`/`*PASSWORD*` 和 `DSH_*` 会被清除。 |
| WASM | 独立 worker 线程 | 无 WASI preopens，无法主动做 IO。死循环会被 `worker.terminate()` 杀掉。内存上限 256MB。 |

> ⚠️ **2026-10-26 事故记录**
>
> 最初的 WASM 后端在**主线程同进程同步执行**。一次死循环直接卡死了整个 dsh ——
> 所有工具调用（包括 bash）全部超时，只能重启恢复。
>
> 根因：V8 没有 fuel metering，也没有中断 wasm 的 API。同步调用 wasm 等于把主线程
> 交给插件摆布，连超时定时器都跑不到。
>
> 修复：WASM 一律跑在 `worker_threads` 里，超时即 `worker.terminate()`。
> 由 `test/wasm-safety.mjs` 用真实死循环插件逐条断言，并且 **WASM 后端默认关闭**。

> ⚠️ **2026-10-26 事故二：事件死锁**
>
> 第二次卡死。插件在 `tools/execute` 事件处理器里调 `ctx.logger.debug`，
> 而 listener 写成了 `async (...) => await dispatchEvent(...)`。
> Cordis 的 **waterfall 会 await 监听器返回值**，于是宿主阻塞在「等插件事件回包」；
> 插件同时同步等 logger 的 RPC 回包 → **永久互等** → tools 通道占满，
> 所有工具调用（含 bash）全部超时。
>
> 根因是两个错误的组合：
> 1. listener 里 `await` 了插件，堵住 waterfall 主链路
> 2. Python 侧 `ctx.logger` 用同步 RPC，在事件处理器内回调宿主
>
> 修复：listener 改为 fire-and-forget 分发插件事件 + **同步调用 `next()`** 传递执行链
> （不调 `next()` 会让工具执行体根本不运行、返回值变 `undefined`——这是修一版时踩的坑），
> Python 侧 logger 改为**单向通知**。由 `test/waterfall.mjs`（10 项）断言。

**v1 的诚实结论**：
- Python 沙箱 = 进程隔离，仅此而已。不要运行不信任的 Python 代码。
- WASM 隔离 = 线程隔离 + 无 IO。能防死循环拖垮宿主，**不是**安全边界。

---

## 已验证 / 未验证

### ✅ 已在本机实测

十二套测试、**265 项断言**全绿（其中 32 项需要 wasm 二进制）：

- 真实 Cordis `Context` + 真实 `dsh-tools` `ToolRuntime` 全链路（23 项）
- 边界场景：schema 预校验、事件白名单、崩溃隔离、卸载清理（17 项）
- Python + WASM 双后端共存（19 项）
- **WASM 死循环不阻塞主线程**（13 项，真实死循环 wasm 插件）
- **事件监听器不阻塞工具执行链**（10 项，覆盖真实 waterfall 语义）
- **Python 子进程重入不死锁**（13 项）
- **★ 宿主 exec 对象安全跨进程**：环 / AbortSignal 投影 + 脏载荷后工具仍可用（43 项）
- `/mloader-status` 命令，真实 `CommandRuntime`（33 项）
- 插件装进 profile 的路径解析与加载（37 项）
- **内置示例释放**，含「绝不覆盖用户改动」（28 项）
- **插件进程崩溃不拖垮 dsh**：EPIPE / 孤儿进程 / 卸载卡死（10 项）
- **终端输出**：三档详细度、EPIPE 不抛出、真实挂载/卸载可见（19 项）

其他：

- 真实 Go 编译产物往返调用（`wasm_add` → 42，`wasm_upper` → `HELLO WASM`）
- 安装进 `web` profile，`--dump-config` 合成正确，**外部插件不出现在插件列表**
- 重启 dsh 后真实挂载，Python 工具全部可调

### ⚠️ 未验证 / 已知风险

- Rust / C 的 WASM 产物（本机缺 `wasm32-unknown-unknown` target）
- 热重载的 `.pyc` 清理（代码已含，未端到端跑通）
- Windows / macOS（只在 Linux aarch64 Android/Termux 验证）
- **Go 的 `wasip1` 是 command 模型**：`_start` 会 `proc_exit`，之后反复调用属未定义行为。
  推荐 Rust/C/Zig 的 `wasm32-unknown-unknown`（reactor 模型）。详见 [docs/ABI.md](docs/ABI.md)。
- **WASM 没有默认示例**：v1 不提供，见「写一个 WASM 插件」。
- `/mloader-status` 的**输入补全**未在浏览器层面验证（命令本身已测）。
- 安全边界是**进程/线程隔离**，不是权限沙箱 —— 见「安全边界」。

---

## 目录结构

```
dsh-mloader/                    ← 码头本体（工作区）
├── src/
│   ├── index.js              # Cordis 插件入口 + PluginManager
│   ├── contract.js           # 事件白名单、schema 校验、roots 解析
│   ├── discovery.js          # 扫描 roots 找 mloader.plugin.json
│   ├── registrar.js          # ★ 注册账本（核心：把插件意图落成 dsh 能力）
│   ├── serialize.js          # ★ 跨进程载荷投影（环 / AbortSignal → 纯数据）
│   ├── backends/
│   │   ├── python.js         # Python 子进程 + NDJSON RPC
│   │   ├── wasm.js           # WASM 宿主侧（worker 管理 + 超时 terminate）
│   │   └── wasm-worker.js    # WASM 实例（跑在独立线程里）
│   ├── runtime/
│   │   ├── dsh_bootstrap.py  # Python 侧启动脚本
│   │   └── dsh_runtime.py    # Python 侧 ctx 实现
│   ├── tools/status.js       # mloader_status 工具（模型调用）
│   ├── commands/status.js    # /mloader-status 命令（用户调用）
│   ├── seed.js               # 内置示例释放（存在即跳过，绝不覆盖用户改动）
│   └── console.js            # ★ 终端输出（dsh 的 ctx.logger 不打印到终端）
├── seed/                     # ★ 内置示例（安装后释放到 profile）
│   └── hello-mloader/        #   用户可读可改的参考实现（唯一的随包示例）
├── test/                     # 十二套测试 + 测试用插件
│   ├── *.mjs                 #   测试本体
│   ├── plugins/              #   测试用插件（python-hello / python-advanced / wasm-hello）
│   ├── deadlock/             #   事件死锁回归夹具（reentrant）
│   ├── exec-payload/         #   ★ exec 对象跨进程夹具（exec-observer）
│   └── fixtures/             #   故障注入用（faulty / guarded / wasm-loop）
└── docs/
    ├── ABI.md                # 完整契约（权威）
    └── VERIFY.md             # 重启后验收清单

~/.dsh/profiles/web/            ← profile（配置 + 已安装的插件）
├── cordis.patch.yml            #   码头配置（id / roots）
├── package.json                #   link 声明
├── node_modules/dsh-mloader →  #   指回工作区
└── mloader/plugins/            # ★ 插件安装位置（真实文件）
    ├── hello-mloader/        # 内置示例（首次启动自动释放）
    ├── python-hello/
    └── python-advanced/
```

> **两处职责分得很清**：工作区放**代码**，profile 放**配置 + 插件**。
> 改码头代码不用碰 profile；装插件不用碰包目录。

---

## 跑测试

```bash
# 需要能解析 @deepseek-ai/cordis 和 @deepseek-ai/dsh-tools
mkdir -p node_modules
ln -sfn <dsh安装路径>/node_modules/@deepseek-ai node_modules/@deepseek-ai

node test/integration.mjs      # 23 项：Python 全链路
node test/edge-cases.mjs       # 17 项：边界与故障
node test/dual-backend.mjs     # 19 项：Python + WASM 共存（需 wasm 二进制，否则跳过）
node test/wasm-safety.mjs      # 13 项：★ WASM 死循环不阻塞主线程（同上，否则跳过）
node test/waterfall.mjs        # 10 项：★ 事件监听器不阻塞工具执行链
node test/reentrancy.mjs       # 13 项：★ 真实 Python 子进程重入不死锁
node test/exec-payload.mjs     # 43 项：★ 宿主 exec 对象安全跨进程（环 / AbortSignal 投影）
node test/command.mjs          # 33 项：/mloader-status 命令（真实 CommandRuntime）
node test/profile-install.mjs  # 37 项：插件装进 profile 的路径解析与加载（含 ctx.baseUrl 探测）
node test/seed.mjs             # 28 项：内置示例释放（含「绝不覆盖用户改动」）
node test/crash-safety.mjs     # 10 项：插件进程崩溃不拖垮 dsh（EPIPE / 孤儿进程 / 卸载卡死）
node test/console.mjs          # 19 项：终端输出（三档详细度 / EPIPE 不抛出）
```

合计 **265 项断言**（其中 32 项需要 wasm 二进制）。每套跑 4-6 秒，
建议一次跑一两个（工具调用有 15 秒上限）。

> **关于 wasm 二进制**：`.wasm` 文件不进版本库（见 `.gitignore`），所以从 git clone
> 出来默认没有它们。`dual-backend` 和 `wasm-safety` 两套会自动**跳过**（不是失败）——
> 那是环境缺文件，不是代码有问题。
>
> 但请注意：`wasm-safety` 覆盖的是「wasm 死循环不能阻塞宿主」这一**关键安全性质**。
> 跳过意味着该项**没有被验证**。要跑完整测试，先编译出二进制：
>
> ```bash
> cd test/plugins/wasm-hello && GOOS=wasip1 GOARCH=wasm go build -o hello.wasm .
> cd test/fixtures/wasm-loop && GOOS=wasip1 GOARCH=wasm go build -o loop.wasm .
> ```
>
> 两处 `main.go` 源码都在仓库里，只是编译产物不入库。


---

## 设计文档

完整契约见 **[docs/ABI.md](docs/ABI.md)**，包括：

- 设计公理（码头是普通 Cordis 插件；外部插件不是 Cordis 插件；能力白名单；注册可逆）
- manifest 完整 schema
- NDJSON RPC 协议与时序
- 生命周期状态机
- Backend / BackendInstance 接口
- core-wasm ABI 细节
- v1 明确的非目标

---

## License

**GNU LGPL v3**（`LGPL-3.0-only`）。

```
LICENSE         LGPL v3 附加条款
COPYING         GNU GPL v3 全文（LGPL v3 通过引用纳入其条款）
COPYING.LESSER  LGPL v3 附加条款（FSF 惯例文件名）
NOTICE          版权归属、插件授权说明、依赖清单
```

LGPL v3 由两部分组成：GPL v3 的全部条款，加上 LGPL 的附加许可。
两份文件缺一不可，请一并阅读。

### 你的插件可以是闭源的

本许可证**只约束码头自身**。通过码头加载的外部插件是独立作品，
不受本许可证约束 —— 你可以为自己的插件选择任何许可证，包括闭源。
这正是选择 LGPL 而非 GPL 的原因。

### 依赖

本项目依赖的 DeepSeek Harness 及其组件均为 **MIT**：

| 包 | 许可证 |
|---|---|
| `@deepseek-ai/dsh` | MIT |
| `@deepseek-ai/cordis` | MIT |
| `@deepseek-ai/dsh-tools` | MIT |
| `@deepseek-ai/dsh-commands` | MIT |

MIT 与 LGPL-3.0 兼容。本项目**不包含**上述软件的任何代码副本，只通过 import 使用。
