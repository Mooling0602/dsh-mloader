# 重启后的验收清单

> `dsh-mloader` 已安装进 `web` profile，
> `~/.dsh/profiles/web/cordis.patch.yml` 里已配好 `roots`，且 `wasm.enabled: false`。
> 你只需**重启 dsh**。

## 0. 重启

重启 dsh 的 Web 服务（或整个 dsh）。

启动日志里应能看到这样的行（`[mloader]` 前缀，直接打在 `dsh web` 的终端里）：

```
[mloader] 挂载 hello-mloader（python，工具 hello_add, hello_mloader）
[mloader] 挂载 py-decl（python，工具 py_add, py_stats）
[mloader] 挂载 py-hello（python，工具 py_echo, py_greet）
[mloader] 码头就绪：3 个插件已挂载
```

> 三个都是 Python 插件。WASM 后端默认关闭，v1 也不提供 WASM 的默认示例。
>
> **看不到 `[mloader]` 行？** 说明 `console` 被关掉了（`console: false`），
> 或者码头的 `roots` 没配对导致零插件 —— 后者会打
> `[mloader] warn: 没有可用的插件根目录，码头什么都没做`。
> 想看扫描细节，把配置里的 `console` 设成 `'verbose'`。

## 1. 加载器是否挂载成功

让模型调用：

```
mloader_status
```

期望看到 3 个插件：

| id | backend | state | tools |
|---|---|---|---|
| hello-mloader | python | applied | hello_add, hello_mloader |
| py-decl | python | applied | py_add, py_stats |
| py-hello | python | applied | py_greet, py_echo |

## 2. ★ 架构关键验收：外部插件"隐身"

这是你最初纠正我的那个点，必须验证：

- ✅ 工具列表里有：`py_greet` / `py_echo` / `py_add` / `py_stats` / `mloader_status`
- ❌ dsh 的**插件管理界面里没有** `py-hello` / `py-decl`
- ❌ 它们不是 Cordis 插件，没有自己的 `ctx` 作用域

打开设置 → 插件，搜 `py-`，**应该一个都搜不到**。

## 3. Python 工具能调

```
py_greet(who="世界")        → {"text": "你好，世界！"}
py_add(a=19, b=23)          → {"sum": 42}
py_stats(values=[1,2,3,4])  → {"count":4,"min":1,"max":4,"mean":2.5}
py_echo(payload={"x": 42})  → {"x": 42}
```

## 4. ★ 死锁回归验证（最重要）

`py-hello` 订阅了 `tools/execute`，并在处理器里调 `ctx.logger.debug` ——
这正是 2026-10-26 造成 dsh 全面卡死的那段代码。

**现在的行为**：
- 每次调用任**工具**（包括 `py_greet`、`bash`、`read`…），`py-hello` 都会收到事件并打一条 debug 日志
- **主链路不受影响**，工具调用立即返回
- 日志里能看到 `[py-hello] 观察到工具执行: {...}`

**验证方法**：连着调 5～10 次工具，每次都应该秒回。
如果出现任何一次卡住/超时 → **立刻回滚**（见 §8），然后告诉我。

## 5. 进程隔离验证

```bash
ps -ef | grep dsh_bootstrap
```

期望看到 **3 个** 进程（hello-mloader、py-hello、py-decl），父进程是 dsh 主进程。

## 6. 崩溃隔离（会杀掉一个 Python 插件）

```bash
# 找到 py-hello 的进程
ps -ef | grep dsh_bootstrap | grep python-hello

# 杀掉
kill -9 <pid>
```

然后：

- 调 `py_greet` → 应报错（插件未运行）
- 调 `py_add` → **必须正常**（另一个插件不受影响）
- dsh 本身**必须继续正常工作**
- `mloader_status` → `py-hello` 状态为 `failed`

## 7. 热重载（可选，v1 已知缺口）

`reload` 目前只能通过 `ctx.get('mloader').reload('py-hello')` 调用，
**还没有暴露成工具**。这是 v1 的已知缺口。

## 8. 出问题怎么回滚

**最快**：只禁用码头，不动其他配置：

```bash
cd ~/.dsh/profiles/web
cp cordis.patch.yml cordis.patch.yml.bak.rollback
python3 - <<'PY'
import pathlib
p = pathlib.Path('cordis.patch.yml')
s = p.read_text()
if '- id: dsh-mloader\n' in s and 'disabled: true' not in s.split('- id: dsh-mloader')[1][:40]:
    s = s.replace('- id: dsh-mloader\n', '- id: dsh-mloader\n  disabled: true\n', 1)
    p.write_text(s)
    print("码头已禁用，重启生效")
PY
```

然后重启 dsh。

**彻底移除**：

```bash
dsh plugin --profile web remove dsh-mloader
```

## 9. 已验证的测试基线

重启前代码已通过本机全部测试（**222 项断言**，11 套）：

| 测试 | 断言数 | 覆盖 |
|---|---|---|
| `integration.mjs` | 23 | Python 全链路 |
| `edge-cases.mjs` | 17 | schema/白名单/崩溃隔离/卸载 |
| `dual-backend.mjs` | 19 | Python + WASM 共存 |
| `wasm-safety.mjs` | 13 | ★ WASM 死循环不阻塞主线程 |
| `waterfall.mjs` | 10 | ★ 监听器不阻塞工具执行链 |
| `reentrancy.mjs` | 13 | ★ 端到端事件死锁回归（真实子进程） |
| `command.mjs` | 33 | `/mloader-status` 命令（真实 CommandRuntime） |
| `profile-install.mjs` | 37 | 插件装进 profile 的路径解析与加载（含 `ctx.baseUrl` 探测） |
| `seed.mjs` | 28 | 内置示例释放（含「绝不覆盖用户改动」） |
| `crash-safety.mjs` | 10 | EPIPE / 孤儿进程 / 卸载卡死 |
| `console.mjs` | 19 | 终端输出（三档详细度 / EPIPE 不抛出） |

```bash
cd dsh-mloader
for t in integration edge-cases dual-backend wasm-safety waterfall \
         reentrancy command profile-install seed crash-safety console; do
  printf "%-16s " "$t"; node test/$t.mjs 2>&1 | grep -E "全部通过|项失败"
done
```
