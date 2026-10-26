"""Example plugin: declarative style (style B).

The module has no ``apply`` function. It collects tools with ``@tool`` and the
runtime registers them during the apply handshake. Both styles may be mixed
under one loader.
"""

from dsh_mloader_sdk import tool

NAME = "py-decl"

TOOLS = []


@tool(
    name="py_add",
    description="Add two numbers",
    parameters={
        "type": "object",
        "properties": {
            "a": {"type": "number"},
            "b": {"type": "number"},
        },
        "required": ["a", "b"],
        "additionalProperties": False,
    },
)
def py_add(args):
    return {"sum": args["a"] + args["b"]}


@tool(
    name="py_stats",
    description="Compute summary statistics for a list of numbers",
    parameters={
        "type": "object",
        "properties": {
            "values": {"type": "array", "items": {"type": "number"}},
        },
        "required": ["values"],
        "additionalProperties": False,
    },
)
def py_stats(args):
    values = args["values"]
    if not values:
        return {"count": 0, "min": None, "max": None, "mean": None}
    return {
        "count": len(values),
        "min": min(values),
        "max": max(values),
        "mean": sum(values) / len(values),
    }
