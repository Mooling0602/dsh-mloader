"""边界测试插件：崩溃与超时。

这个插件被 loader 启动后，可以通过工具触发不同故障，验证隔离行为。
"""

import os
import sys
import time

from dsh_runtime import plugin


@plugin
def apply(ctx):
    @ctx.tools.register(
        name="crash_me",
        description="直接让插件进程崩溃（os._exit），验证宿主存活",
        parameters={"type": "object", "properties": {}, "additionalProperties": False},
    )
    def crash_me(args):
        os._exit(7)

    @ctx.tools.register(
        name="hang_me",
        description="无限循环，验证调用超时",
        parameters={
            "type": "object",
            "properties": {"seconds": {"type": "number"}},
            "additionalProperties": False,
        },
    )
    def hang_me(args):
        seconds = args.get("seconds", 5)
        time.sleep(seconds)
        return {"slept": seconds}

    @ctx.tools.register(
        name="bad_schema_probe",
        description="返回不可序列化的对象，验证渲染兜底",
        parameters={"type": "object", "properties": {}, "additionalProperties": False},
    )
    def bad_schema_probe(args):
        return {"ok": True}

    @ctx.tools.register(
        name="whoami",
        description="返回插件进程的 pid，用于验证进程隔离",
        parameters={"type": "object", "properties": {}, "additionalProperties": False},
    )
    def whoami(args):
        return {"pid": os.getpid(), "ppid": os.getppid(), "python": sys.version.split()[0]}
