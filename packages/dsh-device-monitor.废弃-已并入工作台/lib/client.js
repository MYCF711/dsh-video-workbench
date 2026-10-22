/**
 * dsh-device-monitor client bundle — 由 build.mjs 生成，勿手改。
 */
window.__ModuleLoader__.load({
  id: "dsh-device-monitor",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var __requireShim = function (n) {
      if (n === "react" || n === "react/jsx-runtime" || n === "react-dom") return require(n);
      throw new Error("unexpected require: " + n);
    };

    (function (require, module, exports) {
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client.js
var client_exports = {};
__export(client_exports, {
  apply: () => apply
});
module.exports = __toCommonJS(client_exports);
var import_react = __toESM(require("react"), 1);
var { useState, useEffect, useRef } = import_react.default;
var h = import_react.default.createElement;
var PREFIX = "/device-monitor";
var POLL_MS = 3e3;
function Bar({ pct, color, width = 34 }) {
  const v = Math.max(0, Math.min(100, Number(pct) || 0));
  return h(
    "span",
    {
      style: {
        display: "inline-block",
        width,
        height: 4,
        borderRadius: 2,
        background: "var(--dsw-alias-border-l2, #0000001a)",
        position: "relative",
        overflow: "hidden",
        flex: "none",
        verticalAlign: "middle"
      }
    },
    h("span", {
      style: {
        position: "absolute",
        left: 0,
        top: 0,
        bottom: 0,
        width: `${v}%`,
        background: color,
        borderRadius: 2,
        transition: "width 400ms ease"
      }
    })
  );
}
function Metric({ label, text, pct, color, title }) {
  return h(
    "span",
    {
      title,
      style: {
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: 11,
        lineHeight: "18px",
        whiteSpace: "nowrap",
        color: "var(--dsw-alias-label-tertiary, #81858c)"
      }
    },
    h("span", { style: { opacity: 0.75 } }, label),
    h("span", { style: { fontVariantNumeric: "tabular-nums" } }, text),
    pct != null ? h(Bar, { pct, color }) : null
  );
}
function tempColor(c) {
  if (c == null) return "var(--dsw-alias-label-tertiary, #81858c)";
  if (c >= 80) return "rgb(248,81,73)";
  if (c >= 70) return "rgb(210,153,34)";
  return "rgb(63,185,80)";
}
function DeviceMonitor() {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const timer = useRef(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch(`${PREFIX}/snapshot`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        if (!alive) return;
        setData(j);
        setFailed(false);
      } catch {
        if (!alive) return;
        setFailed(true);
      }
    };
    tick();
    timer.current = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      if (timer.current) clearInterval(timer.current);
    };
  }, []);
  const gpu = data?.gpu ?? null;
  const cpu = data?.cpu ?? null;
  const mem = data?.mem ?? null;
  if (!gpu && !cpu && !mem) return null;
  const items = [];
  if (gpu) {
    if (gpu.temperatureC != null) {
      items.push(h(Metric, {
        key: "gtemp",
        label: "GPU",
        text: `${gpu.temperatureC}\xB0`,
        pct: null,
        color: tempColor(gpu.temperatureC),
        title: `${gpu.name}
\u6E29\u5EA6 ${gpu.temperatureC}\xB0C`
      }));
    }
    if (gpu.utilPct != null) {
      items.push(h(Metric, {
        key: "gutil",
        label: "",
        text: `${gpu.utilPct}%`,
        pct: gpu.utilPct,
        color: "rgb(65,118,230)",
        title: `GPU \u5360\u7528 ${gpu.utilPct}%`
      }));
    }
    if (gpu.vramUsedMiB != null && gpu.vramTotalMiB) {
      const usedGb = (gpu.vramUsedMiB / 1024).toFixed(1);
      const totalGb = (gpu.vramTotalMiB / 1024).toFixed(0);
      items.push(h(Metric, {
        key: "vram",
        label: "\u663E\u5B58",
        text: `${usedGb}/${totalGb}G`,
        pct: gpu.vramPct,
        color: gpu.vramPct >= 90 ? "rgb(248,81,73)" : "rgb(63,185,80)",
        title: `\u663E\u5B58 ${gpu.vramUsedMiB} / ${gpu.vramTotalMiB} MiB\uFF08${gpu.vramPct}%\uFF09`
      }));
    }
  }
  if (cpu?.loadPct != null) {
    items.push(h(Metric, {
      key: "cpu",
      label: "CPU",
      text: `${cpu.loadPct}%`,
      pct: cpu.loadPct,
      color: cpu.loadPct >= 90 ? "rgb(248,81,73)" : "rgb(65,118,230)",
      title: `${cpu.name ?? "CPU"}
\u8D1F\u8F7D ${cpu.loadPct}%\uFF08\u672C\u673A\u4E0D\u66B4\u9732 CPU \u6E29\u5EA6\uFF09`
    }));
  }
  if (mem?.usedMiB != null && mem.totalMiB) {
    const usedGb = (mem.usedMiB / 1024).toFixed(1);
    const totalGb = (mem.totalMiB / 1024).toFixed(0);
    items.push(h(Metric, {
      key: "mem",
      label: "\u5185\u5B58",
      text: `${usedGb}/${totalGb}G`,
      pct: mem.pct,
      color: mem.pct >= 90 ? "rgb(248,81,73)" : "rgb(163,106,3)",
      title: `\u5185\u5B58 ${mem.usedMiB} / ${mem.totalMiB} MiB\uFF08${mem.pct}%\uFF09`
    }));
  }
  if (!items.length) return null;
  return h("div", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 10,
      height: 22,
      padding: "0 2px",
      flex: "none"
    }
  }, ...items);
}
var Boundary = class extends import_react.default.Component {
  constructor(p) {
    super(p);
    this.state = { dead: false };
  }
  static getDerivedStateFromError() {
    return { dead: true };
  }
  componentDidCatch(e) {
    console.warn("[device-monitor] \u6E32\u67D3\u5931\u8D25\uFF0C\u5DF2\u9690\u85CF\uFF1A", e?.message ?? e);
  }
  render() {
    return this.state.dead ? null : this.props.children;
  }
};
function apply(ctx) {
  try {
    ctx.slots.inject(
      "conversation.session.header.utilities",
      () => ctx.slots.register(
        {
          name: "conversation.session.header.utilities",
          id: "device-monitor",
          order: 10,
          children: {},
          inject: () => ({})
        },
        () => h(Boundary, null, h(DeviceMonitor))
      )
    );
    console.log("[device-monitor] \u5DF2\u6302\u5230 header.utilities");
  } catch (err) {
    console.warn("[device-monitor] \u6302\u8F7D\u5931\u8D25\uFF08\u76D1\u63A7\u5C06\u4E0D\u53EF\u7528\uFF09\uFF1A", err?.message ?? err);
  }
}

    })(__requireShim, module, exports);

    return module.exports;
  }
});
