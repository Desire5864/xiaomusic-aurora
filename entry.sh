#!/bin/sh
# 启动顺序：先起刮削触发服务（后台），再把主进程 exec 成 PID 1 ——
# 这样 docker stop 的 SIGTERM 仍然直达 xiaomusic，不会被中间层吞掉。
/app/.venv/bin/python3 /app/tools/trigger.py >>/tmp/aurora-trigger.log 2>&1 &

# 兜底：万一 CMD 被清空（Dockerfile 里设 ENTRYPOINT 会重置 CMD），也要能起主程序
if [ "$#" -eq 0 ]; then
  set -- /app/.venv/bin/python3 /app/xiaomusic.py
fi

exec "$@"
