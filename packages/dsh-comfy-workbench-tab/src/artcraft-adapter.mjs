/**
 * ArtCraft 接入适配层（2026-10-20）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 主人定的架构原则（逐字）
 *
 *   「工作流是作为一个可替换的模块接入我们的插件的，你的所有东西
 *     都应该让工作流对号入座，而不是为工作流服务。」
 *   「先做后端，再匹配前端 ui」
 *
 *   ⇒ 这份文件是【后端】：把我们的资产库/文件代理，实现成 ArtCraft
 *     要求的 adapter 接口。前端 UI 之后再做，两边通过这份契约对接。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么是 adapter，而不是改 ArtCraft 源码
 *
 *   ArtCraft 的 video-editor 只暴露 7 个 adapter 接口（见 adapters/index.ts），
 *   明确写着「Adapter interfaces — the seam between the lib and its host」。
 *   ⇒ 它是【为宿主预留的接缝】，不是需要改的内部实现。
 *
 *   我们只需要实现其中 2 个：
 *     ① assetGallery —— 让 ArtCraft 的「Browse gallery」用我们的资产库
 *     ② mediaSource  —— 让 ArtCraft 能把我们的资产 id 解析成可播放 URL
 *
 *   其余 5 个（projectStorage / authUser / exportSink / toast / sounds）
 *   用 ArtCraft 自带的默认实现即可 —— 它们不涉及我们的数据。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 数据契约（后端定义，前端照此实现）
 *
 *   MediaHandle.id  = 我们的资产 id（如 "output:Krea2-USD-xxx.png"）
 *   MediaHandle.kind= "image" | "video" | "audio"
 *
 *   ⇒ resolveMedia 把资产 id 转成同源代理 URL：
 *        /comfy-assets/file?src=output&rel=Krea2-USD-xxx.png
 *      ★ 为什么必须走这个代理而不是直连 ComfyUI：
 *        实测（2026-10-18）ComfyUI 对带 Origin 的请求一律 403。
 *        代理是唯一能访问的路径。
 */

/* ─────────────────────────────────────────────────────────────────────
   这些函数是【纯逻辑】，不依赖浏览器 API，可以在 node 里直接测。
   前端拿到的 window.DSH_ART_* 就是它们的浏览器版本。
   ───────────────────────────────────────────────────────────────────── */

/**
 * 我们的资产项 → ArtCraft 的 MediaPickerSelection。
 *
 * @param {{id:string, name:string, displayName?:string, kind:string, src:string, rel:string}} it
 *        我们资产库的一条（见 asset-scan.js 的 mergeLibrary 输出）
 * @returns {{handle:{id:string, kind:string}, name:string}|null}
 *          返回 null 表示这个资产 ArtCraft 用不了（如文本文件）
 */
export function assetToSelection(it) {
  if (!it || !it.id) return null;

  // ArtCraft 只认这三种 kind（见 adapters/types.ts 的 MediaKind）
  const KIND_MAP = { image: "image", video: "video", audio: "audio" };
  const kind = KIND_MAP[it.kind];
  if (!kind) return null;                 // text / other → 跳过

  return {
    handle: { id: String(it.id), kind },
    // ArtCraft 用它做素材在媒体箱里的标签
    name: String(it.displayName || it.name || it.id),
  };
}

/**
 * 我们的资产 id + 资产表 → 可播放的 URL。
 *
 * @param {{id:string, src:string, rel:string, kind:string}} handle  其实是 MediaHandle，但我们要查表
 * @param {Array} allItems  资产库全量（用来按 id 找 src/rel）
 * @returns {{url:string, mime:string, durationMs?:number}}
 */
export function handleToResolved(handle, allItems) {
  const id = String(handle?.id ?? "");
  if (!id) throw new Error("缺 handle.id");

  const it = (allItems ?? []).find((x) => x.id === id);
  if (!it) throw new Error(`资产库里找不到 ${id}`);

  /**
   * ★ src + rel 一起给代理（与 AssetLibrary.js 的 assetThumbUrl 一致）：
   *   src = output | input | editor
   *   rel = 相对路径（文件名或带日期子目录）
   */
  const qs = new URLSearchParams({ src: String(it.src ?? "output"), rel: String(it.rel ?? "") });

  return {
    url: `/comfy-assets/file?${qs.toString()}`,
    mime: mimeOf(it),
    durationMs: it.durationMs,
  };
}

/** 按扩展名推 mime（资产库里没有可靠的 mime 字段）。 */
export function mimeOf(it) {
  const n = String(it?.name ?? it?.rel ?? "").toLowerCase();
  const ext = n.slice(n.lastIndexOf("."));
  const MAP = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp",
    ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
    ".mkv": "video/x-matroska", ".m4v": "video/x-m4v",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
    ".aac": "audio/aac", ".flac": "audio/flac", ".ogg": "audio/ogg",
    ".opus": "audio/opus",
  };
  return MAP[ext] ?? "application/octet-stream";
}

/**
 * 按 ArtCraft 传的 kinds 过滤我们的资产。
 *
 * ★ 为什么要过滤：ArtCraft 的 openPicker({ kinds }) 会说「我现在只缺视频」，
 *   我们不能把所有图都塞给它 —— 用户选了一张图放不进视频轨。
 *
 * @param {Array} items     资产库全量
 * @param {string[]} kinds  ArtCraft 要的 kind（已是他自己的枚举）
 * @returns {Array} 可直接给 openPicker 的 MediaPickerSelection 数组
 */
export function filterByKinds(items, kinds) {
  const want = new Set(Array.isArray(kinds) && kinds.length ? kinds : ["image", "video", "audio"]);
  const out = [];
  for (const it of items ?? []) {
    const sel = assetToSelection(it);
    if (sel && want.has(sel.handle.kind)) out.push(sel);
  }
  return out;
}
