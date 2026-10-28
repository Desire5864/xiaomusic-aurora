#!/bin/sh
# 刮削新加的音乐：只处理缺封面/缺歌词的文件，已完整的自动跳过（不联网）
# 用法： ./scrape.sh            扫全库
#        ./scrape.sh --limit 5  先试前 5 首
set -e
# 群晖上 docker 不在 root 的 PATH 里，用绝对路径
DOCKER=/usr/local/bin/docker
[ -x "$DOCKER" ] || DOCKER=docker
sudo "$DOCKER" exec xiaomusic python /app/tools/scrape.py --auto "$@"
