"""Bundled example plugin for dsh-mloader.

The loader releases this directory into ``<profile>/mloader/plugins/`` on every
start and replaces the copy in the profile. Edits are overwritten, because the
bundled example is the reference copy of the installed loader. The id
hello-mloader is reserved for this example.

The directory holds three files:

``mloader.plugin.json``
    Metadata: id, backend, entry and timeouts.
``plugin.py``
    This file.
``.mloader.builtin.json``
    Marks the directory as the bundled example for the reserved id.

The plugin demonstrates three capabilities of the runtime:

1. Registering tools with ``ctx.tools.register``.
2. Subscribing to host events with ``ctx.on``.
3. Registering cleanup work with ``ctx.effect.register``.

Two rules apply to every handler:

- A handler must return immediately. Event handlers run while the host is busy,
  so a blocking handler slows down every tool call.
- A handler must not wait for a host request. The host is not reading plugin
  requests during event dispatch, so a synchronous host request from inside a
  handler deadlocks both sides. Logging is the exception: it is a one way
  notification that never waits for a reply.
"""

from dsh_mloader_sdk import Context, plugin

NAME = "hello-mloader"


@plugin
def apply(ctx: Context):
    """Register the example capabilities.

    The runtime calls this function once during startup. Every registration is
    tracked by the loader and revoked in reverse order when the plugin unloads,
    so this file never has to revoke anything itself.

    :param ctx: The capability context handed to the plugin.
    """

    ctx.logger.info("hello-mloader mounted; the loader refreshes this example")

    @ctx.tools.register(
        name="hello_mloader",
        description="Greet someone and echo the plugin identity.",
        parameters={
            "type": "object",
            "properties": {
                "who": {
                    "type": "string",
                    "description": "Person or thing to greet.",
                },
                "excited": {
                    "type": "boolean",
                    "description": "End the greeting with an exclamation mark.",
                    "default": False,
                },
            },
            "required": ["who"],
            "additionalProperties": False,
        },
    )
    def hello_mloader(args):
        """Greet the requested target.

        :param args: Tool arguments with a string ``who`` and an optional
            boolean ``excited``.
        :type args: dict
        :returns: The greeting, the plugin identity and a hint that points at
            this example file.
        :rtype: dict
        """
        who = args["who"]
        mark = "!" if args.get("excited") else "."
        return {
            "message": f"Hello, {who}{mark}",
            "plugin": NAME,
            "hint": (
                "This tool comes from the bundled example plugin at "
                "mloader/plugins/hello-mloader/plugin.py in the profile; the "
                "loader refreshes it on every start."
            ),
        }

    @ctx.tools.register(
        name="hello_add",
        description="Add two numbers, demonstrating required parameters and type validation.",
        parameters={
            "type": "object",
            "properties": {
                "a": {"type": "number", "description": "First addend."},
                "b": {"type": "number", "description": "Second addend."},
            },
            "required": ["a", "b"],
            "additionalProperties": False,
        },
    )
    def hello_add(args):
        """Add the two requested numbers.

        :param args: Tool arguments with numeric ``a`` and ``b``.
        :type args: dict
        :returns: Both addends and their sum.
        :rtype: dict
        """
        return {"a": args["a"], "b": args["b"], "sum": args["a"] + args["b"]}

    @ctx.on("tools/execute")
    def on_tool_execute(payload):
        """Log one observed tool execution.

        Logging is a one way notification, so it is safe here. The handler
        returns immediately and never waits for the host.

        :param payload: Projected tool execution data sent by the host.
        :type payload: dict
        """
        ctx.logger.debug(f"hello-mloader observed a tool execution: {payload}")

    def cleanup():
        """Report that the plugin is unloading.

        The loader calls this function once when the plugin is disposed. A real
        plugin would close files or connections here.
        """
        ctx.logger.info("hello-mloader is unloading")

    ctx.effect.register("hello-mloader-cleanup", cleanup)
