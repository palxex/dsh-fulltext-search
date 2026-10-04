// 语义级验证：用**真实 React** 渲染 client bundle 的组件，断言子节点真的产出。
//
// 为什么需要这层：`jsx(type, props, child)` 在语法上完全合法，但第三个参数
// 是 **key** 而不是子节点，child 会被静默丢弃（props.children === undefined）。
// 静态检查很难判定，只有真实渲染才能发现「注册成功但渲染成空 div」。
//
// 依赖：本机需有 react + react-dom（从宿主 profile 或任意副本解析）。
// 找不到时跳过，不让缺依赖的机器误报失败。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/** 在若干候选位置里找一对可用的 react + react-dom。 */
function findReactPair() {
  const candidates = [
    // 本机宿主 profile 的副本
    "/home/palxex/.dsh/profiles/web/node_modules",
    "/home/palxex/.dsh/profiles/dsh-tui/node_modules",
    // 任意带 webui 的工程
    "/home/palxex/gst/ds2api/wzxwhxcz_ds2api/webui/node_modules",
    "/home/palxex/gst/ds2api-multi-provider/webui/node_modules",
  ];
  for (const base of candidates) {
    const react = join(base, "react");
    const dom = join(base, "react-dom");
    if (existsSync(join(react, "package.json")) && existsSync(join(dom, "package.json"))) {
      return base;
    }
  }
  return null;
}

const REACT_BASE = findReactPair();

test("渲染：组件产出真实 DOM（子节点未丢失）", { skip: REACT_BASE === null }, async () => {
  const req2 = createRequire(join(REACT_BASE, "noop.js"));
  const React = req2("react");
  const jsxRuntime = req2("react/jsx-runtime");
  const { renderToStaticMarkup } = req2("react-dom/server");

  // 在可控的 ModuleLoader 环境里加载 bundle
  let captured = null;
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  globalThis.window = { __ModuleLoader__: { load: (a) => { captured = a; } } };
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {} }),
    head: { appendChild() {} },
  };
  try {
    await import("../lib/client.js");
    assert.ok(captured !== null, "bundle 应调用 __ModuleLoader__.load");

    // primitives 桩：保留 children 透传，便于断言结构
    const primitives = new Proxy({}, {
      get: (_t, key) => {
        if (key === "IconSearchOutlineRegular") {
          return (props) => React.createElement("svg", { "data-icon": "search", ...props });
        }
        if (key === "Tooltip") {
          return (props) => React.createElement("span", { "data-tooltip": "1" }, props.children);
        }
        return (props) => React.createElement("span", { "data-prim": String(key) }, props.children);
      },
    });

    const seedRequire = (spec) => {
      if (spec === "react") return React;
      if (spec === "react/jsx-runtime") return jsxRuntime;
      if (spec === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
      return {};
    };

    const mod = captured.factory(seedRequire);
    let registered = null;
    const ctx = {
      locale: { register() {} },
      get: () => undefined,
      effect: (fn) => { try { fn(); } catch { /* 桩环境忽略 */ } return () => {}; },
      slots: {
        inject: (_name, fn) => fn(),
        register: (def, comp) => { registered = { def, comp }; return () => {}; },
      },
    };
    mod.apply(ctx);
    assert.ok(registered !== null, "应注册 sidebar.footer.action 条目");
    assert.equal(registered.def.name, "sidebar.footer.action");

    // 在真实 React 树里渲染（hooks 需要）
    const html = renderToStaticMarkup(
      React.createElement(registered.comp, { wide: true, t: (k) => k }),
    );

    // 关键断言：入口按钮及其子节点真的产出
    assert.match(html, /<button/, "应渲染 button 元素");
    assert.match(html, /aria-label="nav"/, "button 应有 aria-label");
    assert.match(html, /data-icon="search"/, "搜索图标子节点未丢失");
    assert.match(html, />nav</, "按钮文字子节点未丢失");
    // 面板为关闭态时不渲染（open=false），入口本身必须可见
    assert.ok(html.length > 50, "入口应产出非空标记");
  } finally {
    globalThis.window = prevWindow;
    globalThis.document = prevDocument;
  }
});

test("渲染：宽栏与 rail 两种形态都产出内容", { skip: REACT_BASE === null }, async () => {
  const req2 = createRequire(join(REACT_BASE, "noop.js"));
  const React = req2("react");
  const jsxRuntime = req2("react/jsx-runtime");
  const { renderToStaticMarkup } = req2("react-dom/server");

  // 模块已被上一个测试 import 且缓存，__ModuleLoader__.load 不会再触发。
  // 这里重新捕获一次 factory：用一个全新 URL 查询串绕过 ESM 缓存。
  let captured = null;
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  globalThis.window = { __ModuleLoader__: { load: (a) => { captured = a; } } };
  globalThis.document = { querySelector: () => null, createElement: () => ({ dataset: {} }), head: { appendChild() {} } };
  try {
    const src = readFileSync(join(here, "..", "lib", "client.js"), "utf8");
    // 直接在受控作用域里执行 bundle 源码，避免 ESM 缓存
    const run = new Function("window", "document", src);
    run(globalThis.window, globalThis.document);
    assert.ok(captured !== null, "bundle 应调用 __ModuleLoader__.load");
  } finally {
    globalThis.window = prevWindow;
    globalThis.document = prevDocument;
  }

  const primitives = new Proxy({}, {
    get: (_t, key) => {
      if (key === "IconSearchOutlineRegular") {
        return () => React.createElement("svg", { "data-icon": "search" });
      }
      if (key === "Tooltip") {
        // 桩需保留可辨识标记，供断言 Tooltip 包裹生效
        return (props) => React.createElement("span", { "data-tooltip": "1" }, props.children);
      }
      return (props) => React.createElement("span", null, props.children);
    },
  });
  const seedRequire = (spec) => spec === "react" ? React
    : spec === "react/jsx-runtime" ? jsxRuntime
    : spec === "@deepseek-ai/dsh-client-ui-primitives" ? primitives : {};

  const mod = captured.factory(seedRequire);
  let registered = null;
  mod.apply({
    locale: { register() {} },
    get: () => undefined,
    effect: (fn) => { try { fn(); } catch { /* ignore */ } return () => {}; },
    slots: { inject: (_n, f) => f(), register: (d, c) => { registered = { d, c }; return () => {}; } },
  });
  assert.ok(registered !== null, "应注册 slot 条目");

  const wide = renderToStaticMarkup(React.createElement(registered.c, { wide: true, t: (k) => k }));
  const rail = renderToStaticMarkup(React.createElement(registered.c, { wide: false, t: (k) => k }));

  assert.match(wide, /data-icon="search"/, "宽栏应含图标");
  assert.match(wide, />nav</, "宽栏应含文字");
  assert.match(rail, /data-icon="search"/, "rail 应含图标");
  assert.match(rail, /data-tooltip="1"/, "rail 应包一层 Tooltip");
});

test("渲染：面板展开时产出官网结构的各部件", { skip: REACT_BASE === null }, async () => {
  const req2 = createRequire(join(REACT_BASE, "noop.js"));
  const React = req2("react");
  const jsxRuntime = req2("react/jsx-runtime");
  const { renderToStaticMarkup } = req2("react-dom/server");

  let captured = null;
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  globalThis.window = { __ModuleLoader__: { load: (a) => { captured = a; } } };
  globalThis.document = { querySelector: () => null, createElement: () => ({ dataset: {} }), head: { appendChild() {} } };
  try {
    const src = readFileSync(join(here, "..", "lib", "client.js"), "utf8");
    new Function("window", "document", src)(globalThis.window, globalThis.document);
  } finally {
    globalThis.window = prevWindow;
    globalThis.document = prevDocument;
  }
  assert.ok(captured !== null, "bundle 应调用 __ModuleLoader__.load");

  const primitives = new Proxy({}, {
    get: (_t, key) => {
      if (String(key).startsWith("Icon")) {
        return () => React.createElement("svg", { "data-icon": String(key) });
      }
      if (key === "Modal") {
        // headless Modal 桩：open 时把 children 直接渲染出来
        return ({ open, children }) => (open ? React.createElement("div", { "data-modal": "1" }, children) : null);
      }
      if (key === "Tooltip") {
        // Tooltip 需转发 children（入口在 rail 形态下包一层）
        return ({ children }) => React.createElement("span", { "data-tooltip": "1" }, children);
      }
      return (props) => React.createElement("span", { "data-prim": String(key) }, props.children);
    },
  });
  const seedRequire = (spec) => spec === "react" ? React
    : spec === "react/jsx-runtime" ? jsxRuntime
    : spec === "@deepseek-ai/dsh-client-ui-primitives" ? primitives : {};

  const mod = captured.factory(seedRequire);
  let registered = null;
  mod.apply({
    locale: { register() {} },
    get: () => undefined,
    effect: (fn) => { try { fn(); } catch { /* ignore */ } return () => {}; },
    slots: { inject: (_n, f) => f(), register: (d, c) => { registered = { d, c }; return () => {}; } },
  });

  const Comp = registered.c;

  // 关闭态：只应有入口
  const closed = renderToStaticMarkup(React.createElement(Comp, { wide: true, t: (k) => k }));
  assert.ok(!closed.includes("dsss-panel"), "关闭时不应渲染面板");

  // 展开态部件：无 DOM 环境无法触发 click，改为对 bundle 源码做静态断言，
  // 与上面的渲染断言互补（渲染保证子节点不丢，静态保证部件齐全）。
  const bundleSrc = readFileSync(join(here, "..", "lib", "client.js"), "utf8");
  assert.match(bundleSrc, /className: "dsss-searchbar"/, "应有输入行");
  assert.match(bundleSrc, /className: "dsss-magnifier"/, "应有放大镜");
  assert.match(bundleSrc, /className: "dsss-close"/, "应有 ✕ 关闭");
  assert.match(bundleSrc, /className: "dsss-results"/, "应有结果区");
  assert.match(bundleSrc, /dsss-rowActive/, "结果行应有选中态");
});
