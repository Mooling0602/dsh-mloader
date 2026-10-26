"""Fixture that observes tool execution events.

The plugin records the payload the host sends for ``tools/execute`` and answers
two ordinary tools. It never blocks and never calls the host, so a failure in
the test can only come from the host side payload or from a broken channel.
"""

from dsh_mloader_sdk import plugin

RECEIVED = []
MAX_RECEIVED = 20


@plugin
def apply(ctx):
    """Register the observer tools and the event subscription.

    :param ctx: The capability context handed to the plugin.
    """

    @ctx.tools.register(
        name="exec_describe",
        description="Return the event payloads this plugin received most recently.",
        parameters={"type": "object", "properties": {}, "additionalProperties": False},
    )
    def exec_describe(args):
        """Return the recorded event payloads.

        :param args: Unused tool arguments.
        :type args: dict
        :returns: The most recent payloads and the total count.
        :rtype: dict
        """
        return {"received": RECEIVED[-MAX_RECEIVED:], "count": len(RECEIVED)}

    @ctx.tools.register(
        name="exec_ping",
        description="Return the marker immediately, proving the channel is alive.",
        parameters={
            "type": "object",
            "properties": {"marker": {"type": "string"}},
            "required": ["marker"],
            "additionalProperties": False,
        },
    )
    def exec_ping(args):
        """Echo the marker.

        :param args: Tool arguments with a string ``marker``.
        :type args: dict
        :returns: The marker and a fixed acknowledgement.
        :rtype: dict
        """
        return {"marker": args["marker"], "ok": True}

    @ctx.on("tools/execute")
    def on_tool_execute(payload):
        """Record one projected tool execution payload.

        :param payload: Projected tool execution data sent by the host.
        :type payload: dict
        """
        RECEIVED.append(payload)
