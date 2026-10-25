"""示例插件：声明式风格（风格 B）。

不写 apply，只用 @tool 收集工具表，由 loader 主动注册。
两种风格可以在同一个 loader 下混用。
"""

from dsh_runtime import tool

NAME = "py-decl"

TOOLS = []


@tool(
    name="py_add",
    description="两数相加",
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
    description="计算一组数字的统计量",
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
