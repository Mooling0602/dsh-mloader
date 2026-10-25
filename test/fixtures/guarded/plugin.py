"""边界测试插件：非法的 schema 与越权事件。

用于验证 loader 的预校验能拦住 dsh schema 子集之外的写法，
以及事件白名单能拦住越权订阅。
"""

from dsh_runtime import plugin


@plugin
def apply(ctx):
    # 合法工具：作为对照，证明插件本身是能挂载的
    @ctx.tools.register(
        name="legal_tool",
        description="一个合法的工具",
        parameters={"type": "object", "properties": {}, "additionalProperties": False},
    )
    def legal_tool(args):
        return {"ok": True}

    # 非法：format 不在 dsh 支持的 schema 子集里
    try:
        @ctx.tools.register(
            name="bad_format",
            description="用了 dsh 不支持的 format 关键词",
            parameters={
                "type": "object",
                "properties": {"when": {"type": "string", "format": "date-time"}},
                "additionalProperties": False,
            },
        )
        def bad_format(args):
            return {}
        ctx.logger.info("bad_format 竟然注册成功了 —— 说明预校验失效")
    except Exception as exc:
        ctx.logger.info(f"bad_format 被正确拒绝: {exc}")

    # 非法：越权事件订阅
    try:
        @ctx.on("agent/assistant-stream")
        def on_stream(payload):
            return None
        ctx.logger.info("越权订阅竟然成功了 —— 说明白名单失效")
    except Exception as exc:
        ctx.logger.info(f"越权事件被正确拒绝: {exc}")
