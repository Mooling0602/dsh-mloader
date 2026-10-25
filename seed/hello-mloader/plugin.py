"""dsh-mloader 内置示例插件。

这是码头释放到 `<profile>/mloader/plugins/hello-mloader/` 的参考实现。
你可以直接改它，码头不会覆盖你的改动（目录已存在就整体跳过）。

目录里就两个文件：
  mloader.plugin.json   ← 元数据（id / backend / entry / 超时）
  plugin.py             ← 本文件

────────────────────────────────────────────────────────────────────
它演示了三件事
────────────────────────────────────────────────────────────────────
1. 注册工具       —— ctx.tools.register(...)
2. 订阅事件       —— ctx.on("tools/execute")
3. 注册清理逻辑   —— ctx.effect.register(...)

────────────────────────────────────────────────────────────────────
两条必须知道的规则（都是真实事故换来的）
────────────────────────────────────────────────────────────────────
① 插件里的任何代码都**不要阻塞**
   你的代码跑在独立子进程里，但事件回调是**同步等待**的。回调里如果
   死循环或长时间 sleep，会拖住 dsh 的事件分发，进而拖慢所有工具调用。

② 事件回调里**不要 await 宿主**
   回调期间宿主正阻塞在事件分发上、没在读你的 stdin。此时任何
   "发请求并等回包" 的操作都会和宿主互等，最终死锁。
   日志是例外：ctx.logger 是单向的，不等回包，可以随便用。
"""

from dsh_runtime import plugin

# 元数据里也有 name；这里可省略。写上便于文件单独阅读。
NAME = "hello-mloader"


@plugin
def apply(ctx):
    """插件入口。码头启动时会调用一次，这里注册的东西在卸载时自动撤销。"""

    ctx.logger.info("hello-mloader 已挂载（这是内置示例插件，欢迎改它）")

    # ───────────────────────────────────────────────────────────────
    # 1. 注册一个工具
    #
    # parameters 是 JSON Schema 的**子集**，支持：
    #   type / properties / required / additionalProperties / items
    #   enum / const / oneOf / description / title / default / examples
    # 不支持 format —— 用了会被码头拒绝并让本插件加载失败。
    # ───────────────────────────────────────────────────────────────
    @ctx.tools.register(
        name="hello_mloader",
        description="内置示例工具：向指定的人问好，并回显码头信息。",
        parameters={
            "type": "object",
            "properties": {
                "who": {
                    "type": "string",
                    "description": "要问候的人或事物",
                },
                "excited": {
                    "type": "boolean",
                    "description": "是否使用感叹号",
                    "default": False,
                },
            },
            "required": ["who"],
            "additionalProperties": False,
        },
    )
    def hello_mloader(args):
        who = args["who"]
        mark = "！" if args.get("excited") else "。"
        return {
            "message": f"你好，{who}{mark}",
            "plugin": NAME,
            "hint": "这个工具来自内置示例插件，代码在 profile 的 mloader/plugins/hello-mloader/plugin.py",
        }

    # ───────────────────────────────────────────────────────────────
    # 2. 注册第二个工具：演示"有返回值形状要求"的用法
    #
    # 返回值必须是 JSON 可序列化对象。抛异常时码头会把错误回给调用方，
    # 不会让插件进程崩溃。
    # ───────────────────────────────────────────────────────────────
    @ctx.tools.register(
        name="hello_add",
        description="内置示例工具：把两个数字相加（演示必填参数与类型校验）。",
        parameters={
            "type": "object",
            "properties": {
                "a": {"type": "number", "description": "第一个加数"},
                "b": {"type": "number", "description": "第二个加数"},
            },
            "required": ["a", "b"],
            "additionalProperties": False,
        },
    )
    def hello_add(args):
        total = args["a"] + args["b"]
        return {"a": args["a"], "b": args["b"], "sum": total}

    # ───────────────────────────────────────────────────────────────
    # 3. 订阅事件
    #
    # 可用事件见 docs/ABI.md §3.1 的白名单，例如：
    #   tools/execute, tools/pre-execute, tools/post-execute,
    #   tools/result, tools/change,
    #   agent/status, agent/created, agent/disposed,
    #   session/created, session/disposed
    #
    # ★ 回调必须立刻返回，不能 await 宿主（见文件顶部规则 ②）。
    #   这里只用单向的 logger，所以是安全的。
    # ───────────────────────────────────────────────────────────────
    @ctx.on("tools/execute")
    def on_tool_execute(payload):
        # logger 是单向的：不等回包，所以在事件回调里调用也不会死锁。
        ctx.logger.debug(f"hello-mloader 观察到工具执行：{payload}")

    # ───────────────────────────────────────────────────────────────
    # 4. 注册清理逻辑
    #
    # 插件被卸载（reload / dsh 退出）时执行。适合关文件、断开连接。
    # 这里只打一行日志，证明它确实被调用了。
    # ───────────────────────────────────────────────────────────────
    ctx.effect.register("hello-mloader-cleanup", lambda: ctx.logger.info("hello-mloader 正在卸载"))
