// dsh-fulltext-search/engine.js — 会话全文搜索引擎（纯逻辑，无 cordis 依赖）。
//
// 与 lib/index.js 的分工：
//   engine.js —— 会话发现、zstd 解码、搜索、元数据提取（可独立单测）
//   index.js  —— cordis 装配：注册 agent 工具 + typert remote 服务
//
// 这样 GUI（client 半区）与 agent 工具共用同一套搜索语义，不会出现两套行为。

import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join, relative } from "node:path";
import { homedir } from "node:os";
import { zstdDecompressSync } from "node:zlib";
import { SEARCH_GROUPS, blockText, isNoise, kindGroup, parseRecord, recordMessage, recordPayload, toEntry } from "./records.js";

// ---- Zstandard 多帧解码（与 dsh-session-persistence-jsonl 相同的帧布局）----
const ZSTD_MAGIC = 4247762216;

/**
 * 扫描 buffer 里的连续 zstd 帧，返回每帧的 [start, end)。
 * DSH 会为每个批次写一个独立帧并 append，所以必须逐帧解压再拼接。
 */
export function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) break;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break;
    offset += 4;
    if (offset === buffer.length) break;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) break;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) break;
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) break;
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) break;
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) break;
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) break;
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return frames;
}

function isZstdPath(p) {
  return p.endsWith(".zstd");
}

/** 整文件解码为 utf8 文本（逐帧解压拼接）。 */
export function decodeSessionFile(path) {
  const buf = readFileSync(path);
  if (!isZstdPath(path)) return buf.toString("utf8");
  let plain = "";
  for (const f of scanZstdFrames(buf)) {
    plain += zstdDecompressSync(buf.subarray(f.start, f.end)).toString("utf8");
  }
  return plain;
}

/** 整文件读取（zstd 自动解码），失败返回 null。 */
export function safeDecodeFull(path) {
  try {
    return decodeSessionFile(path);
  } catch {
    return null;
  }
}

/** 会话根目录：$DSH_HOME/sessions（缺省 ~/.dsh/sessions）。 */
export function sessionsRoot() {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(home, "sessions");
}

/**
 * 会话日志文件名模式。
 *
 * ⚠️ 关键：DSH 会随版本演进改变会话日志文件名，实际落盘形态有：
 *   session.jsonl / session.jsonl.zstd        （旧格式，309 个）
 *   session.v4.jsonl.zstd                     （当前格式，163 个）
 *   session.v3.jsonl.zstd / session.v2.jsonl.zstd（历史遗留，30 个）
 * 只认 `session.jsonl*` 会让 **193 个会话完全搜不到**（实测：um 工作区
 * 全是 v4，21 个会话一个都扫不到）。
 *
 * 这里用正则接受任意版本号，并排除备份/临时文件（.bak / .tmp）。
 */
const SESSION_LOG_RE = /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/;

/** 递归查找会话日志（含各版本命名）。 */
export function findSessionLogs(root = sessionsRoot()) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p, depth + 1);
      } else if (e.isFile() && SESSION_LOG_RE.test(e.name)) {
        out.push(p);
      }
    }
  };
  walk(root, 0);
  return out;
}

/** 会话日志按 mtime 倒序（最近优先）。 */
export function listSessionLogs(root = sessionsRoot()) {
  return findSessionLogs(root).sort((a, b) => {
    try {
      return statSync(b).mtimeMs - statSync(a).mtimeMs;
    } catch {
      return 0;
    }
  });
}

/**
 * 从会话文件中解析 header（type === "session" 的第一行）。
 * @returns {object | null}
 */
export function readSessionHeader(path, raw) {
  const text = typeof raw === "string" ? raw : safeDecodeHead(path);
  if (typeof text !== "string") return null;
  for (const line of text.split("\n", 20)) {
    const rec = parseRecord(line);
    if (rec === undefined) continue;
    if (rec.type === "session") return rec;
  }
  return null;
}

/** 只解码文件头部（用于拿 header，避免整文件解压）。 */
function safeDecodeHead(path) {
  try {
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(1 << 20);
    const bytesRead = readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    const head = buf.subarray(0, bytesRead);
    if (!isZstdPath(path)) return head.toString("utf8");
    const frames = scanZstdFrames(head);
    if (frames.length === 0) return null;
    return zstdDecompressSync(head.subarray(frames[0].start, frames[0].end)).toString("utf8");
  } catch {
    return null;
  }
}

/** 提取过期时间戳。 */
function fileMtime(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * 会话标题：优先 session/title 记录，其次首条用户消息。
 * @returns {string | null}
 */
export function sessionTitle(path, raw) {
  const text = typeof raw === "string" ? raw : safeDecodeFull(path);
  if (typeof text !== "string") return null;
  let firstUser = null;
  for (const line of text.split("\n")) {
    const rec = parseRecord(line);
    if (rec === undefined) continue;
    if (rec.type === "session/title") {
      const t = recordPayload(rec)?.title;
      if (typeof t === "string" && t.trim()) return t.trim();
    }
    if (firstUser === null && rec.type === "user/message") {
      const msg = recordMessage(rec) ?? {};
      if (Array.isArray(msg.content)) {
        const s = msg.content
          .map((b) => blockText(b, 200))
          .filter(Boolean)
          .join(" ")
          .trim();
        if (s) firstUser = s.length > 40 ? s.slice(0, 40) + "…" : s;
      }
    }
  }
  return firstUser;
}

/**
 * 拼接会话元数据（标题、工作目录、父会话、来源等）。
 *
 * ⚠️ **`parentSessionId` 不是 subagent 的判据**（这是实测踩过的坑）：
 * 本机 512 个会话里，271 个带 `parentSession`，其中 **248 个根本没有
 * `origin` 字段** —— 它们是 `isSeeded:true` / `delegationDepth:0` 的
 * **分叉/改写子会话**，用裸 sessionId 就能打开；只有 23 个是
 * `origin:'subagent'` / `delegationDepth:1` 的真 subagent。
 *
 * 权威判据是 header 的 `origin`（见 dsh-api-session-controller 的
 * `SessionHeader.origin?: 'subagent'`，官方注释为
 * "Coarse durable origin for navigation filtering"；官方侧栏
 * `sessionVisible()` 也正是 `if (session.origin === "subagent") return false`）：
 *   - `origin === 'subagent'` → 真 subagent：**不能**用裸 sessionId 打开，
 *     必须构造 `SubagentAddress { parentSessionId, childSessionId, mode }`
 *     交给 `uiWorkspace.openSession()`，否则宿主抛
 *     `session/agent-busy: subagent Sessions require their durable parent address`。
 *   - 有 `parentSession` 但 `origin` 不是 `'subagent'` → 普通子会话（分叉/改写），
 *     **必须用裸 sessionId 打开**；给它套 SubagentAddress 反而会被
 *     `validateAddress` 判成 `subagent/unauthorized` 而打不开。
 *
 * 会话日志里父会话字段名为 `parentSession`（见 type=session header）。
 *
 * @returns {{sessionId:string,title:string,cwd:string,createdAt:number,parentSessionId:string|undefined,origin:'subagent'|undefined}}
 */
export function sessionMeta(path, root, raw) {
  const header = readSessionHeader(path, raw);
  const rel = relative(root, path).replace(/\\/g, "/");
  const segs = rel.split("/");
  const mtime = fileMtime(path);
  const parent = header?.parentSession ?? header?.parentSessionId;
  // ⚠️ 缺省时**不要**带 `parentSessionId: undefined` / `origin: undefined` 的 own key：
  // 结果要过 agent 工具的输出 JSON Schema（`additionalProperties:false` + lossless JSON），
  // `undefined` 值既非合法 JSON，也会被列成「未声明属性」而抛 ToolOutputError。
  // 只有真 subagent 才带 `origin:'subagent'`；分叉子会话只带 `parentSessionId`。
  const isSubagent = header?.origin === "subagent";
  return {
    sessionId: header?.id ?? (segs.length >= 2 ? segs[segs.length - 2] : rel),
    title: header?.title || sessionTitle(path, raw) || "(untitled)",
    cwd: typeof header?.cwd === "string" ? header.cwd : "",
    createdAt: typeof header?.createdAt === "number" ? header.createdAt : mtime,
    ...(typeof parent === "string" && parent.length > 0 ? { parentSessionId: parent } : {}),
    ...(isSubagent ? { origin: "subagent" } : {}),
  };
}

/**
 * 在单个会话中搜索关键词。
 * 归一化条目（用户/助手/工具/标题）以可读文本匹配；
 * 未识别 envelope 以原始行匹配，但噪声类别跳过（避免元数据假命中）。
 *
 * @param {string} path 会话文件路径
 * @param {string} query 关键词
 * @param {number} limit 最多命中数
 * @param {boolean} caseSensitive 是否区分大小写
 * @param {string} [predecoded] 已解码全文（复用可避免重复解压）
 * @param {Set<string>} [groups] 启用的搜索分组；不传 = 全部参与
 * @returns {Array<{lineNo:number,text:string,kind:string}>}
 */
export function searchInLog(path, query, limit, caseSensitive = false, predecoded, groups) {
  let raw = predecoded;
  if (typeof raw !== "string") {
    raw = safeDecodeFull(path);
    if (raw === null) return [];
  }
  const needle = caseSensitive ? query : query.toLowerCase();
  const hits = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length && hits.length < limit; i++) {
    const line = lines[i];
    if (line === undefined || line.trim().length === 0) continue;

    const entry = toEntry(line, i + 1, groups);
    if (entry !== undefined) {
      const hay = caseSensitive ? entry.text : entry.text.toLowerCase();
      if (!hay.includes(needle)) continue;
      hits.push({ lineNo: i + 1, text: entry.text.slice(0, 1200), kind: entry.kind });
      continue;
    }
    const rec = parseRecord(line);
    if (rec !== undefined && isNoise(rec)) continue;
    // 原始行兜底没有可靠的语义分类，归入 other 分组：筛掉 other 时它也不参与。
    if (groups !== undefined && !groups.has("other")) continue;
    const rawHay = caseSensitive ? line : line.toLowerCase();
    if (!rawHay.includes(needle)) continue;
    hits.push({ lineNo: i + 1, text: line.slice(0, 1200), kind: "raw" });
  }
  return hits;
}

/**
 * 跨会话全文搜索（GUI 与 agent 工具共用的入口）。
 *
 * @param {object} options
 * @param {string} options.query 关键词（必填）
 * @param {number} [options.limit] 每个会话最多命中数，默认 5
 * @param {number} [options.maxSessions] 最多扫描会话数，默认 20
 * @param {boolean} [options.caseSensitive] 是否区分大小写，默认 false
 * @param {boolean} [options.includeSubagents] 是否保留真 subagent 会话（`origin:'subagent'`），
 *   默认 false —— 它们需要 SubagentAddress 才能打开，列出来多半是噪音。
 *   ⚠️ 只按 `origin` 剔除；带 `parentSession` 的**分叉子会话照常保留**（它们能打开）。
 * @param {string} [options.root] 会话根目录，缺省 sessionsRoot()
 * @param {Array<string>|Set<string>} [options.groups] 启用的搜索分组（见 records.js 的
 *   SEARCH_GROUPS）。不传或传空 = 全部参与，与不筛选一致。
 * @returns {{query:string,sessionsScanned:number,totalHits:number,matches:Array<object>,subagentsSkipped:number}}
 */
export function searchSessions({
  query,
  limit = 5,
  maxSessions = 20,
  caseSensitive = false,
  includeSubagents = false,
  root,
  groups,
}) {
  const active = normalizeGroups(groups);
  const base = root ?? sessionsRoot();
  const logs = listSessionLogs(base);
  const matches = [];
  let totalHits = 0;
  let subagentsSkipped = 0;

  for (const log of logs.slice(0, maxSessions)) {
    // 每个会话只解码一次：搜索与头部/标题复用同一份全文。
    const raw = safeDecodeFull(log);
    if (raw === null) continue;
    const hits = searchInLog(log, query, limit, caseSensitive, raw, active);
    if (hits.length === 0) continue;

    const meta = sessionMeta(log, base, raw);
    // ⚠️ 判据是 origin === 'subagent'，**不是** parentSessionId 是否存在：
    // 带 parentSession 的分叉/改写子会话能直接用 sessionId 打开，误剔会漏掉
    // 大量可打开的历史会话（实测 248 个）。
    if (meta.origin === "subagent" && !includeSubagents) {
      subagentsSkipped++;
      continue;
    }

    totalHits += hits.length;
    matches.push({
      ...meta,
      hitCount: hits.length,
      // kind 与 group 一并带出：kind 是记录类型，group 是它归属的搜索范围。
      // group 由 records.js 单点判定，UI 直接用它选标签，不必自己再复制一份映射。
      lines: hits.map(({ lineNo, text, kind }) => ({
        lineNo,
        text,
        kind,
        group: kindGroup(kind),
      })),
    });
  }

  return {
    query,
    sessionsScanned: Math.min(logs.length, maxSessions),
    totalHits,
    matches,
    subagentsSkipped,
  };
}

/**
 * 归一化搜索分组：接受数组或 Set，过滤掉未知分组。
 * 空选择（或全是未知值）按「不筛选」处理 —— 全不选时给空结果比给全量更让人困惑。
 * @param {Array<string>|Set<string>|undefined} groups
 * @returns {Set<string>|undefined}
 */
function normalizeGroups(groups) {
  if (groups === undefined || groups === null) return undefined;
  const list = typeof groups === "string" ? [groups] : [...groups];
  const set = new Set(list.filter((g) => typeof g === "string" && SEARCH_GROUPS.includes(g)));
  return set.size === 0 ? undefined : set;
}
