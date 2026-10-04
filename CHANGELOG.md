# Changelog

本文件按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 组织，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-10-05

首个版本，许可证 **AGPL-3.0-only**。

### 新增

- 跨会话全文搜索：遍历本地全部会话记录（zstd 压缩与明文两种存储），按关键字
  返回命中会话、行号与上下文行。
- 两种调用入口：agent 工具 `session_search`，以及供侧栏搜索面板使用的
  `sessionSearch` typert remote 服务。
- 兼容 DSH 0.2.0-rc.2 会话记录格式，覆盖 v2/v3/v4 三代日志命名。
- subagent 子会话默认剔除（打不开），可通过 `includeSubagents` 打开。
- 搜索范围筛选：面板内六个标签（全部 / 用户 / 助手 / 思考 / 工具 / 其他）即时切换，
  每条命中带 `kind` 与 `group` 标注来源。**默认只开「用户」**：全量匹配会把模型
  思考块与命令输出一起算作命中（实测搜 discovery 时 20 个会话里 15 个是这么来的），
  需要时点「全部」或逐项打开。
