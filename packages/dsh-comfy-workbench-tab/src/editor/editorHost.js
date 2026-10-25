/**
 * dsh-artcraft-tab · client 入口（IIFE）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 2026-10-22 · 剪辑台实装
 *
 * 这一版把「时间轴」tab 改成「剪辑台」，并按 DSH 原生 slot 分三处注册：
 *
 *   conversation.view                     ← 剪辑台本体（预览/工具栏/时间轴/检查器）
 *   conversation.session.header.utilities ← 资产库按钮（与「文件资源管理器」并排）
 *   settings.section                      ← 快捷键设置（复用 DSH 设置面板外壳）
 *
 * ── 为什么不再挂 <VideoEditor>
 *   上一版 mount() 里是 root.render(<VideoEditor/>)，那是 ArtCraft 的整套外壳
 *   （左素材栏 + 中预览 + 右属性栏 + 3 条可拖边界）。
 *   主人要的是【预览 / 工具栏 / 时间轴】三段 + 右检查器抽屉，
 *   且工具栏「紧贴时间轴上方」—— PanelGroup 做不到。
 *   ⇒ 改用 mountTimeline()：只挂 <Timeline showToolbar={false}/>，
 *     外壳全部由 DSH 侧用官方 ui-primitives 拼。
 *
 * ══════════════════════════════════════════════════════════════════════
 * ★★ 已踩过、必须保留的东西（改动前先读）
 *
 *   ① payload 必须 base64（AGENTS §6.39 ⑧）
 *      产物里有 `__export(x, { mount, toProject })` 与 `module.exports = __toCommonJS(...)`，
 *      esbuild 做 CJS 导出分析时【不区分是否在字符串里】，
 *      会把它们当成【本模块的导出】⇒ 覆盖 exports.apply ⇒ 插件静默不激活。
 *      症状：tab 在、内容区空、data-slot-error="conversation.view"、没有任何报错。
 *
 *   ② new Function 必须显式传 require（2026-10-20 实测）
 *      产物保留了 require("react")（react 是 external），
 *      而 new Function 的作用域里没有 require ⇒ ReferenceError。
 *
 *   ③ effect 依赖数组不能放 hostRequire（2026-10-20 实测）
 *      hostRequire 是 inject() 每次返回的新引用 ⇒ effect 反复重跑，
 *      每次 cleanup 调 root.unmount()，而 EditorCore 是全局单例
 *      ⇒ 第二次 mount 挂到已卸载的 root 上，容器 children=0。
 *      修法：hostRequire 走 ref，依赖数组为空，mount 后校验 children.length。
 *
 *   ④ 加载提示必须是【兄弟】不是子节点
 *      React 清 children 时会连第三方塞进去的 DOM 一起清掉。
 */

import React from "react";
/**
 * ★★★ 2026-10-25 拆包：payload / css 不再静态 import。
 *
 *   原来：
 *     import ARTCRAFT_SRC from "./_artcraft-payload.js";   // 10.43 MB base64
 *     import ARTCRAFT_CSS from "./_artcraft-css.js";       // 93 KB base64
 *   静态 import ⇒ esbuild 必然内联进 lib/client.js
 *   ⇒ 首屏 11.4 MB，而这两个东西只有「打开剪辑台」才用得上（实测数据见下）。
 *
 *   现在：改为运行时向 host 侧取
 *     GET /comfy-assets/artcraft-asset?name=payload.js|css.js
 *   ⇒ 打包产物 614 KB（实测，旧版 11.4 MB）。
 *   ⇒ 不开剪辑台的人，一分钱不花。
 */
import DSH_NATIVE_CSS from "./dsh-native.css.js";
import EDITOR_CSS from "./editor.css.js";
import { createHttpAdapters } from "./adapters.js";
import { AssetPicker } from "./AssetPicker.js";
import { showModal } from "./showModal.js";
import { createTrimWriter } from "./saveTrim.js";
import { registerMediaAssets, collectMediaIds, fixupMediaIds, restoreLastImports } from "./mediaAssets.js";
import { ArtCraftTab } from "./ArtCraftTab.js";
import { formatTimecode } from "./PreviewPane.js";
import { ShortcutSettings } from "./ShortcutSettings.js";
import { SHORTCUT_DEFS, subscribeShortcuts } from "./shortcuts.js";
import { useAgentSync, countElements, highlightElements } from "./agentSync.js";
import { ui, resolveHostRequire } from "./dsh-primitives.js";
/**
 * ★ 2026-10-22：屏蔽 DSH 中栏列宽手柄 + 恢复默认宽度
 *   （主人报「视频工作台出现了之前修过的bug，可以调节dsh原生的对话框宽度」）
 */
import { installHandleGuard, resetDshWidths } from "./dshHandleGuard.js";
import { CLIPBOARD_KEY, KEYCLIPS } from "./clipboardOps.js";
/**
 * ★ 2026-10-22：真正的剪贴板（C/V/X）
 *   原来只有「原地复制」（duplicateElements），
 *   主人要求按大众习惯改成 Ctrl+C / Ctrl+V / Ctrl+X。
 */
import { copySelection, cutSelection, pasteClipboard, getClipboard } from "./clipboard.js";

export const NS = "artcraft-tab";
const VIEW_ID = "artcraft";

/* ★ 合包后不再导出 name：整个插件只有一个名字（包名） */

/** 依赖的客户端能力。写【服务名】，不是包名（AGENTS §3.1）。 */
/* ★ 合包后不再导出 inject：由包的 client.js 统一声明 */

/* ══════════════════════════════════════════════════════════════════════
 * ArtCraft 产物求值
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * ★★ 2026-10-24：没有 ArtCraft 产物时的降级处理。
 *
 *   主人指出仓库不该带第三方产物 —— 上游 @storyteller/ui-video-editor
 *   【没有声明任何 license】，默认版权保留，不能再分发。
 *   所以 _artcraft-payload.js 改为占位符（export default ""）。
 *
 *   这里要保证：**缺 payload 时插件照常加载，只有剪辑台降级。**
 *   判据 —— 一个可选功能的依赖缺失，不能拖垮核心功能
 *   （视频工作台的生图/生视频完全不依赖 ArtCraft）。
 *
 * ★★★ 2026-10-25：从「打包内联」改成「按需 fetch」。
 *
 *   【实测的问题】首屏 performance 资源明细：
 *     client.js 传输 5096 KB / 解码 14559 KB，其中 10.43 MB 是 ArtCraft 的
 *     base64 payload —— 而它只在【打开剪辑台】那一刻才用得上。
 *     ⇒ 不开剪辑台的人，每次刷新白下 10MB，再 atob 一遍（再吃 ~7MB 内存）。
 *     ⇒ 打包产物 11.4 MB；抽掉 payload/css 后只有 614 KB（实测）。
 *
 *   【做法】构建期 payload 是 ""，真要用时向 host 侧取：
 *     GET /comfy-assets/artcraft-asset?name=payload.js|css.js
 *   host 侧从 src/editor/artcraft-*.b64.txt 读（不在 git 里）。
 *
 *   ★ 为什么不直接 import 那两个 .js：静态 import 会被 esbuild 内联进产物，
 *     体积问题原样保留。必须让「取」这个动作发生在运行时、且只在需要时。
 */
/** ArtCraft 产物（唯一来源：host 侧按需取）。空 = 还没取过。 */
let _rawSrc = "";
let _rawCss = "";

/** 取一次就记住；失败也记住（避免每次挂载都重试 10MB）。 */
let _assetPromise = null;
function loadArtCraftAssets() {
  if (_assetPromise) return _assetPromise;
  _assetPromise = (async () => {
    const get = async (name) => {
      const r = await fetch(`/comfy-assets/artcraft-asset?name=${name}`, {
        headers: { Accept: "text/plain" },
      });
      if (r.status === 404) {
        /* 缺产物是正常降级态，不是异常 */
        const j = await r.json().catch(() => ({}));
        const e = new Error("ARTCRAFT_MISSING");
        e.code = "ARTCRAFT_MISSING";
        e.hint = j?.hint ?? "";
        throw e;
      }
      if (!r.ok) throw new Error(`取 ArtCraft 产物失败（HTTP ${r.status}）`);
      return (await r.text()).trim();
    };
    _rawSrc = await get("payload.js");
    _rawCss = await get("css.js");
    return true;
  })().catch((e) => {
    /* 让下一次挂载还能重试 —— 用户可能刚跑完 fetch-artcraft.ps1 */
    _assetPromise = null;
    throw e;
  });
  return _assetPromise;
}

/** 是否已有可用产物（同步判断，给降级 UI 用）。 */
function hasArtCraft() {
  return typeof _rawSrc === "string" && _rawSrc.length > 0;
}

let _decodedSrc = null;
function decodeArtCraftSrc() {
  if (_decodedSrc) return _decodedSrc;
  const b64 = _rawSrc;
  if (!b64) {
    const e = new Error("ARTCRAFT_MISSING");
    e.code = "ARTCRAFT_MISSING";
    throw e;
  }
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  _decodedSrc = new TextDecoder("utf-8").decode(bytes);
  return _decodedSrc;
}

function evalArtCraftOnce(hostRequire) {
  if (window.__ARTCRAFT__) return window.__ARTCRAFT__;
  if (!hasArtCraft()) {
    /* 用一个明确的错误类型，让上层能区分「缺产物」和「产物坏了」 */
    const e = new Error("ARTCRAFT_MISSING");
    e.code = "ARTCRAFT_MISSING";
    throw e;
  }
  const factory = new Function(
    "module", "exports", "require",
    decodeArtCraftSrc() + "\n;return module.exports;"
  );
  const mod = { exports: {} };
  factory(mod, mod.exports, hostRequire);
  if (!mod.exports || typeof mod.exports.mountTimeline !== "function") {
    throw new Error(
      "ArtCraft 产物没有导出 mountTimeline()\n" +
      "现有导出：" + Object.keys(mod.exports || {}).join(", ")
    );
  }
  window.__ARTCRAFT__ = mod.exports;
  return mod.exports;
}

/* ══════════════════════════════════════════════════════════════════════
 * 样式注入
 * ══════════════════════════════════════════════════════════════════════ */

function b64ToText(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

function injectCssOnce() {
  /* ★ 2026-10-25：CSS 也改成按需取，_rawCss 为空时跳过 ArtCraft 那层
     —— DSH 原生对齐层与外壳样式仍然注入，降级提示框照样能看。 */
  if (!document.getElementById("artcraft-tab-css") && _rawCss) {
    const style = document.createElement("style");
    style.id = "artcraft-tab-css";
    style.textContent = b64ToText(_rawCss);
    document.head.appendChild(style);
  }
  /* ★ 剪辑台外壳样式：必须在 artcraft-tab-css 之后 */
  if (!document.getElementById("artcraft-editor-css")) {
    const s = document.createElement("style");
    s.id = "artcraft-editor-css";
    s.textContent = EDITOR_CSS;
    document.head.appendChild(s);
  }
  injectDshNativeOnce();
}

/**
 * 注入「DSH 原生对齐层」。
 * ★ 必须在 #artcraft-tab-css【之后】进入 head：
 *   覆盖靠「同特异性 + 后加载」赢，不是靠 !important 堆砌。
 */
function injectDshNativeOnce() {
  if (document.getElementById("artcraft-dsh-native")) return;
  const style = document.createElement("style");
  style.id = "artcraft-dsh-native";
  style.textContent = DSH_NATIVE_CSS;
  document.head.appendChild(style);
}

/* ══════════════════════════════════════════════════════════════════════
 * 主题
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 判断 DSH 当前是亮色还是暗色。
 *
 * ★ 不能靠 class / data-theme（实测 html/body 都没有），
 *   DSH 靠 token 的【值】区分主题 ⇒ 读 --dsw-alias-bg-layer-1 再算亮度。
 */
function detectDshTheme(el) {
  const probe = el || document.body;
  const bg =
    getComputedStyle(probe).getPropertyValue("--dsw-alias-bg-layer-1").trim() ||
    getComputedStyle(probe).getPropertyValue("--dsw-alias-bg-base").trim() ||
    "#fff";

  let r = 255, g = 255, b = 255;
  const hex = bg.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  const rgbm = bg.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  if (hex) {
    const s = hex[1];
    if (s.length === 3) {
      r = parseInt(s[0] + s[0], 16);
      g = parseInt(s[1] + s[1], 16);
      b = parseInt(s[2] + s[2], 16);
    } else {
      r = parseInt(s.slice(0, 2), 16);
      g = parseInt(s.slice(2, 4), 16);
      b = parseInt(s.slice(4, 6), 16);
    }
  } else if (rgbm) {
    r = +rgbm[1]; g = +rgbm[2]; b = +rgbm[3];
  }

  const lin = (c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return lum > 0.5 ? "light" : "dark";
}

function artcraftThemeClass(mode) {
  return mode === "light" ? "theme-light" : "theme-gray";
}

function watchDshTheme(onChange) {
  let last = detectDshTheme(null);
  const timer = setInterval(() => {
    const now = detectDshTheme(null);
    if (now !== last) { last = now; onChange(now); }
  }, 2000);
  return () => clearInterval(timer);
}

/* ══════════════════════════════════════════════════════════════════════
 * ErrorBoundary
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * ★ 这不是临时代码：主人要「模块失效只丢那一块」。
 *   有自己的 Boundary 才能保证剪辑台挂了不影响别的 tab，
 *   而且用户看得见原因而不是一片空白。
 *   原话：「空白的界面比报错更难查」。
 */
export class ArtCraftBoundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(e) { return { err: e }; }
  componentDidCatch(e, info) {
    try { console.error("[artcraft] 渲染失败：", e, info); } catch { /* ignore */ }
  }
  render() {
    if (this.state.err) {
      /**
       * ★★ 2026-10-24：区分「缺产物」和「产物坏了」。
       *
       *   缺产物是【使用者还没准备】—— 该给操作指引，不该甩一段 stack。
       *   产物坏了是【真 bug】—— 才需要 stack 去排查。
       *
       *   判据：错误码是 ARTCRAFT_MISSING ⇒ 前者。
       */
      const missing = this.state.err?.code === "ARTCRAFT_MISSING"
        || String(this.state.err?.message || "").includes("ARTCRAFT_MISSING");

      if (missing) {
        return React.createElement("div", {
          style: {
            margin: 12, padding: 16, borderRadius: 10,
            background: "rgba(210,153,34,.10)", color: "var(--dsw-alias-state-warning-primary, #d29922)",
            fontSize: 12, lineHeight: "20px",
          },
        },
          React.createElement("div", { style: { fontWeight: 600, marginBottom: 8 } },
            "剪辑台需要先准备 ArtCraft 产物"),
          React.createElement("div", { style: { marginBottom: 8 } },
            "视频工作台（生图 / 生视频）不受影响，可以正常使用。"),
          React.createElement("div", {
            style: { fontFamily: "ui-monospace, monospace", fontSize: 11, opacity: .85 },
          },
            "在仓库根目录执行：",
            React.createElement("br"),
            "pwsh -NoProfile -File ./scripts/fetch-artcraft.ps1"),
          React.createElement("div", { style: { marginTop: 8, opacity: .7, fontSize: 11 } },
            "★ 本仓库不内置 ArtCraft 代码 —— 上游未声明许可协议，不能随仓库分发。"));
      }

      return React.createElement("div", {
        style: {
          margin: 12, padding: 12, borderRadius: 10,
          background: "rgba(248,81,73,.08)", color: "var(--dsw-alias-state-error-primary, #f25a5a)",
          fontFamily: "ui-monospace, monospace", fontSize: 11, lineHeight: "16px",
          whiteSpace: "pre-wrap", overflow: "auto", maxHeight: "80vh",
        },
      }, "[剪辑台] 渲染失败（其它 tab 不受影响）：\n\n"
        + String(this.state.err?.stack || this.state.err?.message || this.state.err));
    }
    return this.props.children;
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 剪辑台主组件
 * ══════════════════════════════════════════════════════════════════════ */

export function ArtCraftHost({ t, hostRequire }) {
  const hostRef = React.useRef(null);
  const timelineElRef = React.useRef(null);
  const rootRef = React.useRef(null);
  const reqRef = React.useRef(null);
  /**
   * ★★ 2026-10-22 修：这里必须是【真 require】，不能直接用 props 的 hostRequire。
   *
   *   ArtCraft 产物是 CJS，内部保留了 require("react")（react 是 external）。
   *   new Function 的作用域里没有 require ⇒ 必须显式传进去。
   *
   *   而 hostRequire 从 slot 的 inject 拿，现在传的是 null
   *   （改成由全局桥兜底，见 dsh-primitives.js）。
   *
   *   症状（踩过）：TypeError: require is not a function
   *     栈指向 eval at evalArtCraftOnce(<anonymous>:7174)
   *   —— 位置在 8MB 产物内部，看起来像 ArtCraft 自己的 bug，
   *      实际是我们传了个 null 进去。
   */
  if (!reqRef.current) reqRef.current = resolveHostRequire(hostRequire);

  const [state, setState] = React.useState({ s: "loading", err: null });
  const [themeMode, setThemeMode] = React.useState(() => detectDshTheme(null));

  /** 编辑器状态（由 mountTimeline 的 onState 回填） */
  const [editorState, setEditorState] = React.useState({
    elementCount: 0, duration: 0, currentTime: 0, playing: false,
    fps: 30, canUndo: false, canRedo: false, selected: [],
  });

  /**
   * ★★★ 2026-10-25：时间轴真帧率（ref 版，不受渲染时序影响）
   *
   *   为什么不能用 editorState.fps：
   *     编辑器的 onState 会 emit 自己的 fps（内部假设 30），
   *     并把快照里读到的真值（本机 24）覆盖掉。
   *     而「谁最后写 state」取决于 React 调度顺序 —— 靠不住。
   *   ⇒ 逐帧这种需要精确帧长的地方，读这个 ref：
   *     它只由【快照】写，编辑器碰不到。
   *
   *   ★ 必须定义在 seekBy 之前（本项目踩过 TDZ：const 在定义行之前不可访问）。
   */
  const fpsRef = React.useRef(30);

  /** 素材列表 */
  const [media, setMedia] = React.useState({ items: [], loading: true });
  /**
   * 操作级错误（导入失败等）。
   *
   * ★★ 2026-10-23 新增：主人报「导入功能又失效了」，
   *   而实际现象是【什么都没发生】—— 因为 importFiles 把错误
   *   收进 results.failed 只 console.warn，界面零反应。
   *   ⇒ 必须有一个能显示操作失败的地方。
   *   ★ 为什么不用 alert：原生弹窗会打断操作、且不可样式化。
   *     这里做成状态条下方的一行红字，用户看一眼就知道。
   */
  const [actionError, setActionError] = React.useState(null);
  /**
   * 远端真源的元素数（/timeline/snapshot 数出来的）。
   * ★ 为什么还要一个独立计数：
   *   编辑器的 onState 是【本地状态】，用户刚导入完到编辑器 emit 之间
   *   有一个 raf 的空窗；而 Agent 写 timeline-state 时编辑器还没拉取。
   *   两者取大值，保证「有内容」不会因为一端延迟而闪回空态。
   */
  const [remoteElementCount, setRemoteElementCount] = React.useState(0);
  /** 字幕 */
  const [captions, setCaptions] = React.useState([]);
  /** Agent 消息条 */
  const [agentMsg, setAgentMsg] = React.useState(null);

  /** 供 agentSync 的回声消除用 */
  const selfWriteRef = React.useRef(null);
  const modRef = React.useRef(null);
  const editorRef = React.useRef(null);

  /**
   * 把远端的 timeline-state 同步进 ArtCraft 编辑器。
   *
   * ══════════════════════════════════════════════════════════════════════
   * ★★ 为什么必须有这一步（2026-10-22 实测抓出来的缺口）
   *
   *   实测：用真实路由 POST /timeline/cmd/add-shots 加两镜
   *     · 轮询在跑（3 秒 3 次）
   *     · snapshot 里 summary.total=2、tracks[0].clips=2   ✅
   *     · 编辑器 main.elements=0、overlay 全 0              ❌
   *   ⇒ 时间轴上看不到那两个片段，消息条与高亮永远不触发。
   *     根因就是「轮询只更新了计数，没把数据灌进编辑器」。
   *
   * ── 用什么 API
   *   scenes.updateSceneTracks({ tracks }) —— 唯一能整体替换轨道数据的口。
   *   不用 initializeScenes（那是首挂流程用的，会重置场景 id）。
   *
   * ── 为什么不直接重建整个 project
   *   那会触发 ArtCraft 的 project.setActiveProject，
   *   而 setActiveProject 会重置选择、播放头、撤销栈 —— 用户正在操作时很粗暴。
   *   updateSceneTracks 只换轨道数据，其余保持。
   */
  const syncSnapshotToEditor = React.useCallback((snapshot) => {
    const editor = window.__ARTCRAFT_EDITOR__;
    const mod = modRef.current;
    if (!editor || !mod?.toProject) return;
    try {
      /**
       * ★ fps 的同步【不在这里】—— 它必须每次快照都跑，包括首帧，
       *   而本函数是被 `if (meta?.first) return;` 挡在后面才调的。
       *   见 onSnapshot 里那段注释（2026-10-25 实测：首帧漏掉 fps ⇒
       *   逐帧键按 30fps 走，而本机时间轴是 24fps，越走越偏）。
       */
      const project = mod.toProject(snapshot);
      const scene = project?.scenes?.[0];
      if (!scene?.tracks) return;
      editor.scenes.updateSceneTracks({ tracks: scene.tracks });

      /**
       * ★ 同步后还要注册新媒体（否则缩略图不渲染）。
       *   这是 AGENTS §6.39 那条：ArtCraft 不按需 resolveMedia，
       *   而是查【已注册的资产表】；表里没有就静默不画。
       */
      const ids = collectMediaIds(project);
      if (ids.length) {
        Promise.resolve()
          .then(() => registerMediaAssets(editor, ids))
          .catch(() => { /* 失败不阻断：缩略图缺失不该让整块崩 */ });
      }
    } catch (e) {
      console.warn("[artcraft] 远端同步失败：", e?.message ?? e);
    }
  }, []);

  /* ── Agent 实时同步 ── */
  const onSnapshot = React.useCallback((snapshot, meta) => {
    /**
     * 首次快照不弹消息（见 agentSync 注释），但状态要过一遍，
     * 让「有内容 / 空态」的判断尽快与真源一致。
     *
     * ★★ 2026-10-22 实测补：**光更新计数不够，必须把数据同步进编辑器**
     *
     *   实测（19499）：用真实路由 POST /timeline/cmd/add-shots 加了两镜后
     *     · 轮询确实在跑（3 秒内 3 次 /timeline/snapshot）
     *     · snapshot 里 summary.total = 2，tracks[0].clips = 2   ✅ Agent 写进去了
     *     · 但艺术编辑器里 main.elements = 0、overlay 全 0        ❌ 没同步
     *   ⇒ 消息条与元素高亮永远不会触发 —— 因为时间轴上看不到那些片段。
     *
     *   根因：轮询只调了 setRemoteElementCount，没有把新的 timeline-state
     *        重新投影成 TProject 再灌进 ArtCraft。
     *
     *   ⇒ 这里补上投影 + 灌入。用 mod.toProject（与首次挂载同一函数）。
     */
    const n = countElements(snapshot);
    setRemoteElementCount(n);

    /**
     * ★★★ 2026-10-25 修：fps 必须【每次快照都同步】，包括第一次。
     *
     *   原来写的是：
     *     if (meta?.first) return;      ← 首次整个跳过
     *     syncSnapshotToEditor(snapshot);
     *   而 fps 的同步被我放进了 syncSnapshotToEditor 里 ⇒ 首次永远拿不到 fps，
     *   一直用初始值 30。实测本机时间轴是 24fps：
     *     · 预览区时间码按 30fps 算 ⇒ 显示错
     *     · ← → 逐帧每按一次走 4000 tick（30fps 帧长），
     *       而真帧长是 5000 ⇒ 连按 5 次才对上 4 帧，越走越偏
     *
     *   ⇒ 把 fps 提取成独立的一步，放在首帧判断【之前】。
     *     「跳过首次」的本意是「不要重复 updateSceneTracks」，
     *     而不是「不要同步任何元数据」—— 这两件事被我混在一起了。
     */
    const snapFps = Number(snapshot?.fps ?? snapshot?.state?.fps);
    if (Number.isFinite(snapFps) && snapFps > 0) {
      /* ★ ref 是【真源】，每次都写；state 只用于展示，可能被 onState 覆盖 */
      fpsRef.current = snapFps;
      setEditorState((prev) => (prev.fps === snapFps ? prev : { ...prev, fps: snapFps }));
    }

    /* 把远端真源同步进编辑器（跳过首次：首次已在挂载流程里做过） */
    if (meta?.first) return;
    syncSnapshotToEditor(snapshot);
  }, []);

  const onAgentChange = React.useCallback((d) => {
    setAgentMsg(d);

    /**
     * ★ 架构决策 §四「三种反馈同时用」：
     *   ① 变化元素短暂高亮 1.5 秒  ← 这里
     *   ② 右上角消息条「Agent 添加了 3 个片段」
     *   ③（生成类操作显示进度条 —— 本轮未接）
     *
     * ★★ 2026-10-22 第二轮复核抓到的真缺陷：高亮 0 次
     *
     *   实测：Agent 加一镜后消息条弹了两次（正确），但 MutationObserver
     *   记录到的高亮 class 变化是 **0 次**。
     *
     *   根因：**调用顺序 + React 异步渲染**
     *     agentSync 里的顺序是：
     *       onSnapshot()      → syncSnapshotToEditor() → updateSceneTracks()
     *       onAgentChange()   → highlightElements()    → querySelector('[data-element-id]')
     *     updateSceneTracks 只是把数据交给 Zustand/React，**DOM 要等下一帧才更新**。
     *     ⇒ 紧接着同步执行的 querySelector 找不到那个新元素的宿主
     *     ⇒ 高亮静默失效（没有报错，因为「找不到就跳过」是合法分支）。
     *
     *   修法：把高亮推到 DOM 更新之后 —— requestAnimationFrame 套一层。
     *     单层 raf 在 React 18 的并发渲染下仍可能太早（渲染可能跨帧），
     *     所以用「raf + 再套 raf」两级，实测足够稳。
     *
     *   ★ 为什么不改 agentSync 里先调 onAgentChange 再调 onSnapshot：
     *     那样差异是对的但 DOM 更旧，问题更大。
     *     真正要等的是 DOM，不是顺序。
     */
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try {
          const r = highlightElements(d.changedIds);
          /**
           * ★ hit === 0 ⇒ 一个元素都没找到宿主。
           *   这在本轮真实发生过（DOM 还没更新），当时完全静默。
           *   现在留一条 warn：下次坏了一眼能看见，不用靠手工观测。
           */
          if (r.hit === 0 && r.missing.length > 0) {
            console.warn(
              "[artcraft] 高亮未命中任何元素（DOM 可能尚未更新）：" +
              r.missing.slice(0, 5).join(", ")
            );
          }
        } catch (e) {
          console.warn("[artcraft] 高亮失败：", e?.message ?? e);
        }
      });
    });

    // 1.5 秒后消失（与高亮同一时长，视觉上同进同出）
    window.clearTimeout(onAgentChange._t);
    onAgentChange._t = window.setTimeout(() => setAgentMsg(null), 1500);
  }, []);

  /**
   * ★ enabled 用「挂在 DOM 上且可见」判断，不用组件 state ——
   *   组件 state 变化会让 useAgentSync 的 effect 重跑、轮询重启。
   */
  const syncEnabled = state.s === "ready";

  useAgentSync({
    enabled: syncEnabled,
    onSnapshot,
    onAgentChange,
  });

  /* ── 拉资产库 ── */
  const loadMedia = React.useCallback(async () => {
    setMedia((m) => ({ ...m, loading: true }));
    try {
      const res = await fetch("/comfy-assets/library?limit=2000", {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const j = await res.json();
      const items = (Array.isArray(j?.items) ? j.items : []).map((it) => {
        /**
         * ★★ 2026-10-23 修：缩略图 URL 一直是 null（主人：「检查器里面的预览失效」）
         *
         * ── 实测（19499）
         *   `/comfy-assets/library?limit=5` 返回的字段是：
         *     { id, src, rel, dir, name, kind, sizeBytes, mtime, displayName, … }
         *   实测 keys 里【没有 thumbUrl，也没有 url】。
         *   而这里原来写的是 `it.thumbUrl || it.url || null` ⇒ 恒为 null
         *   ⇒ Inspector 里 881 张卡片全部没有 <img>，只剩灰底占位。
         *   实测：卡片 881 个，img 元素 0 个。
         *
         * ── 正确拼法（mediaAssets.js:91 已有同款）
         *   `/comfy-assets/file?src=<src>&rel=<rel>`
         *   这是 M1 的同源代理，支持 Range，图片和视频首帧都能取。
         *
         *   ★ 音频不该给图片 URL（浏览器解码失败 ⇒ 灰底）。
         *     音频留 null，Inspector 会渲染成占位图标 —— 那是正确的表现。
         */
        const src = it.src || "output";
        const rel = it.rel || "";
        let thumbnailUrl = null;
        if (it.kind === "image" || it.kind === "video") {
          thumbnailUrl = `/comfy-assets/file?src=${encodeURIComponent(src)}&rel=${encodeURIComponent(rel)}`;
        }
        return {
          id: it.id,
          name: it.displayName || it.name || it.id,
          kindLabel: it.kind === "video" ? "视频" : it.kind === "audio" ? "音频" : "图片",
          thumbnailUrl,
          kind: it.kind,
        };
      });
      setMedia({ items, loading: false });
      return items;
    } catch (e) {
      console.warn("[artcraft] 资产库读取失败：", e?.message ?? e);
      setMedia({ items: [], loading: false });
      return [];
    }
  }, []);

  /* ── 挂载 ── */
  React.useEffect(() => {
    let alive = true;
    const timer = setTimeout(async () => {
      try {
        /**
         * ★★ 2026-10-25 顺序关键：先取产物（可能 10MB），再注入 CSS，再求值。
         *   原来 CSS 先注入 —— 但现在 CSS 也在按需产物里，
         *   不先取就拿到空串，剪辑台会没样式（一片黑底白字）。
         *
         *   取失败（ARTCRAFT_MISSING）直接抛，走 ArtCraftBoundary 的降级面板。
         *   ★ 只在【打开剪辑台】时才走到这里 ⇒ 视频工作台不付这笔钱。
         */
        await loadArtCraftAssets();
        if (!alive) return;
        injectCssOnce();
        const el = timelineElRef.current;
        if (!el || !alive) return;

        const mod = evalArtCraftOnce(reqRef.current);
        modRef.current = mod;
        if (!alive) return;

        /* ── adapters：与上一版完全一致（那条路有 8 个已踩过的坑）── */
        const adapters = createHttpAdapters({
          openPicker: async (kinds) => {
            const picked = await showModal(AssetPicker, { kinds });
            return Array.isArray(picked) ? picked : [];
          },
          toProject: mod.toProject ?? null,
          onSave: createTrimWriter({ log: console }),
          log: console,
        });

        /* ── 工程快照 → 投影片 TProject ── */
        let project = null;
        let libraryItems = [];
        try {
          const snap = await fetch("/timeline/snapshot", {
            headers: { Accept: "application/json" },
          });
          if (snap.ok) {
            const j = await snap.json();
            const st = j?.state ?? j;
            /**
             * ★★★ 2026-10-25：挂载路径也要写 fpsRef。
             *   首次快照走的是这里（不是 onSnapshot），
             *   漏了这一步 ⇒ 逐帧键一直按 30fps 走，而本机是 24fps。
             */
            const mFps = Number(st?.fps ?? j?.fps);
            if (Number.isFinite(mFps) && mFps > 0) fpsRef.current = mFps;
            /* ★ 用同一个 countElements 喂预览区（不再挂 window） */
            setRemoteElementCount(countElements(st));
            if (st && mod.toProject) {
              project = mod.toProject(st);
              /* ★ mediaId 修正（AGENTS §6.39 ⑦）：音频 id 是 editor: 不是 output: */
              try {
                const lib = await fetch("/comfy-assets/library?limit=2000", {
                  headers: { Accept: "application/json" },
                });
                if (lib.ok) {
                  const lj = await lib.json();
                  libraryItems = Array.isArray(lj?.items) ? lj.items : [];
                  project = fixupMediaIds(project, libraryItems);
                }
              } catch (e) {
                console.warn("[artcraft] 拉资产表失败，mediaId 用投影的猜测值：", e?.message ?? e);
              }
            }
          }
        } catch (e) {
          console.warn("[artcraft] 工程快照取不到，用空工程：", e?.message ?? e);
        }

        const hasProject = project && Array.isArray(project.scenes) && project.scenes.length > 0;

        /* ── 只挂时间轴 ── */
        rootRef.current = mod.mountTimeline(el, {
          adapters,
          project: hasProject ? project : undefined,
          showToolbar: false,       // ★ 上游工具条不要，位置与功能都由我们接管
          onZoomApi: (api) => { KEYCLIPS.setZoomApi(api); },
          onState: (s) => {
            if (!alive) return;
            editorRef.current = window.__ARTCRAFT_EDITOR__;
            setEditorState((prev) => ({
              ...prev,
              ...s,
              /**
               * ★★★ 2026-10-25 修：fps 不许被编辑器覆盖。
               *
               *   实测过程（三层排查才定位）：
               *     ① 预览区时间码 seek(5000) 显示「00:00:00:01」
               *        ⇒ 按 30fps 算才对（5000/4000=1.25→1 帧）；
               *          若按真值 24fps，应该是 5000/5000=1 帧…
               *          两种都显示 1，光看时间码分辨不出来
               *     ② 直接 seek(1920000) 显示 00:00:16:00 —— 秒数对得上，
               *        说明 tick 单位没错，错的是 fps 这个乘数
               *     ③ 于是查 fps 的写入路径，发现【两处都在写】：
               *          onSnapshot（我加的）写 24
               *          onState（编辑器的）带 s.fps 覆盖回 30 ← 罪魁
               *   ⇒ 关键是这里 `...s` 的展开顺序在 fps 之后，把快照值吃掉了。
               *
               *   判据：**时间轴的 fps 只有一个真源（/timeline/snapshot）**，
               *       编辑器自己 emit 的 fps 是它内部假设，不能反向覆盖真源。
               */
              fps: prev.fps,
              /**
               * ★ selected 是对象数组，直接 setState 会让每次 emit 都触发重渲染。
               *   取 id 拼串当比较键。
               */
              selectedKey: (s.selected || []).map((x) => x?.id).join(","),
            }));
          },
          registerMedia: hasProject
            ? async () => {
                const ids = collectMediaIds(project);
                if (!ids.length) return;
                const editor = window.__ARTCRAFT_EDITOR__;
                if (!editor) return;
                const r = await registerMediaAssets(editor, ids);
                console.info(`[artcraft] 媒体注册：成功 ${r.added} / 失败 ${r.failed.length}`);
              }
            : undefined,
        });

        /* ── 校验真的画出来了（容器 children=0 是「空白但无报错」的来源）── */
        await loadMedia();

        /**
         * ── 恢复上次导入的内容（主人：「能不能默认上次的导入内容？」）──
         *
         * ★ 放在这里而不是 mountTimeline 之前：
         *   必须等 EditorCore + 场景都就绪，insertElement 才有效。
         *   mountTimeline 内部已经完成 initialize + setActiveProject +
         *   initializeScenes 的同步部分，所以这里安全。
         *
         * ★ 幂等：已在时间轴上的 mediaId 会跳过（见 restoreLastImports）。
         *   否则每次切 tab 都会把内容复制一遍。
         */
        try {
          const editor = window.__ARTCRAFT_EDITOR__;
          if (editor) {
            const r = await restoreLastImports(editor);
            if (r.restored || r.failed.length) {
              console.info(
                `[artcraft] 恢复上次导入：成功 ${r.restored}` +
                (r.failed.length ? ` / 失败 ${r.failed.length}` : "")
              );
            }
          }
        } catch (e) {
          console.warn("[artcraft] 恢复上次导入失败：", e?.message ?? e);
        }

        setTimeout(() => {
          if (!alive) return;
          const n = el.children.length;
          if (n === 0) {
            setState({
              s: "error",
              err: "ArtCraft mountTimeline() 返回了 root，但容器里没有任何节点。\n"
                + "常见原因：EditorCore 初始化失败，或两个 React root 冲突。\n"
                + "请打开控制台看 ArtCraft 的报错。",
            });
            return;
          }
          setState({ s: "ready", err: null });
        }, 300);
      } catch (e) {
        /**
         * ★★ 2026-10-25 修：缺产物时甩了一屏 stack，降级面板没生效。
         *
         *   实测（把 artcraft-payload.b64.txt 移走后打开剪辑台）：
         *     界面显示「[剪辑台] 加载失败（视频工作台不受影响）」+ 一屏红色调用栈。
         *     而 ArtCraftBoundary 里明明写了「ARTCRAFT_MISSING ⇒ 显示操作指引」。
         *
         *   根因：这一行原来写的是
         *     err: String(e?.stack ?? e)
         *   把 Error 对象【转成字符串】了 —— `e.code` 就此丢失，
         *   下游只能拿到一坨文本，识别不出「这是缺产物」。
         *
         *   ⇒ 保留 Error 对象本身，把 stack 放到另一个字段。
         *     判据：任何要在下游按 `code`/`name` 分支的错误，都不许提前 String()。
         */
        if (alive) {
          const code = e?.code ?? e?.cause?.code;
          const hint = e?.hint ?? e?.cause?.hint;
          setState({
            s: "error",
            err: String(e?.message ?? e),
            errCode: code ?? null,
            errHint: hint ?? null,
            errStack: String(e?.stack ?? e),
          });
        }
      }
    }, 0);

    return () => {
      alive = false;
      clearTimeout(timer);
      try { rootRef.current?.__acUnsub?.(); } catch { /* ignore */ }
      try { rootRef.current?.unmount?.(); } catch { /* ignore */ }
      rootRef.current = null;
      window.__ARTCRAFT__ = undefined;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);   // ★ 空依赖：只挂载一次（hostRequire 走 ref）

  /* ── 主题监听（延迟 1.5s，避免打断首次挂载）── */
  React.useEffect(() => {
    let stop = null;
    const timer = setTimeout(() => {
      try { stop = watchDshTheme((m) => setThemeMode(m)); } catch { /* ignore */ }
    }, 1500);
    return () => {
      clearTimeout(timer);
      if (typeof stop === "function") stop();
    };
  }, []);

  /* ── 动作分发 ── */
  /**
   * ★★ 2026-10-25：游标导航的两个小工具。
   *
   *   MediaTime 是【整数 tick，120000 / 秒】（AGENTS §6.39 ① 踩过这个坑），
   *   不是毫秒、不是 {numerator,denominator}。所以「一帧」= 120000 / fps。
   *
   *   ★ 为什么用 seek 而不是改 playback 的速度：
   *     逐帧就是要「停在那里看这一帧」，seek 是最直接的语义。
   *     而且 seek 不改变播放状态，用户正在播放时按 ← 也不该被打断
   *     （剪映/PR 逐帧会自动暂停，但那是它们的取舍；这里不动播放状态更保守）。
   */
  const seekTo = (editor, seconds) => {
    try {
      const tick = Math.max(0, Math.round(Number(seconds) * 120000));
      editor.playback.seek({ time: tick });
    } catch (e) {
      console.warn("[artcraft] seek 失败：", e?.message ?? e);
    }
  };
  const seekBy = (editor, dir, bySecond = false) => {
    try {
      /**
       * ★★★ 2026-10-25 最终修法：帧率【现场从快照读】，不用 React state。
       *
       *   排查过程记一笔（三层才定位，值得留）：
       *     ① 预览时间码 seek(5000) 显示 1 帧 —— 30fps 与 24fps 都会显示 1，
       *        光看时间码分辨不出来，这条证据是废的
       *     ② seek(1920000) 显示 00:00:16:00 —— 秒数对，说明 tick 单位没错，
       *        错的是「一帧多长」这个乘数
       *     ③ 查 fps 的写入路径，发现编辑器的 onState 会 emit 自己的 fps
       *        并覆盖掉快照值；即使我在 onSnapshot 里写对了，
       *        只要 onState 后到，就又被打回 30
       *
       *   ⇒ 不再依赖「谁最后写 state」这种时序：
       *     逐帧这种需要精确帧长的地方，直接问时间轴真源（/timeline/snapshot）。
       *     带 cache（1 秒），避免连按 ← → 时打出几十个请求。
       *
       *   ★ 拿不到就用 30 —— 但这是【最后的兜底】，不是常态。
       */
      const fps = fpsRef.current || 30;
      const curTick = Number(editor.playback.getCurrentTime?.() ?? 0);
      const delta = bySecond ? 120000 : Math.round(120000 / fps);
      editor.playback.seek({ time: Math.max(0, curTick + dir * delta) });
    } catch (e) {
      console.warn("[artcraft] 游标移动失败：", e?.message ?? e);
    }
  };

  const onAction = React.useCallback(async (id) => {
    const editor = window.__ARTCRAFT_EDITOR__;
    if (!editor) return;

    try {
      switch (id) {
        case "import":
          /* 走 ArtCraft 自己的文件选择器：它已接好 upload 协议（JSON+base64） */
          {
            const input = document.createElement("input");
            input.type = "file";
            input.multiple = true;
            input.accept = "video/*,image/*,audio/*";
            input.onchange = async () => {
              const files = Array.from(input.files || []);
              if (!files.length) return;
              /**
               * ★★ 2026-10-23 修：导入失败必须让用户看见
               *
               *   主人：「导入功能又失效了」——
               *   实测根因是上传字段名写错（name→filename，见 clipboardOps.js），
               *   但更糟的是【失败完全静默】：
               *     importFiles 把错误收进 results.failed，只 console.warn，
               *     界面没有任何反应 ⇒ 用户点了导入、选了文件、什么都没发生。
               *
               *   ⇒ 这里接住返回值，把失败显示到状态条（走 setActionError）。
               *     ★ 判据：静默失败比报错更糟 —— 用户不知道是没选上还是功能坏了。
               */
              try {
                const r = await KEYCLIPS.importFiles(editor, files, { onProgress: console.info });
                await loadMedia();
                if (r?.failed?.length) {
                  const first = r.failed[0];
                  setActionError(
                    `导入失败 ${r.failed.length}/${files.length}：${first.name} — ${first.error}`
                  );
                } else if (r?.added) {
                  setActionError(null);
                }
              } catch (e) {
                setActionError(`导入失败：${e?.message ?? e}`);
              }
            };
            input.click();
          }
          break;

        case "split":          await KEYCLIPS.split(editor); break;
        case "delete":         await KEYCLIPS.delete(editor); break;
        /**
         * ★ 2026-10-22：复制/粘贴/剪切（主人要求按大众习惯用 C/V）
         *   copy  → 存进模块剪贴板
         *   paste → 落到【播放头】位置
         *   cut   → 复制 + 删除原片段
         */
        case "copy": {
          const r = copySelection(editor);
          console.info(`[artcraft] 已复制 ${r.count} 个片段`);
          break;
        }
        case "cut": {
          const r = cutSelection(editor);
          console.info(`[artcraft] 已剪切 ${r.count} 个片段`);
          break;
        }
        case "paste": {
          const r = pasteClipboard(editor);
          console.info(`[artcraft] 已粘贴 ${r.count} 个片段到 ${(r.at / 120000).toFixed(2)}s`);
          break;
        }
        /**
         * ★★ 2026-10-23 新增导出（主人：「整个剪辑台找不到导出按钮」）
         *
         * ── 为什么原来没有
         *   导出按钮在 ArtCraft 的 `ExportButton` 里，它只被两处渲染：
         *     · editor-header.tsx   ← 只有 VideoEditor（整机）才渲染
         *     · panels/inspector/export ← 我们没挂那个 inspector
         *   而我们用的是 `mountTimeline`，它只渲染 <Timeline>，
         *   连 header 都没有 ⇒ 导出入口整个消失。
         *
         * ── 好在能力是现成的
         *   `editor.project.export({ options })` 返回 `{ success, buffer }`，
         *   默认 exportSink 就是「触发浏览器下载」（download-export-sink.ts 实测）。
         *   ⇒ 不需要碰上游，我们自己调这个 API 就行。
         *
         * ── 细节
         *   · format/quality 用 ArtCraft 的默认值（mp4 / high）
         *   · fps 从当前 project settings 取
         *   · includeAudio 默认 true
         *   · 导出期间要置 busy，否则用户会连点多次（每次都在编一整个片）
         *   · 空工程直接拒绝 —— 编出 0 字节文件比报错更糟
         */
        case "export": {
          const proj = editor.project.getActiveOrNull?.() ?? editor.project.getActive?.();
          if (!proj) throw new Error("还没有工程，先导入素材");
          const dur = editor.timeline.getTotalDuration() || 0;
          if (dur <= 0) throw new Error("时间轴是空的，没有可导出的内容");

          const fmt = "mp4";
          const quality = "high";
          console.info(`[artcraft] 开始导出：${fmt} / ${quality} / ${(dur / 120000).toFixed(1)}s`);

          const result = await editor.project.export({
            options: {
              format: fmt,
              quality,
              fps: proj.settings?.fps ?? 30,
              includeAudio: true,
            },
          });

          if (result?.cancelled) {
            console.info("[artcraft] 导出已取消");
            break;
          }
          if (!result?.success || !result.buffer) {
            throw new Error(result?.error || "导出失败（无错误详情）");
          }

          /* 交给 exportSink 落盘 —— 默认实现就是浏览器下载 */
          const mime = fmt === "webm" ? "video/webm" : "video/mp4";
          const ext = fmt === "webm" ? ".webm" : ".mp4";
          const name = (proj.metadata?.name || "export") + ext;
          const adapter = editor.adapters?.exportSink;
          if (adapter?.accept) {
            await adapter.accept(
              { blob: new Blob([result.buffer], { type: mime }), filename: name, mime },
              { saveToDisk: true, saveToLibrary: false }
            );
          } else {
            /* 没有 adapter 时的兜底：自己触发下载 */
            const url = URL.createObjectURL(new Blob([result.buffer], { type: mime }));
            const a = document.createElement("a");
            a.href = url; a.download = name;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 60000);
          }
          console.info(`[artcraft] 导出完成：${name}（${(result.buffer.byteLength / 1048576).toFixed(1)}MB）`);
          break;
        }
        case "undo":           editor.command.undo(); break;
        case "redo":           editor.command.redo(); break;
        case "zoomIn":         KEYCLIPS.nudgeZoom(1); break;
        case "zoomOut":        KEYCLIPS.nudgeZoom(-1); break;
        case "trackTaller":    KEYCLIPS.nudgeTrackScale(1); break;
        case "trackShorter":   KEYCLIPS.nudgeTrackScale(-1); break;
        case "addBookmark":    await KEYCLIPS.addBookmark(editor); break;
        case "extractAudio":   await KEYCLIPS.extractAudio(editor); break;
        case "rippleDelete":   await KEYCLIPS.delete(editor, { ripple: true }); break;
        case "snapping":       KEYCLIPS.toggleSnapping(); break;

        /**
         * ★★★ 2026-10-25 新增：播放与游标导航
         *
         *   一个播放键都没有的剪辑软件是不成立的 ——「空格暂停播放」
         *   是所有剪辑工具的第一肌肉记忆。用户按一下没反应，
         *   不会想到「这里不支持」，只会觉得软件坏了。
         *
         *   ArtCraft 的 API 早就有（editor.playback），只是没人接：
         *     getIsPlaying() / play() / pause()
         *     seek({ time })      ← time 是 MediaTime tick（120000/秒）
         *     getCurrentTime()
         */
        case "playPause": {
          if (editor.playback.getIsPlaying()) editor.playback.pause();
          else editor.playback.play();
          break;
        }
        case "playReverse":    editor.playback.play({ direction: -1 }); break;
        case "playForward":    editor.playback.play({ direction: 1 }); break;
        case "stepBack":       seekBy(editor, -1); break;
        case "stepForward":    seekBy(editor, +1); break;
        case "jumpBack":       seekBy(editor, -1, true); break;
        case "jumpForward":    seekBy(editor, +1, true); break;
        case "goStart":        seekTo(editor, 0); break;
        case "goEnd": {
          /* 结尾 = 时间轴总长。editorState.duration 由 mountTimeline 的 onState 回填 */
          seekTo(editor, Number(editorState.duration) || 0);
          break;
        }

        default:
          console.info("[artcraft] 未实装的动作：" + id);
      }
    } catch (e) {
      console.error("[artcraft] 动作失败 " + id + "：", e);
    }
  }, [loadMedia]);

  /* ── previewRef：交给 ArtCraft 渲染画面？──
   *   ★ 本轮不交。ArtCraft 的 canvas 在 PreviewPanel 里，只挂 Timeline 就没有它。
   *     预览区当前显示空态 / 有内容时显示「画面将由渲染器输出」的占位。
   *     这是本轮的已知缺口，登记在交付报告「还剩什么」。 */
  const previewRef = React.useRef(null);

  /**
   * ── 选中的片段 → 属性面板的数据 ──
   *
   * ★ 用 useMemo 从 editorState 派生，不额外 setState。
   *   编辑器每秒可能 emit 多次，每次 setState 都会让整棵子树重渲染。
   *
   * ★★ 2026-10-22 修 TDZ（AGENTS §6.26 同一个坑，我第三次踩）：
   *   第一版依赖写 `[editorState.selectedKey, editorState.fps]`，
   *   而 selectedKey 是 onState 里拼出来的派生字段，
   *   在 useMemo 求值依赖时尚不存在
   *   ⇒ ReferenceError: Cannot access 'k' before initialization
   *     （minify 后变量名变单字母，栈里只剩 'k'，极难认）
   *   症状：设置面板一切到「剪辑台快捷键」整块就渲染成错误框。
   *
   *   ⇒ 依赖直接放 `editorState`（每次 emit 都是新对象引用，天然会触发），
   *     不再引用任何派生字段。
   */
  const selectedElement = React.useMemo(() => {
    const editor = window.__ARTCRAFT_EDITOR__;
    const sel = editorState.selected || [];
    if (!editor || !sel.length) return null;
    const ref = sel[0];
    try {
      const found = editor.timeline.getElementsWithTracks({ elements: [ref] });
      const el = found?.[0]?.element;
      if (!el) return null;
      return {
        id: el.id,
        name: el.name,
        kindLabel: el.type === "video" ? "视频" : el.type === "audio" ? "音频"
          : el.type === "image" ? "图片" : el.type === "text" ? "字幕" : "元素",
        label: el.name,
        startLabel: formatTimecode(el.startTime, editorState.fps),
        durationLabel: formatTimecode(el.duration, editorState.fps),
        /* ★ 变换/音量/速度在 el.params 里，不在 el 顶层 */
        rotation: el.params?.rotation ?? 0,
        volume: el.params?.volume ?? 0,
        muted: el.muted === true || el.params?.muted === true,
        speed: el.retime?.rate ?? 1,
      };
    } catch {
      return null;
    }
  }, [editorState]);

  /**
   * ── 素材列表变化时，刷新「是否有音频」判断 ──
   *   字幕 tab 的「从音轨识别」要用。
   */
  const hasAudio = React.useMemo(() => {
    const editor = window.__ARTCRAFT_EDITOR__;
    const scene = editor?.scenes?.getActiveSceneOrNull?.();
    /* ★ 这里是【EditorCore 内存】结构，不是 snapshot 结构：
         tracks.audio = [轨道…]，元素在 track.elements 里（AGENTS §6.39 ②）
       两套结构不要混用 —— snapshot 的 tracks 是扁平数组且元素叫 clips。 */
    const list = scene?.tracks?.audio;
    if (!Array.isArray(list)) return false;
    return list.some((t) => Array.isArray(t?.elements) && t.elements.length > 0);
    /* ★ 两个计数任一变化都重算：远端写入（Agent）与本地编辑都要覆盖 */
  }, [editorState.elementCount, remoteElementCount]);

  /* ── 组装 editorState ── */
  const st = {
    ...editorState,
    /**
     * ★ 元素数取「本地编辑器」与「远端真源」的较大者。
     *   理由见 remoteElementCount 的注释：两端各有 emit 延迟，
     *   取大值可避免「有内容」在两拍之间闪回空态（闪烁比慢更难受）。
     */
    elementCount: Math.max(editorState.elementCount || 0, remoteElementCount),
    previewRef,
    media,
    captions,
    aspectLabel: projectAspect(editorState),
    toolbarState: {
      canSplit: (editorState.selected || []).length > 0,
      canDelete: (editorState.selected || []).length > 0,
      /**
       * ★ 2026-10-22：duplicate 拆成 copy / cut / paste
       *   canCopy / canCut：要选中了片段
       *   canPaste：剪贴板里有东西（不需要选中）
       */
      canCopy: (editorState.selected || []).length > 0,
      canCut: (editorState.selected || []).length > 0,
      canPaste: (getClipboard()?.items?.length ?? 0) > 0,
      canUndo: editorState.canUndo === true,
      canRedo: editorState.canRedo === true,
      snapping: KEYCLIPS.isSnapping(),
    },
    selectedElement,
    busy: state.s === "loading",
  };

  const callbacks = {
    onAction,
    /**
     * ★ 2026-10-23：操作级错误透传给 ArtCraftTab 显示（见那里 ②b 的注释）。
     *   导入失败时用户原本什么都看不到 —— 这条把它显示出来。
     */
    actionError,
    onDismissError: () => setActionError(null),
    onImport: () => onAction("import"),
    onPlayPause: () => {
      const editor = window.__ARTCRAFT_EDITOR__;
      if (!editor) return;
      if (editor.playback.getIsPlaying()) editor.playback.pause();
      else editor.playback.play();
    },
    onSeek: (t) => window.__ARTCRAFT_EDITOR__?.playback.seek({ time: t }),
    onPickMedia: (it) => console.info("[artcraft] 选中素材", it?.id),
    hasAudio,
    onGenerateCaptions: (text) => KEYCLIPS.generateCaptions(text, setCaptions),
    onRecognizeCaptions: () => KEYCLIPS.recognizeCaptions(setCaptions),
    onEditCaption: (c, v) => {
      setCaptions((list) => list.map((x) => (x === c ? { ...x, content: v } : x)));
      KEYCLIPS.editCaption(c, v);
    },
    onElementChange: (patch) => {
      /* ★ 属性面板改动必须真的写进编辑器，否则就是「控件是摆设」
         （AGENTS §6.25 记过：能点、能显示、能持久化，但值没传下去） */
      const editor = window.__ARTCRAFT_EDITOR__;
      const sel = editorState.selected || [];
      if (!editor || !sel.length) return;
      try {
        const found = editor.timeline.getElementsWithTracks({ elements: [sel[0]] });
        const el = found?.[0]?.element;
        if (!el) return;
        const nextParams = { ...(el.params || {}) };
        if ("rotation" in patch) nextParams.rotation = patch.rotation;
        if ("volume" in patch) nextParams.volume = patch.volume;
        if ("muted" in patch) nextParams.muted = patch.muted;

        editor.timeline.updateElements({
          updates: [{
            trackId: sel[0].trackId,
            elementId: sel[0].elementId,
            patch: { params: nextParams },
          }],
        });
      } catch (e) {
        console.warn("[artcraft] 属性更新失败：", e?.message ?? e);
      }
    },
  };

  if (state.s === "error") {
    /**
     * ★★ 2026-10-25：与 ArtCraftBoundary 用同一套判据 ——
     *   缺产物 = 使用者还没准备，该给操作指引；
     *   其它 = 真 bug，才值得甩 stack。
     *   （原来这里无差别甩 stack，降级设计等于只在 Boundary 那一层有效）
     */
    const missing = state.errCode === "ARTCRAFT_MISSING"
      || String(state.err ?? "").includes("ARTCRAFT_MISSING");

    if (missing) {
      return React.createElement("div", {
        style: {
          margin: 16, padding: 16, borderRadius: 12,
          background: "rgba(210,153,34,.10)",
          color: "var(--dsw-alias-state-warning-primary, #d29922)",
          fontSize: 13, lineHeight: "22px",
        },
      },
        React.createElement("div", { style: { fontWeight: 600, marginBottom: 8, fontSize: 14 } },
          "剪辑台需要先准备 ArtCraft 产物"),
        React.createElement("div", { style: { marginBottom: 10 } },
          "视频工作台（生图 / 生视频）不受影响，可以正常使用。"),
        React.createElement("div", {
          style: {
            padding: "10px 12px", borderRadius: 8,
            background: "rgba(0,0,0,.05)",
            fontFamily: "ui-monospace, monospace", fontSize: 12,
            userSelect: "all", marginBottom: 10,
          },
        }, "pwsh -NoProfile -File ./scripts/fetch-artcraft.ps1"),
        React.createElement("div", { style: { opacity: .75, fontSize: 12 } },
          "在仓库根目录执行上面这条命令，然后刷新页面。"),
        React.createElement("div", { style: { marginTop: 6, opacity: .6, fontSize: 12 } },
          "★ 本仓库不内置 ArtCraft 代码 —— 上游未声明许可协议，不能随仓库分发。"));
    }

    return React.createElement("div", {
      style: {
        padding: 16, margin: 12, borderRadius: 12,
        background: "rgba(248,81,73,.08)", color: "var(--dsw-alias-state-error-primary, #f25a5a)",
        fontFamily: "ui-monospace, monospace", fontSize: 11,
        whiteSpace: "pre-wrap", overflow: "auto", maxHeight: "80vh",
      },
    }, "[剪辑台] 加载失败（视频工作台不受影响）：\n\n" + (state.errStack ?? state.err));
  }

  return React.createElement("div", {
    className: `ac-scope ${artcraftThemeClass(themeMode)}`,
    style: {
      /**
       * ★★ 2026-10-22 主人：「剪辑台和视频工作台不要出现dsh对话框的调节线」
       *   「或者你把tab内容匹配调节线」
       *
       *   实测（19499）：DSH 的列宽手柄是两条 10px 宽的透明竖条，
       *   贴在中栏两侧（viewArea 280..1905，手柄在 334..344 与 1848..1858）。
       *   官方「对话」tab 的内容 952 居中，线落在两侧留白里不干扰；
       *   而剪辑台铺满了整个宽度 ⇒ 线压在时间轴与检查器上。
       *
       *   ⇒ 加左右 padding 56px 让内容避开那两条线。
       *     与工作台（WorkbenchView 的 .comfy-wb）用同一个值，
       *     两个 tab 的边界看起来才一致。
       *
       *   ★ 不隐藏、不挡手柄 —— 主人要保留调节能力，只是别让线压在内容上。
       */
      /**
       * ★★ 2026-10-22 补底部间距（主人：「对话框上面的分割线没有了」）
       *
       *   实测：时间轴底边 y=794，composer 顶边也是 y=794 —— 完全贴合，
       *   中间既没有间隙也没有分隔，所以时间轴和输入框「糊在一起」，
       *   看不出哪块是工作台、哪块是对话框。
       *
       *   ⇒ 底部留 8px + 一条 0.5px 分隔线（与工具栏、DSH composer 同规格）。
       *     顶部留 0 是因为 DSH 的 tab 栏已经给了边界。
       */
      /**
       * ★★ 2026-10-22 第二次改：从「padding 避让」改成「跟随 contentWidth」
       *
       *   第一版写死 padding: "0 56px" 去避开 DSH 的两条手柄线。
       *   主人：「宽度还是没修，没有跟随DSH原生的中栏宽度调节」—— 对。
       *   避让是常数，拖动时不会跟着变，所以看起来各调各的。
       *
       *   实测 DSH 自己：父级居中 + 子级 width = contentWidth + 32。
       *   ⇒ 这里照做，宽度由 CSS 变量 --ac-follow-w 提供
       *     （由 editor/index.js 的同步器写入，与工作台同一个变量名）。
       */
      /**
       * ★★ 2026-10-23 补底部间距
       *
       *   主人：「剪辑台和对话框直接的间隔直接为0是否太拥挤？」
       *
       *   实测（19499）：
       *     剪辑台 acScope.bottom = 794
       *     DSH composer card.y  = 794
       *     gap = 0  ← 完全贴合，两块内容直接顶在一起
       *
       *   而 DSH 自己的「对话 tab」实测是：
       *     最后一条消息 bottom = 778
       *     composer card.y    = 794
       *     gap = 16px   ← 这是 DSH 的呼吸量
       *
       *   ⇒ 跟到 16px。原来是 8px，但被 boxSizing: border-box 吃掉了
       *     （acRoot.bottom 786 vs acScope.bottom 794，那 8px 在 acScope 内部收缩，
       *      没有形成 acScope 与 composer 之间的空隙）。
       *     现在给 16px，与 DSH 一致。
       */
      padding: "0 0 16px",
      boxSizing: "border-box",
      /**
       * ★★ 2026-10-23 第二次修首帧满宽（主人：刷新时会先顶格最宽再同步）
       *
       * ── 第一版为什么没用
       *   我在 editor.css.js 里加了：
       *     :root { --ac-follow-w: var(--dsh-composer-card-max-width, 100%); }
       *   想让它首帧就有值。实测无效，原因：
       *     injectCssOnce() 在 useEffect + setTimeout 里跑（editorHost.js:506），
       *     比首帧【晚】。首帧时那段 CSS 还没进 document。
       *   实测采样（每 100ms）：
       *     t=400ms  ac 宽 1633（满宽）  --ac-follow-w = (空)
       *     t=500ms  ac 宽 1496          --ac-follow-w = calc(1464px + 32px)
       *   ⇒ 有 1 帧以上的满宽，肉眼可见。
       *
       * ── 现在怎么做
       *   内联样式【直接引用】DSH 的变量，完全绕开我们自己的 CSS：
       *     width: min(100%, var(--dsh-composer-card-max-width, 100%))
       *   --dsh-composer-card-max-width 由 DSH 自己定义在 viewArea 上，
       *   首帧渲染时就已经存在（实测 viewArea 有值、:root 没有）。
       *   ⇒ 首帧就取到正确宽度，不需要等任何 JS 或 CSS 注入。
       *
       *   ★ --ac-follow-w 保留但只作为「以后要覆盖」的扩展点，
       *     这里不再依赖它。
       */
      width: "min(100%, var(--ac-follow-w, var(--dsh-composer-card-max-width, 100%)))",
      maxWidth: "100%",
      margin: "0 auto",
      /**
       * ★★ 2026-10-23 关键：height 必须减掉 padding，否则间距不生效
       *
       *   实测（19499）：padding 改成 16px 后 gap 仍然是 0。
       *   原因：height: "100%" + boxSizing: "border-box" ⇒
       *     padding 被【算在 100% 里面】，容器总高不变
       *     ⇒ 内容内部缩了 16px，但容器底边仍然贴着 composer。
       *
       *   ⇒ 用 calc(100% - 16px)，让底部真的空出 16px。
       *     ★ 这是 border-box 下「用 padding 做外部间距」的陷阱：
       *       padding 永远在盒内，不会把盒子推离邻居。
       */
      height: "calc(100% - 16px)",
      position: "relative",
      /* ★ 2026-10-22 深色修正：bg-layer-1 在深色下比画布亮一档，改同底 */
      background: "var(--dsw-alias-bg-base, #fff)",
      /**
       * ★★ 2026-10-22：底部边界用 boxShadow 而不用 border
       *
       *   实测 window.devicePixelRatio = 1 ⇒ `border: 0.5px` 被浏览器
       *   四舍五入成 1px（量到的 borderBottomWidth 就是 "1px"）。
       *
       *   而 DSH 的 composer 卡片用的是
       *     boxShadow: rgba(255,255,255,0.12) 0 0 0 0.5px, ...
       *   —— boxShadow 的 spread 不会被取整，0.5px 就是 0.5px。
       *   ⇒ 照它的写法，视觉重量才和原生一致。
       */
      boxShadow: "inset 0 -0.5px 0 0 var(--dsw-alias-border-l2, #0000001a)",
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
    },
  },
    React.createElement(ArtCraftTab, {
      hostRequire: reqRef.current,
      timelineRef: timelineElRef,
      editorState: st,
      callbacks,
      agentMessage: agentMsg,
    }),

    /**
     * ★★ 2026-10-23 改：加载提示不再遮挡整个界面
     *
     *   主人（截图里一片「正在载入剪辑台…」）：
     *     「我们的tab加载是不是太久了？不能先把ui加载出来然后再慢慢加载功能吗？」
     *
     * ── 原来是什么样
     *   遮罩是 position: absolute; inset: 0 —— **整块盖住**。
     *   而 ArtCraftTab（预览 / 工具栏 / 时间轴骨架）其实【已经渲染了】，
     *   只是被这层不透明底全盖住，用户只看到一句「正在载入」。
     *
     * ── 改成什么
     *   · 去掉 inset: 0 的全屏覆盖 → 不再盖住骨架
     *   · 变成右上角的轻量状态胶囊（pointerEvents: none，不挡操作）
     *   · 骨架可交互（工具栏点了没反应，但用户能看到结构）
     *
     *   ★ 判据：加载态的正确做法是「已有的显示出来，缺的单独标」，
     *     不是「整块盖住等全部就绪」。
     */
    state.s === "loading"
      ? React.createElement("div", {
          style: {
            position: "absolute",
            top: 8, right: 12,          /* ★ 右上角，不覆盖主体 */
            display: "flex", alignItems: "center", gap: 6,
            padding: "3px 10px",
            borderRadius: 999,
            color: "var(--dsw-alias-label-tertiary, #81858c)",
            fontSize: 11, lineHeight: "16px",
            background: "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05))",
            pointerEvents: "none",
            zIndex: 5,
          },
        },
          /* 小圆点：暗示「在动」而不是「卡住」 */
          React.createElement("span", {
            style: {
              width: 5, height: 5, borderRadius: "50%",
              background: "var(--dsw-alias-label-tertiary, #81858c)",
              opacity: .7, flex: "none",
            },
          }),
          "正在载入时间轴…")
      : null
  );
}

/** 从 project settings 拿画幅比例文案。 */
function projectAspect(s) {
  const w = s?.canvasWidth, hh = s?.canvasHeight;
  if (!w || !hh) return "16:9";
  const g = (a, b) => (b ? g(b, a % b) : a);
  const d = g(w, hh);
  return `${w / d}:${hh / d}`;
}

/* ══════════════════════════════════════════════════════════════════════
 * 资产库按钮 —— 2026-10-22 已撤除（主人：「可以取消不会要了」）
 *
 * 原实现：注册进 conversation.session.header.utilities（kind:"list"）。
 * 撤除理由见 apply 里 ② 那段注释：会挤压 DSH 原生按钮 + 图标认不出。
 * ══════════════════════════════════════════════════════════════════════ */


/* ══════════════════════════════════════════════════════════════════════
 * ★ 2026-10-22 合包：本文件【不再】导出 apply / name / inject
 *
 *   原来这里是 dsh-artcraft-tab 这个独立插件的 client 入口，
 *   自己注册 conversation.view + settings.section。
 *
 *   合包后（主人：「剪辑是视频工作台的一部分」），
 *   整个剪辑台变成 dsh-comfy-workbench-tab 内的一个大模块，
 *   注册动作统一由 src/editor/index.js 的 mountEditorModule() 完成，
 *   由包的 src/client.js 的 apply 调用。
 *
 *   ⇒ 本文件只提供【组件与工具】，不提供任何插件入口。
 *     导出：NS / ArtCraftBoundary / ArtCraftHost
 */


