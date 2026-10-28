# xiaomusic + aurora 主题 + 刮削工具
# 只覆盖静态资源和工具脚本，后端代码一行不改 —— 升级官方镜像时直接改 FROM 重建即可
FROM hanxi/xiaomusic:latest

LABEL description="xiaomusic with aurora theme, scraper and in-panel scrape trigger baked in"

# 1) 主题：必须放进真正对外服务的静态目录（注意不是 /app/static）
COPY aurora/ /app/xiaomusic/static/aurora/

# 2) 根路径 / 和老书签 /static/default/index.html 都直接进 aurora
#    （只覆盖 default 的 index.html，它的 setting.html 等保持原样）
COPY launcher-redirect.html /app/xiaomusic/static/index.html
COPY launcher-redirect.html /app/xiaomusic/static/default/index.html

# 3) 刮削脚本：放 /app/tools，避免被运行时的 /app/conf 卷遮住
COPY scrape.py /app/tools/scrape.py
RUN chmod 644 /app/tools/scrape.py

# 4) 面板里的「开始刮削」按钮打到这里：只跑固定的 scrape.py，不接受外部命令
COPY trigger.py /app/tools/trigger.py
COPY entry.sh /app/tools/entry.sh
RUN chmod 755 /app/tools/entry.sh && chmod 644 /app/tools/trigger.py

EXPOSE 8099
ENTRYPOINT ["/app/tools/entry.sh"]
# 设 ENTRYPOINT 会把继承来的 CMD 清空，这里必须显式写回来
CMD ["/app/.venv/bin/python3", "/app/xiaomusic.py"]
