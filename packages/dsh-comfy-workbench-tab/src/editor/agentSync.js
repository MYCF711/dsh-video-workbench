/**
 * agentSync.js · Agent 操作实时可见（2026-10-22）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 主人要求：「AGENT的操作需要直接在ui实时反馈出来，让用户知道AGETN操作了什么东西」
 *
 * ── 为什么用轮询而不是 SSE / WebSocket（docs/架构决策 §四 的结论）
 *   A. 轮询 /timeline/snapshot   1~2 秒延迟 / 低复杂度 / 高可靠（无状态）
 *   B. SSE                       实时 / 中 / 中（断线要重连）
 *   C. WebSocket                 实时 / 高 / 低（要心跳）
 *   选 A：dsh-editor 已有 /timeline/snapshot；返回 JSON 几 KB；
 *         断了自动恢复；不用动 dsh-editor 一行代码。
 *
 * ── 四条必须做对的事（架构决策 §四「但要做得对」）
 *   ① 用 version / savedAt 判变化，没变不重渲染（否则每秒全量重渲染会卡）
 *   ② 变化要【呈现出来】，不能只静默更新
 *   ③ 三种反馈同时用：元素高亮 1.5s / 消息条 / 生成类显示进度
 *   ④ 区分「自己改的」与「Agent 改的」（自己改的不弹提示，否则每拖一下都弹）
 *
 * ══════════════════════════════════════════════════════════════════════
 * ★★ 2026-10-22 设计要点：怎么做「区分自己改的和 Agent 改的」
 *
 *   没有可靠的「谁写的」标记 —— timeline-state 里没有 author 字段，
 *   加一个要改 dsh-editor 的写入路径（跨项目、跨模块），
 *   而且 Agent 走的是 host-store 的 addShot，我们改不到。
 *
 *   ⇒ 用【回声消除】：自己写入时记一个 pending 指纹，
 *     下一次轮询若快照与自己的写入一致，就吞掉这条差异。
 *     指纹 = 元素 id 集合 + 每个 id 的 (startTime, duration) 的组合哈希。
 *     自己改完 → 快照回来 → 指纹匹配 → 不提示。
 *     Agent 改 → 指纹不匹配 → 提示。
 *
 *   ★ 局限（如实记录）：如果 Agent 的改动与我自己的写入碰巧产生完全相同的
 *     指纹，那次 Agent 改动不会提示。实际概率极低（Agent 改的是内容与数量），
 *     且只影响「是否弹消息」，不影响数据正确性。
 *
 * ★★ 第二个设计要点：轮询要能停
 *   剪辑台不可见时（切到别的 tab）必须停轮询，否则后台每秒一次请求。
 *   用 document.visibilityState + 组件卸载两个信号。
 */

import React from "react";

const SNAPSHOT_URL = "/timeline/snapshot";
const POLL_MS = 1000;

/* ══════════════════════════════════════════════════════════════════════
 * 字段读取：两套结构（同 eachElement 的问题）
 *
 *   dsh-editor 的 clip：{ id, kind, name, src, in, out, speed, trim, rendered, status }
 *     · 时间：in / out（秒）
 *     · 有没有画面：src !== "（待生成）" 或 rendered.filename
 *     · 没有 startTime / duration / mediaId
 *   ArtCraft 的 element：{ id, type, name, startTime, duration, mediaId, … }
 *
 *   ⚠ 我第一版指纹/差异全按 ArtCraft 字段读，
 *     对着 dsh-editor 的 clip 就全是 undefined
 *     ⇒ 指纹只剩 id、describeDiff 永远算不出「改了什么」
 *     ⇒ 消息条要么内容错、要么根本不弹。这是今天同一个错误的第三次。
 *
 *   ⇒ 统一用下面三个取值器。
 */
const elStart = (el) => num(el.startTime ?? el.in);
const elDuration = (el) => {
  /* ArtCraft 用 duration；dsh-editor 用 out - in */
  if (el.duration != null) return num(el.duration);
  const i = num(el.in), o = num(el.out);
  return o > i ? o - i : 0;
};
const elMedia = (el) =>
  String(el.mediaId ?? el.rendered?.filename ?? el.rendered?.path ?? el.src ?? "");
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

/**
 * 从 /timeline/snapshot 的 state 算出「结构指纹」。
 *
 * ══════════════════════════════════════════════════════════════════════
 * ★★ 2026-10-22 实测：这里有 **两套完全不同的结构**，不能混用
 *
 *   ┌─ ArtCraft 的 EditorCore（内存）──────────────────────────────┐
 *   │ tracks = { overlay: [轨道…], main: 轨道(单个), audio: [轨道…] } │
 *   │ 每个轨道件 = { id, name, type, elements: [元素…], muted, hidden } │
 *   └───────────────────────────────────────────────────────────────┘
 *   ┌─ dsh-editor 的 timeline-state（/timeline/snapshot 的 state）──┐
 *   │ tracks = [ { id, kind:"video"|"audio"|"text", name, clips:[…] } ] │
 *   │                          ↑ 扁平数组        ↑ 元素叫 clips 不叫 elements │
 *   └───────────────────────────────────────────────────────────────┘
 *
 *   ⚠ 我第一版按 ArtCraft 结构读 snapshot（`state.tracks.main.elements`），
 *     而 snapshot 给的是 dsh-editor 结构
 *     ⇒ `state.tracks.main` 是 undefined ⇒ 元素数永远 0
 *     ⇒ 预览区空态判断与 Agent 变化检测全部失效，且【不报错】。
 *
 *     实测证据（19499，GET /timeline/snapshot）：
 *       state.tracks 类型 Object[] Count 2
 *       tracks[0] = { id:"t_mvii3s20_5", kind:"video", name:"视频 1", clips:[] }
 *       summary.total = 0
 *
 *   ⇒ 本文件的 eachElement 同时兼容两种结构：
 *     先试 dsh-editor 的扁平数组（clips），再试 ArtCraft 的嵌套（elements）。
 *     这样 Agent 侧用 snapshot、本地侧用 EditorCore，同一个函数都吃得下。
 */

/**
 * 遍历所有元素，两种结构都兼容。
 *
 * @param {object} state  ArtCraft TProject 或 dsh-editor timeline-state
 * @param {(el:object, track:object)=>void} fn
 */
function eachElement(state, fn) {
  const tracks = state?.tracks;
  if (!tracks) return;

  const emit = (tr) => {
    if (!tr) return;
    /* dsh-editor 结构：元素在 clips */
    if (Array.isArray(tr.clips)) {
      for (const el of tr.clips) if (el) fn(el, tr);
      return;
    }
    /* ArtCraft 结构：元素在 elements */
    if (Array.isArray(tr.elements)) {
      for (const el of tr.elements) if (el) fn(el, tr);
    }
  };

  /* ① dsh-editor：tracks 是扁平数组 */
  if (Array.isArray(tracks)) {
    for (const tr of tracks) emit(tr);
    return;
  }

  /* ② ArtCraft：overlay / audio 是轨道数组，main 是单个轨道 */
  if (Array.isArray(tracks.overlay)) for (const tr of tracks.overlay) emit(tr);
  if (tracks.main) emit(tracks.main);
  if (Array.isArray(tracks.audio)) for (const tr of tracks.audio) emit(tr);
}

export function fingerprint(state) {
  if (!state) return "";
  const parts = [];
  eachElement(state, (el) => {
    parts.push(
      String(el.id ?? "") + ":" +
      String(elStart(el)) + ":" +
      String(elDuration(el)) + ":" +
      elMedia(el)
    );
  });
  parts.sort();
  return parts.join("|");
}

/** 元素 id 集合（用于高亮「哪些是新的 / 变了的」）。 */
export function idSet(state) {
  const out = new Set();
  eachElement(state, (el) => { if (el.id) out.add(String(el.id)); });
  return out;
}

/** 元素总数 —— 预览区判「有没有内容」用它。 */
export function countElements(state) {
  let n = 0;
  eachElement(state, () => { n += 1; });
  return n;
}

/** 逐元素的详情，用于生成人类可读的提示文案。 */
function elementMap(state) {
  const m = new Map();
  eachElement(state, (el, tr) => {
    if (el.id) m.set(String(el.id), { ...el, trackName: tr?.name });
  });
  return m;
}

/**
 * 描述两次快照之间的差异，生成消息条文案。
 *
 * ★ 文案必须说「操作了什么」，不能只说「有更新」。
 *   主人原话：「让用户知道 AGETN操作了什么东西」
 */
export function describeDiff(prev, next) {
  const a = elementMap(prev);
  const b = elementMap(next);
  const added = [];
  const removed = [];
  const moved = [];

  for (const [id, el] of b) {
    if (!a.has(id)) { added.push(el); continue; }
    const pa = a.get(id);
    /* ★ 用取值器，别直接读字段名 —— 两套结构的字段名不一样（见文件头） */
    if (elStart(pa) !== elStart(el) || elDuration(pa) !== elDuration(el)) moved.push(el);
  }
  for (const id of a.keys()) if (!b.has(id)) removed.push(a.get(id));

  /**
   * ★ 还有一个必须计入的变化：**同一片段「从待生成变成已生成」**。
   *
   *   实测（19499）：Agent 加一镜 → 它是「待生成」状态（src="（待生成）"）
   *     ⇒ 投影层有意跳过它（不进时间轴）
   *     ⇒ 用户点生成、产物落盘后，它才出现在时间轴上。
   *   这中间的差异是 media（elMedia）变了，不是时间变了、也不是新增。
   *   ⇒ 不算 Media 变化的话，这种最需要提示的场景反而静默。
   */
  const rendered = [];
  for (const [id, el] of b) {
    const pa = a.get(id);
    if (!pa) continue;
    if (elMedia(pa) !== elMedia(el)) rendered.push(el);
  }

  const parts = [];
  if (added.length) parts.push(`添加了 ${added.length} 个片段`);
  if (removed.length) parts.push(`删除了 ${removed.length} 个片段`);
  if (moved.length) parts.push(`调整了 ${moved.length} 个片段的时间`);
  if (rendered.length) parts.push(`更新了 ${rendered.length} 个片段的画面`);

  /* 名称尽量带上，让用户认得出是哪一个 */
  const sample = added[0] || rendered[0] || moved[0] || removed[0];
  const name = sample?.label || sample?.name || sample?.shotTitle || "";
  const total = added.length + moved.length + removed.length + rendered.length;
  const detail = name ? `（${name}${total > 1 ? " 等" : ""}）` : "";

  return {
    text: parts.length ? `Agent ${parts.join("，")}${detail}` : "Agent 更新时间轴",
    changedIds: [
      ...added.map((e) => String(e.id)),
      ...moved.map((e) => String(e.id)),
      ...removed.map((e) => String(e.id)),
      ...rendered.map((e) => String(e.id)),
    ],
    kind: added.length ? "added" : removed.length ? "removed"
      : rendered.length ? "rendered" : "moved",
  };
}

/**
 * Agent 同步 hook。
 *
 * @param {object} o
 * @param {boolean} o.enabled       剪辑台可见时才轮询
 * @param {(state:object)=>void} o.onSnapshot   每次拿到新快照（含首次）
 * @param {(msg:{text:string,changedIds:string[]})=>void} o.onAgentChange
 * @returns {{ markSelfWrite: (state:object)=>void }}
 */

/* ══════════════════════════════════════════════════════════════════════
 * 元素高亮（架构决策 §四 的第 1 条反馈）
 *
 *   定时 1500ms，给变化的元素宿主加一个描边类。
 *
 * ★ 选择器靠 data-element-id —— 本轮在
 *   video-editor/src/lib/timeline/components/timeline-element.tsx 里新挂的属性。
 *   ArtCraft 原本元素 DOM 上没有任何 data-*，只能自己加。
 *
 * ★ 为什么用「加 class 到目标节点」而不是「画一层绝对定位的遮罩」：
 *   遮罩要算每个元素的像素矩形（时间轴缩放/滚动/轨道高全是动态的），
 *   算错就偏。直接给元素本体加 outline，位置永远跟着元素走。
 *
 * ★ 退出时必须清干净：如果元素在 1.5 秒内被删掉，直接 DOM 引用已失效，
 *   所以用 querySelectorAll 每次清全量，不记引用。
 */
const HIGHLIGHT_CLASS = "ac-el-changed";
const HIGHLIGHT_MS = 1500;
const HIGHLIGHT_CSS = `
.ac-el-changed {
  outline: 2px solid var(--dsw-alias-state-business-primary, #4176e6) !important;
  outline-offset: -2px;
  animation: ac-el-pulse 1500ms ease-out;
}
@keyframes ac-el-pulse {
  0%   { box-shadow: inset 0 0 0 0 rgba(65,118,230,0.55); }
  40%  { box-shadow: inset 0 0 0 12px rgba(65,118,230,0); }
  100% { box-shadow: inset 0 0 0 0 rgba(65,118,230,0); }
}
@media (prefers-reduced-motion: reduce) {
  .ac-el-changed { animation: none; }
}
`;

let _hlCssInjected = false;
function ensureHighlightCss() {
  if (_hlCssInjected) return;
  if (document.getElementById("ac-highlight-css")) { _hlCssInjected = true; return; }
  const s = document.createElement("style");
  s.id = "ac-highlight-css";
  s.textContent = HIGHLIGHT_CSS;
  document.head.appendChild(s);
  _hlCssInjected = true;
}

/**
 * 高亮一批元素 id，1.5 秒后自动清除。
 *
 * @param {string[]} ids
 * @returns {{hit:number, missing:string[]}}  命中数 + 找不到宿主的 id
 *
 * ★★ 2026-10-22 第二轮复核：返回值从 number 改成对象
 *
 *   原来返回 number，调用方 `highlightElements(d.changedIds)` 根本不看返回值。
 *   于是「一个都没命中」和「全部命中」在外部完全无法区分 ——
 *   这就是本轮高亮静默失效 0 次却没被发现的直接原因。
 *
 *   ⇒ 现在返回 missing 列表。调用方在 hit === 0 时打一条 console.warn，
 *     下次再坏就一眼能看出来，而不是靠 MutationObserver 手工数。
 */
export function highlightElements(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return { hit: 0, missing: [] };
  ensureHighlightCss();

  /* ★ 先清全量：上一批可能已被删除，残留的 class 不会再被触发 */
  for (const el of document.querySelectorAll("." + HIGHLIGHT_CLASS)) {
    el.classList.remove(HIGHLIGHT_CLASS);
  }

  let hit = 0;
  const missing = [];
  for (const id of ids) {
    /**
     * ★ id 里可能有引号/反斜杠（element id 是我们自己生成的 `el-<ts>-<rand>`，
     *   但为了稳，用 CSS.escape 包一下）。
     */
    const sel = `[data-element-id="${CSS.escape(String(id))}"]`;
    const nodes = document.querySelectorAll(sel);
    if (nodes.length === 0) { missing.push(String(id)); continue; }
    for (const el of nodes) {
      el.classList.add(HIGHLIGHT_CLASS);
      hit += 1;
    }
  }

  /* 每次都重设定时器：连续多次变化时，以最后一次为准，不叠加 */
  clearTimeout(highlightElements._t);
  highlightElements._t = setTimeout(() => {
    for (const el of document.querySelectorAll("." + HIGHLIGHT_CLASS)) {
      el.classList.remove(HIGHLIGHT_CLASS);
    }
  }, HIGHLIGHT_MS);

  return { hit, missing };
}
export function useAgentSync({ enabled, onSnapshot, onAgentChange }) {
  const prevRef = React.useRef(null);      // 上一次的 state
  const fpRef = React.useRef("");          // 上一次的指纹
  const selfWriteRef = React.useRef("");   // 自己写入后期待的指纹
  const timerRef = React.useRef(null);
  const aliveRef = React.useRef(true);

  /**
   * 自己写完时间轴后调一次，把「预期指纹」记下来。
   * 下一次轮询若与它一致 ⇒ 这条差异是自己造成的，不提示。
   */
  const markSelfWrite = React.useCallback((state) => {
    selfWriteRef.current = fingerprint(state);
  }, []);

  React.useEffect(() => {
    aliveRef.current = true;

    const tick = async () => {
      if (!aliveRef.current) return;
      // 页面不可见时不请求（省电、省服务端）
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        timerRef.current = setTimeout(tick, POLL_MS);
        return;
      }
      try {
        const res = await fetch(SNAPSHOT_URL, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(4000),
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const j = await res.json();
        const state = j?.state ?? j;
        const fp = fingerprint(state);

        if (fp !== fpRef.current) {
          const prev = prevRef.current;
          const isFirst = prevRef.current === null;

          /* 回声消除：自己刚写的那次不提示 */
          const isSelf = fp === selfWriteRef.current;
          if (isSelf) selfWriteRef.current = "";

          fpRef.current = fp;
          prevRef.current = state;

          onSnapshot?.(state, { first: isFirst });

          if (!isFirst && !isSelf && prev) {
            const d = describeDiff(prev, state);
            if (d.changedIds.length) onAgentChange?.(d);
          }
          /* ★ 首次不提示：否则每次打开剪辑台都弹一条「Agent 更新时间轴」 */
        }
      } catch {
        /* 桥不可用 / 网络抖动 —— 静默跳过这一拍，下一拍再试。
           ★ 不弹错误：1 秒轮询会把它变成每秒一条报错。 */
      }
      if (aliveRef.current) timerRef.current = setTimeout(tick, POLL_MS);
    };

    if (enabled) tick();

    return () => {
      aliveRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [enabled, onSnapshot, onAgentChange]);

  return { markSelfWrite };
}
