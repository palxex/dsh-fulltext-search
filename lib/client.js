// dsh-fulltext-search/client.js — Client 半区：侧栏底部入口 + 会话全文搜索面板。
//
// 形态：window.__ModuleLoader__.load({ id, factory })。
// 只能 require 种子白名单（react / react/jsx-runtime / react-dom /
// react-dom/client / @deepseek-ai/cordis / @deepseek-ai/dsh-client-ui-slots /
// @deepseek-ai/dsh-client-ui-primitives）。
//
// 与 Host 通信走 typert Remote（ctx.remote.sessionSearch.query），
// 不自己接 RPC 通道（自建通道在 rc.2 已废弃，会落到 HTTP 405）。
// 打开历史会话走 ctx.uiWorkspace.openSession(sessionId)。
"use strict";

window.__ModuleLoader__.load({
  id: "dsh-fulltext-search",
  factory: (require) => {
    const bundleModule = { exports: {} };
    Object.defineProperty(bundleModule.exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const jsxRuntime = require("react/jsx-runtime");
    const jsx = jsxRuntime.jsx;
    // ⚠️ 多子节点必须用 jsxs：`jsx(type, props, a, b)` 的第三参是 **key**，
    // 传多个子节点会被静默丢弃（症状：slot 注册成功但渲染成空 div）。
    const jsxs = jsxRuntime.jsxs;
    const fragments = jsxRuntime.Fragment;
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    const Button = primitives.Button;
    const Input = primitives.Input;
    const Modal = primitives.Modal;
    const Tooltip = primitives.Tooltip;
    const StateDot = primitives.StateDot;
    const IconSearchOutlineRegular = primitives.IconSearchOutlineRegular;
    const IconCloseOutlineRegular = primitives.IconCloseOutlineRegular;
    // 官方图标集里没有「对话气泡」，结果行用 IconListPenOutlineRegular（会话记录）代替。
    const IconListPenOutlineRegular = primitives.IconListPenOutlineRegular;

    const NS = "session-search";

    /** 输入防抖：停止输入后多久才真正发起搜索。 */
    const SEARCH_DEBOUNCE_MS = 250;
    /**
     * 单次搜索扫描的会话数。本机实测 502 个会话（含 v2/v3/v4 命名），
     * 值太小会让老工作区（如 um）搜不到。宿主侧上限由 MAX_SESSIONS_LIMIT 保护。
     */
    const SEARCH_MAX_SESSIONS = 200;

    /**
     * 搜索范围分组 —— 必须与 lib/records.js 的 SEARCH_GROUPS 逐字一致。
     * 面板里六个标签（全部/用户/助手/思考/工具/其他）就是这五组加一个「全部」。
     */
    const SEARCH_GROUPS = ["user", "assistant", "reasoning", "tool", "other"];

    /**
     * 默认开启的范围：**只搜「人说的话」**。
     * 全量匹配会把模型思考块与命令输出一起算命中（实测搜 discovery 时
     * 20 个会话里 15 个靠 [思考]/[工具结果] 命中），所以默认收窄到用户消息，
     * 需要时再点开其它标签或点「全部」。
     */
    const DEFAULT_GROUPS = ["user"];

    /**
     * 分组的显示名。
     * 刻意写成字面量分支而不是拼接键名：scripts/check-i18n.mjs 按字面量扫描
     * 代码引用的键，拼接出来的键它看不见，拼错也没人拦。
     */
    function groupLabel(t, group) {
      if (group === "user") return t("panel.filter.user");
      if (group === "assistant") return t("panel.filter.assistant");
      if (group === "reasoning") return t("panel.filter.reasoning");
      if (group === "tool") return t("panel.filter.tool");
      return t("panel.filter.other");
    }

    // ---- i18n：zh / en 键集必须一一对齐 ------------------------------------
    const TABLES = {
      zh: {
        "nav": "会话全文搜索",
        "panel.title": "会话全文搜索",
        "panel.intro": "在所有本地会话中检索关键词，点击结果可打开该历史会话。",
        "panel.placeholder": "输入关键词…",
        "panel.search": "搜索",
        "panel.searching": "正在扫描会话…",
        "panel.hint": "输入关键词后回车开始搜索。",
        "panel.empty": "没有命中。试试更短或更常见的关键词。",
        "panel.summary": "扫描 {scanned} 个会话，共 {hits} 处命中，涉及 {sessions} 个会话。",
        "panel.open": "打开",
        "panel.openTitle": "打开会话「{title}」",
        "panel.untitled": "（无标题）",
        "panel.occurrences": "{count} 处命中",
        "panel.loading": "正在加载…",
        "panel.remoteUnavailable": "搜索服务不可用：插件未注册 Remote。",
        "panel.error": "搜索失败：{message}",
        "panel.skippedSubagents": "已隐藏 {count} 个打不开的子会话。",
        "panel.filters": "搜索范围",
        "panel.filter.all": "全部",
        "panel.filter.user": "用户",
        "panel.filter.assistant": "助手",
        "panel.filter.reasoning": "思考",
        "panel.filter.tool": "工具",
        "panel.filter.other": "其他",
        "panel.filterNone": "未选中任何范围，已按全部范围搜索。",
        "panel.close": "关闭",
      },
      en: {
        "nav": "Session full-text search",
        "panel.title": "Session full-text search",
        "panel.intro": "Search every local session by keyword; click a result to open that past session.",
        "panel.placeholder": "Enter a keyword…",
        "panel.search": "Search",
        "panel.searching": "Scanning sessions…",
        "panel.hint": "Type a keyword and press Enter to search.",
        "panel.empty": "No matches. Try a shorter or more common keyword.",
        "panel.summary": "Scanned {scanned} sessions · {hits} hits across {sessions} sessions.",
        "panel.open": "Open",
        "panel.openTitle": "Open session “{title}”",
        "panel.untitled": "(untitled)",
        "panel.occurrences": "{count} hits",
        "panel.loading": "Loading…",
        "panel.remoteUnavailable": "Search service unavailable: the plugin registered no Remote.",
        "panel.error": "Search failed: {message}",
        "panel.skippedSubagents": "Hid {count} unopenable subagent sessions.",
        "panel.filters": "Scope",
        "panel.filter.all": "All",
        "panel.filter.user": "User",
        "panel.filter.assistant": "Assistant",
        "panel.filter.reasoning": "Reasoning",
        "panel.filter.tool": "Tool",
        "panel.filter.other": "Other",
        "panel.filterNone": "Nothing selected — searching all scopes.",
        "panel.close": "Close",
      },
    };

    // ---- 样式：对齐 DeepSeek 官网「搜索对话」面板（规格见 docs/deepseek-search-ui-spec.md）----
    // 颜色优先走宿主 --dsw-* token；官网用的具体灰阶作为兜底值写在 var() 第二参。
    const CSS = [
      ".dsss-root{display:flex;align-items:center}",

      // 顶部悬浮定位 + 卡片本体。
      //
      // 宽度规则**实测自 DeepSeek 官网**（不是拍脑袋的硬编码）：
      //   ≥768px 视口 → 固定 660px 居中、圆角 20px、顶部 114px
      //   <768px 视口 → 铺满（移动端形态）
      // 断点实测：768px→660px；760px→铺满，故断点为 768px。
      // 官网用 `--dsl-modal-*` 变量 + 媒体查询实现，这里用等价规则复现。
      //
      // ⚠️ `.dsss-card` 落在宿主 Modal 的 dialog 包裹元素上，
      // 宿主默认给了 380px，必须 !important 覆盖，否则宽度不生效。
      ".dsss-card{align-self:flex-start;margin:114px auto 24px;box-sizing:border-box;",
      "width:660px !important;min-width:0 !important;max-width:min(660px,calc(100vw - 32px)) !important;",
      "height:auto;border-radius:20px;padding:0;",
      "background:var(--dsw-alias-bg-layer-1,#fff);",
      "box-shadow:0 2px 4px rgba(0,0,0,.04),0 4px 10px rgba(0,0,0,.02);",
      "overflow:hidden;display:flex;flex-direction:column}",


      ".dsss-panel{display:flex;flex-direction:column;width:100%;min-width:0;box-sizing:border-box;",
      "min-height:420px;max-height:min(585px,calc(100vh - 160px))}",

      // 输入行：放大镜 + 无边框输入 + 竖分隔线 + ✕
      ".dsss-searchbar{display:flex;align-items:center;gap:0;height:61px;flex:0 0 auto;width:100%;min-width:0;box-sizing:border-box;",
      "border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.06));padding:0 16px}",
      ".dsss-magnifier{display:inline-flex;align-items:center;justify-content:center;",
      "width:36px;height:36px;flex:0 0 auto;border-radius:28px;",
      "color:var(--dsw-alias-label-secondary,#818589)}",
      ".dsss-input{flex:1 1 auto;min-width:0;height:24px;border:none;outline:none;background:transparent;",
      "font-size:16px;line-height:24px;color:var(--dsw-alias-label-primary,#0f1115);padding:0 8px 0 0}",
      ".dsss-input::placeholder{color:var(--dsw-alias-label-tertiary,#9aa0a6)}",
      ".dsss-divider{width:1px;height:20px;flex:0 0 auto;background:var(--dsw-alias-border-l2,rgba(0,0,0,.04))}",
      ".dsss-close{display:inline-flex;align-items:center;justify-content:center;width:32px;height:28px;",
      "flex:0 0 auto;margin-left:8px;border:none;background:transparent;cursor:pointer;border-radius:28px;",
      "min-width:32px;box-sizing:border-box;",
      "color:var(--dsw-alias-label-tertiary,#818589)}",
      ".dsss-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}",

      // 范围筛选条：一排小胶囊，点一下切换该范围是否参与搜索
      ".dsss-filters{display:flex;flex-wrap:wrap;align-items:center;gap:6px;flex:0 0 auto;",
      "padding:8px 16px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.06))}",
      ".dsss-filterLabel{font-size:12px;line-height:16px;margin-right:2px;",
      "color:var(--dsw-alias-label-tertiary,#9aa0a6)}",
      ".dsss-chip{display:inline-flex;align-items:center;height:24px;padding:0 10px;border-radius:12px;",
      "border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));background:transparent;cursor:pointer;",
      "font-size:12px;line-height:16px;font-family:inherit;box-sizing:border-box;",
      "color:var(--dsw-alias-label-secondary,#5f6368)}",
      ".dsss-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}",
      ".dsss-chipOn{background:var(--dsw-alias-interactive-bg-active,rgba(0,0,0,.08));",
      "border-color:transparent;color:var(--dsw-alias-label-primary,#0f1115)}",
      ".dsss-kind{display:inline-flex;align-items:center;height:18px;padding:0 6px;margin-right:6px;",
      "border-radius:9px;font-size:11px;line-height:18px;flex:0 0 auto;",
      "background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04));",
      "color:var(--dsw-alias-label-tertiary,#818589)}",

      // 结果区
      ".dsss-results{flex:1 1 auto;min-height:0;overflow-y:auto;padding:8px}",
      ".dsss-list{display:flex;flex-direction:column;gap:2px}",
      ".dsss-msg{margin:0;padding:10px 12px;font-size:13px;line-height:20px;",
      "color:var(--dsw-alias-label-tertiary,#818589)}",
      ".dsss-msgError{color:var(--dsw-alias-state-error-primary,#d33)}",
      ".dsss-msgMuted{opacity:.7}",

      // 单行结果：36px 圆形图标 + 标题/日期 + 等宽预览（对齐官网）
      ".dsss-row{display:flex;align-items:flex-start;gap:12px;width:100%;text-align:left;",
      "padding:10px 12px 10px 10px;border:none;background:transparent;cursor:pointer;",
      "border-radius:16px;font:inherit;color:inherit}",
      ".dsss-rowActive{background:var(--dsw-alias-interactive-bg-hover,#f1f3f5)}",
      ".dsss-rowIcon{display:inline-flex;align-items:center;justify-content:center;",
      "width:36px;height:36px;flex:0 0 auto;border-radius:28px;",
      "background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03));",
      "color:var(--dsw-alias-label-secondary,#818589)}",
      ".dsss-rowBody{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto}",
      ".dsss-rowHead{display:flex;align-items:baseline;gap:12px}",
      ".dsss-rowTitle{font-size:15px;line-height:25px;color:var(--dsw-alias-label-primary,#0f1115);",
      "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;min-width:0}",
      ".dsss-rowDate{font-size:13px;line-height:25px;flex:0 0 auto;",
      "color:var(--dsw-alias-label-tertiary,#818589)}",
      ".dsss-rowPreview{font-size:12px;line-height:18px;",
      "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;",
      "color:var(--dsw-alias-label-tertiary,#9aa0a6);",
      "overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",

      // ---- 窄屏（<768px）：全屏接管，更像原生 APP 搜索页 ----
      // ⚠️ 必须放在数组**最后**：同优先级下后写者胜，
      //    放前面会被上面的桌面规则覆盖（实测踩到过）。
      // 桌面窄窗口与手机都要铺满，因此只用宽度断点，不看设备类型。
      //
      // ⚠️ 为什么用带 `[aria-modal="true"]` 的高特异性选择器：
      //    宿主有一条 `[aria-modal="true"]:not(...){max-width:calc(100vw - 32px)!important}`
      //    会命中我们的卡片，导致**右侧永远缺 32px**（实测踩到）。
      //    它带 !important，普通 `.dsss-card{...!important}` 打平后不保证胜出；
      //    这里把特异性提高（属性选择器 + 类），稳定压过它。
      "@media (max-width:767.98px){",
      "div:has(> .dsss-card){padding:0 !important;align-items:stretch !important;justify-content:stretch !important}",
      '[aria-modal="true"].dsss-card,div.dsss-card{',
      "align-self:stretch !important;margin:0 !important;height:100% !important;",
      "width:100% !important;max-width:100vw !important;min-width:100% !important;",
      "max-height:100vh !important;border-radius:0 !important;box-shadow:none !important}",
      ".dsss-panel{height:100% !important;min-height:0 !important;max-height:none !important}",
      ".dsss-results{flex:1 1 auto}",
      "}",
    ];

    /** 幂等注入 CSS（插件卸载后残留无害，重载时按标记跳过）。 */
    function injectCss() {
      if (typeof document === "undefined") return;
      const tagId = "dsh-fulltext-search/client.css";
      if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return;
      const tag = document.createElement("style");
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS.join("\n");
      document.head.appendChild(tag);
    }

    /** 极简插值：{name} → vars[name]。 */
    function interpolate(template, vars) {
      return String(template).replace(/\{(\w+)\}/g, (m, key) =>
        Object.hasOwn(vars, key) ? String(vars[key]) : m);
    }

    let ctxRef = null;
    /** 模块级 ctx 引用：footer 槽的 owner props 只有 {wide}，服务靠这里读。 */
    function getCtx() {
      return ctxRef;
    }

    /**
     * 侧栏当前是否展开（宽栏）。
     *
     * `ctx.layout` 只暴露 `toggleSidebar()`，没有只读状态 API，
     * 所以直接量宿主侧栏列的宽度：rail 形态约 52-56px，展开后 >=100px。
     * 找不到元素时返回 false（宁可不收，也不要误把侧栏打开）。
     * @returns {boolean}
     */
    function isSidebarWide() {
      if (typeof document === "undefined") return false;
      const candidates = [
        document.querySelector(".pI_x6G_sidebarCol"),
        document.querySelector('[data-slot="sidebar"]')?.closest("div"),
      ];
      for (const el of candidates) {
        if (el === null || el === undefined) continue;
        const w = el.getBoundingClientRect().width;
        if (w > 0) return w >= 100;
      }
      return false;
    }

    /**
     * 取本插件的 Remote 命名空间服务。
     * 由 apply 里的 `remote.$mount(...)` 物化；挂载完成前为 undefined。
     * @returns {Record<string, Function> | undefined}
     */
    function getRemote() {
      return ctxRef?.get?.("remote." + REMOTE_NAMESPACE);
    }

    /**
     * Remote 挂载失败的原因（null = 正常）。
     * 用订阅式小 store 让面板能响应挂载结果，而不是只在挂载那一刻读一次。
     */
    let remoteError = null;
    const remoteErrorListeners = new Set();
    function setRemoteError(value) {
      const next = value === null ? null : String(value);
      if (next === remoteError) return;
      remoteError = next;
      for (const fn of remoteErrorListeners) fn();
    }
    /** 订阅 remote 挂载状态；返回取消订阅函数。 */
    function useRemoteError() {
      const [, force] = react.useReducer((n) => n + 1, 0);
      react.useEffect(() => {
        remoteErrorListeners.add(force);
        return () => {
          remoteErrorListeners.delete(force);
        };
      }, [force]);
      return remoteError;
    }

    /** 取翻译函数；locale 服务缺失时回退到浏览器语言，再回退 zh。 */
    function translate(ctx, key, vars) {
      const table = pickTable(ctx);
      const template = Object.hasOwn(table, key) ? table[key] : (TABLES.zh[key] ?? key);
      return vars === undefined ? template : interpolate(template, vars);
    }

    function pickTable(ctx) {
      const active = ctx?.locale?.getSnapshot?.()?.active;
      if (typeof active === "string" && active.toLowerCase().startsWith("en")) return TABLES.en;
      return TABLES.zh;
    }

    // ---- Remote 挂载 --------------------------------------------------------
    /** Remote 描述符必须与 Host 侧逐字一致，否则 $mount 失败。 */
    const REMOTE_PACKAGE = "dsh-fulltext-search";
    const REMOTE_NAMESPACE = "sessionSearch";
    const REMOTE_METHOD = "query";

    function strictCodec(typeSymbol, schema) {
      return { mode: "strict", typeSymbol, create: () => schema };
    }

    const REMOTE_CONTRIBUTION = {
      package: REMOTE_PACKAGE,
      descriptors: [
        {
          id: `${REMOTE_PACKAGE}#${REMOTE_NAMESPACE}/${REMOTE_METHOD}`,
          service: `${REMOTE_NAMESPACE}Remote`,
          namespace: REMOTE_NAMESPACE,
          method: REMOTE_METHOD,
          invocation: { kind: "direct" },
          parameters: [
            {
              name: "request",
              wire: "request",
              source: "json",
              codec: strictCodec(`${REMOTE_PACKAGE}#SessionSearchQuery`, {
                parse(value) {
                  if (value === null || typeof value !== "object") throw new Error("query request must be an object");
                  // ⚠️ 必须与 Host 侧 codec 保持同一形状：
                  //   - 漏掉 groups → 筛选参数被静默丢弃（开关点了没反应）；
                  //   - 任何值为 undefined 的字段 → Host 的 strict 边界校验拒绝整个
                  //     请求，症状是面板永远停在「正在扫描会话…」（实测踩过）。
                  // 缺省值用「不出现该键」表达。
                  const out = {
                    query: typeof value.query === "string" ? value.query : "",
                    caseSensitive: value.caseSensitive === true,
                    includeSubagents: value.includeSubagents === true,
                    // 空数组 = 不筛选
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
          result: strictCodec(`${REMOTE_PACKAGE}#SessionSearchResult`, {
            parse(value) {
              if (value === null || typeof value !== "object") throw new Error("result must be an object");
              return {
                query: typeof value.query === "string" ? value.query : "",
                sessionsScanned: typeof value.sessionsScanned === "number" ? value.sessionsScanned : 0,
                totalHits: typeof value.totalHits === "number" ? value.totalHits : 0,
                matches: Array.isArray(value.matches) ? value.matches : [],
              };
            },
          }),
        },
      ],
    };

    // ---- 面板组件 ----------------------------------------------------------
    /**
     * 侧栏底部入口 + 搜索面板。
     *
     * 面板形态对齐 DeepSeek 官网「搜索对话」：**顶部悬浮面板**（非居中弹窗），
     * 宽 660px、圆角 20px；输入行 = 放大镜 + 无边框输入 + 竖分隔线 + ✕；
     * 结果行 = 36px 圆形图标 + 15px 标题 + 13px 日期 + 等宽内容预览。
     * 规格来源见 docs/deepseek-search-ui-spec.md。
     *
     * ⚠️ React 19 的 `jsx` / `jsxs` 签名都是 `(type, config, maybeKey)`：
     * 第三个参数是 **key**，不是子节点。所有子节点必须放进 `config.children`，
     * 否则会被静默丢弃（症状：slot 注册成功但渲染成空 div）。
     *
     * @param {{wide:boolean, t:(key:string, vars?:object)=>string}} props
     */
    function SessionSearchEntry({ wide, t }) {
      // 局部遮蔽：t 由注册面 inject 传入；若宿主未注入则退回模块级翻译，保证不崩。
      if (typeof t !== "function") t = (key, vars) => translate(getCtx(), key, vars);
      const [open, setOpen] = react.useState(false);
      const [draft, setDraft] = react.useState("");
      const [loading, setLoading] = react.useState(false);
      const [result, setResult] = react.useState(null);
      const [error, setError] = react.useState(null);
      const [active, setActive] = react.useState(0);
      // 启用的搜索范围，默认只开「用户」（见 DEFAULT_GROUPS）。用 Set 便于 O(1) 判断。
      const [groups, setGroups] = react.useState(() => new Set(DEFAULT_GROUPS));
      const mountError = useRemoteError();

      /** 切换某个搜索范围是否参与。 */
      const toggleGroup = react.useCallback((group) => {
        setGroups((prev) => {
          const next = new Set(prev);
          if (next.has(group)) next.delete(group);
          else next.add(group);
          return next;
        });
      }, []);

      /** 一键恢复全选。 */
      const selectAllGroups = react.useCallback(() => {
        setGroups(new Set(SEARCH_GROUPS));
      }, []);

      // 打开时清掉上次错误，并把选中项复位。
      react.useEffect(() => {
        if (!open) return;
        setError(null);
        setActive(0);
      }, [open]);

      // 窄屏（<768px）打开面板前**收起侧栏**：
      // 宿主侧栏 z-index 1100 高于 modal 的 1000，不收起会盖在搜索面板上。
      // 只在窄屏做，宽屏要保留侧栏（面板是悬浮卡片，不冲突）。
      react.useEffect(() => {
        if (!open) return;
        if (typeof window === "undefined") return;
        if (!window.matchMedia("(max-width:767.98px)").matches) return;
        const layout = getCtx()?.layout;
        if (layout !== undefined && layout !== null && typeof layout.toggleSidebar === "function") {
          // 只在侧栏确实展开时才收，避免把它又打开（toggle 语义）。
          if (isSidebarWide()) layout.toggleSidebar();
        }
      }, [open]);

      // 竞态守卫：每次请求带一个递增序号，只有「最新那次」的返回才允许写入
      // state。否则快速输入时先发的慢请求后返回，会把新结果覆盖掉 ——
      // 症状就是「一会儿有一会儿没有」（用户实测反馈过）。
      const searchSeq = react.useRef(0);
      // IME 组字标记：组字期间跳过搜索（见 input 的 composition 处理）。
      const composingRef = react.useRef(false);
      // 当前关键词 / 当前范围的镜像。runSearch 只依赖 t，分组必须从 ref 读，
      // 否则切换范围后重搜会用闭包里的旧分组。
      const draftRef = react.useRef("");
      const groupsRef = react.useRef(groups);
      // runSearch 的镜像。**任何 effect 都不得直接依赖 runSearch**：
      // slot 注入的 t 每次渲染都是新函数，runSearch 的身份因此每渲染必变，
      // 依赖它会变成「渲染 → 触发搜索 → setState → 渲染」的无限循环
      // （实测把页面主线程打满，CDP 都连不上）。
      const runSearchRef = react.useRef(null);

      const runSearch = react.useCallback(async (rawQuery) => {
        const query = String(rawQuery ?? "").trim();
        const seq = ++searchSeq.current;
        if (query.length === 0) {
          setResult(null);
          setLoading(false);
          return;
        }
        setLoading(true);
        setError(null);
        try {
          // 每次调用现取，避免闭包持有挂载前的 undefined 引用。
          const remote = getRemote();
          if (remote === undefined || remote === null) {
            if (seq !== searchSeq.current) return;
            setError(t("panel.remoteUnavailable"));
            setResult(null);
            return;
          }
          // 分组从 ref 读，保证拿到的是「本次切换之后」的范围。
          const active = groupsRef.current;
          // ⚠️ Remote 方法返回的是 `{ ok, value | error }` 包装，不是裸数据。
          const res = await remote[REMOTE_METHOD]({
            query,
            limit: 5,
            maxSessions: SEARCH_MAX_SESSIONS,
            // 全选时不传，省掉一次归一化；否则只送选中的分组。
            groups: active.size === SEARCH_GROUPS.length ? undefined : [...active],
          });
          // 过期响应直接丢弃（不写 state、不改 loading）。
          if (seq !== searchSeq.current) return;
          if (res !== null && typeof res === "object" && "ok" in res) {
            if (res.ok !== true) {
              setError(res.error?.message ?? t("panel.remoteUnavailable"));
              setResult(null);
              return;
            }
            setResult(res.value ?? null);
          } else {
            setResult(res ?? null);
          }
          setActive(0);
        } catch (e) {
          if (seq !== searchSeq.current) return;
          setError(t("panel.error", { message: e instanceof Error ? e.message : String(e) }));
          setResult(null);
        } finally {
          // 只有最新请求才允许收尾，避免旧请求把 loading 提前关掉。
          if (seq === searchSeq.current) setLoading(false);
        }
      }, [t]);

      // 镜像 effect 必须排在「范围变化重搜」之前：React 按声明顺序执行 effect，
      // 这样重搜时读到的一定是本轮最新的关键词与范围。
      react.useEffect(() => { draftRef.current = draft; }, [draft]);
      react.useEffect(() => { groupsRef.current = groups; }, [groups]);
      react.useEffect(() => { runSearchRef.current = runSearch; }, [runSearch]);

      // 切换范围后立刻用当前关键词重搜，否则界面还停在旧范围的结果上。
      // ⚠️ 依赖数组里**只能有 groups**：加上 runSearch 就会因 t 的身份漂移
      // 变成无限重搜（见上面 runSearchRef 的说明），把页面卡死。
      react.useEffect(() => {
        const q = draftRef.current;
        if (q.trim().length === 0) return;
        const search = runSearchRef.current;
        if (typeof search === "function") void search(q);
      }, [groups]);

      // 防抖搜索：输入变化后延迟触发，避免每敲一个字符就打一次 Remote。
      // 用户实测「疑似在持续搜索」，根因就是逐键直发。
      const debounceRef = react.useRef(null);
      const scheduleSearch = react.useCallback((value) => {
        if (debounceRef.current !== null) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
          debounceRef.current = null;
          void runSearch(value);
        }, SEARCH_DEBOUNCE_MS);
      }, [runSearch]);

      // 组件卸载/关闭时清掉待触发的定时器。
      react.useEffect(() => () => {
        if (debounceRef.current !== null) clearTimeout(debounceRef.current);
      }, []);

      /**
       * 打开一条命中会话。
       *
       * ⚠️ **判据是 `origin === 'subagent'`，不是「有没有 parentSessionId」**。
       * 这两种会话完全不同，实测混淆过一次：
       *   - `origin:'subagent'`（真 subagent，全库仅 ~23 个）：**必须**传
       *     `SubagentAddress { parentSessionId, childSessionId, mode }`，
       *     裸 sessionId 会被宿主以 `session/agent-busy: subagent Sessions
       *     require their durable parent address` 拒绝。
       *   - 有 `parentSessionId` 但无 `origin`（分叉/改写子会话，~257 个）：
       *     **必须**用裸 sessionId 打开；套 SubagentAddress 反而被
       *     `validateAddress` 判成 `subagent/unauthorized` 而打不开。
       *
       * @param {object|string} match - 命中项（含 sessionId、可选 origin/parentSessionId），
       *                                兼容直接传 id 的字符串。
       */
      const openSession = react.useCallback((match) => {
        const nav = getCtx()?.uiWorkspace;
        if (nav === undefined || nav === null || typeof nav.openSession !== "function") return;
        const sessionId = typeof match === "string" ? match : match?.sessionId;
        if (typeof sessionId !== "string" || sessionId.length === 0) return;
        const isSubagent = typeof match !== "string" && match?.origin === "subagent";
        const parentSessionId = typeof match === "string" ? undefined : match?.parentSessionId;
        // 只有真 subagent 才构造地址；mode 无法从日志判定，用 unknown。
        const target = isSubagent && typeof parentSessionId === "string" && parentSessionId.length > 0
          ? { parentSessionId, childSessionId: sessionId, mode: "unknown" }
          : sessionId;
        nav.openSession(target);
        setOpen(false);
      }, []);

      const matches = result !== null && Array.isArray(result.matches) ? result.matches : [];

      // 键盘：↑/↓ 选择，Enter 打开选中项（无选中时执行搜索）。
      const onKeyDown = react.useCallback((e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setActive((i) => (matches.length === 0 ? 0 : Math.min(i + 1, matches.length - 1)));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setActive((i) => Math.max(i - 1, 0));
        } else if (e.key === "Enter") {
          // IME 组字时回车是「确认候选词」，不能当作提交搜索。
          if (composingRef.current) return;
          e.preventDefault();
          const target = matches[active];
          if (target !== undefined && target.sessionId !== undefined) {
            openSession(target);
          } else {
            void runSearch(draft);
          }
        }
      }, [matches, active, openSession, runSearch, draft]);

      const trigger = jsxs("button", {
        type: "button",
        className: "dsss-root",
        "aria-label": t("nav"),
        title: t("nav"),
        onClick: () => setOpen((v) => !v),
        style: {
          display: "inline-flex",
          alignItems: "center",
          gap: "8px",
          background: "none",
          border: "none",
          color: "var(--dsw-alias-label-secondary)",
          cursor: "pointer",
          font: "inherit",
          fontSize: "12px",
          lineHeight: "18px",
          padding: "4px 6px",
          borderRadius: "6px",
        },
        children: [
          jsx(IconSearchOutlineRegular, { size: 16 }, "icon"),
          wide ? jsx("span", { children: t("nav") }, "label") : null,
        ].filter((x) => x !== null),
      });

      // 侧栏收起成 rail 时只显示图标按钮 + Tooltip。
      const anchor = wide
        ? trigger
        : jsx(Tooltip, { label: t("nav"), side: "right", delayMs: 200, children: trigger });

      return jsxs(fragments, {
        children: [
          anchor,
          // headless：只用它的遮罩 / Escape / portal，内部结构完全自绘，
          // 以便对齐官网的顶部悬浮面板（而非居中 Modal）。
          jsx(Modal, {
            open,
            onClose: () => setOpen(false),
            title: t("panel.title"),
            headless: true,
            // ⚠️ 实测：Modal 只把 `className` 落到 dialog 包裹元素上，
            // `contentClassName` 未生效（DOM 里没有该 class）。
            // 因此宽度/圆角等卡片样式统一写在 className 里。
            className: "dsss-card",
            onKeyDownCapture: onKeyDown,
            children: jsxs("div", {
              className: "dsss-panel",
              children: [
                // ---- 输入行 ----
                jsxs("div", {
                  className: "dsss-searchbar",
                  children: [
                    jsx("span", {
                      className: "dsss-magnifier",
                      children: jsx(IconSearchOutlineRegular, { size: 16 }),
                    }),
                    jsx("input", {
                      className: "dsss-input",
                      value: draft,
                      placeholder: t("panel.placeholder"),
                      "aria-label": t("panel.placeholder"),
                      "data-modal-autofocus": true,
                      spellCheck: false,
                      autoComplete: "off",
                      // 中文等 IME 输入：组字期间**不发搜索**，否则会拿拼音去搜
                      // （用户实测「输入中文疑似按按键在搜索」）。
                      // React 的 onChange 在组字过程中也会触发，必须自行用
                      // compositionstart / compositionend 标记。
                      onCompositionStart: () => { composingRef.current = true; },
                      onCompositionEnd: (e) => {
                        composingRef.current = false;
                        const value = e.currentTarget.value;
                        setDraft(value);
                        void runSearch(value);
                      },
                      onChange: (e) => {
                        const value = e.target.value;
                        setDraft(value);
                        // 组字中只更新文本，不触发搜索。
                        if (composingRef.current) return;
                        scheduleSearch(value);
                      },
                    }),
                    jsx("span", { className: "dsss-divider" }),
                    jsx("button", {
                      type: "button",
                      className: "dsss-close",
                      "aria-label": t("panel.close"),
                      onClick: () => setOpen(false),
                      children: jsx(IconCloseOutlineRegular, { size: 16 }),
                    }),
                  ],
                }),
                // ---- 范围筛选条 ----
                jsxs("div", {
                  className: "dsss-filters",
                  children: [
                    jsx("span", { className: "dsss-filterLabel", children: t("panel.filters") }),
                    jsx("button", {
                      type: "button",
                      className: groups.size === SEARCH_GROUPS.length ? "dsss-chip dsss-chipOn" : "dsss-chip",
                      "aria-pressed": groups.size === SEARCH_GROUPS.length,
                      onClick: selectAllGroups,
                      children: t("panel.filter.all"),
                    }, "all"),
                    ...SEARCH_GROUPS.map((g) =>
                      jsx("button", {
                        type: "button",
                        className: groups.has(g) ? "dsss-chip dsss-chipOn" : "dsss-chip",
                        "aria-pressed": groups.has(g),
                        onClick: () => toggleGroup(g),
                        children: groupLabel(t, g),
                      }, g)),
                    groups.size === 0
                      ? jsx("span", { className: "dsss-filterLabel", children: t("panel.filterNone") })
                      : null,
                  ].filter((x) => x !== null),
                }),
                // ---- 结果区 ----
                jsxs("div", {
                  className: "dsss-results",
                  children: [
                    error !== null
                      ? jsx("p", { className: "dsss-msg dsss-msgError", children: error })
                      : null,
                    error === null && typeof mountError === "string"
                      ? jsx("p", { className: "dsss-msg dsss-msgError", children: mountError })
                      : null,
                    loading
                      ? jsx("p", { className: "dsss-msg", children: t("panel.searching") })
                      : null,
                    result !== null && result.subagentsSkipped > 0
                      ? jsx("p", {
                          className: "dsss-msg dsss-msgMuted",
                          children: t("panel.skippedSubagents", { count: result.subagentsSkipped }),
                        })
                      : null,
                    renderBody(result, loading, t, openSession, active, setActive),
                  ].filter((x) => x !== null),
                }),
              ],
            }),
          }),
        ],
      });
    }

    /** 结果区：空态 / 命中列表（对齐官网行样式）。 */
    function renderBody(result, loading, t, openSession, active, setActive) {
      if (loading) return null;
      if (result === null) {
        return jsx("p", { className: "dsss-msg", children: t("panel.hint") });
      }

      const matches = Array.isArray(result.matches) ? result.matches : [];
      if (matches.length === 0) {
        return jsx("p", { className: "dsss-msg", children: t("panel.empty") });
      }

      return jsx("div", {
        className: "dsss-list",
        children: matches.map((m, i) =>
          jsx(
            ResultRow,
            {
              match: m,
              t,
              active: i === active,
              onHover: () => setActive(i),
              onOpen: openSession,
            },
            m.sessionId ?? String(i),
          )),
      });
    }

    /** 单条结果行：36px 圆形图标 + 15px 标题 + 13px 日期 + 等宽预览。 */
    function ResultRow({ match, t, active, onHover, onOpen }) {
      const title = match.title && match.title.length > 0 ? match.title : t("panel.untitled");
      const lines = Array.isArray(match.lines) ? match.lines : [];
      const first = lines[0];
      // 这条命中来自哪类记录（用户说的 / 助手正文 / 思考块 / 工具输出…）。
      // group 由 Host 侧 records.js 判定后随结果下发，这里不再自己复制一份映射。
      const kindLabel = first !== undefined && typeof first.group === "string" && first.group.length > 0
        ? groupLabel(t, first.group)
        : null;
      const preview = first !== undefined
        ? "L" + first.lineNo + "  " + String(first.text ?? "").replace(/\s+/g, " ").trim()
        : (match.cwd || "");
      return jsxs("button", {
        type: "button",
        className: active ? "dsss-row dsss-rowActive" : "dsss-row",
        onMouseEnter: onHover,
        onFocus: onHover,
        onClick: () => onOpen(match),
        title: t("panel.openTitle", { title }),
        children: [
          jsx("span", {
            className: "dsss-rowIcon",
            children: jsx(IconListPenOutlineRegular, { size: 16 }),
          }),
          jsxs("span", {
            className: "dsss-rowBody",
            children: [
              jsxs("span", {
                className: "dsss-rowHead",
                children: [
                  kindLabel !== null
                    ? jsx("span", { className: "dsss-kind", children: kindLabel })
                    : null,
                  jsx("span", { className: "dsss-rowTitle", children: title }),
                  jsx("span", { className: "dsss-rowDate", children: formatDate(match.createdAt) }),
                ].filter((x) => x !== null),
              }),
              jsx("span", { className: "dsss-rowPreview", children: preview }),
            ],
          }),
        ],
      });
    }

    /** 把时间戳格式化为「9月29日」（对齐官网日期样式）。 */
    function formatDate(ts) {
      if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return "";
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) return "";
      return (d.getMonth() + 1) + "月" + d.getDate() + "日";
    }

    // ---- 装配 --------------------------------------------------------------
    function apply(ctx) {
      ctxRef = ctx;
      injectCss();

      // Host locale 注册（走 ctx.locale；缺失时组件内自动回退）。
      if (ctx.locale !== undefined && typeof ctx.locale.register === "function") {
        ctx.locale.register(NS, { zh: TABLES.zh, en: TABLES.en });
      }

      // 物化 Remote 命名空间：rc.2 要求 client 侧 $mount 贡献描述符，
      // 之后 `ctx.get("remote.sessionSearch")` 才会返回可用服务。
      // 缺这一步的症状是「装了但一调用就是 undefined」。
      ctx.effect(() => {
        let disposed = false;
        let unmount = null;
        const remote = ctx.get("remote");
        if (remote === undefined || typeof remote.$mount !== "function") {
          setRemoteError("panel.remoteUnavailable");
          return () => {};
        }
        void remote.$mount(REMOTE_CONTRIBUTION).then(
          (dispose) => {
            if (disposed) {
              // 竞态：卸载先到，立刻回收，避免泄漏挂载。
              void dispose();
              return;
            }
            unmount = dispose;
            setRemoteError(null);
          },
          (e) => {
            setRemoteError(e instanceof Error ? e.message : String(e));
          },
        );
        return () => {
          disposed = true;
          if (unmount !== null) void unmount();
        };
      }, "dsh-fulltext-search: mount remote");

      // 侧栏底部入口（list 槽，增量，不抢占官方「设置」）。
      //
      // ⚠️ 必须直接传**组件函数本身**，不能写成 `() => jsx(Comp, props)` 包一层：
      // 后者渲染空白（slot 渲染器要求一个真正接收 owner props 的组件）。
      // 文案翻译通过注册面 `inject` 传入，避免组件闭包依赖模块级 ctx。
      ctx.slots.inject("sidebar.footer.action", () =>
        ctx.slots.register(
          {
            name: "sidebar.footer.action",
            id: "session-search",
            locale: NS,
            order: 50,
            inject: () => ({ t: (key, vars) => translate(getCtx(), key, vars) }),
          },
          SessionSearchEntry,
        ));
    }

    bundleModule.exports.apply = apply;
    // 只声明**已存在**的服务。
    // ⚠️ 不要在这里声明 "remote." + REMOTE_NAMESPACE：该命名空间是本插件
    // 自己在 apply 里 $mount 出来的；把它写进 inject 会形成死锁
    // （apply 等注入 → 注入等 $mount → $mount 在 apply 里），插件永远 parked。
    bundleModule.exports.inject = [
      "slots",
      "connection",
      "remote",
      "uiWorkspace",
      "locale",
      // 窄屏打开面板时需要收起侧栏（侧栏 z-index 1100 > modal 1000，
      // 不收起会盖住搜索面板）。ctx.layout.toggleSidebar() 由它提供。
      "layout",
    ];
    bundleModule.exports.__contribution = REMOTE_CONTRIBUTION;
    return bundleModule.exports;
  },
});
