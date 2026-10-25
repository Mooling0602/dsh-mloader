"""复现死锁的最小夹具。

这个插件在事件处理器里**回调宿主**（ctx.logger）。修复前这会形成
「宿主等事件回包 / 插件等 logger 回包」的永久互等，堵死整个 tools 通道。
"""

from dsh_runtime import plugin


@plugin
def apply(ctx):
    @ctx.tools.register(
        name="reentrant_ping",
        description="触发一次会被 re-entrant 事件处理影响的操作",
        parameters={"type": "object", "properties": {}, "additionalProperties": False},
    )
    def reentrant_ping(args):
        return {"ok": True}

    @ctx.on("tools/execute")
    def on_tool_execute(payload):
        # ★ 关键：在事件处理器内部回调宿主。
        # 修复前 → 死锁。修复后 → 正常返回。
        ctx.logger.info(f"事件回显: {payload.get('name', '?') if isinstance(payload, dict) else payload}")
