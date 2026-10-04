// dsh-fulltext-search/records.js — DSH 会话记录适配层（0.2.0-rc.2 格式）。
//
// DSH 0.2.0-rc.2 的会话日志是「每行一个 envelope」的 JSONL：
//   { type: "<kind>", seq, time, data: {...}, surfaceOp? }
// 会话状态（标题、消息、工具调用、工具结果）都藏在 data 里，而不是顶层。
// 本模块把各种 envelope 归一化成统一的「可搜索条目」，供搜索与渲染共用。
//
// 该文件是纯函数，不碰文件系统，便于单元测试。

/**
 * @typedef {object} SearchEntry
 * @property {number} lineNo      1-based 行号
 * @property {string} kind        语义类型：user | assistant | reasoning | tool-call | tool-result | title | inbox | other
 * @property {string} text        归一化后的可读文本（用于命中展示）
 * @property {number} time        envelope 时间戳（缺省 0）
 */

/**
 * 搜索范围分组：GUI 的筛选开关与 `session_search` 的 `groups` 参数共用这组取值。
 * 不传 = 全部参与，与旧行为一致。
 *
 *   user       用户消息、注入消息、会话标题 —— 人写下的内容
 *   assistant  助手正文
 *   reasoning  助手消息里的思考块（模型内部独白）
 *   tool       工具调用与工具结果
 *   other      其余可读记录（compaction/summary、todo、command 等）
 */
export const SEARCH_GROUPS = ["user", "assistant", "reasoning", "tool", "other"];

/**
 * 一条记录的 `kind` 归属哪个搜索分组。
 * @param {string} kind
 * @returns {"user"|"assistant"|"reasoning"|"tool"|"other"}
 */
export function kindGroup(kind) {
  if (kind === "user" || kind === "inbox" || kind === "title") return "user";
  if (kind === "tool-call" || kind === "tool-result") return "tool";
  if (kind === "reasoning") return "reasoning";
  if (kind === "assistant") return "assistant";
  // other 以及原始行兜底（raw）都归入 other
  return "other";
}

/** 内容块嵌套的最大深度，防止畸形/损坏的会话文件触发栈溢出。 */
const MAX_BLOCK_DEPTH = 64;

/**
 * 从任意 block 里抽取文本，宽容处理各种历史形态。
 * @param {unknown} block
 * @param {number} maxLen 结果文本上限
 * @param {number} depth 当前递归深度（内部使用）
 */
export function blockText(block, maxLen = 4000, depth = 0) {
  if (typeof block === "string") return block;
  if (block === null || typeof block !== "object") return "";
  if (depth >= MAX_BLOCK_DEPTH) return "";
  if (typeof block.text === "string") return block.text;
  if (typeof block.content === "string") return block.content;
  if (Array.isArray(block.content)) {
    const t = block.content
      .map((b) => blockText(b, maxLen, depth + 1))
      .filter(Boolean)
      .join("\n");
    return t.slice(0, maxLen);
  }
  let json;
  try {
    json = JSON.stringify(block);
  } catch {
    return "";
  }
  if (typeof json !== "string") return "";
  return json.length > maxLen ? json.slice(0, maxLen) + "…" : json;
}

/** 安全 JSON.parse；失败返回 undefined（调用方据此降级为原始行）。 */
export function parseRecord(line) {
  if (typeof line !== "string") return undefined;
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const v = JSON.parse(trimmed);
    return v !== null && typeof v === "object" ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 取 0.2.0-rc.2 envelope 的负载。
 * 兼容三种历史形态：data 包装（当前）、message 包装、裸记录（最老）。
 */
export function recordPayload(rec) {
  if (rec === null || typeof rec !== "object") return undefined;
  if (rec.data !== null && typeof rec.data === "object" && !Array.isArray(rec.data)) return rec.data;
  if (rec.message !== null && typeof rec.message === "object" && !Array.isArray(rec.message)) return rec.message;
  return rec;
}

/** 取消息体（带 role/content 的那层）。 */
export function recordMessage(rec) {
  const data = recordPayload(rec);
  if (data === null || typeof data !== "object") return undefined;
  if (data.message !== null && typeof data.message === "object" && !Array.isArray(data.message)) return data.message;
  return data;
}

/** 提取 content 数组。 */
function contentBlocks(msg) {
  if (msg === null || typeof msg !== "object") return [];
  if (Array.isArray(msg.content)) return msg.content;
  return [];
}

/** 工具参数序列化为单行文本。 */
function formatArguments(args) {
  if (args === undefined || args === null) return "{}";
  if (typeof args === "string") {
    // 参数常是 JSON 字符串：尽量解成紧凑可读形态。
    const parsed = parseRecord(args);
    if (parsed !== undefined) {
      try {
        return JSON.stringify(parsed);
      } catch {
        return args;
      }
    }
    return args;
  }
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

/**
 * 归一化 `agent/inbox/spliced`：`data.inserted` 是一组消息，
 * 每条消息形如 `{ content: [{type:'text', text}, ...] }`（如 background job 回执）。
 * 这些是真实正文，必须可搜索。
 * @param {unknown} data envelope 的 data 负载
 * @returns {string} 拼接后的文本；无可读内容时返回空串
 */
function renderInserted(data) {
  const inserted = data?.inserted;
  if (!Array.isArray(inserted)) return "";
  const out = [];
  for (const item of inserted) {
    const blocks = Array.isArray(item?.content) ? item.content : [];
    const text = blocks
      .map((b) => blockText(b, 4000))
      .filter(Boolean)
      .join("\n")
      .trim();
    if (text) out.push(text);
  }
  return out.join("\n");
}

/**
 * 把一条 envelope 归一化为可搜索条目；无法识别时返回 undefined。
 * 识别不了的行由调用方降级为「原始行搜索」。
 *
 * `groups` 是启用的搜索分组集合（Set）；不传表示全部分组都参与，行为与
 * 引入筛选之前完全一致。被筛掉的分组既不算命中，也不会出现在返回文本里。
 *
 * @param {string} line
 * @param {number} lineNo
 * @param {Set<string>} [groups]
 * @returns {SearchEntry | undefined}
 */
export function toEntry(line, lineNo, groups) {
  const rec = parseRecord(line);
  if (rec === undefined) return undefined;
  const type = typeof rec.type === "string" ? rec.type : "";
  const time = typeof rec.time === "number" ? rec.time : 0;
  const data = recordPayload(rec) ?? {};
  /** 该 kind 所在分组是否启用。 */
  const want = (kind) => groups === undefined || groups.has(kindGroup(kind));

  // 标题
  if (type === "session/title") {
    if (!want("title")) return undefined;
    const title = typeof data.title === "string" ? data.title.trim() : "";
    if (title) return { lineNo, kind: "title", text: `[标题] ${title}`, time };
    return undefined;
  }

  // 用户消息
  if (type === "user/message") {
    if (!want("user")) return undefined;
    const msg = recordMessage(rec) ?? {};
    const text = contentBlocks(msg)
      .map((b) => blockText(b, 4000))
      .filter(Boolean)
      .join("\n");
    if (text.trim()) return { lineNo, kind: "user", text: `[用户] ${text}`, time };
    return undefined;
  }

  // 助手消息：可能同时含 reasoning / text / tool-call 三种 block。
  // 逐段打分组标签：筛选时既能决定这条算不算命中，也能只展示要的那几段
  // （否则关掉「思考」后，片段里仍会夹着 [思考] 正文）。
  if (type === "assistant/message") {
    const msg = recordMessage(rec) ?? {};
    const parts = [];
    for (const b of contentBlocks(msg)) {
      if (b === null || typeof b !== "object") {
        const t = blockText(b, 4000);
        if (t) parts.push({ group: "assistant", text: t });
        continue;
      }
      if (b.type === "reasoning") {
        const t = blockText(b, 4000);
        if (t) parts.push({ group: "reasoning", text: `[思考] ${t}` });
      } else if (b.type === "text") {
        const t = blockText(b, 4000);
        if (t) parts.push({ group: "assistant", text: `[助手] ${t}` });
      } else if (b.type === "tool-call") {
        parts.push({ group: "tool", text: `[工具调用 ${b.name ?? "tool"}] ${formatArguments(b.arguments ?? b.input)}` });
      } else {
        const t = blockText(b, 4000);
        if (t) parts.push({ group: "assistant", text: t });
      }
    }
    const kept = groups === undefined ? parts : parts.filter((p) => groups.has(p.group));
    if (kept.length === 0) return undefined;
    // 只剩一类段落时把 kind 报得更具体，结果列表才好标注这条命中来自哪。
    const seen = new Set(kept.map((p) => p.group));
    const kind = seen.size === 1 && seen.has("reasoning")
      ? "reasoning"
      : seen.size === 1 && seen.has("tool")
        ? "tool-call"
        : "assistant";
    return { lineNo, kind, text: kept.map((p) => p.text).join("\n"), time };
  }

  // 工具调用（独立 envelope 形态）
  if (type === "tool/call") {
    if (!want("tool-call")) return undefined;
    const name = data.name ?? data.toolName ?? "tool";
    return {
      lineNo,
      kind: "tool-call",
      text: `[工具调用 ${name}] ${formatArguments(data.arguments ?? data.input)}`,
      time,
    };
  }

  // 工具结果：content 里通常是 `tool-result` block，其 content 再嵌 text block。
  // blockText 会递归穿透任一形态，无需在此分支判断。
  if (type === "tool/result") {
    if (!want("tool-result")) return undefined;
    const msg = recordMessage(rec) ?? {};
    const text = contentBlocks(msg)
      .map((b) => blockText(b, 8000))
      .filter(Boolean)
      .join("\n");
    if (text.trim()) return { lineNo, kind: "tool-result", text: `[工具结果] ${text}`, time };
    return undefined;
  }

  // 注入到 inbox 的消息（background job 回执等）
  if (type === "agent/inbox/spliced") {
    if (!want("inbox")) return undefined;
    const text = renderInserted(data);
    if (text) return { lineNo, kind: "inbox", text: `[注入消息] ${text}`, time };
    return undefined;
  }

  // 其余内容型 envelope（compaction/summary、todo/write、command/run、
  // approval/asked、session/end-seed…）：尝试抽取可读字段，避免回落到原始 JSON。
  const rendered = renderFallback(rec);
  if (rendered !== undefined) {
    if (!want("other")) return undefined;
    return { lineNo, kind: "other", text: `[${type || "记录"}] ${rendered}`, time };
  }
  return undefined;
}

/**
 * 兜底渲染：对**已确认不含正文、但也不属于噪声**的 envelope，
 * 从 data 里挑出可直接阅读的字符串字段，避免展示整行原始 JSON。
 * 找不到可读字段时返回 undefined，交回调用方做原始行匹配。
 * @param {object} rec
 * @returns {string | undefined}
 */
export function renderFallback(rec) {
  const data = recordPayload(rec);
  if (data === null || typeof data !== "object") return undefined;
  const parts = [];
  for (const key of ["text", "title", "summary", "content", "message", "output", "value", "delta"]) {
    const v = data[key];
    if (typeof v === "string" && v.trim()) {
      parts.push(v.trim());
    } else if (v !== null && typeof v === "object") {
      const t = blockText(v, 4000).trim();
      if (t) parts.push(t);
    }
  }
  if (parts.length === 0) return undefined;
  return parts.join("\n").slice(0, 4000);
}

/**
 * 该 envelope 是否属于「结构/传输层记录」——不含面向用户的正文。
 *
 * 这是**允许正文搜索的负面清单**：只有确定不含可读内容的类别才算噪声。
 * 判定原则：宁可漏判（退回原始行匹配）也不能误判，
 * 因为误判会让 `compaction/summary`、`todo/write` 这类真正有文本的记录搜不到。
 *
 * 采用「前缀族 + 具名清单」两段式，避免逐个枚举不断漏项。
 */
const NOISE_PREFIXES = [
  "request/", // request/header、request/context
  "step/",
  "turn/",
  "llm/",
];

const NOISE_NAMES = new Set([
  "assistant/chunk",
  "reasoning-chunks",
  "text-chunks",
  "tool-call-chunks",
  // 生成标题用的 LLM 请求（含 system prompt），不是会话正文
  "session/title-llm-request",
]);

export function isNoise(rec) {
  const type = typeof rec?.type === "string" ? rec.type : "";
  if (type === "") return false;
  if (NOISE_NAMES.has(type)) return true;
  if (type.endsWith("/chunk") || type.endsWith("-chunks")) return true;
  return NOISE_PREFIXES.some((p) => type.startsWith(p));
}
