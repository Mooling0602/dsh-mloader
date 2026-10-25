"""示例插件：Cordis 对齐风格（风格 A）。

插件用 Python 写，但写法与 dsh 的 Cordis 插件一致：导出 apply(ctx)。
"""

from dsh_runtime import plugin

NAME = "py-hello"


@plugin
def apply(ctx):
    ctx.logger.info("py-hello 正在挂载")

    @ctx.tools.register(
        name="py_greet",
        description="用中文向指定的人问好",
        parameters={
            "type": "object",
            "properties": {
                "who": {"type": "string", "description": "要问候的人"},
            },
            "required": ["who"],
            "additionalProperties": False,
        },
    )
    def py_greet(args):
        return {"text": f"你好，{args['who']}！"}

    @ctx.tools.register(
        name="py_echo",
        description="原样回显传入的内容（用于验证往返）",
        parameters={
            "type": "object",
            "properties": {
                "payload": {"type": "object", "additionalProperties": True},
            },
            "required": ["payload"],
            "additionalProperties": False,
        },
    )
    def py_echo(args):
        return args["payload"]

    @ctx.on("tools/execute")
    def on_tool_execute(payload):
        ctx.logger.debug(f"观察到工具执行: {payload}")

    ctx.effect.register("hello-cleanup", lambda: ctx.logger.info("py-hello 正在卸载"))
