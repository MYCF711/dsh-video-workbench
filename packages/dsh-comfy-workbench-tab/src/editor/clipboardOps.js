/**
 * clipboardOps.js · 剪辑动作封装（2026-10-22）
 *
 * ══════════════════════════════════════════════════════════════════════
 * ★★ 为什么这里全部用静态 import，不用 await import()
 *
 *   本插件最终打进 lib/client.js（IIFE + CJS 产物 + new Function 求值）。
 *   动态 import() 在那里会让 esbuild 生成【独立 chunk】，
 *   而 client.js 是被当成一个字符串内联的 —— chunk 文件根本不存在，
 *   运行时静默报「Failed to fetch dynamically imported module」，
 *   而剪辑台看起来只是「导入没反应」。
 *
 *   ⇒ 判据：凡是会进 bundle 的模块，一律静态 import。
 */

import { insertAssetToTimeline as _insertAsset, rememberImport } from "./mediaAssets.js";

/**
 * ══════════════════════════════════════════════════════════════════════
 * 为什么单独一个文件
 *
 *   工具栏的每个动作都对应 ArtCraft 的一个 manager 方法，但用法上有三处
 *   容易写错的地方（都是实测踩出来的）：
 *
 *   ① 所有「元素引用」的形状是 { trackId, elementId }，不是 element 对象
 *      timeline.splitElements / deleteElements / duplicateElements
 *      的签名都要求这个形状。传 element 对象进去不报错，但什么也不发生。
 *
 *   ② 选择状态在 selection manager 里，是 ElementRef[]，不是元素本体。
 *      ⇒ 要操作「选中的片段」，直接用 editor.selection.getSelectedElements()，
 *        不要自己去扫 tracks。
 *
 *   ③ 「分割」的时间点是【播放头】，不是「片段的中间」。
 *      PR 的 Ctrl+K 也是这个语义（添加编辑 = 在播放头处切）。
 *      布局文档 §四 已确认只保留这一个分割语义。
 *
 * ══════════════════════════════════════════════════════════════════════
 * ★★ AGENTS §6.30：schema 的 required 不是运行时拦截
 *   ⇒ 每个入口都显式检查「有没有选中 / 有没有素材」，
 *     并给出可读的错误，而不是静默什么都不做。
 *   「点了没反应」比「报错」更差 —— 见布局重设计 §六。
 */

/** 从 editor 拿「选中的元素引用」。永远是 {trackId, elementId}[]。 */
function selectedRefs(editor) {
  const sel = editor?.selection?.getSelectedElements?.() || [];
  return sel
    .map((r) => ({ trackId: r?.trackId, elementId: r?.elementId }))
    .filter((r) => r.trackId && r.elementId);
}

/** 播放头位置。 */
function playhead(editor) {
  return editor?.playback?.getCurrentTime?.() ?? 0;
}

/* ══════════════════════════════════════════════════════════════════════
 * 基础动作
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 分割：在播放头处切开选中的片段。
 *
 * ★ 只切「播放头落在其内部」的片段 ——
 *   播放头在片段外时切开会把片段一分为二成两个不连续块，
 *   这是 PR 里也不允许的操作（切点不在元素内 = 无操作）。
 *   ArtCraft 的 SplitElementsCommand 内部也会跳过，但这里先筛一遍，
 *   好给出「为什么没反应」的提示。
 */
async function split(editor) {
  const refs = selectedRefs(editor);
  if (!refs.length) throw new Error("先选中要分割的片段");

  const t = playhead(editor);
  const scene = editor.scenes.getActiveSceneOrNull();
  if (!scene) throw new Error("没有活动场景");

  const inside = refs.filter((ref) => {
    const found = editor.timeline.getElementsWithTracks({
      elements: [ref],
    });
    const el = found?.[0]?.element;
    if (!el) return false;
    return t > el.startTime && t < el.startTime + el.duration;
  });

  if (!inside.length) {
    throw new Error(
      "播放头不在选中片段的内部，没有可切的位置。\n" +
      "先把播放头拖到片段中间再按分割。"
    );
  }

  return editor.timeline.splitElements({
    elements: inside,
    splitTime: t,
    retainSide: "both",
  });
}

/**
 * 删除。
 *
 * @param {boolean} opts.ripple 波纹删除（删完后面的自动前移）
 *
 * ★ ArtCraft 没有独立的「波纹删除」command ——
 *   它的 DeleteElementsCommand 之后跟 RippleDiff 应用。
 *   这里先做普通删除并把限制说清楚，不假装支持波纹。
 *   （布局文档把「波纹删除」列为低频收进菜单，可以慢一步。）
 */
async function del(editor, opts = {}) {
  const refs = selectedRefs(editor);
  if (!refs.length) throw new Error("先选中要删除的片段");
  if (opts.ripple) {
    console.info("[artcraft] 波纹删除尚未实装，本次按普通删除处理");
  }
  editor.timeline.deleteElements({ elements: refs });
  editor.selection.clearSelection();
}

/** 复制（原地复制一份，落在同一轨道）。 */
async function duplicate(editor) {
  const refs = selectedRefs(editor);
  if (!refs.length) throw new Error("先选中要复制的片段");
  return editor.timeline.duplicateElements({ elements: refs });
}

/**
 * 添加书签（标记）。放在播放头处。
 * ★ ArtCraft 的 bookmark 在 scene 上：scene.bookmarks
 */
async function addBookmark(editor) {
  const scene = editor.scenes.getActiveSceneOrNull();
  if (!scene) throw new Error("没有活动场景");
  const t = playhead(editor);
  /**
   * ★ 用 toggleBookmark 而不是直接改 scene：
   *   scene 是快照对象（getActiveSceneOrNull 返回副本），
   *   直接 push 到它的 bookmarks 不会写回 store，也不会触发重渲染。
   */
  const api = editor.scenes;
  if (typeof api.toggleBookmark === "function") {
    api.toggleBookmark({ time: t });
    return t;
  }
  throw new Error("当前 ArtCraft 版本没有 scenes.toggleBookmark");
}

/**
 * 提取音频。
 *
 * ★ ArtCraft 有这个能力：timeline.toggleSourceAudioSeparation
 *   它把「视频片段内嵌的音轨」分离成独立音频片段。
 *   这正是工具栏「提取音频」的语义。
 */
async function extractAudio(editor) {
  const refs = selectedRefs(editor);
  if (!refs.length) throw new Error("先选中要提取音频的视频片段");
  editor.timeline.toggleSourceAudioSeparation({ elements: refs });
}

/* ══════════════════════════════════════════════════════════════════════
 * 吸附开关
 *
 * ★★ 2026-10-22 重写：原来用 window.__AC_SNAP__ / __AC_SET_SNAP__ 传状态，
 *   被 verify-no-debug-probes.mjs 判为「调试探针残留」—— 判得对。
 *   window 上的东西没法溯源、会跨插件泄漏，而且卸载后还留着。
 *
 *   ⇒ 改成模块级信号：本模块自己持有状态 + 订阅者列表。
 *     时间轴那边通过 setSnappingSignal() 注入真正的 store setter。
 */

let _snapping = true;
const _snapListeners = new Set();
let _snapWriter = null;

/**
 * 让真正的时间轴 store setter 接进来。
 * 由 client.js 在挂载后调用一次。
 *
 * @param {(v:boolean)=>void} writer
 */
export function setSnappingWriter(writer) {
  _snapWriter = typeof writer === "function" ? writer : null;
  /* 若 writer 能读，顺便对齐初值 */
  try {
    const v = writer?.read?.();
    if (typeof v === "boolean") _snapping = v;
  } catch { /* ignore */ }
}

/** 当前是否开启吸附。 */
export function isSnapping() {
  return _snapping !== false;
}

/** 切换吸附，返回新值。 */
export function toggleSnapping() {
  _snapping = !isSnapping();
  try { _snapWriter?.set?.(_snapping); } catch { /* ignore */ }
  for (const fn of _snapListeners) {
    try { fn(_snapping); } catch { /* ignore */ }
  }
  return _snapping;
}

/** 订阅吸附状态变化（工具栏重渲染用）。 */
export function subscribeSnapping(fn) {
  _snapListeners.add(fn);
  return () => _snapListeners.delete(fn);
}

/* ══════════════════════════════════════════════════════════════════════
 * 缩放 / 行高读写口
 *
 * ★★ 2026-10-22：同上，原来挂在 window.__AC_ZOOM__，被判为探针残留。
 *   ⇒ 改成模块级单例。Timeline 通过 onZoomApi 交进来，工具栏从这里读。
 */

let _zoom = null;

/** 由挂载时注入（来自 ArtCraft Timeline 的 onZoomApi）。 */
export function setZoomApi(api) {
  _zoom = api && typeof api === "object" ? api : null;
}

/**
 * 取当前的缩放 API 对象（给滚轮手势用）。
 *
 * ★ 为什么要有它：滚轮手势需要读【当前值】再算下一值，
 *   而不是像 nudgeZoom 那样只给方向。
 *   返回 null 表示还没挂载完成，调用方应当跳过这次手势。
 */
export function getZoomApi() {
  return _zoom;
}

/** 当前缩放值（没有就返回 null）。 */
export function getZoom() {
  return _zoom ? Number(_zoom.zoom) || 0 : null;
}

/** 缩放一步。dir = 1 放大 / -1 缩小。 */
export function nudgeZoom(dir) {
  if (!_zoom) return null;
  const factor = dir > 0 ? 1.4 : 1 / 1.4;
  const next = (_zoom.zoom || 1) * factor;
  try { _zoom.setZoom?.(next); } catch { /* ignore */ }
  return next;
}

/** 行高一步。dir = 1 增高 / -1 减矮。 */
export function nudgeTrackScale(dir) {
  if (!_zoom) return null;
  const factor = dir > 0 ? 1.15 : 1 / 1.15;
  const next = (_zoom.trackScale || 1) * factor;
  try { _zoom.setTrackScale?.(next); } catch { /* ignore */ }
  return next;
}

/* ══════════════════════════════════════════════════════════════════════
 * 导入
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 导入文件到时间轴。
 *
 * ★ 为什么走 HTTP 而不是 ArtCraft 的本地文件 adapter：
 *   本项目的资产真源是 dsh-comfy-workbench-tab 的资产库（磁盘 + json），
 *   不是浏览器 IndexedDB。
 *   上传协议已实测定死（AGENTS §6.39 / verify-upload-protocol.mjs）：
 *     POST /comfy-assets/upload，body = JSON + base64（不是 FormData！）
 *     响应是扁平结构：{ ok:true, id:"input:wb_xxx.png" }
 *   发 multipart 会 400「请求体不是合法 JSON」。
 *
 * ★ 落轨规则（主人 2026-10-21 规格，verify-import-behavior.mjs 锁定）：
 *   视频 → 视频1，音频自动分离到音频1；
 *   第二个视频 → 接在视频1已有内容后面；
 *   手动拖才能到视频2。
 *   ⇒ 这里的「接在后面」由 ArtCraft 的 placement 处理，
 *     我们只负责把文件变成 media asset 再调 insertElement。
 */
async function importFiles(editor, files, opts = {}) {
  if (!files?.length) return { added: 0, failed: [] };

  const results = { added: 0, failed: [] };

  for (const file of files) {
    try {
      /* ① 读成 base64 */
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      const base64 = btoa(bin);

      /**
       * ② 上传（JSON + base64，不是 FormData）
       *
       * ★★ 2026-10-23 修：字段名写错 ⇒ 导入永远 400（主人：「导入功能又失效了」）
       *
       * ── 实测（19499，逐个字段试）
       *   { name, mime, data }      → 400 "缺 filename"
       *   { filename, mime, data }  → 400 "缺 base64"
       *   { filename, base64 }      → 200 {"ok":true,"id":"input:wb_xxx.png"}
       *
       *   ⇒ 服务端只认 filename + base64 两个字段。
       *     我原来写的是 name + data（凭印象猜的），两边一个都对不上。
       *
       * ── 为什么之前「看起来没坏」
       *   上传失败被下面的 catch 吞进 results.failed，只 console.warn，
       *   界面没有任何提示 ⇒ 用户点了导入、文件选了、什么都没发生。
       *   ★ 判据：静默失败比报错更糟 —— 必须把 failed 抛到用户眼前。
       */
      const res = await fetch("/comfy-assets/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: file.name,
          base64,
        }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`上传失败 HTTP ${res.status} ${txt.slice(0, 200)}`);
      }
      const j = await res.json();
      /**
       * 服务端返回 { ok, id, absPath, filename, … }（扁平结构）。
       * ★ id 形如 "input:wb_xxx.png" —— 注意服务端会重命名（加 wb_ 前缀 + 随机后缀），
       *   所以【不能用 file.name 当 id】。后面插入时间轴必须用返回的 id。
       */
      const assetId = j?.id ?? j?.item?.id;
      if (!assetId) throw new Error("上传成功但没返回资产 id");

      opts.onProgress?.(`已上传 ${file.name} → ${assetId}`);

      /* ③ 交给 ArtCraft 插入时间轴
       *    ★ 具体 insertElement 参数由 mediaAssets.js 里已有的
       *      「按实际扩展名判 type」逻辑决定（AGENTS §6.39 ③） */
      if (typeof _insertAsset === "function") {
        await _insertAsset(editor, {
          id: assetId,
          name: file.name,
          mime: file.type,
        });
        /* ④ 记一笔，下次打开时恢复（主人：「能不能默认上次的导入内容？」） */
        rememberImport(assetId, file.name);
      }
      results.added += 1;
    } catch (e) {
      results.failed.push({ name: file.name, error: String(e?.message ?? e) });
    }
  }

  if (results.failed.length) {
    console.warn("[artcraft] 导入部分失败：", results.failed);
  }
  return results;
}

/* ══════════════════════════════════════════════════════════════════════
 * 字幕
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 贴稿生成字幕。
 *
 * 规格来源：verify-captions.mjs 已实测通过的行为
 *   贴 3 行 → 生成 3 条，start = 0/360000/720000，dur 各 360000，
 *   posY = 410（1080 × 0.38）。
 *   ★ 每段 3 秒（= 360000 tick，120000/秒）是当时的定值。
 */
async function generateCaptions(text, setCaptions) {
  const editor = window.__ARTCRAFT_EDITOR__;
  if (!editor) throw new Error("编辑器未就绪");

  const lines = String(text || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (!lines.length) throw new Error("没有可用的字幕行");

  const SEG = 360000;              // 3 秒
  const captions = lines.map((content, i) => ({
    id: "cap-" + Date.now() + "-" + i,
    content,
    start: i * SEG,
    duration: SEG,
    startLabel: formatTick(i * SEG),
  }));

  setCaptions(captions);
  /* ★ 本轮只更新检查器里的列表；真正写入字幕轨在下一轮
   *   （要复现 verify-captions 的 insertElement 参数，不在本文件里硬写）。 */
  console.info(`[artcraft] 生成 ${captions.length} 条字幕（已进检查器列表）`);
  return captions;
}

/** 从音轨识别（whisper 已装 medium 模型）。 */
async function recognizeCaptions(setCaptions) {
  /**
   * ★ 这是真入口不是假按钮：本机已装 faster-whisper 1.2.1 + medium 模型
   *   （见 verify-asr.mjs / verify-asr-models.mjs，准确率 91.8%）。
   *   调用链在 dsh-editor 侧，这里先把请求发出去。
   */
  const res = await fetch("/timeline/asr", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "audio-track" }),
  });
  if (!res.ok) {
    throw new Error(`识别失败 HTTP ${res.status}（音频轨可能没有内容）`);
  }
  const j = await res.json();
  const list = Array.isArray(j?.captions) ? j.captions : [];
  setCaptions(list);
  return list;
}

async function editCaption(caption, content) {
  /* ★ 改字幕必须同时改时间轴上的元素，否则刷新就丢。
   *   下一轮接：按 caption.id 找到字幕轨上的元素并 updateElements。 */
  console.info("[artcraft] 字幕已改（本轮只在检查器内生效）", caption?.id, content);
}

/* ══════════════════════════════════════════════════════════════════════
 * 工具
 * ══════════════════════════════════════════════════════════════════════ */

function formatTick(ticks) {
  const TPS = 120000;
  const total = Math.max(0, Math.floor(ticks / TPS));
  const ss = total % 60;
  const mm = Math.floor(total / 60) % 60;
  const hh = Math.floor(total / 3600);
  const p2 = (n) => String(n).padStart(2, "0");
  return `${p2(hh)}:${p2(mm)}:${p2(ss)}`;
}

export const CLIPBOARD_KEY = "artcraft.clipboard.v1";

export const KEYCLIPS = {
  split,
  delete: del,
  duplicate,
  addBookmark,
  extractAudio,
  isSnapping,
  toggleSnapping,
  subscribeSnapping,
  setSnappingWriter,
  setZoomApi,
  getZoomApi,
  getZoom,
  nudgeZoom,
  nudgeTrackScale,
  importFiles,
  generateCaptions,
  recognizeCaptions,
  editCaption,
  selectedRefs,
  formatTick,
};
