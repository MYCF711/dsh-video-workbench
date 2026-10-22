/**
 * 把我们的资产注册进 ArtCraft 的 media manager（2026-10-20）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要这一步（实测踩出来的）
 *
 *   症状：时间轴上的 clip 片段只有文字「分镜 2」，没有缩略图。
 *
 *   加日志后发现：mediaSource.resolveMedia 一次都没被调用。
 *
 *   追到 ArtCraft 的 timeline-element.tsx 第 1096 行：
 *     const mediaAssets = useEditor((e) => e.media.getAssets());
 *     const mediaAsset = mediaAssets.find((a) => a.id === element.mediaId);
 *     const imageUrl = mediaAsset?.thumbnailUrl ?? mediaAsset?.url;
 *
 *   ⇒ ArtCraft 不是按需 resolveMedia，而是先查【已注册的资产表】。
 *     asset 表里没有 element.mediaId，就直接不渲染缩略图，也不报错。
 *
 *   ⇒ 所以光有 adapter 不够，还必须把资产【主动注册】进 media manager。
 *     这是 resolveMedia 的设计前提，不是替代。
 *
 * ══════════════════════════════════════════════════════════════════════
 * MediaAsset 的必填字段（video-editor/src/lib/media/types.ts 逐字）
 *
 *   export interface MediaAsset extends Omit<MediaAssetData, "size" | "lastModified"> {
 *     file: File;
 *     url?: string;
 *   }
 *   // MediaAssetData: { id, name, type, size, lastModified,
 *   //                   width?, height?, duration?, fps?, hasAudio?, thumbnailUrl? }
 *
 * ★ 两个关键点：
 *   ① `id` 必须【严格等于】element 的 mediaId —— 那是唯一匹配依据
 *   ② `file: File` 是必填 —— 必须真去 fetch 一次字节并包成 File
 *      好消息：同源代理 /comfy-assets/file 支持 Range，取一次就行
 */

/** 按扩展名推 MediaType（ArtCraft 只要 image/video/audio 三种） */
function mediaTypeOf(name) {
  const n = String(name ?? "").toLowerCase();
  const ext = n.slice(n.lastIndexOf("."));
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif"].includes(ext)) return "image";
  if ([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus"].includes(ext)) return "audio";
  return "video";
}

/** mime（File 需要一个 type） */
function mimeOf(name) {
  const n = String(name ?? "").toLowerCase();
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

/** 从 mediaId（"output:xxx.png"）拆出 src 与 rel */
function splitMediaId(mediaId) {
  const s = String(mediaId ?? "");
  const i = s.indexOf(":");
  if (i < 0) return { src: "output", rel: s };
  return { src: s.slice(0, i), rel: s.slice(i + 1) };
}

/**
 * 把一个 mediaId 解析成 ArtCraft 认的 MediaAsset。
 *
 * @param {string} mediaId   形如 "output:Krea2-USD-xxx.png"
 * @param {object} [opts]
 * @param {(url:string)=>Promise<Response>} [opts.fetchFn]
 * @param {(url:string)=>string} [opts.proxyUrl]  把 src/rel 拼成同源代理 URL
 * @returns {Promise<object|null>}  失败返回 null（不抛，调用方批量处理）
 */
export async function mediaIdToAsset(mediaId, opts = {}) {
  const id = String(mediaId ?? "");
  if (!id) return null;

  const { src, rel } = splitMediaId(id);
  const name = rel.split("/").pop() || rel || id;
  const type = mediaTypeOf(name);
  const mime = mimeOf(name);

  const url = opts.proxyUrl
    ? opts.proxyUrl(id)
    : `/comfy-assets/file?src=${encodeURIComponent(src)}&rel=${encodeURIComponent(rel)}`;

  const doFetch = opts.fetchFn ?? ((u) => fetch(u));

  let blob;
  try {
    const res = await doFetch(url);
    if (!res.ok) {
      console.warn(`[artcraft] 取媒体失败 ${id}：HTTP ${res.status}`);
      return null;
    }
    const buf = await res.arrayBuffer();
    blob = new Blob([buf], { type: mime });
  } catch (e) {
    console.warn(`[artcraft] 取媒体异常 ${id}：`, e?.message ?? e);
    return null;
  }

  /**
   * ★ File 构造：name 用真实文件名，type 用 mime，lastModified 用当前时间。
   *   MediaAsset 的 lastModified 是必填（虽然 Omit 掉了 size），
   *   我们无法从字节可靠地拿到原始 mtime，用 now 是可接受的近似 ——
   *   它只用于「同 id 覆盖」判断，不影响渲染。
   */
  const file = new File([blob], name, { type: mime, lastModified: Date.now() });

  /**
   * ★★ 2026-10-20 加：探测媒体元数据
   *
   *   实测：只给 id/name/type/size 时，
   *     · 视频预览区能渲染（<video> 自己读字节）
   *     · 但【时间轴上的 clip 条带是空白灰条】
   *       —— ArtCraft 平铺缩略图时需要 duration / width / height 才能算格子数
   *
   *   ⇒ 用 video/img 元素自己解码一次拿真实元数据。
   *     复用一个临时 blob URL，用完 revoke，不占内存。
   */
  const meta = await probeMeta({ blob, type, fileName: name });

  return {
    id,                       // ★ 必须与 element.mediaId 严格相等
    name,
    type,
    size: blob.size,
    lastModified: file.lastModified,
    /**
     * ★★ 2026-10-21 修：视频的 thumbnailUrl 必须是【首帧图】，不能是视频 URL
     *
     *   timeline-element.tsx 第 1094~1105 行逐字：
     *     const imageUrl = element.type === "video"
     *       ? mediaAsset?.thumbnailUrl                    // ← 视频只看这一个
     *       : (mediaAsset?.thumbnailUrl ?? mediaAsset?.url);
     *     if (!imageUrl) return <span>{element.name}</span>;  // 没有就只显示名字
     *
     *   有了之后也不是 <img>，而是 CSS 背景横向平铺：
     *     backgroundImage: `url(${imageUrl})`,
     *     backgroundRepeat: "repeat-x",
     *     backgroundSize: `${tileWidth}px ${trackHeight}px`,
     *
     *   我原来把 mp4 的 URL 直接当 thumbnailUrl ⇒ 浏览器解码失败
     *   ⇒ 条带只剩灰底 rgb(107,107,107) + 文件名。
     *
     *   ★ 为什么我一度以为「已经有缩略图了」：
     *     我当时查的是 timeline 里的 <img>，但条带根本不用 <img>，
     *     它用 background-image。找错了对象，所以看到 imgCount=0 还以为是别处的问题。
     *
     *   ⇒ 视频用 canvas 抽首帧生成 dataURL；图片直接用原 URL。
     */
    thumbnailUrl: meta.thumbnailUrl || url,
    file,
    // ★ 探测出来的元数据：缺省时不写，避免用 undefined 覆盖内部默认值
    ...(meta.width ? { width: meta.width } : {}),
    ...(meta.height ? { height: meta.height } : {}),
    ...(meta.duration ? { duration: meta.duration } : {}),
    /**
     * ★ url 也填上 —— 图片走 `thumbnailUrl ?? url` 的兜底。
     */
    url,
  };
}

/**
 * 用浏览器自带的解码器探测媒体元数据。
 *
 * @returns {Promise<{width?:number, height?:number, duration?:number}>}
 *          探测失败返回空对象 —— 不抛错，缺元数据总比整个注册失败好
 */
function probeMeta({ blob, type, fileName }) {
  return new Promise((resolve) => {
    let objUrl;
    try {
      objUrl = URL.createObjectURL(blob);
    } catch {
      resolve({});
      return;
    }

    const cleanup = (val) => {
      try { URL.revokeObjectURL(objUrl); } catch { /* ignore */ }
      resolve(val);
    };

    // ★ 超时保护：某些损坏的媒体不会触发 load/error，会永远挂着
    const timer = setTimeout(() => cleanup({}), 8000);

    if (type === "image") {
      const img = new Image();
      img.onload = () => {
        clearTimeout(timer);
        cleanup({ width: img.naturalWidth, height: img.naturalHeight });
      };
      img.onerror = () => { clearTimeout(timer); cleanup({}); };
      img.src = objUrl;
      return;
    }

    // video / audio 都用 <video> 探（audio 也能读出 duration）
    const v = document.createElement("video");
    v.preload = "metadata";
    // ★ muted + playsInline：某些浏览器对带音轨的 video 会拒绝加载元数据
    v.muted = true;
    v.playsInline = true;
    v.onloadedmetadata = () => {
      const base = {
        width: v.videoWidth || undefined,
        height: v.videoHeight || undefined,
        // duration 可能是 NaN（流式媒体）或 Infinity
        duration: Number.isFinite(v.duration) && v.duration > 0 ? v.duration : undefined,
      };
      /**
       * ★★ 2026-10-21 加：抽首帧当缩略图（dataURL）
       *
       *   为什么必须抽：ArtCraft 的时间轴条带用 CSS background-image 平铺
       *   mediaAsset.thumbnailUrl。视频文件 URL 不能被当图片解码 ⇒ 灰底。
       *
       *   ★ 抽第 0 秒而不是 0.1 秒：第一帧就是最典型的画面。
       *     某些视频第一帧是黑场/纯色 —— 那种情况抽它有意义的
       *     改进是「跳过黑场」，但那要多抽几帧比对亮度，这版先不做。
       *
       *   ★ 用 seeked 而不是 loadeddata：seeked 保证画面已解码到目标帧。
       */
      try {
        v.currentTime = 0;
      } catch {
        cleanup(base);
        return;
      }
      const onSeeked = () => {
        v.removeEventListener("seeked", onSeeked);
        try {
          const c = document.createElement("canvas");
          // 缩略图不需要原分辨率 —— 限宽 480，够平铺用，省内存
          const MAXW = 480;
          const scale = v.videoWidth > 0 ? Math.min(1, MAXW / v.videoWidth) : 1;
          c.width = Math.max(1, Math.round((v.videoWidth || 160) * scale));
          c.height = Math.max(1, Math.round((v.videoHeight || 90) * scale));
          const ctx = c.getContext("2d");
          if (!ctx) { cleanup(base); return; }
          ctx.drawImage(v, 0, 0, c.width, c.height);
          // quality 0.82：条带平铺时看不出差别，体积约为 PNG 的 1/10
          const dataUrl = c.toDataURL("image/jpeg", 0.82);
          cleanup({ ...base, thumbnailUrl: dataUrl });
        } catch {
          // 跨源 / 画布污染等 —— 宁可没缩略图，也不要整个注册失败
          cleanup(base);
        }
      };
      v.addEventListener("seeked", onSeeked);
      // 兜底：seek 不触发 seeked 的浏览器
      setTimeout(() => {
        v.removeEventListener("seeked", onSeeked);
        cleanup(base);
      }, 5000);
    };
    v.onerror = () => { clearTimeout(timer); cleanup({}); };
    v.src = objUrl;
  });
}

/**
 * 把一批 mediaId 注册进 ArtCraft 的 media manager。
 *
 * @param {object} editor        EditorCore.getInstance()
 * @param {string[]} mediaIds    element 里出现过的 mediaId
 * @param {object} [opts]
 * @returns {Promise<{added:number, failed:string[]}>}
 */
export async function registerMediaAssets(editor, mediaIds, opts = {}) {
  const media = editor?.media;
  if (!media || typeof media.addMediaAsset !== "function") {
    console.warn("[artcraft] editor.media.addMediaAsset 不可用，跳过资产注册");
    return { added: 0, failed: [...(mediaIds ?? [])] };
  }

  // 去重 + 去掉已经在表里的
  const existing = new Set(
    (typeof media.getAssets === "function" ? media.getAssets() : []).map((a) => a.id)
  );
  const want = [...new Set((mediaIds ?? []).filter(Boolean))].filter((id) => !existing.has(id));

  let added = 0;
  const failed = [];

  /**
   * ★ 串行执行，不用 Promise.all。
   *   原因：每个资产要 fetch 一次真实字节（图片可能几 MB）。
   *   并行会把浏览器连接池打满，反而更慢，而且大文件同时占内存。
   */
  for (const id of want) {
    const asset = await mediaIdToAsset(id, opts);
    if (!asset) { failed.push(id); continue; }
    try {
      const out = await media.addMediaAsset({ asset });
      if (out) added++;
      else failed.push(id);
    } catch (e) {
      console.warn(`[artcraft] addMediaAsset 失败 ${id}：`, e?.message ?? e);
      failed.push(id);
    }
  }

  return { added, failed };
}

/** 从 TProject 里收集所有 element 用到的 mediaId。 */
export function collectMediaIds(project) {
  const out = new Set();
  /**
   * ★★ 2026-10-22 实测修正：TProject 的 tracks 形状
   *     overlay = [轨道, …]   main = 轨道(单个)   audio = [轨道, …]
   *   ⇒ overlay 也要下钻 .elements（旧代码把它当元素数组，永远为空）。
   */
  for (const scene of project?.scenes ?? []) {
    const t = scene?.tracks ?? {};
    const push = (el) => { if (el?.mediaId) out.add(String(el.mediaId)); };
    const fromTrack = (tr) => {
      for (const el of tr?.elements ?? []) push(el);
    };
    if (Array.isArray(t.overlay)) for (const tr of t.overlay) fromTrack(tr);
    if (t.main) fromTrack(t.main);
    if (Array.isArray(t.audio)) for (const tr of t.audio) fromTrack(tr);
  }
  return [...out];
}

/**
 * 用资产表把 TProject 里的 mediaId 修正成【真实 id】。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要这一步（实测抓到的真 bug）
 *
 *   音频资产的 id 是 "editor:D:\\主工作区\\资产库\\音频\\test-mix.m4a"
 *   （src="editor"，rel 是绝对路径）
 *   但投影（纯函数，无资产表）猜出 "output:test-mix.m4a"
 *   ⇒ 这个 id 在资产表里不存在
 *   ⇒ 音频条带渲染不出来、也不会被注册进 media manager
 *
 *   视频恰好猜对了，因为它们的 src 就是 "output"。
 *   所以这个 bug 只在音频（或任何非 output/input 来源的资产）上暴露。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 匹配策略（按可靠性排序）
 *
 *   ① 精确 id 命中 → 不动
 *   ② 用 rel 的 basename（文件名）在资产表里找 name 相同的 → 用它的 id
 *   ③ 找不到 → 保留原值（至少不比之前差，且会进 failed 列表被日志记下）
 *
 * ★ 为什么用文件名匹配而不是完整路径：
 *   投影已经把路径 norm 成 /，而资产表的 rel 可能是 \\ 或绝对路径。
 *   跨两种分隔符做路径相等判断很容易出错，文件名是稳定锚点。
 *   代价：同名不同目录的资产会混淆 —— 在「同一工程内」这个前提下可接受。
 */
export function fixupMediaIds(project, libraryItems) {
  if (!project || !Array.isArray(libraryItems) || !libraryItems.length) return project;

  const byId = new Map();
  const byName = new Map();
  for (const it of libraryItems) {
    if (!it?.id) continue;
    byId.set(String(it.id), it);
    const n = String(it.name ?? "").trim();
    if (n && !byName.has(n)) byName.set(n, it);   // 同名取第一个
  }

  const fix = (el) => {
    const id = String(el?.mediaId ?? "");
    if (!id) return;
    // ① 精确命中
    if (byId.has(id)) return;

    // ② 用 basename 找
    const rel = id.slice(id.indexOf(":") + 1);
    const base = rel.split("/").pop().split("\\\\").pop();
    const hit = byName.get(base);
    if (hit) {
      el.mediaId = String(hit.id);
      return;
    }
    // ③ 保留原值
  };

  for (const scene of project.scenes ?? []) {
    const t = scene?.tracks ?? {};
    /* ★ 同上：overlay / audio 是轨道数组，main 是单个轨道 */
    const fromTrack = (tr) => { for (const el of tr?.elements ?? []) fix(el); };
    if (Array.isArray(t.overlay)) for (const tr of t.overlay) fromTrack(tr);
    if (t.main) fromTrack(t.main);
    if (Array.isArray(t.audio)) for (const tr of t.audio) fromTrack(tr);
  }
  return project;
}

/* ══════════════════════════════════════════════════════════════════════
 * 把资产插入时间轴（2026-10-22 新增）
 *
 * 用途有两个，共用一条路径：
 *   ① 用户点「导入」上传完 → 插进时间轴
 *   ② 刷新后「恢复上次导入内容」→ 用同一函数重建
 *
 * ══════════════════════════════════════════════════════════════════════
 * ★★ 落轨规则（主人 2026-10-21 规格，verify-import-behavior.mjs 锁定）
 *
 *   视频 → 视频1（main 轨）；音频自动分离到音频1
 *   第二个视频 → 接在视频1已有内容【后面】
 *   手动拖才能到视频2
 *
 *   ⇒ 这里用 placement.mode = "auto" 交给 ArtCraft 的 placement 层，
 *     它会按「该类型第一条可用轨 + 接在已有内容后面」处理。
 *     不写死 trackId —— 写死会让「手动拖到视频2」之后的新导入又跳回视频1。
 *
 * ★★ 元素字段（video-editor/src/lib/timeline/types.ts 逐字）
 *   BaseTimelineElement: id / name / duration / startTime /
 *                        trimStart / trimEnd / sourceDuration? / animations? / params
 *   VideoElement:  + type:"video"  + mediaId
 *   ImageElement:  + type:"image"  + mediaId
 *   UploadAudioElement: + type:"audio" + sourceType:"upload" + mediaId
 *
 *   ⚠ 三个必踩的坑（AGENTS §6.39）：
 *     ② tracks 是 { overlay, main(单个对象), audio } —— main 单数、audio 复数
 *     ③ element.type 按【实际扩展名】判，不是 clip.kind
 *     ⑥ AudioElement 必须声明 sourceType，否则导出无音频流
 *
 * ★ 时间单位：MediaTime 是整数 tick，120000 / 秒（不是 {numerator, denominator}）
 */

const TICKS_PER_SEC = 120000;

/** 秒 → MediaTime tick（整数） */
function secToTicks(sec) {
  return Math.round(Number(sec || 0) * TICKS_PER_SEC);
}

/**
 * 读媒体时长。
 *
 * ★ 为什么要真的读：duration 决定片段在时间轴上占多长。
 *   猜一个默认值（比如 5 秒）会让 30 秒的视频只显示前 5 秒，
 *   而时间轴看起来「正常」，只是内容被截断了 —— 不报错，最难发现。
 */
async function probeDuration(asset) {
  if (asset?.duration) return asset.duration;
  const url = asset?.url;
  if (!url) return 0;

  return new Promise((resolve) => {
    const isAudio = mediaTypeOf(asset.name) === "audio";
    const el = document.createElement(isAudio ? "audio" : "video");
    el.preload = "metadata";
    const done = (v) => { try { el.src = ""; } catch { /* ignore */ } resolve(v); };
    el.onloadedmetadata = () => done(Number.isFinite(el.duration) ? el.duration : 0);
    el.onerror = () => done(0);
    /* ★ 超时兜底：某些容器的 metadata 事件可能不触发 */
    setTimeout(() => done(0), 5000);
    el.src = url;
  });
}

/**
 * 把一个资产插入时间轴。
 *
 * @param {object} editor   EditorCore 实例
 * @param {{id:string,name:string,mime?:string,url?:string,duration?:number}} asset
 * @param {object} [opts]
 * @param {number} [opts.atTime]  指定起点 tick（不传 = 接在已有内容后面）
 * @returns {Promise<{trackId:string, elementId:string}|null>}
 */
export async function insertAssetToTimeline(editor, asset, opts = {}) {
  if (!editor?.timeline?.insertElement) {
    console.warn("[artcraft] editor.timeline.insertElement 不可用");
    return null;
  }
  const id = String(asset?.id ?? "");
  if (!id) throw new Error("insertAssetToTimeline：资产缺 id");

  const name = String(asset?.name ?? id.split(":").pop());
  const type = mediaTypeOf(name);          // ★ 按扩展名判，不看 mime（坑 ③）

  /* ① 先把资产注册进 media manager —— 不注册就没缩略图、也放不进轨道 */
  await registerMediaAssets(editor, [id]);

  const media = editor.media;
  const assets = typeof media?.getAssets === "function" ? media.getAssets() : [];
  const reg = assets.find((a) => String(a?.id) === id);

  /* ② 时长 */
  const durSec = await probeDuration(reg ?? asset);
  const duration = secToTicks(durSec > 0 ? durSec : 5);

  /* ③ 起点：默认接在「该类型目标轨」已有内容之后 */
  const scene = editor.scenes.getActiveSceneOrNull();
  const tracks = scene?.tracks;
  let startTime = opts.atTime;
  if (startTime === undefined) {
    startTime = 0;
    if (tracks) {
      const collect = (arr) => {
        let maxEnd = 0;
        for (const el of arr ?? []) {
          const end = Number(el?.startTime ?? 0) + Number(el?.duration ?? 0);
          if (end > maxEnd) maxEnd = end;
        }
        return maxEnd;
      };
      if (type === "video") {
        startTime = collect(tracks.main?.elements);
      } else if (type === "image") {
        startTime = collect(tracks.main?.elements);
      } else {
        /* 音频：接在第一条音频轨后面 */
        const firstAudio = Array.isArray(tracks.audio) ? tracks.audio[0] : null;
        startTime = collect(firstAudio?.elements);
      }
    }
  }

  /* ④ 构造元素（字段名严格照 types.ts） */
  const base = {
    id: `el-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    duration,
    startTime,
    trimStart: 0,
    trimEnd: duration,
    sourceDuration: duration,
    params: {},
  };

  let element;
  if (type === "audio") {
    /* ★ 坑 ⑥：AudioElement 必须声明 sourceType（联合类型） */
    element = { ...base, type: "audio", sourceType: "upload", mediaId: id };
  } else if (type === "image") {
    element = { ...base, type: "image", mediaId: id };
  } else {
    element = { ...base, type: "video", mediaId: id, isSourceAudioEnabled: true };
  }

  /* ⑤ 插入：placement.auto 交给 ArtCraft 解析轨位（不写死 trackId） */
  editor.timeline.insertElement({
    element,
    placement: { mode: "auto" },
  });

  return { trackId: null, elementId: element.id };
}

/**
 * 「恢复上次导入的内容」。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 主人要求：「能不能默认上次的导入内容？」
 *
 * ── 现状（docs/架构决策 §三 实测）
 *   数据真源是 dsh-editor 的 timeline-state（Agent 写这里），
 *   ArtCraft 只在保存时把 trim 写回去。
 *   ⇒ ArtCraft 里新导入的片段不进 timeline-state ⇒ 刷新就没了。
 *
 * ── 本函数的做法
 *   不新造存储，而是把「导入过的资产 id 列表」记到 localStorage，
 *   刷新后逐个重新插入时间轴。
 *
 *   ★ 为什么不用 timeline-state 当载体：
 *     那需要改 dsh-editor 的写入路径（跨项目），而且会与 Agent 的写入打架
 *     （架构决策 §七 的「谁是真源」问题）。
 *     本轮先用本地记录 —— 它是【只在 ArtCraft 内部】的语义，
 *     不污染真源，也不会被 Agent 的写入覆盖。
 *
 *   ★ 与 Agent 数据的关系：
 *     Agent 加的片段来自 timeline-state（已投影）；
 *     我们恢复的是「用户自己导入的资产」。
 *     两者在时间轴上共存，靠 startTime 接在后面，不互相覆盖。
 */

const LOCAL_IMPORTS_KEY = "artcraft.localImports.v1";

/** 记一笔「这个资产是用户导入的」。 */
export function rememberImport(assetId, name) {
  try {
    const list = readLocalImports();
    if (list.some((x) => x.id === assetId)) return;
    list.push({ id: assetId, name, at: Date.now() });
    localStorage.setItem(LOCAL_IMPORTS_KEY, JSON.stringify(list));
  } catch { /* 配额满 / 隐私模式 —— 静默，不影响导入本身 */ }
}

/** 读回导入记录。 */
export function readLocalImports() {
  try {
    const raw = localStorage.getItem(LOCAL_IMPORTS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** 清空导入记录（用户点了「清空时间轴」之类时用）。 */
export function clearLocalImports() {
  try { localStorage.removeItem(LOCAL_IMPORTS_KEY); } catch { /* ignore */ }
}

/**
 * 恢复上次导入的内容。
 *
 * @param {object} editor
 * @returns {Promise<{restored:number, failed:string[]}>}
 *
 * ★ 幂等：已经在时间轴上的资产不重复插入。
 *   判据是 element.mediaId 集合（不是 id —— 元素 id 每次新建都不同）。
 */
export async function restoreLastImports(editor) {
  const list = readLocalImports();
  if (!list.length) return { restored: 0, failed: [] };

  const scene = editor?.scenes?.getActiveSceneOrNull?.();
  const tracks = scene?.tracks;
  const existing = new Set();
  const push = (el) => { if (el?.mediaId) existing.add(String(el.mediaId)); };
  /* ★ 同上：overlay / audio 是轨道数组，main 是单个轨道 */
  const fromTrack = (tr) => { for (const el of tr?.elements ?? []) push(el); };
  if (Array.isArray(tracks?.overlay)) for (const tr of tracks.overlay) fromTrack(tr);
  if (tracks?.main) fromTrack(tracks.main);
  if (Array.isArray(tracks?.audio)) for (const tr of tracks.audio) fromTrack(tr);

  let restored = 0;
  const failed = [];

  for (const item of list) {
    if (existing.has(String(item.id))) continue;
    try {
      await insertAssetToTimeline(editor, { id: item.id, name: item.name });
      restored += 1;
    } catch (e) {
      console.warn(`[artcraft] 恢复失败 ${item.id}：`, e?.message ?? e);
      failed.push(item.id);
    }
  }

  return { restored, failed };
}
