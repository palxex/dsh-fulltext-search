# dsh-fulltext-search · DSH 会话全文搜索

[![npm](https://img.shields.io/npm/v/dsh-fulltext-search)](https://www.npmjs.com/package/dsh-fulltext-search)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

[English](README.md) · **中文**

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）本地保存的所有会话中按关键词**全文搜索**，找回历史对话、代码片段与决策记录。支持 **zstd 压缩**（`.jsonl.zstd`，DSH 默认存储格式）与**明文**（`.jsonl`）两种会话存储。

纯 Node 实现，**零第三方运行时依赖**。

> **兼容性**：本插件适配 DSH **`0.2.0-rc.2`**。低于 `0.2.0-rc.2` 的 dsh 版本**不受支持**，因为会话持久化格式不同。

## 功能

- `session_search` — 关键词全文搜索：返回命中会话（标题 / ID / 工作目录）、命中行号与具体行内容
- 按最近使用排序，默认扫描最近 20 个会话；`maxSessions` / `limit` 可调
- 默认不区分大小写（可用 `caseSensitive` 开关）
- **图形界面**：侧栏底部入口，关键词搜索，点击结果直接打开该会话
- 返回**可读文本而非原始 JSON**：用户消息、助手回复、思考（reasoning）、工具调用（`arguments` 已展开）、工具结果分别带语义前缀归一化
- 结构性 / 流式记录（`request/*`、`step/*`、`turn/*`、`llm/*`、`*/chunk`）不含会话正文，会被跳过，因此不会因元数据产生假命中
- 正确解码 dsh 的**多帧 zstd** 会话日志
- peer-only 依赖（随 DSH 宿主加载）

## 安装

```sh
dsh plugin --profile web add dsh-fulltext-search
# 或任意 profile：dsh plugin --profile <name> add dsh-fulltext-search
```

## 使用（图形界面）

点击**侧栏底部的搜索图标**（「设置」旁边）打开全文搜索面板。
输入关键词回车，点击任意结果的「打开」即可直接跳转到那条历史会话。

## 使用（agent 工具）

- 「我上次讨论过 `<关键词>`，帮我找找」→ 调用 `session_search`
- 「搜索会话里所有提到 `<函数名>` 的地方」→ `session_search` query=`<函数名>`
- English: "Find where I mentioned `<keyword>`" → `session_search`

### 参数

| 参数 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `query` | string | — | **必填。** 搜索关键词（默认不区分大小写）。 |
| `limit` | integer | `5` | 每个会话最多返回的命中条数。 |
| `maxSessions` | integer | `20` | 最多检查的会话数（按最近优先）。 |
| `caseSensitive` | boolean | `false` | 是否区分大小写。 |

## 实现说明

会话日志位于 `$DSH_HOME/sessions`（默认 `~/.dsh/sessions`），路径形如
`<会话目录>/session.jsonl[.zstd]`。自 dsh `0.2.0-rc.2` 起，每行是一个 envelope：

```json
{ "type": "user/message", "seq": 8, "time": 1700000000010, "data": { "content": [ ... ], "role": "user" } }
```

`lib/records.js` 负责把这些 envelope 归一化为可搜索、可阅读的条目；
`lib/index.js` 负责多帧 zstd 解码、会话发现、元数据提取与工具定义。

## 开发

```sh
npm test        # 35 个用例：记录适配、zstd 分帧、搜索语义、真实数据回归
```

测试 fixture 由**真实**的 `0.2.0-rc.2` 会话记录构造，包含一个与 dsh 实际落盘
布局一致的多帧 zstd 文件。

## 为什么选它

- **找回被遗忘的历史**：agent 会话是重要资产，搜索让它们可复用
- **跨项目检索**：所有工作目录的会话一网打尽

## 许可证

以 **AGPL-3.0-only** 授权，详见 [LICENSE](LICENSE)。
