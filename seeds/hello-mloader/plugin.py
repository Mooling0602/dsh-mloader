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

The plugin demonstrates four capabilities of the runtime:

1. Registering tools with ``ctx.tools.register``.
2. Registering slash commands with ``ctx.commands.register``, including one that exposes a tool to the user.
3. Subscribing to host events with ``ctx.on``.
4. Registering cleanup work with ``ctx.effect.register``.

Two rules apply to every handler:

- A handler must return immediately. Event handlers run while the host is busy,
  so a blocking handler slows down every tool call.
- A handler must not wait for a host request. A blocking handler can delay later
  work in the plugin process. Logging is a one way notification that never
  waits for a reply.
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

    @ctx.commands.register(
        names="hello-mloader",
        description="Greet someone from the slash command line.",
        input_hint="who",
    )
    def hello_mloader_command(input):
        """Greet the requested target from a command.

        The command is registered in the global command namespace. If another
        plugin already took this name, the loader keeps the existing command
        and skips this one.

        The text is multi-line on purpose. The dsh chat card draws a command
        result on one summary row, and it adds an expandable body only when
        the text contains a line break.

        :param input: Text after the command name.
        :type input: str
        :returns: A successful command result with multi-line text.
        :rtype: dict
        """
        who = input.strip() or "world"
        return {
            "kind": "success",
            "text": "\n".join([
                f"Hello, {who}!",
                f"plugin: {NAME} (python, bundled example)",
                "Use /mloader hello-mloader to inspect this plugin's registrations.",
            ]),
        }

    @ctx.commands.register(
        names="hello-add",
        description="Add two numbers from the slash command line.",
        input_hint="a b",
    )
    def hello_add_command(input):
        """Add the two numbers given after the command name.

        The command exposes the same arithmetic as the ``hello_add`` tool, so
        the user and the model reach one capability through both surfaces.
        That pairing is a choice: a plugin registers the surfaces its users
        need, and the loader never derives one from the other.

        :param input: Two whitespace separated numbers.
        :type input: str
        :returns: A successful command result with the addends and the sum,
            or an error result carrying the usage line.
        :rtype: dict
        """
        parts = input.split()
        if len(parts) != 2:
            return {"kind": "error", "text": "Usage: /hello-add <a> <b>"}
        try:
            a, b = (float(part) for part in parts)
        except ValueError:
            return {"kind": "error", "text": "Usage: /hello-add <a> <b>"}
        return {
            "kind": "success",
            "text": "\n".join([
                f"{a:g} + {b:g} = {a + b:g}",
                "This command runs the same arithmetic as the hello_add tool.",
            ]),
        }

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
