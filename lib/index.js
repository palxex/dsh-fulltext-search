// dsh-fulltext-search — DSH 会话全文搜索（DeepSeek Harness）。
//
// 本文件是 cordis 装配层，注册两样东西：
//   1. agent 工具 `session_search`（纯 Host 能力，模型可调用）
//   2. typert remote 服务 `sessionSearch`（供 client 半区 GUI 调用）
//
// 搜索语义全部在 lib/engine.js，两处共用，不会出现行为分叉。
// 兼容目标：DSH 0.2.0-rc.2。
import { defineTool } from "@deepseek-ai/dsh-tools";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { searchSessions } from "./engine.js";

const name = "会话全文检索";
// ⚠️ 不要声明 `inject = ["tools"]`：cordis 会等 inject 里的服务**全部就绪**
// 才调用 apply。插件树里只要有一个声明服务未及时就位，整个插件会被无限期 parked，
// 连带 typert Remote 也注册不上 —— 症状是「client 半区正常、host 路由 404」。
// 改为 inject 为空 + apply 内部按需获取（与 dsh-deeppilot 同款做法）。
const inject = [];

/** Remote 服务的包名与命名空间：client 侧通过 `remote.sessionSearch` 访问。 */
const REMOTE_PACKAGE = "dsh-fulltext-search";
const REMOTE_NAMESPACE = "sessionSearch";
const REMOTE_SERVICE = "sessionSearchRemote";

/** 单次查询的上限，防止 GUI 请求把宿主拖死。 */
/**
 * 单次查询允许扫描的最大会话数。
 * 实测本机有 502 个会话（含 v2/v3/v4 多版本命名），上限必须能覆盖全量，
 * 否则靠「最近优先」永远搜不到老会话（um 工作区就是因此完全搜不到）。
 */
const MAX_SESSIONS_LIMIT = 1000;
const MAX_HITS_LIMIT = 20;
/** 查询词长度上限。 */
const MAX_QUERY_CHARS = 500;

/** 严格的 JSON 值校验器工厂（rc.2 网关通过 create() 物化 codec）。 */
function strictCodec(typeSymbol, schema) {
  return { mode: "strict", typeSymbol, create: () => schema };
}

/** 把任意输入夹到 [min,max]，非法值回落 fallback。 */
function clampInt(value, min, max, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const n = Math.trunc(value);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

// ---- 结果集 schema（网关据此序列化/校验）----------------------------------
const searchResultSchema = {
  parse(value) {
    if (value === null || typeof value !== "object") throw new Error("result must be an object");
    return {
      query: typeof value.query === "string" ? value.query : "",
      sessionsScanned: typeof value.sessionsScanned === "number" ? value.sessionsScanned : 0,
      totalHits: typeof value.totalHits === "number" ? value.totalHits : 0,
      matches: Array.isArray(value.matches) ? value.matches : [],
      subagentsSkipped: typeof value.subagentsSkipped === "number" ? value.subagentsSkipped : 0,
    };
  },
};

/** Host 侧 remote 服务：把引擎结果暴露给 client 半区。 */
class SessionSearchRemote extends TypertRemoteService {
  /** @param {import('@deepseek-ai/cordis').Context} ctx */
  constructor(ctx) {
    super(ctx, REMOTE_SERVICE, { namespace: REMOTE_NAMESPACE });
  }

  /**
   * 跨会话全文搜索。
   * @param {object} request - `{ query, limit?, maxSessions?, caseSensitive? }`
   * @returns {Promise<object>} 与 agent 工具同构的结果对象
   */
  async query(request) {
    const query = typeof request?.query === "string" ? request.query : "";
    if (query.trim().length === 0) {
      return { query, sessionsScanned: 0, totalHits: 0, matches: [] };
    }
    // GUI 输入框可能传来超长串；截断而不是抛错，避免面板白屏。
    const bounded = query.slice(0, MAX_QUERY_CHARS);
    return searchSessions({
      query: bounded,
      limit: clampInt(request?.limit, 1, MAX_HITS_LIMIT, 5),
      maxSessions: clampInt(request?.maxSessions, 1, MAX_SESSIONS_LIMIT, 60),
      caseSensitive: request?.caseSensitive === true,
      includeSubagents: request?.includeSubagents === true,
      groups: request?.groups,
    });
  }
}

/** Remote 描述符：向 typert 注册 `sessionSearch/query` 端点。 */
// TypertContribution 的确切契约（见 dsh-typert-registry 的 types.d.ts）：
//   { package, face, schemas, model, invocations }
// 注意是 `invocations`（不是 descriptors），且 `face`/`schemas`/`model` 为必填；
// 缺任何一个字段都会让注册被静默拒绝，症状是 host 路由 404。
const REMOTE_CONTRIBUTION = {
  package: REMOTE_PACKAGE,
  face: "host",
  schemas: [],
  model: { services: [], events: [], objects: [] },
  invocations: [
    {
      id: `${REMOTE_PACKAGE}#${REMOTE_NAMESPACE}/query`,
      service: REMOTE_SERVICE,
      namespace: REMOTE_NAMESPACE,
      method: "query",
      invocation: { kind: "direct" },
      parameters: [
        {
          name: "request",
          wire: "request",
          source: "json",
          codec: strictCodec(`${REMOTE_PACKAGE}#SessionSearchQuery`, {
            parse(value) {
              if (value === null || typeof value !== "object") throw new Error("query request must be an object");
              // ⚠️ 解析结果里**绝不能出现值为 undefined 的字段**：typert 的 strict
              // 边界校验会因此判定 wire field "request" 校验失败，客户端拿到
              // error 结果后 promise 不再 settle，症状是面板永远停在
              // 「正在扫描会话…」（默认全选时不发 groups，正是这条路径）。
              // 缺省值一律靠「不出现该键」表达，由 query() 里的 clampInt 兜底。
              const out = {
                query: typeof value.query === "string" ? value.query : "",
                caseSensitive: value.caseSensitive === true,
                includeSubagents: value.includeSubagents === true,
                // 空数组 = 不筛选（engine 的 normalizeGroups 同样把空集当不筛选）
                groups: Array.isArray(value.groups)
                  ? value.groups.filter((g) => typeof g === "string")
                  : [],
              };
              if (typeof value.limit === "number") out.limit = value.limit;
              if (typeof value.maxSessions === "number") out.maxSessions = value.maxSessions;
              return out;
            },
          }),
        },
      ],
      result: strictCodec(`${REMOTE_PACKAGE}#SessionSearchResult`, searchResultSchema),
    },
  ],
};

/**
 * 工具输出的 JSON Schema，字段与 engine 返回的对象一一对应。
 * 拆成三层具名常量，复用与阅读都不用在层层缩进里找边界。
 */
const hitLineSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    lineNo: { type: "integer", required: true },
    text: { type: "string", required: true },
    // 命中来自哪类记录：user | assistant | reasoning | tool-call | tool-result |
    // title | inbox | other | raw；group 是它归属的搜索范围
    // （user | assistant | reasoning | tool | other）。两者都必须声明，否则
    // additionalProperties:false 会把引擎带出的字段判成未声明属性抛 ToolOutputError。
    kind: { type: "string", required: true },
    group: { type: "string", required: true },
  },
};

const hitEntrySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    sessionId: { type: "string", required: true },
    title: { type: "string", required: true },
    cwd: { type: "string", required: true },
    createdAt: { type: "integer", required: true },
    hitCount: { type: "integer", required: true },
    // 可选字段：真 subagent 才带 origin:"subagent"，被分叉出去的子会话只有 parentSessionId。
    // 两个都得声明，否则 additionalProperties:false 会把它们当未声明属性抛 ToolOutputError。
    parentSessionId: { type: "string" },
    origin: { type: "string", enum: ["subagent"] },
    lines: { type: "array", required: true, items: hitLineSchema },
  },
};

const searchOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: { type: "string", required: true },
    sessionsScanned: { type: "integer", required: true },
    totalHits: { type: "integer", required: true },
    matches: { type: "array", required: true, items: hitEntrySchema },
  },
};

/**
 * 注册 agent 工具。走可选注入：宿主未提供 `tools` 服务时跳过，不影响 GUI 半区。
 */
function applyTool(ctx) {
  ctx.inject(["tools"], (toolCtx) => {
    toolCtx.tools.register(defineTool({
    name: "session_search",
    description:
      "在所有本地 DeepSeek Harness 会话（含 zstd 压缩与明文存储）中全文搜索关键词，返回命中的会话标题、ID、命中行数与具体行内容。用于找回历史对话、代码片段、决策记录。`query` 必填；`limit` 限制每个会话最多返回多少条命中，默认 5；`maxSessions` 限制最多检查多少个会话，默认 20（按最近优先）；`caseSensitive` 默认 false；`includeSubagents` 默认 false（subagent 会话打不开，默认剔除）；`groups` 可把命中限定为用户消息/助手正文/思考块/工具调用与结果等类别，默认全部参与。",
    parameters: {
      query: { type: "string", required: true, description: "待匹配的关键字，缺省忽略大小写。" },
      limit: { type: "integer", description: "单个会话最多给出几条命中，缺省 5。" },
      maxSessions: { type: "integer", description: "扫描会话数的上限，由新到旧取，缺省 20。" },
      caseSensitive: { type: "boolean", description: "设为 true 才区分大小写，缺省 false。" },
      includeSubagents: { type: "boolean", description: "是否保留 subagent 子会话（默认剔除，因为它们打不开）。" },
      groups: {
        type: "array",
        items: { type: "string", enum: ["user", "assistant", "reasoning", "tool", "other"] },
        description:
          "限定命中来自哪类记录：user=用户消息/标题，assistant=助手正文，reasoning=思考块，tool=工具调用与结果，other=其余记录。缺省全部参与。默认范围会命中大量模型思考与命令输出，只想找「人聊过什么」时传 [\"user\",\"assistant\"]。",
      },
    },
    output: {
      schema: searchOutputSchema,
      render: (_args, value) => {
        const header = `关键词「${value.query}」命中 ${value.totalHits} 处，共扫描 ${value.sessionsScanned} 个会话`;
        const blocks = value.matches.map((m) => {
          const excerpt = m.lines
            .map((l) => `      L${l.lineNo}  ${String(l.text).replace(/\n/g, " ").slice(0, 150)}`)
            .join("\n");
          const label = `  · ${m.title || m.sessionId} — ${m.cwd}（${m.hitCount} 条）`;
          return `${label}\n${excerpt}`;
        });
        const text = blocks.length === 0
          ? `${header}\n      没有找到匹配的内容`
          : [header, ...blocks].join("\n");
        return [{ type: "text", text }];
      },
    },
    execute: async (args) => searchSessions({
      query: args.query,
      limit: clampInt(args.limit, 1, MAX_HITS_LIMIT, 5),
      maxSessions: clampInt(args.maxSessions, 1, MAX_SESSIONS_LIMIT, 50),
      caseSensitive: args.caseSensitive === true,
      includeSubagents: args.includeSubagents === true,
      groups: Array.isArray(args.groups) ? args.groups : undefined,
    }),
    }));
  });
}

/**
 * 注册 client GUI 用的 remote 服务。
 * 走可选 `typert` inject：没有 web 栈的 profile（如 headless）不激活，
 * agent 工具照常工作。
 */
function applyRemote(ctx) {
  ctx.inject(["typert"], (remoteCtx) => {
    new SessionSearchRemote(remoteCtx);
    const unregister = remoteCtx.typert.register(REMOTE_CONTRIBUTION);
    remoteCtx.effect(() => () => void unregister(), "dsh-fulltext-search: remote");
  });
}

function apply(ctx) {
  applyTool(ctx);
  applyRemote(ctx);
}

export { apply, inject, name };
export { SessionSearchRemote, REMOTE_NAMESPACE, REMOTE_CONTRIBUTION, searchOutputSchema };
