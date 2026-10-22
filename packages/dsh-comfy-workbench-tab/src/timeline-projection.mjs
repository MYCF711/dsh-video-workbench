/**
 * 工程投影层：我们的 timeline-state ⇄ ArtCraft 的 TProject（2026-10-20）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么是「投影」而不是「统一模型」
 *
 *   我一开始想的是 A 方案：把我们的工程直接改成 ArtCraft 的 TProject 形状。
 *   查完真实数据后放弃，理由是具体的：
 *
 *   我们的 clip 里有这些字段（真实存档抄下来的）：
 *     "shot": { "modeId":"yz", "prompt":"…", "aspect":"16:9",
 *               "durationSec":5, "toggles":{}, "media":{}, "history":[] }
 *     "handoff": { "locks": { "prompt": { "by":"user", "fp":"…" } },
 *                  "log": [{ "at":…, "by":"user", "field":"prompt" }] }
 *     "rendered": { "path":"…", "generatedAt":… }
 *     "regenError"、"fromVideoClipId"
 *
 *   ★ `shot` 的意义是「这个 clip 还没生成，就已经带着完整的生成配方」。
 *     ArtCraft 的 element 没有这个概念 —— 它只认 mediaId（已存在的媒体）。
 *   ★ `handoff.locks` 是 M7 人机交接的成果（谁锁了哪个字段）。
 *
 *   若强行统一成 ArtCraft 模型，这些字段只能塞进自定义字段（可能被它的
 *   序列化丢掉），或存工程外（与 clip 脱钩）。
 *   ⇒ 两个都是坏选择。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 采用的做法：单一真相 + 单向投影
 *
 *   timeline-state.json   ← 唯一真相（含 shot / handoff）
 *          ↓ toArtCraft()      只读投影
 *   ArtCraft TProject     ← 给它做时间轴编辑
 *          ↑ fromArtCraft()    只取「时间 / 裁切 / 顺序」，其余字段原样保留
 *
 *   ★ 这是主人定的范围的正确实现：
 *     「范围只取 ArtCraft 的时间轴能力 + 我们自己的 ComfyUI 生成链路」
 *     ArtCraft 只负责时间轴，不需要知道 shot 和 handoff。
 */

/** 我们的 fps → ArtCraft 的 MediaTime（Fraction） */
export function fpsToRate(fps, denominator = 1) {
  const n = Number(fps);
  if (!Number.isFinite(n) || n <= 0) return { numerator: 30, denominator: 1 };
  return { numerator: n, denominator };
}

/**
 * 秒 → ArtCraft 的 MediaTime（{numerator, denominator} 表示秒数）。
 *
 * ★ 这里必须非常小心：ArtCraft 的 MediaTime 是【分数】，
 *   它既可以表示「帧号」（numerator=帧数, denominator=fps）
 *   也可以表示「秒」（denominator=1）。
 *   实测踩过坑：把浮点 30.0 直接塞进期望 struct FrameRate 的位置，
 *   serde 报 "invalid type: floating point 30.0, expected struct FrameRate"。
 *   ⇒ 统一用 {numerator: 秒×1000, denominator: 1000} 表示秒，避免浮点。
 */
/**
 * ★★ 2026-10-20 重大修正：MediaTime 是【整数 tick】，不是 {numerator, denominator}
 *
 *   证据（video-editor/src/lib/wasm/media-time.ts 逐字）：
 *     // Integer-tick time. Mirrors MediaTime(i64)
 *     export type MediaTime = number & { readonly __mediaTime: unique symbol };
 *     export function addMediaTime({ a, b }) { return requireMediaTime({ value: a + b, ... }); }
 *     function isMediaTime(value) { return Number.isInteger(value); }
 *
 *   ⇒ MediaTime 就是整数 tick，`a + b` 直接数字相加。
 *     我传 {numerator, denominator} 对象进去，
 *     addMediaTime 里 a + b 变成 "[object Object][object Object]"
 *     ⇒ 报错 "addMediaTime(): expected an integer tick count"。
 *
 *   `{numerator, denominator}` 是 FrameRate（帧率）的类型，不是时间。
 *
 * ★ TICKS_PER_SECOND 实测 = 120000（node 直接 import opencut-wasm 得到）
 */
export const TICKS_PER_SECOND = 120000;

export function secToTime(sec) {
  return Math.round((Number(sec) || 0) * TICKS_PER_SECOND);
}

/** ArtCraft 的 MediaTime → 秒（浮点，给我们自己用） */
export function timeToSec(t) {
  if (t == null) return 0;
  const n = typeof t === "number" ? t : Number(t);
  if (!Number.isFinite(n)) return 0;
  return n / TICKS_PER_SECOND;
}

/**
 * 我们的一条 clip → ArtCraft 的一个 element。
 *
 * @param {object} clip   我们的 clip（见 timeline-state.json）
 * @param {object} opts   { fps, mediaIdOf }
 * @returns {object|null} null 表示这条 clip 投影不过去（如「待生成」）
 */
export function clipToElement(clip, opts = {}) {
  if (!clip || !clip.id) return null;

  const fps = Number(opts.fps) || 24;
  const inSec = Number(clip.in) || 0;
  const outSec = Number(clip.out) || 0;
  const dur = Math.max(0, outSec - inSec);
  if (dur <= 0) return null;              // 零长度 clip 不投影

  /**
   * ★ 只投影【已经有媒体】的 clip。
   *   `src === "（待生成）"` 或没有 rendered 的 clip 在 ArtCraft 里无法显示 ——
   *   它需要一个 mediaId 才能画出缩略图。硬投影会得到一个空白块。
   *   ⇒ 跳过，让它在我们的时间轴上等待生成。
   */
  /**
   * ★★ 2026-10-20 修：判据必须同时看 src 与 rendered
   *
   *   第一版只看 src：`hasMedia = src && src !== "（待生成）"`
   *
   *   实测 bug：用 /timeline/cmd/replace-clip 给 clip 挂素材后，
   *     rendered.filename = "Krea2-USD-....png"  ✓
   *     src 仍是 "（待生成）"                     ★
   *   ⇒ 投影判它没有媒体而跳过。
   *
   *   后果比看起来严重：我们的生成链路（ComfyUI 出图 → replace-clip
   *   写 rendered）【全都不会改 src】。所以每一个真正生成出来的镜头，
   *   在 ArtCraft 里都看不见，只剩一片空白的时间轴。
   *
   *   ⇒ 语义正确的判据是「有没有可解析的媒体」，两个来源：
   *     ① src 是真实文件名（用户直接拖进来的素材）
   *     ② rendered.filename / path 有值（生成产物）
   *     任一成立即算有媒体。
   */
  const src = String(clip.src ?? "");
  const srcUsable = !!src && src !== "（待生成）";
  const renderedName = String(clip.rendered?.filename ?? clip.rendered?.path ?? "").trim();
  const hasMedia = srcUsable || !!renderedName;
  if (!hasMedia) return null;

  /**
   * ★★ 2026-10-20 修（实测：resolveMedia 一次都没被调用、缩略图空白）
   *
   *   clip.kind 表示【在哪条轨上】（video / audio），
   *   不是【媒体是什么类型】。
   *
   *   实测：一个 clip 在视频轨上（kind="video"），
   *   但 rendered.filename = "Krea2-USD-20261018_00008_.png" —— 是张图片。
   *   我按 clip.kind 判成 type:"video"，
   *   ArtCraft 就用 <video> 去加载 PNG ⇒ 加载失败 ⇒ 静默不显示缩略图
   *   ⇒ 而且 resolveMedia 根本不会被调用（它先看 type 决定要不要取媒体）。
   *
   *   ⇒ 必须按【实际文件的扩展名】判断 element 类型。
   *     音频仍看 clip.kind（音频轨上的就是音频）。
   */
  const mediaName = String(srcUsable ? src : renderedName).toLowerCase();
  const ext = mediaName.slice(mediaName.lastIndexOf("."));
  const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif"]);
  const AUDIO_EXT = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus"]);
  const kind = AUDIO_EXT.has(ext) || clip.kind === "audio"
    ? "audio"
    : IMAGE_EXT.has(ext)
      ? "image"
      : "video";

  /**
   * ★★ 2026-10-20 修：duration 必须按 trim 算，不能用原始 out-in
   *
   *   实测：后端 trim = { startSec: 0, endSec: 1.5 }（从 5 秒里裁掉后 3.5 秒），
   *   但 ArtCraft 时间轴上仍显示 00:00:05:00、clip 条带宽度不变。
   *
   *   根因：我把 duration 写成 `out - in`（源素材完整长度），
   *   而 ArtCraft 的语义是：
   *     duration   这个 element 在时间轴上【占多长】
   *     trimStart  从源素材的哪个位置开始取
   *     trimEnd    取到源素材的哪个位置
   *   ⇒ 三者满足 duration === (trimEnd - trimStart)（未设 trim 时等于全长）
   *
   *   我让 duration 恒等于全长、只改 trim ⇒ 视觉毫无变化，导出也仍按全长。
   *   这是个静默错误：界面看起来「保存了」，实际没生效。
   */
  const trimStartSec = Number(clip.trim?.startSec) || 0;
  const trimEndRaw = Number(clip.trim?.endSec);
  const hasTrim = Number.isFinite(trimEndRaw) && trimEndRaw > trimStartSec;
  const effectiveDur = hasTrim ? (trimEndRaw - trimStartSec) : dur;

  const element = {
    id: String(clip.id),
    name: String(clip.name ?? clip.id),
    duration: secToTime(effectiveDur),
    startTime: secToTime(Number(clip.startSec) || 0),
    trimStart: secToTime(trimStartSec),
    /**
     * ★ trimEnd 为 0 表示「没设裁切」，但 ArtCraft 会理解成
     *   「取到源素材第 0 秒」⇒ 没裁切时必须写成完整长度。
     */
    trimEnd: secToTime(hasTrim ? trimEndRaw : dur),
    params: {},
  };

  /**
   * ★ mediaId 的取法（2026-10-20 修）：
   *   我们的 src 是相对路径（如 "Krea2-USD-xxx.png"），
   *   ArtCraft 的 mediaId 要能给 mediaSource.resolveMedia 用。
   *   ⇒ 直接沿用我们的资产 id 格式："output:Krea2-USD-xxx.png"
   *     （与 artcraft-adapter.mjs 的 handleToResolved 一致）
   *
   * ★★ 第一版写错：优先取了 `rendered.filename`。
   *   实测得到 "output:yz-result.mp4"，而我是拿 DONE_CLIP 测的，
   *   它的 src 明明是 Krea2-USD-...png。
   *
   *   语义：【src 是这个 clip 现在引用的媒体】；rendered 是「这一镜生成过什么」
   *   的历史记录（可能已被后续覆盖/替换，还有 replaced:true 标记）。
   *   ⇒ 必须优先 src。rendered.filename 只在 src 为空时兜底。
   */
  /**
   * ★★ 2026-10-20 修：`src || rendered.filename` 的陷阱
   *
   *   "（待生成）" 是一个【真值字符串】。
   *   所以 `src || clip.rendered?.filename` 会返回 "（待生成）"，
   *   而不是回退到 rendered.filename。
   *   实测：mediaId 变成 "output:（待生成）"，
   *   resolveMedia 找不到这个资产 ⇒ ArtCraft 显示空白块。
   *
   *   ⇒ 用前面算好的 srcUsable 判断，不能用真值判断。
   */
  const rel = String(srcUsable ? src : renderedName).replace(/\\/g, "/");

  /**
   * ★★ 2026-10-20 修：mediaId 必须用【资产库里的真实 id】，不能靠猜前缀
   *
   *   实测 bug（音频轨）：
   *     音频资产在库里的 id 是 "editor:D:\主工作区\资产库\音频\test-mix.m4a"
   *     （src="editor"，rel 是绝对路径）
   *     但投影猜出 "output:test-mix.m4a" —— 这个 id 在资产表里不存在
   *     ⇒ 音频条带渲染不出来、也不会被注册进 media manager
   *
   *   根因：我原来用「src 是否绝对路径」来猜前缀：
   *     const srcRoot = /^[a-zA-Z]:|^\/\//.test(src) ? "output" : (opts.srcTag || "output");
   *   而这里的 src 是 "（待生成）"，真正带前缀的信息在 clip 引用的资产上，
   *   投影（纯函数）拿不到资产表。
   *
   *   ⇒ 让调用方传一个解析器：mediaIdOf(clip, { rel, kind }) → 真实 id
   *     调用方那边有资产表，能按 absPath / filename 精确匹配。
   *     拿不到时退回原来的猜测（至少不比之前差）。
   */
  const guessed = `${/^[a-zA-Z]:|^\/\//.test(src) ? "output" : (opts.srcTag || "output")}:${rel}`;
  element.mediaId = typeof opts.mediaIdOf === "function"
    ? (opts.mediaIdOf(clip, { rel, kind, src }) || guessed)
    : guessed;

  // 音轨用 AudioElement，视觉轨用 Video/ImageElement
  if (kind === "audio") {
    element.type = "audio";
    /**
     * ★★ 2026-10-21 修（导出没有音频流的真因）
     *
     *   AudioElement 是【联合类型】，必须声明走哪条路径：
     *     UploadAudioElement   { type:"audio", sourceType:"upload",  mediaId }
     *     LibraryAudioElement  { type:"audio", sourceType:"library", sourceUrl }
     *
     *   我原来两者都没设 ⇒ ArtCraft 的 mixAudioChannels 里：
     *     if (element.sourceType === "upload") { …mediaMap 查资产… }
     *     if (element.buffer) return element.buffer;
     *     const response = await fetch(element.sourceUrl);   // ← undefined
     *   ⇒ fetch(undefined) 抛错 → catch 里 warn 后 return null
     *   ⇒ audioElements 为空 → createTimelineAudioBuffer 返回 null
     *   ⇒ 导出只有视频流，没有音频
     *
     *   症状：时间轴上音频条带正常显示（那是另一条渲染路径），
     *        但导出文件里 Stream 只有 #0:0 Video。
     *
     *   ⇒ 用 sourceType:"upload" + mediaId（我们已有媒体注册，走资产表那条路）。
     */
    element.sourceType = "upload";
  } else if (kind === "image") {
    element.type = "image";
  } else {
    element.type = "video";
    // 源音轨开关：我们 clip 上有 gain 就视为开着源音
    if (clip.gain != null) element.isSourceAudioEnabled = true;
  }

  return element;
}

/**
 * 我们的 timeline-state → ArtCraft 的 TProject。
 *
 * @param {object} state   timeline-state.json 的内容
 * @param {object} opts    { projectName }
 * @returns {object} ArtCraft 认的工程对象
 */
export function toArtCraft(state, opts = {}) {
  const fps = Number(state?.fps) || 24;
  const tracks = Array.isArray(state?.tracks) ? state.tracks : [];

  /**
   * ★ 只放【主场景】。ArtCraft 支持多场景，但我们的模型没有场景概念
   *   （我们是平铺的两条轨）。硬造多场景会引入我们的模型里不存在的状态。
   *   ⇒ 一个工程 = 一个主场景。
   */
  const elements = { video: [], audio: [] };
  for (const tr of tracks) {
    const type = tr.kind === "audio" ? "audio" : "video";
    let t = 0;
    for (const clip of tr.clips ?? []) {
      /**
       * ★ 顺序即时间：我们的模型里 clip 是按数组顺序线性排布的（没有显式
       *   startSec，我刚才那条 clip 上也没看到）。投影时按累计时长算起点。
       *
       * ★★ 2026-10-20 修：累计必须在【投影成功之后】做。
       *   第一版写的是「先累加、后投影」——
       *   于是「待生成」的 clip（被跳过、不投影）仍然吃掉了 5 秒时间轴，
       *   导致它在 ArtCraft 里的位置留下一个空洞（startTime 不从 0 开始）。
       *
       *   语义：只有真正出现在 ArtCraft 时间轴上的 clip 才占时间。
       *   待生成的 clip 在我们的时间轴上「等待生成」，不代表它已经占了 5 秒。
       */
      const el = clipToElement(clip, {
        fps,
        srcTag: clip.srcRoot,
        /**
         * ★ 把调用方的 mediaId 解析器透传下去（见 clipToElement 里那段说明）。
         *   opts.mediaIdOf 由 toArtCraft 的调用方提供 —— 那边有资产表。
         */
        mediaIdOf: opts.mediaIdOf,
      });
      if (!el) continue;                    // 投影不过去 ⇒ 不占时间

      /**
       * ★★ 2026-10-20 修：累加必须用 element 的【实际时长】，不是 out-in
       *
       *   实测（双 clip 验证）：第一个裁切到 1.5 秒、第二个完整 5 秒，
       *   结果两个 clip 之间出现 3.5 秒空隙，总时长 8 秒（应为 6.5）。
       *
       *   根因：`t += dur` 用的是 `out - in`（源素材全长 5 秒），
       *   而 `el.duration` 已按 trim 算成 1.5 秒。
       *   ⇒ 前一个 clip 在时间轴上只占 1.5 秒，游标却前进 5 秒 ⇒ 空隙。
       *
       *   语义：累加的应该是「这个 element 在时间轴上占多长」= el.duration，
       *   与 ArtCraft 的 duration 语义完全一致。
       */
      el.startTime = secToTime(t);           // 覆盖成累加值
      elements[type].push(el);
      t += timeToSec(el.duration);            // ★ 用 element 实际时长，不是 out-in
    }
  }

  const scene = {
    id: "scene_main",
    name: String(opts.sceneName ?? state?.name ?? "Main scene"),
    isMain: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    bookmarks: [],
    /**
     * ★★ 2026-10-20 修（实测报错：scene.tracks.overlay is not iterable）
     *
     *   ArtCraft 的 SceneTracks 不是「每条轨道一个数组」，而是：
     *     tracks: {
     *       overlay: [],        ← 叠加轨数组
     *       main: { … },        ← 【单个】主轨对象（不是数组！）
     *       audio: [],          ← 音频轨数组
     *     }
     *
     *   我最初写成 { video: [...], audio: [...] }：
     *     · video 这个键根本不存在，ArtCraft 找的是 main
     *     · overlay 缺失 ⇒ it iterate 时拿到 undefined
     *       ⇒ "scene.tracks.overlay is not iterable"
     *
     *   ★ 教训：「看起来对称的结构」不等于真实结构。
     *     video / audio 都是轨道，很容易想当然认为形状一样，
     *     实际是 main 单数、audio 复数。
     *     要看 ArtCraft 自己的 buildDefaultScene 怎么造，不能类比。
     *
     * ⚠ 这一处曾经被「同步」覆盖回去过一次 ——
     *   两份文件（工作台 timeline-projection.mjs / ArtCraft dsh-projection.ts）
     *   必须同时修，否则用 Copy-Item 单向覆盖时会丢掉修复。
     */
    tracks: {
      overlay: [],
      main: {
        id: "track_main",
        name: "Main Track",
        type: "video",
        elements: elements.video,
        muted: false,
        hidden: false,
      },
      audio: elements.audio.length
        ? [{
            id: "track_audio",
            name: "音频 1",
            type: "audio",
            elements: elements.audio,
            muted: false,
            hidden: false,
          }]
        : [],
    },
  };

  return {
    metadata: {
      id: String(opts.projectId ?? "wb_project"),
      name: String(state?.name ?? "未命名"),
      duration: secToTime(Math.max(
        elements.video.reduce((s, e) => s + timeToSec(e.duration), 0),
        elements.audio.reduce((s, e) => s + timeToSec(e.duration), 0),
      )),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    scenes: [scene],
    currentSceneId: scene.id,
    settings: {
      fps: fpsToRate(fps),
      canvasSize: { width: 1920, height: 1080 },
      background: { type: "color", color: "#000000" },
    },
    version: 1,
  };
}

/**
 * ArtCraft 改完 → 回写到我们的 state（只取时间/裁切/顺序）。
 *
 * ★ 这是【唯一允许从 ArtCraft 取数的路径】。它只碰：
 *     trim.startSec / trim.endSec / 顺序
 *   其余字段（shot / handoff / rendered / regenError…）原样不动。
 *
 * ★ 为什么只取这三样：
 *   ArtCraft 能编辑的能力里，只有「裁切」和「顺序」在我们的模型里有对应物。
 *   它还能加特效、动画面、改音量 —— 那些我们的模型没有，硬搬会造出
 *   「UI 上能调但后端不认」的摆设参数（这条是 M1 参数闭环验收专门防的）。
 *
 * @param {object} state   我们的 state（会被复制，不修改入参）
 * @param {object} project ArtCraft 改完的 TProject
 * @returns {{next: object, changed: string[]}}
 */
export function fromArtCraft(state, project) {
  const next = JSON.parse(JSON.stringify(state ?? {}));
  const changed = [];

  const scene = (project?.scenes ?? []).find((s) => s.isMain) ?? project?.scenes?.[0];
  if (!scene) return { next, changed };

  /**
   * ★ 2026-10-20 同步修：ArtCraft 主轨是 tracks.main（单个对象），
   *   不是 tracks.video（数组）。见 toArtCraft 里那段说明。
   */
  const vt = scene.tracks?.main ?? null;
  const at = (scene.tracks?.audio ?? [])[0];

  /** 用 element.id 找回我们对应的 clip，逐条更新 trim 与顺序。 */
  const apply = (track, ourKind) => {
    if (!track?.elements) return;
    const ourTrack = (next.tracks ?? []).find((t) => (t.kind ?? "video") === ourKind);
    if (!ourTrack) return;

    // ArtCraft 的 elements 顺序就是时间轴顺序 ⇒ 直接作为我们的新顺序
    const order = [];
    for (const el of track.elements) {
      const clip = (ourTrack.clips ?? []).find((c) => c.id === el.id);
      if (!clip) continue;

      const ts = Math.round(timeToSec(el.trimStart) * 1000) / 1000;
      const te = Math.round(timeToSec(el.trimEnd) * 1000) / 1000;
      const oldS = Number(clip.trim?.startSec) || 0;
      const oldE = Number(clip.trim?.endSec) || 0;
      if (ts !== oldS || te !== oldE) {
        clip.trim = { ...(clip.trim ?? {}), startSec: ts, endSec: te };
        changed.push(`${clip.id}.trim`);
      }
      order.push(clip);
    }

    /**
     * ★★ 2026-10-20 修（验收抓出来的真 bug）
     *
     *   第一版写的是 `newClips = [...order, ...rest]` ——
     *   把没能投影到 ArtCraft 的 clip（「待生成」那些）统统挪到末尾。
     *
     *   实测：
     *     原顺序  [分镜1(待生成), 分镜2(已生成)]
     *     order   [分镜2]        ← 只有能投影的
     *     rest    [分镜1]
     *     newClips[分镜2, 分镜1] ← 顺序被悄悄改了
     *
     *   语义错误：ArtCraft 看不到「待生成」的 clip，不代表用户希望它们被
     *   挪到最后。它们在我们的时间轴上位置是用户排的，不能被编辑器的
     *   「视野缺失」当成「删除」。
     *
     *   ⇒ 正确做法：用 ArtCraft 给出的相对顺序【原地填空】——
     *     遍历原数组，遇到能投影的就取 order 里的下一个，遇到不能的就原样保留。
     */
    const byId = new Map(order.map((c) => [c.id, c]));
    const projectedIds = new Set(order.map((c) => c.id));
    let oi = 0;
    const newClips = (ourTrack.clips ?? []).map((c) => {
      if (projectedIds.has(c.id)) return order[oi++];
      return c;                              // 没投影过去的：留在原位
    });
    const orderChanged = newClips.some((c, i) => c.id !== (ourTrack.clips ?? [])[i]?.id);
    if (orderChanged) {
      ourTrack.clips = newClips;
      changed.push(`${ourKind}.order`);
    }
  };

  apply(vt, "video");
  apply(at, "audio");

  return { next, changed };
}
