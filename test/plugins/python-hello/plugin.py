"""Example plugin: Cordis aligned style (style A).

The plugin is written in Python but follows the shape of a Cordis plugin: it
exports an ``apply(ctx)`` entry function.
"""

from dsh_mloader_sdk import plugin

NAME = "py-hello"


@plugin
def apply(ctx):
    ctx.logger.info("py-hello is mounting")

    @ctx.tools.register(
        name="py_greet",
        description="Greet the named person",
        parameters={
            "type": "object",
            "properties": {
                "who": {"type": "string", "description": "Person to greet"},
            },
            "required": ["who"],
            "additionalProperties": False,
        },
    )
    def py_greet(args):
        return {"text": f"Hello, {args['who']}!"}

    @ctx.tools.register(
        name="py_echo",
        description="Echo the supplied payload unchanged, to check the round trip",
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
        ctx.logger.debug(f"observed tool execution: {payload}")

    ctx.effect.register("hello-cleanup", lambda: ctx.logger.info("py-hello is unloading"))
