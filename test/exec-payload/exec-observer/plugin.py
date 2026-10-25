"""夹具：订阅 tools/execute，用来验证「宿主 exec 对象能安全跨进程」。

这个夹具本身不做任何危险的事 —— 它只是在收到事件后**记录宿主发来的形状**，
并回一条正常工具结果。真正危险的是宿主侧的载荷（带环的 exec 对象）。

修复前（2026-10-26）：宿主把活的 exec 对象直接 JSON.stringify，
抛 `Converting circular structure to JSON`，且把失败当成「对端已关闭」，
置 stdinBroken → 此后**每一帧**被静默丢弃 → 插件所有工具 15 秒超时。
"""

from dsh_runtime import plugin

# 收到的事件载荷（只保留最近 N 条，供工具查询）
RECEIVED = []
MAX_RECEIVED = 20


@plugin
def apply(ctx):
    @ctx.tools.register(
        name="exec_describe",
        description="返回本插件最近收到的事件载荷，用于断言宿主投影是否正确",
        parameters={"type": "object", "properties": {}, "additionalProperties": False},
    )
    def exec_describe(args):
        return {"received": RECEIVED[-MAX_RECEIVED:], "count": len(RECEIVED)}

    @ctx.tools.register(
        name="exec_ping",
        description="一个永远应该立刻返回的简单工具（用来证明通道还活着）",
        parameters={
            "type": "object",
            "properties": {"marker": {"type": "string"}},
            "required": ["marker"],
            "additionalProperties": False,
        },
    )
    def exec_ping(args):
        return {"marker": args["marker"], "ok": True}

    @ctx.on("tools/execute")
    def on_tool_execute(payload):
        RECEIVED.append(payload)
