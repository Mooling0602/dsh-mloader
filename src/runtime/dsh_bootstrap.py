#!/usr/bin/env python3
"""dsh-mloader — Python 插件引导器

插件进程的入口。loader 会这样启动它：

    python3 -u dsh_bootstrap.py /abs/path/to/plugin.py

它把 stdlib 路径里加上 dsh_runtime 所在目录，然后交给 run()。
"""

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)


def main(argv):
    if len(argv) < 2:
        print("usage: dsh_bootstrap.py <plugin.py>", file=sys.stderr)
        return 2
    plugin_path = os.path.abspath(argv[1])
    if not os.path.isfile(plugin_path):
        print(f"plugin file not found: {plugin_path}", file=sys.stderr)
        return 2
    # 把插件自身目录也加进 sys.path，允许它拆成多个本地模块
    plugin_dir = os.path.dirname(plugin_path)
    if plugin_dir not in sys.path:
        sys.path.insert(0, plugin_dir)

    import dsh_runtime

    return dsh_runtime.run(plugin_path)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
