// dsh-fulltext-search 测试：覆盖 0.2.0-rc.2 记录格式适配、zstd 多帧解码与搜索语义。
// 运行：node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  blockText,
  parseRecord,
  recordPayload,
  recordMessage,
  toEntry,
  isNoise,
  kindGroup,
  SEARCH_GROUPS,
} from "../lib/records.js";
import { scanZstdFrames, decodeSessionFile, searchInLog, searchSessions, sessionTitle, readSessionHeader } from "../lib/engine.js";
import { searchOutputSchema } from "../lib/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const PLAIN = join(here, "sessions/sess-a/session.jsonl");
const ZSTD = join(here, "sessions/sess-b/session.jsonl.zstd");

// ---------------------------------------------------------------- records 层

test("blockText 覆盖字符串/对象/嵌套 content", () => {
  assert.equal(blockText("plain"), "plain");
  assert.equal(blockText({ text: "t" }), "t");
  assert.equal(blockText({ content: "c" }), "c");
  assert.equal(blockText({ content: [{ text: "a" }, { text: "b" }] }), "a\nb");
  assert.equal(blockText(null), "");
  assert.equal(blockText(42), "");
});

test("blockText: 超深嵌套不触发栈溢出（畸形文件防护）", () => {
  let deep = { text: "leaf" };
  for (let i = 0; i < 5000; i++) deep = { content: [deep] };
  // 不得抛 RangeError
  assert.equal(typeof blockText(deep, 100), "string");
});

test("blockText: 正常嵌套仍完整抽取", () => {
  assert.equal(blockText({ content: [{ content: [{ text: "x" }] }, { text: "y" }] }), "x\ny");
});

test("parseRecord 对非法输入返回 undefined 而非抛错", () => {
  assert.equal(parseRecord(""), undefined);
  assert.equal(parseRecord("   "), undefined);
  assert.equal(parseRecord("{bad json"), undefined);
  assert.equal(parseRecord("null"), undefined);
  assert.equal(parseRecord("[1,2]") === undefined || typeof parseRecord("[1,2]") === "object", true);
  assert.deepEqual(parseRecord('{"a":1}'), { a: 1 });
});

test("recordPayload 优先 data，其次 message，最后裸记录", () => {
  assert.deepEqual(recordPayload({ type: "x", data: { a: 1 } }), { a: 1 });
  assert.deepEqual(recordPayload({ type: "x", message: { b: 2 } }), { b: 2 });
  assert.deepEqual(recordPayload({ type: "x", c: 3 }), { type: "x", c: 3 });
});

test("recordMessage 深入 data.message（0.2.0-rc.2 的 assistant/message 形态）", () => {
  const rec = { type: "assistant/message", data: { message: { role: "assistant", content: [] } } };
  assert.deepEqual(recordMessage(rec), { role: "assistant", content: [] });
});

test("toEntry: user/message 归一化为可读文本", () => {
  const line = JSON.stringify({
    type: "user/message", seq: 8, time: 1700,
    data: { content: [{ type: "text", text: "hello world" }], role: "user" },
  });
  const e = toEntry(line, 5);
  assert.equal(e.kind, "user");
  assert.equal(e.lineNo, 5);
  assert.equal(e.time, 1700);
  assert.equal(e.text, "[用户] hello world");
});

test("toEntry: assistant/message 区分 reasoning 与 text", () => {
  const line = JSON.stringify({
    type: "assistant/message",
    data: { message: { role: "assistant", content: [{ type: "reasoning", text: "R" }, { type: "text", text: "T" }] } },
  });
  assert.equal(toEntry(line, 1).text, "[思考] R\n[助手] T");
});

test("toEntry: tool/call 展开 arguments（JSON 字符串）", () => {
  const line = JSON.stringify({
    type: "tool/call", data: { name: "bash", arguments: '{"command":"ls -la"}' },
  });
  assert.equal(toEntry(line, 1).text, '[工具调用 bash] {"command":"ls -la"}');
});

test("toEntry: tool/result 提取嵌套 tool-result 文本", () => {
  const line = JSON.stringify({
    type: "tool/result",
    data: { message: { content: [{ type: "tool-result", content: [{ type: "text", text: "OUT" }] }] } },
  });
  assert.equal(toEntry(line, 1).text, "[工具结果] OUT");
});

test("toEntry: session/title 产出标题条目", () => {
  const line = JSON.stringify({ type: "session/title", data: { title: "  My Title  " } });
  const e = toEntry(line, 1);
  assert.equal(e.kind, "title");
  assert.equal(e.text, "[标题] My Title");
});

test("toEntry: 无法识别的 envelope 返回 undefined（交由调用方降级）", () => {
  assert.equal(toEntry(JSON.stringify({ type: "request/header", data: {} }), 1), undefined);
  assert.equal(toEntry("not json at all", 1), undefined);
});

test("toEntry: 空消息不产出条目", () => {
  assert.equal(toEntry(JSON.stringify({ type: "user/message", data: { content: [] } }), 1), undefined);
  assert.equal(toEntry(JSON.stringify({ type: "session/title", data: { title: "   " } }), 1), undefined);
});

test("isNoise 覆盖 chunk/step/request 等噪声类别", () => {
  for (const t of ["assistant/chunk", "text-chunks", "step/start", "step/end", "request/header", "turn/end", "llm/retry"]) {
    assert.equal(isNoise({ type: t }), true, `${t} 应为噪声`);
  }
  for (const t of ["user/message", "assistant/message", "tool/result", "session/title"]) {
    assert.equal(isNoise({ type: t }), false, `${t} 不应为噪声`);
  }
});

// ---------------------------------------------------------------- 兜底与注入

test("toEntry: agent/inbox/spliced 展开 inserted 正文", () => {
  const line = JSON.stringify({
    type: "agent/inbox/spliced",
    data: { target: "next-step", start: 0, inserted: [{ content: [{ type: "text", text: "background job bash-4 done" }] }] },
  });
  const e = toEntry(line, 1);
  assert.equal(e.kind, "inbox");
  assert.match(e.text, /background job bash-4 done/);
});

test("renderFallback: compaction/summary 等有正文的记录不回落原始 JSON", () => {
  const sum = JSON.stringify({ type: "compaction/summary", data: { summary: "We decided to use zstd framing." } });
  const e = toEntry(sum, 1);
  assert.ok(e, "compaction/summary 应被归一化");
  assert.match(e.text, /zstd framing/);
  assert.equal(e.kind, "other");

  const todo = JSON.stringify({ type: "todo/write", data: { text: "ship the compat release" } });
  assert.match(toEntry(todo, 1).text, /ship the compat release/);
});

test("renderFallback: 无正文的结构记录仍返回 undefined", () => {
  // sandbox/mode 的 data 只有 mode/kind 这类枚举，无可读正文
  const mode = JSON.stringify({ type: "sandbox/mode", data: { mode: { kind: "workspace-write" } } });
  assert.equal(toEntry(mode, 1), undefined);
  assert.equal(toEntry(JSON.stringify({ type: "approval/policy", data: {} }), 1), undefined);
});

test("session/title-llm-request 属于噪声（system prompt 不算会话正文）", () => {
  assert.equal(isNoise({ type: "session/title-llm-request" }), true);
});

test("isNoise: 前缀族覆盖 request/step/turn/llm 的任意子类型", () => {
  for (const t of ["request/anything", "step/foo", "turn/bar", "llm/baz"]) {
    assert.equal(isNoise({ type: t }), true, `${t} 应为噪声`);
  }
  // 不误伤含正文的同类族
  for (const t of ["compaction/summary", "agent/inbox/spliced", "todo/write", "command/run"]) {
    assert.equal(isNoise({ type: t }), false, `${t} 不应为噪声`);
  }
});

// ---------------------------------------------------------------- 回归：真实数据形态

test("回归：真实用户消息（repro 自 0.2.0-rc.2 会话）可读且可搜", () => {
  // 该形态直接取自真实 session.jsonl.zstd 解压结果
  const line = JSON.stringify({
    type: "user/message", seq: 8, time: 1789346627160,
    data: {
      content: [{ type: "text", text: "在palresearch里，找到rolrix.exe，进行完整的逆向到asm" }],
      source: { kind: "user", rpcId: "364eec08" },
      role: "user", id: "cf0b6b82",
    },
    surfaceOp: "append",
  });
  const e = toEntry(line, 1);
  assert.equal(e.kind, "user");
  assert.match(e.text, /rolrix\.exe/);
  assert.ok(!e.text.startsWith("{"), "不得输出原始 JSON");
});

test("回归：真实 tool/call 的 arguments 为 JSON 字符串时可读展开", () => {
  const line = JSON.stringify({
    type: "tool/call", seq: 98, time: 1789346637104,
    data: { turn: 1, step: 1, callId: "call_054da4", name: "bash", arguments: '{"command":"ls -la /home/palxex/gst/"}' },
  });
  const e = toEntry(line, 1);
  assert.equal(e.kind, "tool-call");
  assert.match(e.text, /ls -la \/home\/palxex\/gst\//);
});

test("回归：真实 tool/result 深层嵌套文本被提取", () => {
  const line = JSON.stringify({
    type: "tool/result", seq: 100, time: 1789346639812,
    data: {
      turn: 1, step: 1,
      message: {
        source: { kind: "tool", callId: "call_054da4" },
        content: [{ type: "tool-result", toolCallId: "call_054da4", content: [{ type: "text", text: "总计 559096" }] }],
      },
    },
  });
  assert.match(toEntry(line, 1).text, /总计 559096/);
});


test("decodeSessionFile: 明文直接读取", () => {
  const raw = decodeSessionFile(PLAIN);
  assert.match(raw, /kumquat/);
});

test("decodeSessionFile: zstd 多帧逐帧解压后拼接", () => {
  const raw = decodeSessionFile(ZSTD);
  const plain = readFileSync(PLAIN, "utf8");
  assert.equal(raw, plain, "多帧解压结果必须与明文等价");
});

test("scanZstdFrames: 在真实多帧文件上识别出 3 帧", () => {
  const buf = readFileSync(ZSTD);
  const frames = scanZstdFrames(buf);
  assert.equal(frames.length, 3);
  // 帧必须连续、无重叠、覆盖整个文件
  assert.equal(frames[0].start, 0);
  assert.equal(frames[frames.length - 1].end, buf.length);
  for (let i = 1; i < frames.length; i++) assert.equal(frames[i].start, frames[i - 1].end);
});

test("scanZstdFrames: 非 zstd 数据返回空数组（不抛错）", () => {
  assert.deepEqual(scanZstdFrames(Buffer.from("plain text")), []);
});

// ---------------------------------------------------------------- 会话元数据

test("readSessionHeader: 取 type=session 记录（0.2.0-rc.2 在顶层）", () => {
  const h = readSessionHeader(PLAIN);
  assert.equal(h.id, "session-1111-2222");
  assert.equal(h.cwd, "/home/palxex/demo");
  assert.equal(h.createdAt, 1700000000000);
});

test("sessionTitle: 优先 session/title，其次首条用户消息", () => {
  assert.equal(sessionTitle(PLAIN), "kumquat investigation");
  // 无 title 记录时回退到首条用户消息
  const fake = PLAIN + "";
  assert.equal(typeof sessionTitle(ZSTD), "string");
});

// ---------------------------------------------------------------- 搜索语义

test("searchInLog: 命中可读文本而非原始 JSON", () => {
  const hits = searchInLog(PLAIN, "kumquat", 10, false);
  assert.ok(hits.length > 0);
  const userHit = hits.find((h) => h.kind === "user");
  assert.ok(userHit, "应命中用户消息");
  assert.equal(userHit.text, "[用户] Please find the kumquat marker in the codebase");
  assert.ok(!userHit.text.includes('"type":"user/message"'), "不得返回原始 JSON envelope");
});

test("searchInLog: 噪声 envelope 不被命中（元数据含关键词也不算）", () => {
  // request/header 的 system 文本含 "dsh"，assistant/chunk 含 "kumquat"
  const hits = searchInLog(PLAIN, "kumquat", 10, false);
  const kinds = new Set(hits.map((h) => h.kind));
  assert.ok(!kinds.has("raw"), `不应出现 raw 噪声命中，实际 kinds=${[...kinds]}`);
});

test("searchInLog: 大小写不敏感为默认行为", () => {
  const hits = searchInLog(PLAIN, "KUMQUAT", 10, false);
  assert.ok(hits.length > 0, "大写查询也应命中");
});

test("searchInLog: caseSensitive=true 时严格匹配", () => {
  assert.equal(searchInLog(PLAIN, "KUMQUAT", 10, true).length, 0);
  assert.ok(searchInLog(PLAIN, "kumquat", 10, true).length > 0);
});

test("searchInLog: limit 精确限制命中条数", () => {
  assert.equal(searchInLog(PLAIN, "kumquat", 2, false).length, 2);
  assert.equal(searchInLog(PLAIN, "kumquat", 1, false).length, 1);
});

test("searchInLog: 未命中返回空数组", () => {
  assert.deepEqual(searchInLog(PLAIN, "zzz-not-present-zzz", 10, false), []);
});

test("searchInLog: 搜索 tool-call 参数与 tool-result 输出", () => {
  const callHits = searchInLog(PLAIN, "grep -r", 10, false);
  assert.ok(callHits.some((h) => h.kind === "tool-call"), "应命中工具调用参数");
  const resHits = searchInLog(PLAIN, "export const kumquat", 10, false);
  assert.ok(resHits.some((h) => h.kind === "tool-result"), "应命中工具结果");
});

test("searchInLog: 行号为原始文件行号（1-based）", () => {
  const hits = searchInLog(PLAIN, "kumquat investigation", 10, false);
  const titleHit = hits.find((h) => h.kind === "title");
  assert.ok(titleHit);
  assert.equal(titleHit.lineNo, 2, "标题在 fixture 第 2 行");
});

test("searchInLog: zstd 与明文结果一致", () => {
  const a = searchInLog(PLAIN, "kumquat", 10, false);
  const b = searchInLog(ZSTD, "kumquat", 10, false);
  assert.deepEqual(b, a, "zstd 与明文搜索应完全等价");
});

// ------------------------------------------------- 搜索范围（groups 筛选）

const ASSISTANT_MIXED = JSON.stringify({
  type: "assistant/message",
  data: {
    message: {
      role: "assistant",
      content: [{ type: "reasoning", text: "R" }, { type: "text", text: "T" }],
    },
  },
});

test("SEARCH_GROUPS 就是约定的五组", () => {
  assert.deepEqual(SEARCH_GROUPS, ["user", "assistant", "reasoning", "tool", "other"]);
});

test("kindGroup: 每种 kind 归入正确分组", () => {
  assert.equal(kindGroup("user"), "user");
  assert.equal(kindGroup("inbox"), "user");
  assert.equal(kindGroup("title"), "user");
  assert.equal(kindGroup("assistant"), "assistant");
  assert.equal(kindGroup("reasoning"), "reasoning");
  assert.equal(kindGroup("tool-call"), "tool");
  assert.equal(kindGroup("tool-result"), "tool");
  assert.equal(kindGroup("other"), "other");
  assert.equal(kindGroup("raw"), "other", "原始行兜底归入 other");
});

test("toEntry: 不传 groups 时与筛选引入前完全一致", () => {
  assert.equal(toEntry(ASSISTANT_MIXED, 1).text, "[思考] R\n[助手] T");
  assert.equal(toEntry(ASSISTANT_MIXED, 1).kind, "assistant");
});

test("toEntry: groups 只保留选中分组的段落", () => {
  const onlyText = toEntry(ASSISTANT_MIXED, 1, new Set(["assistant"]));
  assert.equal(onlyText.text, "[助手] T", "关掉思考后片段里不得再夹带 [思考] 正文");
  assert.equal(onlyText.kind, "assistant");

  const onlyReasoning = toEntry(ASSISTANT_MIXED, 1, new Set(["reasoning"]));
  assert.equal(onlyReasoning.text, "[思考] R");
  assert.equal(onlyReasoning.kind, "reasoning", "只剩一类段落时 kind 应更具体");

  assert.equal(toEntry(ASSISTANT_MIXED, 1, new Set(["user"])), undefined,
    "整条都不在选中范围内应返回 undefined");
});

test("toEntry: groups 同样作用于用户/工具/标题条目", () => {
  const userLine = JSON.stringify({
    type: "user/message", data: { content: [{ type: "text", text: "hello" }], role: "user" },
  });
  const toolLine = JSON.stringify({
    type: "tool/result",
    data: { message: { content: [{ type: "tool-result", content: [{ type: "text", text: "OUT" }] }] } },
  });
  const titleLine = JSON.stringify({ type: "session/title", data: { title: "T" } });

  assert.equal(toEntry(userLine, 1, new Set(["tool"])), undefined);
  assert.equal(toEntry(userLine, 1, new Set(["user"])).kind, "user");
  assert.equal(toEntry(toolLine, 1, new Set(["user"])), undefined);
  assert.equal(toEntry(toolLine, 1, new Set(["tool"])).kind, "tool-result");
  assert.equal(toEntry(titleLine, 1, new Set(["assistant"])), undefined);
  assert.equal(toEntry(titleLine, 1, new Set(["user"])).kind, "title");
});

test("searchInLog: groups 限定命中类型，且筛掉 other 后无原始行兜底命中", () => {
  const onlyUser = searchInLog(PLAIN, "kumquat", 20, false, undefined, new Set(["user"]));
  assert.ok(onlyUser.length > 0, "fixture 里确有用户消息命中");
  assert.ok(onlyUser.every((h) => kindGroup(h.kind) === "user"),
    `只应有用户类命中，实际 ${onlyUser.map((h) => h.kind)}`);
  assert.ok(!onlyUser.some((h) => h.kind === "raw"), "筛掉 other 后不应有 raw 兜底命中");

  const all = searchInLog(PLAIN, "kumquat", 20, false);
  assert.ok(all.length >= onlyUser.length);
});

test("searchSessions: 每条命中都带 kind，groups 能收窄且空选择等同不筛选", () => {
  const root = join(here, "sessions");
  const all = searchSessions({ query: "kumquat", limit: 20, maxSessions: 50, root });
  assert.ok(all.matches.length > 0, "fixture 应能命中");
  for (const m of all.matches) {
    for (const l of m.lines) {
      assert.equal(typeof l.kind, "string", "每条命中都应带 kind");
      assert.ok(l.kind.length > 0);
    }
  }

  const onlyUser = searchSessions({ query: "kumquat", limit: 20, maxSessions: 50, root, groups: ["user"] });
  assert.ok(onlyUser.matches.length > 0);
  assert.ok(onlyUser.matches.length <= all.matches.length);
  for (const m of onlyUser.matches) {
    for (const l of m.lines) assert.equal(kindGroup(l.kind), "user");
  }

  const empty = searchSessions({ query: "kumquat", limit: 20, maxSessions: 50, root, groups: [] });
  assert.equal(empty.matches.length, all.matches.length, "空 groups 应等同不筛选");

  const unknown = searchSessions({ query: "kumquat", limit: 20, maxSessions: 50, root, groups: ["nope"] });
  assert.equal(unknown.matches.length, all.matches.length, "未知分组应被忽略，而不是清空结果");
});

test("工具输出 schema 声明了 kind —— 否则 additionalProperties:false 会抛 ToolOutputError", () => {
  const lineProps = searchOutputSchema.properties.matches.items.properties.lines.items.properties;
  assert.ok(lineProps.kind, "lines[].kind 必须在 schema 中声明");
  assert.equal(lineProps.kind.required, true);

  // 引擎真实产出的行字段必须都能在 schema 里找到归宿
  const root = join(here, "sessions");
  const res = searchSessions({ query: "kumquat", limit: 20, maxSessions: 50, root });
  const declared = new Set(Object.keys(lineProps));
  let checked = 0;
  for (const m of res.matches) {
    for (const l of m.lines) {
      for (const key of Object.keys(l)) {
        assert.ok(declared.has(key), `引擎产出的 ${key} 未在 schema 中声明`);
      }
      checked++;
    }
  }
  assert.ok(checked > 0, "应至少校验到一条命中");
});
