"""Fault injection fixture: crash, hang and process identity.

Each tool triggers one failure mode so the loader's isolation behavior can be
asserted while the plugin process is running.
"""

import os
import sys
import time

from dsh_mloader_sdk import plugin


@plugin
def apply(ctx):
    @ctx.tools.register(
        name="crash_me",
        description="Exit the plugin process immediately to prove the host survives",
        parameters={"type": "object", "properties": {}, "additionalProperties": False},
    )
    def crash_me(args):
        os._exit(7)

    @ctx.tools.register(
        name="hang_me",
        description="Sleep inside the call to prove the call timeout",
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
        description="Return a plain value to probe the renderer fallback",
        parameters={"type": "object", "properties": {}, "additionalProperties": False},
    )
    def bad_schema_probe(args):
        return {"ok": True}

    @ctx.tools.register(
        name="whoami",
        description="Return the plugin process id and its parent for process isolation checks",
        parameters={"type": "object", "properties": {}, "additionalProperties": False},
    )
    def whoami(args):
        return {"pid": os.getpid(), "ppid": os.getppid(), "python": sys.version.split()[0]}
