"""dsh-mloader — Python 运行时（插件侧 SDK）

插件作者唯一需要 import 的东西：

    from dsh_runtime import ctx, plugin

    @plugin
    def apply(ctx):
        @ctx.tools.register(name="py_greet", description="向某人问好",
                            parameters={"type": "object",
                                        "properties": {"who": {"type": "string"}},
                                        "required": ["who"]})
        def py_greet(args):
            return {"text": f"你好，{args['who']}！"}

或声明式风格：

    from dsh_runtime import tool

    @tool(name="py_add", description="两数相加",
          parameters={"type": "object",
                      "properties": {"a": {"type": "number"}, "b": {"type": "number"}},
                      "required": ["a", "b"]})
    def py_add(args):
        return {"sum": args["a"] + args["b"]}

协议见 docs/ABI.md §4。纯标准库，无第三方依赖。
"""

from __future__ import annotations

import importlib.util
import json
import sys
import traceback

PROTOCOL_VERSION = 1


class PluginCallError(RuntimeError):
    """宿主拒绝了插件的一次调用（schema 非法、工具名冲突等）。"""


class HostUnavailable(RuntimeError):
    """宿主通道已关闭。"""


# ─────────────────────────────────────────────────────────────────────────────
# 通道
# ─────────────────────────────────────────────────────────────────────────────


class _Channel:
    """stdout 上的 NDJSON 双向通道。

    stdout 是协议通道 —— 插件里任何 print() 都会污染它。需要调试输出请用
    ctx.logger，或写 stderr。
    """

    def __init__(self, stdin, stdout):
        self._stdin = stdin
        self._stdout = stdout
        self._next_id = 1
        self.closed = False

    def send(self, frame):
        if self.closed:
            raise HostUnavailable("channel is closed")
        self._stdout.write(json.dumps(frame, ensure_ascii=False, separators=(",", ":")) + "\n")
        self._stdout.flush()

    def read_frame(self):
        """读一帧；EOF 返回 None。空行与非 JSON 行被跳过。"""
        while True:
            line = self._stdin.readline()
            if not line:
                self.closed = True
                return None
            line = line.strip()
            if not line:
                continue
            try:
                frame = json.loads(line)
            except json.JSONDecodeError:
                # 不是合法帧，极可能是用户误写了 print()；忽略并继续。
                print(f"[dsh_runtime] ignoring non-JSON line: {line[:120]}", file=sys.stderr)
                continue
            if isinstance(frame, dict):
                return frame

    def request(self, op, payload=None):
        """发一条请求并同步等宿主应答（单线程阻塞模型）。"""
        request_id = self._next_id
        self._next_id += 1
        self.send({"v": PROTOCOL_VERSION, "id": request_id, "op": op, "payload": payload or {}})

        while True:
            frame = self.read_frame()
            if frame is None:
                raise HostUnavailable("host closed the channel")
            if frame.get("id") == request_id and ("ok" in frame or "error" in frame):
                if frame.get("ok"):
                    return frame.get("result")
                raise PluginCallError((frame.get("error") or {}).get("message", "host rejected the request"))
            if "op" in frame:
                _serve_host_request(self, frame)

    def respond(self, request_id, ok, result=None, error=None):
        frame = {"v": PROTOCOL_VERSION, "id": request_id, "ok": ok}
        if ok:
            frame["result"] = result
        else:
            frame["error"] = error or {"message": "unknown error"}
        self.send(frame)


# ─────────────────────────────────────────────────────────────────────────────
# 全局状态（单例）
# ─────────────────────────────────────────────────────────────────────────────


class _State:
    def __init__(self):
        self.channel: _Channel | None = None
        self.context: Context | None = None
        self.apply_fn = None
        self.tool_handlers: dict[str, object] = {}
        self.event_handlers: dict[str, object] = {}
        self.cleanups: list = []
        self.declared_tools: list[dict] = []


_state = _State()


# ─────────────────────────────────────────────────────────────────────────────
# ctx 投影（白名单，见 docs/ABI.md §3）
# ─────────────────────────────────────────────────────────────────────────────


class ToolNamespace:
    """`ctx.tools` —— 工具注册。"""

    def __init__(self, state: _State):
        self._state = state

    def register(self, name, description, parameters=None, output=None, timeout_ms=None):
        """注册一个工具，可作为装饰器使用。"""

        def decorator(fn):
            self._commit(
                {
                    "name": name,
                    "description": description,
                    "parameters": parameters
                    or {"type": "object", "properties": {}, "additionalProperties": False},
                    **({"output": output} if output is not None else {}),
                    **({"timeoutMs": timeout_ms} if timeout_ms is not None else {}),
                },
                fn,
            )
            return fn

        return decorator

    def _commit(self, spec, fn):
        _state.channel.request("tools.register", {"tool": spec})
        _state.tool_handlers[spec["name"]] = fn


class EventNamespace:
    """`ctx.on` —— 事件订阅（白名单见 docs/ABI.md §3.1）。"""

    def __init__(self, state: _State):
        self._state = state

    def __call__(self, event):
        return self.on(event)

    def on(self, event):
        """订阅一个事件，可作为装饰器使用。"""

        def decorator(fn):
            self._state.channel.request("events.on", {"event": event})
            self._state.event_handlers[event] = fn
            return fn

        return decorator


class LoggerNamespace:
    """`ctx.logger` —— **单向**日志。

    关键：绝不等待宿主回包。

    反例（曾经的事故）：早期实现用 ``channel.request("logger.log", ...)`` 同步等应答。
    插件在事件处理期间调 logger 时，宿主正阻塞在事件分发上、没在读 stdin，
    双方互等，最终占满 tools 通道，dsh 所有工具调用一起超时。

    日志本质是单向的，本来就不需要回包：这里直接 ``send()`` 后立即返回。
    即使宿主不在读、管道写满，最坏也只是这一条日志丢失，绝不会死锁。
    """

    def __init__(self, state: _State):
        self._state = state

    def _log(self, level, message, data=None):
        payload = {"level": level, "message": str(message)}
        if data is not None:
            payload["data"] = data
        try:
            channel = self._state.channel
            if channel is None:
                return
            # 单向通知，不等回包。
            channel.send(
                {
                    "v": PROTOCOL_VERSION,
                    "id": channel._next_id,
                    "op": "logger.log",
                    "payload": payload,
                    "notification": True,
                }
            )
            channel._next_id += 1
        except Exception:  # noqa: BLE001 - 日志失败绝不该拖垮插件
            pass

    def debug(self, message, data=None):
        self._log("debug", message, data)

    def info(self, message, data=None):
        self._log("info", message, data)

    def warn(self, message, data=None):
        self._log("warn", message, data)

    warning = warn

    def error(self, message, data=None):
        self._log("error", message, data)


class EffectNamespace:
    """`ctx.effect` —— 注册带清理的副作用。"""

    def __init__(self, state: _State):
        self._state = state

    def register(self, label, cleanup=None):
        """登记一个副作用；cleanup 在插件卸载时按 LIFO 顺序调用。"""
        if cleanup is not None:
            self._state.cleanups.append(cleanup)
        self._state.channel.request("effect.register", {"label": label})

    def run_cleanups(self):
        while self._state.cleanups:
            cleanup = self._state.cleanups.pop()
            try:
                cleanup()
            except Exception:  # noqa: BLE001
                traceback.print_exc(file=sys.stderr)


class Context:
    """投影给插件的 ctx。刻意只暴露四项能力。"""

    def __init__(self, state: _State):
        self.tools = ToolNamespace(state)
        self.on = EventNamespace(state)
        self.logger = LoggerNamespace(state)
        self.effect = EffectNamespace(state)


# ─────────────────────────────────────────────────────────────────────────────
# 装饰器
# ─────────────────────────────────────────────────────────────────────────────


def plugin(fn=None, *, name=None):
    """把 `apply(ctx)` 标记为插件入口。可 `@plugin` 也可 `@plugin(name=...)`。"""

    def decorate(func):
        _state.apply_fn = func
        return func

    if fn is not None and callable(fn):
        return decorate(fn)
    return decorate


def tool(name, description, parameters=None, output=None, timeout_ms=None):
    """声明式风格（风格 B）：收集工具声明，由 loader 主动注册。"""

    def decorator(fn):
        entry = {"name": name, "description": description, "handler": fn}
        if parameters is not None:
            entry["parameters"] = parameters
        if output is not None:
            entry["output"] = output
        if timeout_ms is not None:
            entry["timeoutMs"] = timeout_ms
        _state.declared_tools.append(entry)
        return fn

    return decorator


def get_context() -> Context | None:
    """当前 ctx。apply 之外调用返回 None。"""
    return _state.context


# `from dsh_runtime import ctx` 拿到的是一个代理：
# 它在 boot 之后才真正可用，但引用关系在 import 时就能建立。
class _CtxProxy:
    def __getattr__(self, item):
        ctx = _state.context
        if ctx is None:
            raise HostUnavailable("ctx is not available before boot")
        return getattr(ctx, item)


ctx = _CtxProxy()


# ─────────────────────────────────────────────────────────────────────────────
# 宿主请求处理（事件投递等）
# ─────────────────────────────────────────────────────────────────────────────


def _serve_host_request(channel: _Channel, frame):
    op = frame.get("op")
    payload = frame.get("payload") or {}

    if op == "event":
        event = payload.get("event")
        args = payload.get("args") or []
        handler = _state.event_handlers.get(event)
        if handler is None:
            channel.respond(frame.get("id"), True, None)
            return
        try:
            result = handler(*args) if len(args) != 1 else handler(args[0])
            channel.respond(frame.get("id"), True, result)
        except Exception as exc:  # noqa: BLE001
            channel.respond(frame.get("id"), False, error={"message": str(exc)})
        return

    if op == "dispose":
        try:
            _state.context.effect.run_cleanups() if _state.context else None
        except Exception:  # noqa: BLE001
            pass
        channel.respond(frame.get("id"), True, {"disposed": True})
        raise SystemExit(0)

    channel.respond(frame.get("id"), False, error={"message": f"unsupported host op {op}"})


# ─────────────────────────────────────────────────────────────────────────────
# 主循环
# ─────────────────────────────────────────────────────────────────────────────


def _load_plugin_module(plugin_path):
    spec = importlib.util.spec_from_file_location("dsh_user_plugin", plugin_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load plugin module from {plugin_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["dsh_user_plugin"] = module
    spec.loader.exec_module(module)
    return module


def _collect_declared(module):
    entries = list(_state.declared_tools)
    module_tools = getattr(module, "TOOLS", None)
    if isinstance(module_tools, list):
        entries.extend(module_tools)
    return entries


def run(plugin_path):
    """插件进程主入口。由 dsh_bootstrap.py 调用。"""
    channel = _Channel(sys.stdin, sys.stdout)
    _state.channel = channel
    _state.context = Context(_state)

    # ── STEP 1: boot —— 加载模块，回 ready ──
    boot = channel.read_frame()
    if boot is None:
        return 0
    if boot.get("op") != "boot":
        channel.respond(boot.get("id"), False, error={"message": "expected boot"})
        return 1

    try:
        module = _load_plugin_module(plugin_path)
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc(file=sys.stderr)
        channel.respond(boot.get("id"), False, error={"message": f"import failed: {exc}"})
        return 1

    plugin_id = (boot.get("payload") or {}).get("pluginId")
    channel.respond(boot.get("id"), True, {
        "pluginId": plugin_id,
        "python": sys.version.split()[0],
    })

    # ── STEP 2: apply —— 执行注册，回注册清单 ──
    apply_frame = channel.read_frame()
    if apply_frame is None:
        return 0
    if apply_frame.get("op") != "apply":
        channel.respond(apply_frame.get("id"), False, error={"message": "expected apply"})
        return 1

    try:
        # 先注册声明式风格的 TOOLS
        for entry in _collect_declared(module):
            spec = {
                "name": entry["name"],
                "description": entry["description"],
                "parameters": entry.get("parameters")
                or {"type": "object", "properties": {}, "additionalProperties": False},
            }
            if "output" in entry:
                spec["output"] = entry["output"]
            if "timeoutMs" in entry:
                spec["timeoutMs"] = entry["timeoutMs"]
            channel.request("tools.register", {"tool": spec})
            _state.tool_handlers[spec["name"]] = entry["handler"]

        # 再执行 Cordis 风格（风格 A）的 apply(ctx)
        entry_fn = _state.apply_fn or getattr(module, "apply", None)
        if callable(entry_fn):
            entry_fn(_state.context)

        channel.respond(apply_frame.get("id"), True, {
            "tools": sorted(_state.tool_handlers),
            "events": sorted(_state.event_handlers),
        })
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc(file=sys.stderr)
        channel.respond(apply_frame.get("id"), False, error={"message": str(exc)})
        return 1

    # ── STEP 3: 服务循环 ──
    while True:
        frame = channel.read_frame()
        if frame is None:
            break
        op = frame.get("op")
        payload = frame.get("payload") or {}
        request_id = frame.get("id")

        if op == "tool.call":
            name = payload.get("tool")
            handler = _state.tool_handlers.get(name)
            if handler is None:
                channel.respond(request_id, False, error={"message": f"unknown tool {name!r}"})
                continue
            try:
                channel.respond(request_id, True, handler(payload.get("args") or {}))
            except Exception as exc:  # noqa: BLE001
                channel.respond(request_id, False, error={"message": str(exc)})

        elif op == "event":
            try:
                _serve_host_request(channel, frame)
            except SystemExit:
                break

        elif op == "dispose":
            _state.context.effect.run_cleanups()
            channel.respond(request_id, True, {"disposed": True})
            break

        else:
            channel.respond(request_id, False, error={"message": f"unsupported op {op}"})

    return 0
