/**
 * dsh-editor bundle 冒烟测试 —— 装进浏览器之前最后一道闸。
 *
 * ★ 替身要跟着依赖升级同步补。
 *   dsh-canvas 踩过：缺 React.createContext 导致 factory 抛错，
 *   报出来的「失败」其实是被测物缺替身，不是产品坏。
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.join(HERE, "..", "lib", "client.js");

let pass = 0, fail = 0;
const failures = [];
function t(desc, fn) {
  try {
    const r = fn();
    if (r === true || r === undefined) { console.log(`  ✅ ${desc}`); pass++; }
    else { console.log(`  ❌ ${desc}\n     ${r}`); fail++; failures.push(desc); }
  } catch (err) {
    console.log(`  ❌ ${desc}\n     ${String(err.message).slice(0, 300)}`);
    fail++; failures.push(desc);
  }
}

const fakeContext = { Provider: function () {}, Consumer: function () {} };
const fakeReact = {
  createElement: (type, props, ...kids) => ({ type, props, kids }),
  createContext: () => fakeContext,
  useContext: () => null,
  useState: (init) => [typeof init === "function" ? init() : init, () => {}],
  useReducer: (r, init) => [typeof init === "function" ? init() : init, () => {}],
  useRef: (v) => ({ current: v }),
  useCallback: (fn) => fn,
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: (fn) => fn(),
  useId: () => "id-1",
  useImperativeHandle: () => {},
  useSyncExternalStore: (s, g) => g(),
  memo: (c) => c,
  forwardRef: (f) => f,
  Children: { map: () => [], toArray: () => [], count: () => 0, only: (c) => c },
  isValidElement: () => false,
  cloneElement: (e) => e,
  Fragment: "Fragment",
  StrictMode: "StrictMode",
  version: "18.3.1",
};

function makeCtx() {
  const reg = { views: [], locales: [], effects: [] };
  return {
    __reg: reg,
    locale: {
      bind: (ns) => (k) => `[${ns}]${k}`,
      register: (ns, dict) => { reg.locales.push({ ns, dict }); return () => {}; },
    },
    slots: {
      inject: (name, fn) => { reg.effects.push({ name }); return fn(); },
      register: (def, View) => { reg.views.push({ def, View }); return () => {}; },
    },
    effect: (fn, label) => { reg.effects.push({ label }); return fn(); },
  };
}

console.log("═══ ① bundle 可执行 ═══");
const code = fs.readFileSync(BUNDLE, "utf8");
let captured = null;

const sandbox = {
  window: { __ModuleLoader__: { load: (r) => { captured = r; } } },
  require: (name) => {
    if (name === "react") return fakeReact;
    if (name === "react/jsx-runtime") return { jsx: fakeReact.createElement, jsxs: fakeReact.createElement, Fragment: "Fragment" };
    if (name === "react-dom") return { createPortal: (x) => x, flushSync: (f) => f() };
    throw new Error(`unexpected require: ${name}`);
  },
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  MutationObserver: class { observe() {} disconnect() {} },
  document: {
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, click() {} }),
    querySelector: () => null,
    querySelectorAll: () => [],
    head: { appendChild() {} },
    body: { appendChild() {}, removeChild() {} },
    addEventListener() {}, removeEventListener() {},
  },
  navigator: { userAgent: "node-test" },
  fetch: () => Promise.resolve({ ok: true, text: () => Promise.resolve("{}") }),
  URL: Object.assign(function () {}, { createObjectURL: () => "blob:x", revokeObjectURL() {} }),
  Math, Date, JSON, Object, Array, String, Number, Boolean, Set, Map, WeakMap, WeakSet,
  Error, TypeError, Symbol, isNaN, parseInt, parseFloat, Promise, RegExp,
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox.window;
sandbox.global = sandbox;

t("bundle 在沙箱中执行不抛错", () => {
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { timeout: 20000 });
  return true;
});

t("注册 id = dsh-editor", () => (captured?.id === "dsh-editor" ? true : captured?.id));

console.log("\n═══ ② factory 导出 ═══");
let mod = null;
t("factory 执行成功", () => { mod = captured.factory(sandbox.require); return mod ? true : "返回空"; });
t("导出 apply", () => (typeof mod?.apply === "function" ? true : typeof mod?.apply));
t("inject 是服务名（不是包名）", () => {
  const inj = mod?.inject;
  if (!Array.isArray(inj)) return `不是数组：${typeof inj}`;
  const bad = inj.filter((x) => String(x).startsWith("@"));
  return bad.length === 0 ? true : `含包名：${bad.join(",")}`;
});
t("inject 含 slots 与 locale", () => {
  const inj = mod?.inject ?? [];
  return inj.includes("slots") && inj.includes("locale") ? true : JSON.stringify(inj);
});

console.log("\n═══ ③ apply 注册 ═══");
let ctx;
t("apply 执行不抛错", () => { ctx = makeCtx(); mod.apply(ctx, {}); return true; });
t("注册 locale（zh + en）", () => {
  const loc = ctx.__reg.locales.find((x) => x.ns === "dsh-editor");
  if (!loc) return "没注册";
  return loc.dict.zh && loc.dict.en ? true : Object.keys(loc.dict);
});
t("注册到 conversation.view", () => {
  const v = ctx.__reg.views.find((x) => x.def.name === "conversation.view");
  return v ? true : ctx.__reg.views.map((x) => x.def.name).join(",");
});
t("view id = timeline，order = 25（排在画布 30 之前）", () => {
  const v = ctx.__reg.views.find((x) => x.def.id === "timeline");
  if (!v) return "没有 id=timeline";
  return v.def.order === 25 ? true : `order=${v.def.order}`;
});
t("label 可调用", () => {
  const v = ctx.__reg.views.find((x) => x.def.id === "timeline");
  const l = v.def.label();
  return typeof l === "string" && l.length > 0 ? true : l;
});
t("View 是函数组件", () => {
  const v = ctx.__reg.views.find((x) => x.def.id === "timeline");
  return typeof v.View === "function" ? true : typeof v.View;
});

console.log("\n═══ ④ bundle 内含的关键逻辑 ═══");
// ★ M9 之后客户端变薄了：业务逻辑全在 host，客户端只做订阅 + 发命令。
//   所以要断言的是「客户端能正确发命令、能接 SSE」，而不是业务函数。
t("含 SSE 订阅（EventSource）", () => (/EventSource/.test(code) ? true : "没找到"));
t("含命令路由调用（/cmd/ 前缀）", () => (/\/cmd\//.test(code) ? true : "没找到"));
t("含三个面板（时间轴/素材库/音频）", () => {
  // ★ 不能用中文标签判断 —— esbuild 会按 target 把非 ASCII 转义成 \uXXXX。
  //   改判断组件名（ASCII 标识符，不会被转义）。
  const has = ["AssetsPanel", "AudioPanel", "TimelinePanelLazy"].every((s) => code.includes(s));
  return has ? true : `缺：${["AssetsPanel", "AudioPanel", "TimelinePanelLazy"].filter((s) => !code.includes(s)).join(",")}`;
});
t("含音频编辑控制（gain / fadeIn）", () => {
  return /fadeInSec/.test(code) && /gain/.test(code) ? true : "没找到";
});
t("含素材扫描入口", () => (/assets-scan/.test(code) ? true : "没找到"));
t("未把 react 打进包（应为 external）", () => (/require\("react"\)/.test(code) ? true : "React 可能被打进去了"));
t("体积合理（15~200 KB，M9 后客户端变薄）", () => {
  const kb = fs.statSync(BUNDLE).size / 1024;
  return kb > 15 && kb < 200 ? true : `${kb.toFixed(0)} KB`;
});

console.log("\n" + "═".repeat(58));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  M7-b bundle 冒烟测试全过 —— 可以装进浏览器");
