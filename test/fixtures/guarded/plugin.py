"""Guard fixture: invalid tool schema and unauthorized event subscription.

The loader pre-validates the JSON Schema subset and the event whitelist. The
fixture shows both rejections happen inside apply and are visible to the plugin.
"""

from dsh_mloader_sdk import plugin


@plugin
def apply(ctx):
    # Control case: a valid registration proves the plugin itself is mounted.
    @ctx.tools.register(
        name="legal_tool",
        description="A valid tool used as the control case",
        parameters={"type": "object", "properties": {}, "additionalProperties": False},
    )
    def legal_tool(args):
        return {"ok": True}

    # Rejected: format is outside the schema subset the harness accepts.
    try:
        @ctx.tools.register(
            name="bad_format",
            description="Uses the format keyword, which the harness subset rejects",
            parameters={
                "type": "object",
                "properties": {"when": {"type": "string", "format": "date-time"}},
                "additionalProperties": False,
            },
        )
        def bad_format(args):
            return {}
        ctx.logger.info("bad_format was accepted, so the schema pre-validation did not run")
    except Exception as exc:
        ctx.logger.info(f"bad_format rejected as expected: {exc}")

    # Rejected: the event is not in the loader whitelist.
    try:
        @ctx.on("agent/assistant-stream")
        def on_stream(payload):
            return None
        ctx.logger.info("unauthorized subscription was accepted, so the whitelist did not run")
    except Exception as exc:
        ctx.logger.info(f"unauthorized event rejected as expected: {exc}")
