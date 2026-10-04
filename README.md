# dsh-fulltext-search · Full-text search across DSH sessions

[![npm](https://img.shields.io/npm/v/dsh-fulltext-search)](https://www.npmjs.com/package/dsh-fulltext-search)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

**English** · [中文](README.zh.md)

Full-text search across every locally stored [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) session — reclaim past conversations, code snippets, and decision records. Works with **zstd-compressed** (`.jsonl.zstd`, dsh's default) and plaintext (`.jsonl`) session logs.

Pure Node implementation, **zero third-party runtime dependencies**.

> **Compatibility:** targets DSH **`0.2.0-rc.2`**. dsh versions older than `0.2.0-rc.2` are **not** supported, because the session persistence format differs.

## Features

- `session_search` — keyword search returning matched sessions (title / ID / working directory), matched line numbers, and the matching line content
- Sorted by most-recently-used; scans the latest 20 sessions by default — tune with `maxSessions` / `limit`
- Case-insensitive by default (toggle with `caseSensitive`)
- **GUI panel**: sidebar-foot entry with keyword search; click a result to open that session
- Returns **readable text, not raw JSON**: user messages, assistant replies, reasoning, tool calls (with expanded `arguments`), and tool results are each normalized with a semantic prefix
- Structure and streaming records (`request/*`, `step/*`, `turn/*`, `llm/*`, `*/chunk`) carry no conversation body, so they are skipped and cannot produce false matches from metadata
- Correctly decodes dsh's **multi-frame zstd** session logs
- Peer-only dependencies (supplied by the dsh host)

## Install

```sh
dsh plugin --profile web add dsh-fulltext-search
# or any profile: dsh plugin --profile <name> add dsh-fulltext-search
```

## Usage (GUI)

Click the **search icon at the sidebar foot** (next to Settings) to open the
full-text search panel. Type a keyword, press Enter, and click **Open** on any
result to jump straight to that past session.

## Usage (agent tool)

- "Find where I mentioned `<keyword>`" → call `session_search`
- "Search my sessions for every mention of `<function name>`" → `session_search` query=`<function name>`
- 中文：「我上次讨论过 `<关键词>`，帮我找找」→ `session_search`

### Parameters

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `query` | string | — | **Required.** Keyword to search for (case-insensitive by default). |
| `limit` | integer | `5` | Max matching lines returned per session. |
| `maxSessions` | integer | `20` | Max sessions to scan, most-recent first. |
| `caseSensitive` | boolean | `false` | Whether matching is case-sensitive. |

## How it works

Session logs live under `$DSH_HOME/sessions` (default `~/.dsh/sessions`) as
`<session-dir>/session.jsonl[.zstd]`. Since dsh `0.2.0-rc.2`, each line is an envelope:

```json
{ "type": "user/message", "seq": 8, "time": 1700000000010, "data": { "content": [ ... ], "role": "user" } }
```

`lib/records.js` normalizes those envelopes into searchable, human-readable
entries; `lib/index.js` handles multi-frame zstd decoding, session discovery,
metadata extraction, and the tool definition.

## Development

```sh
npm test        # 35 cases: record adaptation, zstd framing, search semantics, real-data regressions
```

Test fixtures are built from **real** `0.2.0-rc.2` session records, including a
multi-frame zstd file mirroring dsh's actual on-disk layout.

## Why use it

- **Reclaim forgotten history** — agent sessions are valuable assets; search makes them reusable
- **Cross-project search** — every working directory's sessions, in one query

## License

Licensed under **AGPL-3.0-only** — see [LICENSE](LICENSE).
