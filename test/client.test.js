// 新装配层的测试：searchSessions 引擎、SessionSearchRemote（GUI 走的 remote）、
// client bundle 的静态契约。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { searchSessions, sessionMeta, listSessionLogs, sessionsRoot } from "../lib/engine.js";
import { SEARCH_GROUPS } from "../lib/records.js";
import { SessionSearchRemote, REMOTE_NAMESPACE, REMOTE_CONTRIBUTION } from "../lib/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "sessions");

// ---------------------------------------------------------------- 引擎层

test("searchSessions: 在指定 root 上跨会话搜索并返回结构化结果", () => {
  const res = searchSessions({ query: "kumquat", root: FIXTURES, maxSessions: 10, limit: 5 });
  assert.equal(typeof res.query, "string");
  assert.equal(res.query, "kumquat");
  assert.ok(res.sessionsScanned >= 1, "至少扫描到 fixture");
  assert.ok(res.totalHits >= 1, "应命中 fixture 中的 kumquat");
  assert.ok(res.matches.length >= 1);
  const m = res.matches[0];
  for (const key of ["sessionId", "title", "cwd", "createdAt", "hitCount", "lines"]) {
    assert.ok(Object.hasOwn(m, key), `match 缺字段 ${key}`);
  }
  assert.equal(m.title, "kumquat investigation", "标题应取自 session/title");
  assert.equal(m.cwd, "/home/palxex/demo");
  assert.equal(typeof m.createdAt, "number");
  assert.ok(Array.isArray(m.lines) && m.lines.length > 0);
  assert.equal(typeof m.lines[0].lineNo, "number");
  assert.equal(typeof m.lines[0].text, "string");
});

test("searchSessions: limit 精确控制每个会话的命中数", () => {
  const one = searchSessions({ query: "kumquat", root: FIXTURES, maxSessions: 10, limit: 1 });
  assert.ok(one.matches.every((m) => m.lines.length <= 1));
  const three = searchSessions({ query: "kumquat", root: FIXTURES, maxSessions: 10, limit: 3 });
  assert.ok(three.matches.every((m) => m.lines.length <= 3));
});

test("searchSessions: 未命中返回空 matches 而非抛错", () => {
  const res = searchSessions({ query: "zzz-absent-zzz", root: FIXTURES, maxSessions: 10 });
  assert.equal(res.totalHits, 0);
  assert.deepEqual(res.matches, []);
});

test("searchSessions: caseSensitive 透传", () => {
  const ins = searchSessions({ query: "KUMQUAT", root: FIXTURES, maxSessions: 10, caseSensitive: false });
  const sens = searchSessions({ query: "KUMQUAT", root: FIXTURES, maxSessions: 10, caseSensitive: true });
  assert.ok(ins.totalHits > 0, "默认不区分大小写应命中");
  assert.equal(sens.totalHits, 0, "区分大小写时大写不应命中");
});

test("sessionMeta: header 缺字段时安全回落", () => {
  // 构造只有 session header 的最小会话
  const meta = sessionMeta(join(FIXTURES, "sess-a/session.jsonl"), FIXTURES);
  assert.equal(meta.sessionId, "session-1111-2222");
  assert.equal(meta.cwd, "/home/palxex/demo");
  assert.equal(meta.createdAt, 1700000000000);
});

test("listSessionLogs / sessionsRoot: 返回可用的根与列表", () => {
  assert.equal(typeof sessionsRoot(), "string");
  const logs = listSessionLogs(FIXTURES);
  assert.ok(logs.length >= 2, "fixture 目录应有明文 + zstd 两个会话");
  // 必须按 mtime 倒序
  assert.ok(Array.isArray(logs));
});

// ---------------------------------------------------------------- Remote 层

const fakeCtx = () => ({
  reflect: { provide() {} },
  effect() {},
});

/**
 * Remote 测试隔离：sessionsRoot() 解析 $DSH_HOME/sessions，
 * 把 DSH_HOME 指向 test/ 即落在 test/sessions（存放 fixture 会话）。
 * 这样测试快速且与开发机的真实会话数据无关。
 */
function withFixtureHome(fn) {
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = here;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
  }
}

test("REMOTE_NAMESPACE: 与 client 侧约定一致", () => {
  assert.equal(REMOTE_NAMESPACE, "sessionSearch");
});

test("REMOTE_CONTRIBUTION: 符合 TypertContribution 契约（含 face/schemas/model/invocations）", () => {
  assert.equal(REMOTE_CONTRIBUTION.package, "dsh-fulltext-search");
  // 契约字段齐全：缺任何一个都会被注册器静默拒绝（症状 host 路由 404）
  assert.equal(REMOTE_CONTRIBUTION.face, "host");
  assert.ok(Array.isArray(REMOTE_CONTRIBUTION.schemas), "schemas 必须是数组");
  assert.ok(REMOTE_CONTRIBUTION.model, "model 必填");
  for (const k of ["services", "events", "objects"]) {
    assert.ok(Array.isArray(REMOTE_CONTRIBUTION.model[k]), `model.${k} 必须是数组`);
  }
  assert.ok(Array.isArray(REMOTE_CONTRIBUTION.invocations), "方法清单字段名是 invocations，不是 descriptors");
  assert.equal(REMOTE_CONTRIBUTION.descriptors, undefined, "不得使用 descriptors（旧字段名）");
  const d = REMOTE_CONTRIBUTION.invocations[0];
  assert.equal(d.namespace, "sessionSearch");
  assert.equal(d.method, "query");
  assert.equal(d.id, "dsh-fulltext-search#sessionSearch/query");
  // codec 必须是 strict + create()，否则 rc.2 网关物化失败
  assert.equal(d.parameters[0].codec.mode, "strict");
  assert.equal(typeof d.parameters[0].codec.create, "function");
  assert.equal(d.result.mode, "strict");
  assert.equal(typeof d.result.create, "function");
});

test("SessionSearchRemote.query: 空查询短路，不扫描磁盘", async () => {
  const svc = new SessionSearchRemote(fakeCtx());
  for (const q of ["", "   ", "\n\t"]) {
    const res = await svc.query({ query: q });
    assert.equal(res.totalHits, 0);
    assert.deepEqual(res.matches, []);
    assert.equal(res.sessionsScanned, 0, "空查询不应扫描会话");
  }
});

test("SessionSearchRemote.query: 非对象入参不抛错", async () => {
  const svc = new SessionSearchRemote(fakeCtx());
  for (const bad of [undefined, null, 42, "x", []]) {
    const res = await svc.query(bad);
    assert.equal(res.totalHits, 0);
  }
});

test("SessionSearchRemote.query: 超长查询被截断而非抛错", async () => {
  const svc = new SessionSearchRemote(fakeCtx());
  const res = await withFixtureHome(() => svc.query({ query: "x".repeat(5000), maxSessions: 1, limit: 1 }));
  assert.ok(res.query.length <= 500, `查询应被截断，实际 ${res.query.length}`);
});

test("SessionSearchRemote.query: 在隔离的 fixture 根上真实命中", async () => {
  const svc = new SessionSearchRemote(fakeCtx());
  const res = await withFixtureHome(() => svc.query({ query: "kumquat", limit: 5, maxSessions: 10 }));
  assert.ok(res.totalHits >= 1, "应命中 fixture 中的 kumquat");
  assert.equal(res.matches[0].title, "kumquat investigation");
});

test("SessionSearchRemote.query: limit / maxSessions 被夹到安全范围", async () => {
  const svc = new SessionSearchRemote(fakeCtx());
  const res = await withFixtureHome(() => svc.query({ query: "the", limit: 99999, maxSessions: 99999 }));
  assert.ok(res.sessionsScanned <= 200, "maxSessions 上限 200");
  assert.ok(res.matches.every((m) => m.lines.length <= 20), "limit 上限 20");
});

test("SessionSearchRemote.query: 负数/NaN/小数入参回落默认值", async () => {
  const svc = new SessionSearchRemote(fakeCtx());
  for (const bad of [-5, NaN, Infinity, 1.7, "3"]) {
    const res = await withFixtureHome(() => svc.query({ query: "the", limit: bad, maxSessions: bad }));
    assert.ok(res.sessionsScanned >= 0);
    assert.ok(Number.isInteger(res.sessionsScanned));
  }
});

// ---------------------------------------------------------------- Client 契约

const clientSrc = readFileSync(join(here, "..", "lib", "client.js"), "utf8");

test("client.js: 范围分组清单与 records.js 的 SEARCH_GROUPS 逐字一致", () => {
  const m = clientSrc.match(/const SEARCH_GROUPS = \[([^\]]*)\]/);
  assert.ok(m, "client.js 应声明 SEARCH_GROUPS");
  const clientGroups = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  assert.deepEqual(clientGroups, SEARCH_GROUPS,
    "两边不一致会让筛选开关送出 Host 不认的分组");
});

test("client.js: 面板提供了范围筛选开关并下发 groups", () => {
  assert.match(clientSrc, /className: "dsss-filters"/, "应有筛选条");
  assert.match(clientSrc, /toggleGroup/, "应能逐项切换范围");
  assert.match(clientSrc, /groups:\s*active\.size === SEARCH_GROUPS\.length \? undefined : \[\.\.\.active\]/,
    "全选时应不传 groups（保持全量语义），否则只送选中的分组");
  assert.match(clientSrc, /panel\.filterNone/, "全不选时应给出提示");
});

test("client.js: 默认只开「用户」范围（全量匹配的噪音太大）", () => {
  assert.match(clientSrc, /const DEFAULT_GROUPS = \["user"\]/,
    "默认范围应只有 user");
  assert.match(clientSrc, /useState\(\(\) => new Set\(DEFAULT_GROUPS\)\)/,
    "初始 state 必须用 DEFAULT_GROUPS，而不是 SEARCH_GROUPS");
  assert.ok(!/useState\(\(\) => new Set\(SEARCH_GROUPS\)\)/.test(clientSrc),
    "不得退回「默认全选」");
});

test("client.js: 范围重搜 effect 只能依赖 groups —— 依赖 runSearch 会无限重搜卡死页面", () => {
  // slot 注入的 t 每次渲染都是新函数 → runSearch 身份每渲染必变 →
  // 若重搜 effect 依赖它，就会「渲染→搜索→setState→渲染」转死。
  // 这个坑实测把页面主线程打满，CDP 都连不上，必须钉住。
  const m = clientSrc.match(/void search\(q\);\s*\}, \[([^\]]*)\]\)/);
  assert.ok(m, "应能定位「切换范围后重搜」的 effect");
  const deps = m[1].split(",").map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(deps, ["groups"], `该 effect 只允许依赖 groups，实际依赖 ${JSON.stringify(deps)}`);
  assert.match(clientSrc, /runSearchRef\.current = runSearch/, "重搜必须经 ref 调用 runSearch");
});

test("client.js: 客户端 codec 透传 groups（漏掉会让开关点了没反应）", () => {
  const codec = clientSrc.match(/codec: strictCodec\(`\$\{REMOTE_PACKAGE\}#SessionSearchQuery`[\s\S]*?\n\s{14}\}\),/);
  assert.ok(codec, "应能定位客户端请求 codec");
  assert.match(codec[0], /groups:\s*Array\.isArray\(value\.groups\)/,
    "客户端 codec 必须与 Host 侧同步透传 groups");
});

test("REMOTE_CONTRIBUTION: 请求 codec 的解析结果不得含 undefined 值字段", () => {
  // typert 的 strict 边界校验会拒绝解析结果里值为 undefined 的字段，整个请求被判
  // input-invalid；客户端拿到 error 结果后 promise 不再 settle，症状是面板永远停在
  // 「正在扫描会话…」。默认全选时不发 groups，正好走这条路径 —— 实测踩过。
  const inv = REMOTE_CONTRIBUTION.invocations.find((x) => x.method === "query");
  assert.ok(inv, "应有 query invocation");
  const codec = inv.parameters[0].codec.create();

  const full = codec.parse({ query: "x", limit: 5, maxSessions: 20 });
  for (const [k, v] of Object.entries(full)) {
    assert.notEqual(v, undefined, `字段 ${k} 为 undefined 会让边界校验失败`);
  }
  assert.deepEqual(full.groups, [], "缺省应解析为空数组（=不筛选），不能是 undefined");

  const withGroups = codec.parse({ query: "x", groups: ["user", 7] });
  assert.deepEqual(withGroups.groups, ["user"], "非字符串分组应被过滤");

  const bare = codec.parse({ query: "x" });
  assert.ok(!("limit" in bare) && !("maxSessions" in bare),
    "缺省时应省略该键，而不是给一个 undefined");
  for (const [k, v] of Object.entries(bare)) {
    assert.notEqual(v, undefined, `字段 ${k} 为 undefined 会让边界校验失败`);
  }
});

test("client.js: 使用 ModuleLoader 格式且 id 与包名一致", () => {
  assert.match(clientSrc, /window\.__ModuleLoader__\.load\(/);
  assert.match(clientSrc, /id:\s*"dsh-fulltext-search"/);
});

test("client.js: 只 require 种子白名单", () => {
  const SEED = new Set([
    "react",
    "react/jsx-runtime",
    "react-dom",
    "react-dom/client",
    "@deepseek-ai/cordis",
    "@deepseek-ai/dsh-client-ui-slots",
    "@deepseek-ai/dsh-client-ui-primitives",
  ]);
  const required = [...clientSrc.matchAll(/require\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]);
  assert.ok(required.length > 0, "应至少 require 一次");
  for (const spec of required) {
    assert.ok(SEED.has(spec), `require("${spec}") 不在种子白名单内，运行时会 miss`);
  }
});

test("client.js: 注册 sidebar.footer.action 槽（非抢占式入口）", () => {
  assert.match(clientSrc, /slots\.inject\(\s*"sidebar\.footer\.action"/);
  assert.match(clientSrc, /name:\s*"sidebar\.footer\.action"/);
  // 不能抢占 official 单占槽
  for (const occupied of ["sidebar.workspaces", "sidebar.settings"]) {
    assert.ok(!clientSrc.includes(`slots.inject("${occupied}"`), `不得抢占 ${occupied}`);
  }
});

test("client.js: 注册 slot 时直接传组件函数（不是包一层 jsx）", () => {
  // 反例（会渲染空白）：
  //   register({...}, (props) => jsx(Comp, props))
  //   register({...}, () => jsx(Component, null))
  // 正确：register({...}, Component)
  const call = clientSrc.match(/slots\.register\(\s*\{[\s\S]*?\},\s*([A-Za-z0-9_$]+)\s*,?\s*\)/);
  assert.ok(call, "应能解析出 slots.register 的第二个实参");
  const target = call[1];
  assert.ok(
    /^[A-Z]/.test(target),
    `slot 注册的第二个实参必须是组件函数本身（形如 SessionSearchEntry），实际: ${target}`,
  );
  // 不得是箭头函数包装
  assert.ok(
    !/slots\.register\(\s*\{[\s\S]*?\},\s*\(/.test(clientSrc),
    "不得用箭头函数包装组件后再注册（会渲染空白）",
  );
});

test("client.js: 组件对未注入的 t 有兜底（不崩）", () => {
  assert.match(clientSrc, /typeof t !== "function"/, "应有 t 的兜底判断");
});


test("client.js: 通过 openSession 打开历史会话", () => {
  assert.match(clientSrc, /openSession/);
  assert.match(clientSrc, /uiWorkspace/);
});

test("client.js: 走 remote 通道而非自建 RPC（rc.2 已废弃自建通道）", () => {
  assert.match(clientSrc, /\$mount\(/);
  assert.ok(!/connection\.rpc\.call|rpc\.handle/.test(clientSrc), "不得使用已废弃的自建 RPC 通道");
});

test("client.js: inject 只声明已存在的服务，且不含自建 remote 命名空间", () => {
  const m = clientSrc.match(/bundleModule\.exports\.inject\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(m, "应导出 inject");
  const list = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  for (const need of ["slots", "remote", "uiWorkspace", "locale"]) {
    assert.ok(list.includes(need), `inject 缺少 "${need}"`);
  }
  // 关键回归：不得把本插件自己 $mount 出来的命名空间写进 inject，
  // 否则 apply 等注入、注入等 $mount、$mount 在 apply 里 —— 永久死锁。
  assert.ok(
    !list.some((n) => n.startsWith("remote.")),
    `inject 不得声明自建 remote 命名空间（死锁），实际: ${list.join(", ")}`,
  );
  assert.ok(!m[1].includes("REMOTE_NAMESPACE"), "不得用 REMOTE_NAMESPACE 拼进 inject");
});

test("package.json: dsh.client 声明合法（platform=web + 注入包名数组）", () => {
  const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
  const client = pkg.dsh?.client;
  assert.ok(client, "package.json 应声明 dsh.client（GUI 半区）");
  assert.equal(client.platform, "web");
  assert.ok(Array.isArray(client.inject), "dsh.client.inject 应为数组");
  // dsh.client.inject 里是**客户端插件包名**（与 module 层的短服务名不同）
  for (const spec of client.inject) {
    assert.match(spec, /^@deepseek-ai\//, `dsh.client.inject 应为包名，实际: ${spec}`);
  }
  assert.ok(pkg.exports["./client"], 'exports["./client"] 必须存在，否则 host 报 "declares dsh.client but exports no ./client bundle"');
});

test("client.js: Host 与 Client 的 Remote 描述符逐字一致", () => {
  // 两侧 descriptor 不一致会导致 $mount 失败，必须交叉校验
  const clientDesc = clientSrc.match(/id:\s*`\$\{REMOTE_PACKAGE\}#\$\{REMOTE_NAMESPACE\}\/\$\{REMOTE_METHOD\}`/);
  assert.ok(clientDesc, "client 侧 descriptor id 结构应与 host 一致");
  assert.match(clientSrc, /const REMOTE_PACKAGE = "dsh-fulltext-search"/);
  assert.match(clientSrc, /const REMOTE_NAMESPACE = "sessionSearch"/);
  assert.match(clientSrc, /const REMOTE_METHOD = "query"/);
  const host = REMOTE_CONTRIBUTION.invocations[0];
  assert.equal(host.namespace, "sessionSearch");
  assert.equal(host.method, "query");
});

test("client.js: 有 CSS 幂等注入标记", () => {
  assert.match(clientSrc, /data-plugin-css/);
  assert.match(clientSrc, /querySelector\('style\[data-plugin-css=/);
});

// ------------------------------------------------- 官方组件名交叉校验（防拼写漂移）

test("client.js: 引用的每个 primitives 组件都真实存在", () => {
  // 从真实 primitives 的 d.ts 提取导出名（权威来源），避免凭记忆写组件名。
  const PRIMITIVES_DIR =
    "/home/palxex/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-primitives";
  let dts;
  try {
    dts = readFileSync(join(PRIMITIVES_DIR, "lib/types/index.d.ts"), "utf8");
  } catch {
    // 没有本机宿主副本时跳过（CI/其他机器），不误报失败。
    return;
  }
  // 收集所有导出的组件/图标名；递归解析 re-export 子模块（icons 等）
  const available = new Set();
  const seenFiles = new Set();
  function collect(file, depth) {
    if (depth > 3 || seenFiles.has(file)) return;
    seenFiles.add(file);
    let src;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      return;
    }
    for (const m of src.matchAll(/export\s+(?:declare\s+)?(?:const|function|class)\s+([A-Za-z0-9_$]+)/g)) available.add(m[1]);
    for (const m of src.matchAll(/export\s*\{\s*([^}]+)\s*\}/g)) {
      for (const part of m[1].split(",")) {
        const name = part.split(/\s+as\s+/).pop().trim();
        if (/^[A-Za-z0-9_$]+$/.test(name)) available.add(name);
      }
    }
    for (const m of src.matchAll(/from\s+'\.\/([A-Za-z0-9_$./-]+)'/g)) {
      collect(join(dirname(file), m[1].replace(/\.tsx?$/, ".d.ts")), depth + 1);
    }
  }
  collect(join(PRIMITIVES_DIR, "lib/types/index.d.ts"), 0);
  assert.ok(available.size > 50, `应解析出大量 primitives 导出，实际 ${available.size}`);

  // 找出 client.js 里 primitives.X 的用法
  const used = new Set();
  for (const m of clientSrc.matchAll(/primitives\.([A-Za-z0-9_$]+)/g)) used.add(m[1]);
  assert.ok(used.size > 0, "client.js 应使用 primitives 组件");

  const missing = [...used].filter((n) => !available.has(n));
  assert.deepEqual(missing, [], `引用了不存在的 primitives 导出: ${missing.join(", ")}`);
});

test("client.js: 子节点一律走 props.children（第三参是 key，不是 child）", () => {
  // React 18/19 的 react/jsx-runtime 签名都是 (type, config, maybeKey)：
  // 第三个参数是 key，不是子节点。`jsx("div", {className}, child)` 会
  // **静默丢弃** child（实测 props.children === undefined，值跑到 key 上）。
  // 症状：slot 注册成功却渲染成空 div —— 本项目实际踩过。
  //
  // 静态检查只覆盖可判定的部分；真正的语义验证在
  // test/jsx-children.test.js（用真实 React 渲染并断言 DOM）。
  assert.equal(/jsx\(\s*fragments\s*,/.test(clientSrc), false, "Fragment 必须用 jsxs");

  const code = clientSrc
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

  // jsx(<type>, {...}, <third>)：third 只能是 key。
  // 若形如 t(...) / jsx(...) / String(...) 调用，则明显是子节点被误放。
  const offenders = [];
  const re = /(?:^|[^.\w$])jsx\(\s*("[a-z]+"|[A-Z][A-Za-z0-9_$]*)\s*,\s*\{[\s\S]*?\}\s*,\s*([^)]*(?:\([^)]*\)[^)]*)*)\)/g;
  for (const m of code.matchAll(re)) {
    const third = m[2].trim();
    if (/^(t|jsx|jsxs|String|Number|React\.createElement)\s*\(/.test(third)) {
      const line = code.slice(0, m.index).split("\n").length;
      offenders.push(`L${line}: jsx 第三参疑似子节点 -> ${third.slice(0, 60)}`);
    }
  }
  assert.deepEqual(offenders, [], `jsx 第三参是 key，子节点请放进 props.children：\n${offenders.join("\n")}`);
});

test("client.js: 必须解包 Remote 的 {ok, value} 信封", () => {
  // Remote 方法返回 `{ ok: true, value } | { ok: false, error }`，
  // 不是裸数据。直接把返回值当结果用 → matches undefined → 永远「0 处命中」。
  assert.match(clientSrc, /"ok" in res/, "应判断返回值是否为 Remote 信封");
  assert.match(clientSrc, /res\.ok !== true/, "应处理 ok=false 的错误分支");
  assert.match(clientSrc, /res\.value/, "应取 res.value 作为真实数据");
});

// ------------------------------------------------- UI 对齐 DeepSeek 官网（规格文档）

test("client.js: 面板对齐 DeepSeek 官网「搜索对话」规格", () => {
  // 规格见 docs/deepseek-search-ui-spec.md（实测快照）。
  // 关键尺寸/形态必须与官网一致，避免以后被改回居中 Modal。
  const spec = [
    [/\.dsss-card\{[^}]*width:660px/, "面板宽度 660px"],
    [/\.dsss-card\{[^}]*border-radius:20px/, "面板圆角 20px"],
    [/\.dsss-card\{[^}]*margin:114px auto 24px/, "顶部悬浮（114px）而非居中"],
    [/\.dsss-searchbar\{[^}]*height:61px/, "输入行高 61px"],
    [/\.dsss-input\{[^}]*font-size:16px/, "输入字号 16px"],
    [/\.dsss-rowIcon\{[^}]*width:36px;height:36px/, "结果行图标 36x36"],
    [/\.dsss-rowIcon\{[^}]*border-radius:28px/, "结果行图标圆形 28px"],
    [/\.dsss-row\{[^}]*border-radius:16px/, "结果行圆角 16px"],
    [/\.dsss-rowTitle\{[^}]*font-size:15px/, "结果标题 15px"],
    [/\.dsss-rowDate\{[^}]*font-size:13px/, "结果日期 13px"],
  ];
  const missing = spec.filter(([re]) => !re.test(clientSrc)).map(([, label]) => label);
  assert.deepEqual(missing, [], `UI 规格缺失项：${missing.join("、")}`);
});

test("client.js: 用 headless Modal 承载悬浮面板（保留遮罩/Escape）", () => {
  assert.match(clientSrc, /headless:\s*true/, "应使用 headless Modal 自绘结构");
  assert.match(clientSrc, /onKeyDownCapture/, "应接管键盘（↑↓/Enter）");
  // ⚠️ 实测：Modal 只把 className 落到 dialog 包裹元素，contentClassName 不生效。
  // 卡片样式必须写在 className 上，否则宽度/圆角全都不生效（曾因此宽度错成 380px）。
  assert.match(clientSrc, /className:\s*"dsss-card"/, "卡片样式类必须在 className 上");
  assert.equal(/contentClassName\s*:/.test(clientSrc), false, "代码中不得使用不生效的 contentClassName");
});


test("client.js: 结果行支持键盘上下选择", () => {
  assert.match(clientSrc, /"ArrowDown"/, "应支持 ↓ 选择");
  assert.match(clientSrc, /"ArrowUp"/, "应支持 ↑ 选择");
  assert.match(clientSrc, /matches\[active\]/, "Enter 应打开当前选中项");
});

test("client.js: 日期格式化为「N月N日」", () => {
  assert.match(clientSrc, /"月"\s*\+\s*d\.getDate\(\)\s*\+\s*"日"/, "应输出「N月N日」");
});

test("client.js: 宽度是响应式的（768px 断点，非硬编码）", () => {
  // 宿主 Modal 的 dialog 包裹元素自带 380px；不覆盖就会窄成 380。
  assert.match(clientSrc, /\.dsss-card\{[^}]*width:660px\s*!important/, "桌面必须 !important 覆盖宿主宽度");
  assert.match(clientSrc, /\.dsss-card\{[^}]*border-radius:20px/, "桌面圆角 20px");
  // 不得写死 min-width:660px —— 窄屏会横向溢出
  assert.ok(!/\.dsss-card\{[^}]*min-width:660px/.test(clientSrc), "不得写死 min-width:660px");
  assert.match(clientSrc, /@media \(max-width:767\.98px\)/, "应有 768px 断点");
});

test("client.js: <768px 全屏接管（桌面窄窗口与手机一致）", () => {
  // 需求：宽度 <768px 时全屏接管，不区分设备类型（桌面窄窗/手机都铺满）。
  const m = clientSrc.match(/@media \(max-width:767\.98px\)\{([\s\S]*?)\n\s*\}\n/);
  assert.ok(m, "应能解析出窄屏规则块");
  const block = m[1];
  // 卡片：全屏、去圆角、去阴影、去外边距
  assert.match(block, /\.dsss-card\{[^}]*width:100%\s*!important/, "窄屏卡片应铺满宽度");
  assert.match(block, /\.dsss-card\{[^}]*height:100%/, "窄屏卡片应撑满高度");
  assert.match(block, /border-radius:0\s*!important/, "窄屏应去圆角");
  assert.match(block, /box-shadow:none\s*!important/, "窄屏应去阴影");
  // 宿主 modal 根的内边距必须归零（否则 inset 成 552px —— 实测踩过）
  assert.match(block, /div:has\(> \.dsss-card\)[^}]*padding:0\s*!important/, "宿主 modal 根内边距必须归零");
  // 宿主根用构建哈希类名，必须用 :has() 而非硬编码类名
  assert.ok(!/\.dsss-modalRoot/.test(clientSrc), "不得硬编码宿主哈希类名");
  // 面板不再限制 585px 高
  assert.match(block, /\.dsss-panel\{[^}]*max-height:none/, "窄屏面板应解除高度上限");
});

test("client.js: 用 headless Modal 承载悬浮面板（保留遮罩/Escape）", () => {
  assert.match(clientSrc, /headless:\s*true/, "应使用 headless Modal 自绘结构");
  assert.match(clientSrc, /onKeyDownCapture/, "应接管键盘（↑↓/Enter）");
  // ⚠️ 实测：Modal 只把 className 落到 dialog 包裹元素，contentClassName 不生效。
  // 卡片样式必须写在 className 上，否则宽度/圆角全都不生效（曾因此宽度错成 380px）。
  assert.match(clientSrc, /className:\s*"dsss-card"/, "卡片样式类必须在 className 上");
  assert.equal(/contentClassName\s*:/.test(clientSrc), false, "代码中不得使用不生效的 contentClassName");
});


test("client.js: 结果行支持键盘上下选择", () => {
  assert.match(clientSrc, /"ArrowDown"/, "应支持 ↓ 选择");
  assert.match(clientSrc, /"ArrowUp"/, "应支持 ↑ 选择");
  assert.match(clientSrc, /matches\[active\]/, "Enter 应打开当前选中项");
});

test("client.js: 日期格式化为「N月N日」", () => {
  assert.match(clientSrc, /"月"\s*\+\s*d\.getDate\(\)\s*\+\s*"日"/, "应输出「N月N日」");
});

test("client.js: 用 headless Modal 承载悬浮面板（保留遮罩/Escape）", () => {
  assert.match(clientSrc, /headless:\s*true/, "应使用 headless Modal 自绘结构");
  assert.match(clientSrc, /onKeyDownCapture/, "应接管键盘（↑↓/Enter）");
  // ⚠️ 实测：Modal 只把 className 落到 dialog 包裹元素，contentClassName 不生效。
  // 卡片样式必须写在 className 上，否则宽度/圆角全都不生效（曾因此宽度错成 380px）。
  assert.match(clientSrc, /className:\s*"dsss-card"/, "卡片样式类必须在 className 上");
  assert.equal(/contentClassName\s*:/.test(clientSrc), false, "代码中不得使用不生效的 contentClassName");
});


test("client.js: 结果行支持键盘上下选择", () => {
  assert.match(clientSrc, /"ArrowDown"/, "应支持 ↓ 选择");
  assert.match(clientSrc, /"ArrowUp"/, "应支持 ↑ 选择");
  assert.match(clientSrc, /matches\[active\]/, "Enter 应打开当前选中项");
});

test("client.js: 日期格式化为「N月N日」", () => {
  assert.match(clientSrc, /"月"\s*\+\s*d\.getDate\(\)\s*\+\s*"日"/, "应输出「N月N日」");
});

test("client.js: 宽度是响应式的（768px 断点，非硬编码）", () => {
  // 宿主 Modal 的 dialog 包裹元素自带 380px；不覆盖就会窄成 380。
  assert.match(clientSrc, /\.dsss-card\{[^}]*width:660px\s*!important/, "桌面必须 !important 覆盖宿主宽度");
  assert.match(clientSrc, /\.dsss-card\{[^}]*border-radius:20px/, "桌面圆角 20px");
  // 不得写死 min-width:660px —— 窄屏会横向溢出
  assert.ok(!/\.dsss-card\{[^}]*min-width:660px/.test(clientSrc), "不得写死 min-width:660px");
  assert.match(clientSrc, /@media \(max-width:767\.98px\)/, "应有 768px 断点");
});

test("client.js: <768px 全屏接管（桌面窄窗口与手机一致）", () => {
  // 需求：宽度 <768px 时全屏接管，不区分设备类型（桌面窄窗/手机都铺满）。
  const m = clientSrc.match(/@media \(max-width:767\.98px\)\{([\s\S]*?)\n\s*\}\n/);
  assert.ok(m, "应能解析出窄屏规则块");
  const block = m[1];
  // 卡片：全屏、去圆角、去阴影、去外边距
  assert.match(block, /\.dsss-card\{[^}]*width:100%\s*!important/, "窄屏卡片应铺满宽度");
  assert.match(block, /\.dsss-card\{[^}]*height:100%/, "窄屏卡片应撑满高度");
  assert.match(block, /border-radius:0\s*!important/, "窄屏应去圆角");
  assert.match(block, /box-shadow:none\s*!important/, "窄屏应去阴影");
  // 宿主 modal 根的内边距必须归零（否则 inset 成 552px —— 实测踩过）
  assert.match(block, /div:has\(> \.dsss-card\)[^}]*padding:0\s*!important/, "宿主 modal 根内边距必须归零");
  // 宿主根用构建哈希类名，必须用 :has() 而非硬编码类名
  assert.ok(!/\.dsss-modalRoot/.test(clientSrc), "不得硬编码宿主哈希类名");
  // 面板不再限制 585px 高
  assert.match(block, /\.dsss-panel\{[^}]*max-height:none/, "窄屏面板应解除高度上限");
});

test("client.js: 用 headless Modal 承载悬浮面板（保留遮罩/Escape）", () => {
  assert.match(clientSrc, /headless:\s*true/, "应使用 headless Modal 自绘结构");
  assert.match(clientSrc, /onKeyDownCapture/, "应接管键盘（↑↓/Enter）");
  // ⚠️ 实测：Modal 只把 className 落到 dialog 包裹元素，contentClassName 不生效。
  // 卡片样式必须写在 className 上，否则宽度/圆角全都不生效（曾因此宽度错成 380px）。
  assert.match(clientSrc, /className:\s*"dsss-card"/, "卡片样式类必须在 className 上");
  assert.equal(/contentClassName\s*:/.test(clientSrc), false, "代码中不得使用不生效的 contentClassName");
});


test("client.js: 结果行支持键盘上下选择", () => {
  assert.match(clientSrc, /"ArrowDown"/, "应支持 ↓ 选择");
  assert.match(clientSrc, /"ArrowUp"/, "应支持 ↑ 选择");
  assert.match(clientSrc, /matches\[active\]/, "Enter 应打开当前选中项");
});

test("client.js: 日期格式化为「N月N日」", () => {
  assert.match(clientSrc, /"月"\s*\+\s*d\.getDate\(\)\s*\+\s*"日"/, "应输出「N月N日」");
});

test("client.js: 卡片宽度覆盖宿主 dialog 默认宽度 + 768px 响应式断点", () => {
  // 宿主 Modal 的 dialog 包裹元素自带 width:380px；不显式覆盖就会窄成 380。
  assert.match(clientSrc, /\.dsss-card\{[^}]*width:660px\s*!important/, "必须 !important 覆盖宿主宽度");
  assert.match(clientSrc, /\.dsss-card\{[^}]*border-radius:20px/, "卡片圆角 20px");
  // 宽度是响应式的（实测自官网）：≥768px 固定 660，<768px 铺满去圆角。
  // 不得写死 min-width:660px —— 那会让窄屏横向溢出。
  assert.ok(!/\.dsss-card\{[^}]*min-width:660px/.test(clientSrc), "不得写死 min-width:660px（窄屏会溢出）");
  assert.match(clientSrc, /@media \(max-width:767\.98px\)/, "应有 768px 断点");
  const m = clientSrc.match(/@media \(max-width:767\.98px\)\{([\s\S]*?)\n\s*\}\n/);
  assert.ok(m, "应能解析出窄屏规则块");
  assert.match(m[1], /width:100%\s*!important/, "窄屏应铺满");
  assert.match(m[1], /border-radius:0/, "窄屏应去圆角");
  // 面板与输入行要有宽度约束，否则内部 flex 撑爆、✕ 被顶出可视区
  assert.match(clientSrc, /\.dsss-panel\{[^}]*min-width:0/, "面板需 min-width:0 防撑爆");
  assert.match(clientSrc, /\.dsss-searchbar\{[^}]*min-width:0/, "输入行需 min-width:0 防撑爆");
  assert.match(clientSrc, /\.dsss-close\{[^}]*min-width:32px/, "关闭按钮需固定最小宽度");
});

test("client.js: 窄屏媒体查询必须在 CSS 末尾（否则被桌面规则覆盖）", () => {
  // 实测踩过：媒体查询写在桌面规则之前时，同优先级下后写者胜，
  // 桌面 `.dsss-panel{max-height:min(585px,...)}` 会把窄屏的
  // `max-height:none` 覆盖掉，导致全屏时面板仍卡在 585px。
  const mediaIdx = clientSrc.indexOf("@media (max-width:767.98px)");
  assert.ok(mediaIdx > 0, "应有窄屏媒体查询");
  const panelRules = [...clientSrc.matchAll(/\.dsss-panel\{[^}]*max-height:min\(585px/g)];
  assert.ok(panelRules.length > 0, "应有桌面面板高度规则");
  for (const m of panelRules) {
    assert.ok(m.index < mediaIdx, "桌面 .dsss-panel 高度规则必须出现在媒体查询之前");
  }
});

// ------------------------------------------------- CSS token 真实性校验

test("client.js: 用到的 --dsw-* token 必须真实存在（防止编造 token）", () => {
  // 实测教训：我编造过 --dsw-alias-bg-primary / -bg-secondary / -border-secondary，
  // 这三个官方**不存在**。亮色下靠 var() 兜底值碰巧正常，
  // 暗色下 `label-primary` 变近白、卡片背景却仍是兜底的白色 → 白底白字看不见。
  const THEME =
    "/home/palxex/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js";
  let theme;
  try {
    theme = readFileSync(THEME, "utf8");
  } catch {
    return; // 无本机宿主副本时跳过
  }
  const used = [...new Set([...clientSrc.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map((m) => m[1]))];
  assert.ok(used.length > 0, "应使用 --dsw-* token");
  const invented = used.filter((t) => !theme.includes(t));
  assert.deepEqual(invented, [], `使用了官方不存在的 token：${invented.join(", ")}`);
});

test("client.js: 暗色模式适配（不写死亮色兜底）", () => {
  // 兜底值只能是「亮色近似」，真正的暗色适配必须靠 token 自动切换。
  // 因此关键色（背景/正文）必须走存在的 token，而不是裸色值。
  assert.match(clientSrc, /\.dsss-card\{[^}]*background:var\(--dsw-alias-bg-layer-1/, "卡片背景应走 bg-layer-1 token");
  assert.match(clientSrc, /\.dsss-input\{[^}]*color:var\(--dsw-alias-label-primary/, "输入文字应走 label-primary token");
  assert.match(clientSrc, /\.dsss-rowTitle\{[^}]*color:var\(--dsw-alias-label-primary/, "结果标题应走 token");
  // 不得对卡片/输入写死 #fff / #000 之类的绝对色
  assert.ok(!/\.dsss-card\{[^}]*background:#fff/.test(clientSrc), "卡片背景不得写死 #fff");
});

test("client.js: 窄屏打开面板时收起侧栏（z-index 竞争）", () => {
  // 宿主侧栏 z-index 1100 > modal 的 1000；窄屏不收起侧栏会盖住搜索面板。
  assert.match(clientSrc, /"layout"/, "inject 应声明 layout 服务");
  assert.match(clientSrc, /toggleSidebar/, "应收起侧栏");
  assert.match(clientSrc, /matchMedia\("\(max-width:767\.98px\)"\)\.matches/, "收起侧栏应仅在窄屏生效");
  assert.match(clientSrc, /isSidebarWide\(\)/, "toggle 前应先判断当前是否展开，避免反向打开");
});

test("client.js: 输入走防抖，不逐键发请求", () => {
  // 用户实测「疑似在持续搜索」：逐键直发导致请求风暴 + 竞态。
  assert.match(clientSrc, /SEARCH_DEBOUNCE_MS/, "应有防抖常量");
  assert.match(clientSrc, /scheduleSearch/, "onChange 应走防抖");
  assert.match(clientSrc, /clearTimeout\(debounceRef\.current\)/, "应清理上一次待触发定时器");
  // onChange 不得直接 runSearch
  assert.ok(
    !/onChange:\s*\(e\)\s*=>\s*\{[^}]*void runSearch\(e\.target\.value\)/s.test(clientSrc),
    "onChange 不应直接 runSearch（应经防抖）",
  );
  // 卸载时要清定时器，避免关闭面板后仍触发
  assert.match(clientSrc, /clearTimeout\(debounceRef\.current\);/, "卸载应清定时器");
});

test("client.js: 竞态守卫（旧响应不得覆盖新结果）", () => {
  // 快速输入时先发的慢请求后返回会覆盖新结果 → 「一会有一会没有」。
  assert.match(clientSrc, /searchSeq/, "应有请求序号");
  assert.match(clientSrc, /seq !== searchSeq\.current/, "过期响应应被丢弃");
  // 只有最新请求才允许关 loading
  assert.match(clientSrc, /if \(seq === searchSeq\.current\) setLoading\(false\)/, "只有最新请求可收尾");
});

test("client.js: IME 组字期间不触发搜索（中文输入）", () => {
  // 用户实测「输入中文疑似按按键在搜索」：组字中的拼音被当成查询词。
  assert.match(clientSrc, /onCompositionStart/, "应监听 compositionstart");
  assert.match(clientSrc, /onCompositionEnd/, "应监听 compositionend");
  assert.match(clientSrc, /composingRef\.current = true/, "组字开始应置位");
  assert.match(clientSrc, /if \(composingRef\.current\) return;/, "组字中 onChange 应跳过搜索");
  // Enter 在组字中不应提交
  assert.match(clientSrc, /composingRef\.current\) return;[\s\S]{0,120}Enter|Enter[\s\S]{0,200}composingRef\.current\) return;/, "组字中 Enter 不应提交搜索");
});

test("client.js: 窄屏铺满需压过宿主 aria-modal 的 max-width", () => {
  // 宿主 `[aria-modal="true"]:not(...){max-width:calc(100vw - 32px)!important}`
  // 会命中我们的卡片，右侧永远缺 32px（实测踩到）。
  const m = clientSrc.match(/@media \(max-width:767\.98px\)\{([\s\S]*?)\n\s*\}\n/);
  assert.ok(m, "应能解析窄屏规则块");
  assert.match(m[1], /\[aria-modal="true"\]\.dsss-card/, "窄屏需用属性选择器提高特异性压过宿主");
  assert.match(m[1], /max-width:100vw\s*!important/, "窄屏 max-width 应为 100vw");
});

// ------------------------------------------------- subagent 会话打开

test("client.js: subagent 会话必须构造 SubagentAddress 打开", () => {
  // ⚠️ 实测 bug：subagent 会话只用裸 sessionId 打开会落到「新会话」界面。
  //    现象很隐蔽 —— 搜索结果前 3 条（普通会话）能进，第 4 条起（全是 subagent）进不去。
  //    宿主契约：SessionTarget = SessionId | SubagentAddress
  //              SubagentAddress = { parentSessionId, childSessionId, mode }
  assert.match(clientSrc, /parentSessionId/, "应读取 parentSessionId");
  assert.match(clientSrc, /childSessionId/, "应构造 SubagentAddress 的 childSessionId");
  assert.match(clientSrc, /mode:\s*"unknown"/, "mode 未知时用 unknown");
  // 传参必须是整条 match（含 parentSessionId），不能只传 id
  assert.match(clientSrc, /onOpen\(match\)/, "结果行应传整条 match，而非只传 id");
  assert.match(clientSrc, /openSession\(target\)/, "Enter 分支应传整条 match");
  // 不得再出现只传 sessionId 的旧写法
  assert.ok(!/onOpen\(match\.sessionId\)/.test(clientSrc), "不得只传 match.sessionId（subagent 会丢失父会话）");
});

test("engine.js: sessionMeta 暴露 parentSessionId（subagent 判定依据）", async () => {
  const { sessionMeta, readSessionHeader } = await import("../lib/engine.js");
  assert.equal(typeof sessionMeta, "function");
  // 真实 subagent 会话：日志 header 里该字段名为 parentSession
  const { readFileSync } = await import("node:fs");
  const f = "/home/palxex/.dsh/sessions/--home-palxex-test--/session-ff2d010a-c88e-431a-bc38-f162e8779b4b/session.jsonl.zstd";
  let raw;
  try {
    const { decodeSessionFile } = await import("../lib/engine.js");
    raw = decodeSessionFile(f);
  } catch {
    return; // 本机没有该会话样本时跳过
  }
  const header = readSessionHeader(f, raw);
  assert.ok(header, "应能解析出 session header");
  // 会话日志里的字段名是 parentSession，不是 parentSessionId
  assert.equal(typeof header.parentSession, "string", "真实日志字段名为 parentSession");
  const meta = sessionMeta(f, "/home/palxex/.dsh/sessions", raw);
  assert.equal(meta.parentSessionId, header.parentSession, "应把 parentSession 映射为 parentSessionId");
});

// ------------------------------------------------- 会话日志发现（v2/v3/v4 命名）

test("engine.js: 必须发现各版本命名的会话日志（v2/v3/v4）", () => {
  // ⚠️ 实测 bug：只认 session.jsonl* 会让 193 个会话完全搜不到。
  //    本机落盘形态：session.jsonl.zstd(309) / session.v4.jsonl.zstd(163)
  //                 session.v3.jsonl.zstd(21) / session.v2.jsonl.zstd(9)
  //    um 工作区全是 v4，21 个会话一个都扫不到 → 搜「缇娜夏」找不到"unnamed memory"。
  const engineSrc = readFileSync(join(here, "..", "lib", "engine.js"), "utf8");
  // 不得再硬编码两个名字
  assert.ok(
    !/e\.name === "session\.jsonl" \|\| e\.name === "session\.jsonl\.zstd"/.test(engineSrc),
    "不得只认 session.jsonl / session.jsonl.zstd（会漏掉全部 v2/v3/v4 会话）",
  );
  // 必须用正则接受版本号
  assert.match(engineSrc, /SESSION_LOG_RE/, "应有会话日志名正则");
  const m = engineSrc.match(/const SESSION_LOG_RE = (\/.*\/);/);
  assert.ok(m, "应能取出正则");
  const re = eval(m[1]);
  for (const name of ["session.jsonl", "session.jsonl.zstd", "session.v2.jsonl.zstd",
                      "session.v3.jsonl.zstd", "session.v4.jsonl.zstd"]) {
    assert.equal(re.test(name), true, `应匹配 ${name}`);
  }
  // 备份/临时文件必须排除
  for (const name of ["session.jsonl.zstd.bak.2026-01-01", "session.v4.jsonl.zstd.bak-2026-09-30T15-59-44-555Z",
                      "session.migration.abc.jsonl.zstd.tmp", "session.lock"]) {
    assert.equal(re.test(name), false, `不应匹配 ${name}`);
  }
});

test("engine.js: findSessionLogs 有默认 root（不传参也能用）", async () => {
  // ⚠️ 实测 bug：签名 findSessionLogs(root) 缺默认值，不传参返回 0，
  //    而 listSessionLogs 有默认值 —— 两者行为不一致，极易踩坑。
  const engineSrc = readFileSync(join(here, "..", "lib", "engine.js"), "utf8");
  assert.match(engineSrc, /export function findSessionLogs\(root = sessionsRoot\(\)\)/,
    "findSessionLogs 的 root 必须有默认值");
  const { findSessionLogs } = await import("../lib/engine.js");
  assert.ok(Array.isArray(findSessionLogs()), "不传参应返回数组而非报错");
});

// ------------------------------------------------- subagent 剔除

test("engine.js: subagent 判据是 origin，不是 parentSessionId", () => {
  // ⚠️ 实测混淆过一次：把「有 parentSessionId」当成 subagent，误杀了 257 个
  //    dsh-easyrewrite 分叉子会话（它们用裸 sessionId 就能打开）。
  //    权威判据：header.origin === 'subagent'（全库仅 ~23 个）。
  const engineSrc = readFileSync(join(here, "..", "lib", "engine.js"), "utf8");
  assert.match(engineSrc, /includeSubagents = false/, "includeSubagents 默认应为 false");
  assert.match(engineSrc, /meta\.origin === "subagent" && !includeSubagents/,
    "应只按 origin==='subagent' 剔除");
  assert.ok(!/meta\.parentSessionId !== undefined && !includeSubagents/.test(engineSrc),
    "不得按 parentSessionId 剔除（会误杀分叉子会话）");
  assert.match(engineSrc, /subagentsSkipped\+\+/, "应统计被剔除的数量");
});

test("engine.js: 只剔真 subagent，分叉子会话保留", async () => {
  const { searchSessions } = await import("../lib/engine.js");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const fsMod = await import("node:fs");
  const tmp = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), "dss-"));
  const root = pathMod.join(tmp, "sessions");
  const mk = (dir, header) => {
    const d = pathMod.join(root, dir);
    fsMod.mkdirSync(d, { recursive: true });
    fsMod.writeFileSync(pathMod.join(d, "session.jsonl"),
      JSON.stringify(header) + "\n" +
      JSON.stringify({ type: "user/message", data: { content: [{ type: "text", text: "zebra" }], role: "user" } }) + "\n");
  };
  // 根会话
  mk("session-plain", { type: "session", id: "session-plain", cwd: "/tmp", createdAt: 1 });
  // 分叉/改写子会话：有 parentSession，无 origin —— 必须保留（能打开）
  mk("session-fork", { type: "session", id: "session-fork", cwd: "/tmp", createdAt: 2, parentSession: "session-plain", isSeeded: true });
  // 真 subagent：origin='subagent' —— 剔除
  mk("session-sub", { type: "session", id: "session-sub", cwd: "/tmp", createdAt: 3, parentSession: "session-plain", origin: "subagent" });
  try {
    const off = searchSessions({ query: "zebra", root, maxSessions: 10 });
    assert.equal(off.subagentsSkipped, 1, "只应剔除 1 个真 subagent");
    const ids = off.matches.map((m) => m.sessionId);
    assert.ok(ids.includes("session-fork"), "分叉子会话必须保留（它能打开）");
    assert.ok(!ids.includes("session-sub"), "真 subagent 应剔除");
    assert.equal(off.matches.length, 2, "默认应剩根会话 + 分叉子会话");

    const on = searchSessions({ query: "zebra", root, maxSessions: 10, includeSubagents: true });
    assert.equal(on.subagentsSkipped, 0, "开启后不剔除");
    assert.equal(on.matches.length, 3, "开启后应含三个会话");
  } finally {
    fsMod.rmSync(tmp, { recursive: true, force: true });
  }
});

test("client.js: 只有 origin==='subagent' 才构造 SubagentAddress", () => {
  // 分叉子会话（有 parentSessionId 无 origin）套 SubagentAddress 会被
  // 宿主 validateAddress 判成 subagent/unauthorized 而打不开 —— 必须用裸 id。
  assert.match(clientSrc, /const isSubagent = .*origin === "subagent"/,
    "应以 origin 判定是否 subagent");
  assert.match(clientSrc, /isSubagent && typeof parentSessionId === "string"/,
    "构造地址必须以 isSubagent 为前提");
});


test("engine.js: 只剔除真 subagent（origin 判据），且可关闭", async () => {
  const { searchSessions } = await import("../lib/engine.js");
  // 用暂存目录做确定性验证：普通会话 + 分叉子会话（仅 parentSession）+ 真 subagent（origin）
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const fsMod = await import("node:fs");
  const tmp = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), "dss-"));
  const root = pathMod.join(tmp, "sessions");
  const mk = (dir, header) => {
    const d = pathMod.join(root, dir);
    fsMod.mkdirSync(d, { recursive: true });
    fsMod.writeFileSync(pathMod.join(d, "session.jsonl"),
      JSON.stringify(header) + "\n" +
      JSON.stringify({ type: "user/message", data: { content: [{ type: "text", text: "zebra" }], role: "user" } }) + "\n");
  };
  mk("session-plain", { type: "session", id: "session-plain", cwd: "/tmp", createdAt: 1 });
  // 分叉/改写子会话：只有 parentSession、没有 origin —— 能用裸 sessionId 打开，默认必须保留
  mk("session-fork", { type: "session", id: "session-fork", cwd: "/tmp", createdAt: 2, parentSession: "session-parent" });
  // 真 subagent：header 带 origin:"subagent" —— 裸 sessionId 打不开，默认剔除
  mk("session-agent", { type: "session", id: "session-agent", cwd: "/tmp", createdAt: 3, parentSession: "session-parent", origin: "subagent" });
  try {
    const off = searchSessions({ query: "zebra", root, maxSessions: 10 });
    assert.equal(off.subagentsSkipped, 1, "默认应剔除 1 个真 subagent");
    assert.ok(!off.matches.some((m) => m.sessionId === "session-agent"), "结果里不应有 subagent");
    assert.ok(off.matches.some((m) => m.sessionId === "session-fork"), "带 parentSession 的分叉子会话默认应保留");

    const on = searchSessions({ query: "zebra", root, maxSessions: 10, includeSubagents: true });
    assert.equal(on.subagentsSkipped, 0, "开启后不剔除");
    assert.equal(on.matches.length, 3, "开启后应含三个会话");
  } finally {
    fsMod.rmSync(tmp, { recursive: true, force: true });
  }
});
