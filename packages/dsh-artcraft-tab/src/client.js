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
import ARTCRAFT_SRC from "./_artcraft-payload.js";
import ARTCRAFT_CSS from "./_artcraft-css.js";
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

const NS = "artcraft-tab";
const VIEW_ID = "artcraft";

export const name = "dsh-artcraft-tab";

/** 依赖的客户端能力。写【服务名】，不是包名（AGENTS §3.1）。 */
export const inject = ["slots", "locale"];

/* ══════════════════════════════════════════════════════════════════════
 * ArtCraft 产物求值
 * ══════════════════════════════════════════════════════════════════════ */

let _decodedSrc = null;
function decodeArtCraftSrc() {
  if (_decodedSrc) return _decodedSrc;
  const bin = atob(ARTCRAFT_SRC);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  _decodedSrc = new TextDecoder("utf-8").decode(bytes);
  return _decodedSrc;
}

function evalArtCraftOnce(hostRequire) {
  if (window.__ARTCRAFT__) return window.__ARTCRAFT__;
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
  if (!document.getElementById("artcraft-tab-css")) {
    const style = document.createElement("style");
    style.id = "artcraft-tab-css";
    style.textContent = b64ToText(ARTCRAFT_CSS);
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
class ArtCraftBoundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(e) { return { err: e }; }
  componentDidCatch(e, info) {
    try { console.error("[artcraft] 渲染失败：", e, info); } catch { /* ignore */ }
  }
  render() {
    if (this.state.err) {
      return React.createElement("div", {
        style: {
          margin: 12, padding: 12, borderRadius: 10,
          background: "rgba(248,81,73,.08)", color: "rgb(207,34,46)",
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

function ArtCraftHost({ t, hostRequire }) {
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

  /** 素材列表 */
  const [media, setMedia] = React.useState({ items: [], loading: true });
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
      const items = (Array.isArray(j?.items) ? j.items : []).map((it) => ({
        id: it.id,
        name: it.displayName || it.name || it.id,
        kindLabel: it.kind === "video" ? "视频" : it.kind === "audio" ? "音频" : "图片",
        thumbnailUrl: it.thumbUrl || it.url || null,
      }));
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
        if (alive) setState({ s: "error", err: String(e?.stack ?? e) });
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
              await KEYCLIPS.importFiles(editor, files, { onProgress: console.info });
              await loadMedia();
            };
            input.click();
          }
          break;

        case "split":          await KEYCLIPS.split(editor); break;
        case "delete":         await KEYCLIPS.delete(editor); break;
        case "duplicate":      await KEYCLIPS.duplicate(editor); break;
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
      canDuplicate: (editorState.selected || []).length > 0,
      canUndo: editorState.canUndo === true,
      canRedo: editorState.canRedo === true,
      snapping: KEYCLIPS.isSnapping(),
    },
    selectedElement,
    busy: state.s === "loading",
  };

  const callbacks = {
    onAction,
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
    return React.createElement("div", {
      style: {
        padding: 16, margin: 12, borderRadius: 12,
        background: "rgba(248,81,73,.08)", color: "rgb(207,34,46)",
        fontFamily: "ui-monospace, monospace", fontSize: 11,
        whiteSpace: "pre-wrap", overflow: "auto", maxHeight: "80vh",
      },
    }, "[剪辑台] 加载失败（视频工作台不受影响）：\n" + state.err);
  }

  return React.createElement("div", {
    className: `ac-scope ${artcraftThemeClass(themeMode)}`,
    style: {
      width: "100%", height: "100%",
      position: "relative",
      background: "var(--dsw-alias-bg-layer-1, #fff)",
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

    /* 加载遮罩：必须是【兄弟】不是子节点 */
    state.s === "loading"
      ? React.createElement("div", {
          style: {
            position: "absolute", inset: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "var(--dsw-alias-label-tertiary, #81858c)",
            fontSize: 12, pointerEvents: "none",
            background: "var(--dsw-alias-bg-layer-1, #fff)",
          },
        }, "正在载入剪辑台…")
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
 * apply
 * ══════════════════════════════════════════════════════════════════════ */

export function apply(ctx) {
  /**
   * ★ 整个 apply 包 try/catch —— 否则 Slot API 的任何异常
   *   都会击穿 DSH 的 client loader，导致整个前端白屏（AGENTS §3.1）。
   */
  try {
    const t = ctx.locale.bind(NS);

    ctx.effect(
      () => ctx.locale.register(NS, {
        zh: {
          "view.label": "剪辑台",
          "settings.shortcuts": "剪辑台快捷键",
        },
        en: {
          "view.label": "Editor",
          "settings.shortcuts": "Editor shortcuts",
        },
      }),
      "artcraft-tab: dictionaries"
    );

    /**
     * ★★ 2026-10-22：屏蔽 DSH 中栏列宽手柄 + 恢复默认宽度
     *
     *   主人报「视频工作台出现了之前修过的bug，可以调节dsh原生的对话框宽度」
     *   ＋「把宽度恢复默认」。
     *
     *   实测（19499）：剪辑台与视频工作台**两个 tab 都能拖**那条 10px 手柄
     *   （`.Dc7zOa_widthHandle`，x≈597 / 1585，y=76~914）。
     *   这不是某一个 tab 的缺陷，是两个都继承了 DSH 的原生行为。
     *
     *   ⇒ 用「只在那 10px 上打开 pointer-events 的固定覆盖层」挡住，
     *     事件根本到不了手柄；DSH 自己的布局代码一行不动。
     *     细节见 dshHandleGuard.js 文件头。
     */
    ctx.effect(() => {
      let dispose = null;
      try {
        dispose = installHandleGuard(".ac-root");
      } catch (e) {
        console.warn("[artcraft] 列宽手柄屏蔽安装失败（不影响其它功能）：", e?.message ?? e);
      }
      return () => { try { dispose?.(); } catch { /* ignore */ } };
    }, "artcraft-tab: dsh width handle guard");

    /* 「恢复默认宽度」：删掉 DSH 的内容宽度偏好（无值 = 走默认公式） */
    try {
      const rd = resetDshWidths();
      if (rd.cleared) {
        console.info(`[artcraft] DSH 内容宽度已恢复默认（原值 ${rd.previous ?? "(未知)"}）`);
      }
    } catch (e) {
      console.warn("[artcraft] 恢复默认宽度失败：", e?.message ?? e);
    }

    /* ── ① 剪辑台本体 ── */
    ctx.slots.inject("conversation.view", () =>
      ctx.slots.register(
        {
          name: "conversation.view",
          id: VIEW_ID,
          order: 30,               // 排在视频工作台(20)之后
          locale: NS,
          label: () => t("view.label"),
          children: {},
          inject: (sessionId) => ({
            sessionId, t,
            hostRequire: null   // ★ 由 resolveHostRequire() 兜底取（见 dsh-primitives.js）,
          }),
        },
        function ArtCraftTabView(props) {
          return React.createElement(ArtCraftBoundary, null,
            React.createElement(ArtCraftHost, props));
        }
      )
    );

    /**
     * ── ② 资产库按钮 —— 2026-10-22 已撤除 ──
     *
     * 主人原话：「右上角你做的资产库位置不对，把原生dsh的ui挤压到左边去了，
     *           而且图片是一个文件夹，不放上去不知道这个是资产库，
     *           可以取消不会要了」
     *
     * 两条都是真的：
     *   ① 挤压：header.utilities 是 `kind:"list"` 的横向容器，
     *      往里加一项会把「用 文件资源管理器 打开」那个 group 往左推。
     *      实测加入后 utilities 容器宽度 87 → 115，原生按钮整体左移 28px。
     *      —— 这正是主人 2026-10-18 就说过不能做的事
     *         （AGENTS：设备监控不放 header.utilities，理由一模一样）。
     *   ② 认不出：只有一个 folder 图标 + tooltip，不悬停不知道是资产库。
     *
     * ⇒ 整块撤掉。素材入口改为「剪辑台里点检查器按钮 → 素材 tab」，
     *   那是用户本来就会去的地方，不需要额外的全局按钮。
     *
     * ★ 保留注释而不是删干净：下次有人想加回来，先看这两条代价。
     */

    /* ── ③ 快捷键设置（settings.section） ── */
    ctx.slots.inject("settings.section", () =>
      ctx.slots.register(
        {
          name: "settings.section",
          id: "artcraft-shortcuts",
          order: 60,              // 排在 models(10) / general 之后
          label: () => t("settings.shortcuts"),
          inject: () => ({
            hostRequire: null   // ★ 由 resolveHostRequire() 兜底取（见 dsh-primitives.js）,
          }),
        },
        function ArtCraftShortcutSection(props) {
          /**
           * ★ 复用 DSH 设置面板外壳 —— 我们只填内容。
           *   这是主人 2026-10-21 纠正的第四点（纠正-DSH原生一体 §五 ②）。
           *   ShortcutSettings 的第一版是自己画模态，这一版改成嵌在 section 里。
           */
          return React.createElement(ArtCraftBoundary, null,
            React.createElement(ShortcutSettings, {
              hostRequire: props.hostRequire,
              embedded: true,
            }));
        }
      )
    );
  } catch (e) {
    try { console.error("[artcraft] apply 失败：", e); } catch { /* ignore */ }
  }
}


