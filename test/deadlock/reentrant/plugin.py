"""Minimal fixture that exercises re-entrant event handling.

The plugin calls back into the host from inside an event handler. The host must
deliver the event without waiting for the reply, because the handler needs the
host to answer the callback before it can return.
"""

from dsh_mloader_sdk import plugin


@plugin
def apply(ctx):
    @ctx.tools.register(
        name="reentrant_ping",
        description="Run one operation affected by re-entrant event handling",
        parameters={"type": "object", "properties": {}, "additionalProperties": False},
    )
    def reentrant_ping(args):
        return {"ok": True}

    @ctx.on("tools/execute")
    def on_tool_execute(payload):
        # A host callback from inside the handler must not deadlock.
        ctx.logger.info(f"event echo: {payload.get('name', '?') if isinstance(payload, dict) else payload}")
