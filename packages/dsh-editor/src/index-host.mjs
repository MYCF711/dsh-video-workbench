/**
 * dsh-editor —— host 侧插件入口。
 * 装配四件事：
 * ① 权威时间轴状态（createTimelineStore）
 * ② SSE 推送（前端订阅）
 * ③ LLM 工具（Agent 操控）
 * ④ 前端命令路由（用户点按钮）—— 与 Agent 落在同一个 store
 * ⑤ 任务轮询器（把任务推进到完成）
 * ⑥ 导出（时间轴 → ffmpeg 一次成片）
 * ★ 人机协同的实现要点
 * Agent 走 ctx.tools，用户走 /timeline/cmd/*，但两者调用的
 * 是同一个 store 的方法。这样「谁改的」只体现在 history 的 who 字段，
 * 行为完全一致 —— 不会出现「Agent 能做的用户做不了」或反之。
 */
import fs from "node:fs";
import path from "node:path";
/* ★ 2026-10-23：把 URL 转本地路径必须用它 —— .pathname 不做 percent-decoding，
   含中文的路径会被编码成 %E4%B8%BB... 导致目录找不到。 */
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createTimelineStore } from "./host-store.mjs";
import { registerSse } from "./sse.mjs";
import { registerCommands } from "./commands.mjs";
import { buildTimelineTools } from "./tools-def.mjs";
import { createBridge } from "./bridge.mjs";
import { buildRenderCommand, commandLine } from "./render.mjs";
import { buildExtractAudioArgs, audioClipFromVideo, checkAvAlignment } from "./audio-split.mjs";
import { createPersister } from "./persist-host.mjs";
import { resolveFfmpeg as resolveFfmpegImpl, canRun, missingHint } from "./ffmpeg-resolver.mjs";
import { createAssetLibrary } from "./assets.mjs";
import { registerPromptGuard } from "./prompt-gate.mjs";

export const name = "dsh-editor";

/**
 * ★ 服务依赖（写服务名，不是包名）
 * webServer —— SSE 与命令路由
 * tools     —— LLM 工具注册
 */
export const inject = ["webServer", "tools"];

/**
 * 找 ffmpeg。委托给 resolver；另加一条兜底：本机装了 ComfyUI 时，
 * 它自带的 imageio_ffmpeg 里通常有可用二进制。
 */
async function resolveFfmpeg(log) {
  const r = await resolveFfmpegImpl({ log });
  if (r.bin) return r;

  const guesses = [
    process.env.COMFYUI_PATH ? path.join(process.env.COMFYUI_PATH, ".venv/Lib/site-packages/imageio_ffmpeg/binaries") : null,
    process.env.PYTHON_HOME ? path.join(process.env.PYTHON_HOME, "Lib/site-packages/imageio_ffmpeg/binaries") : null,
  ].filter(Boolean);

  for (const dir of guesses) {
    try {
      if (!fs.existsSync(dir)) continue
      const hit = fs.readdirSync(dir).find((n) => /^ffmpeg.*\.exe$|^ffmpeg$/.test(n))
      if (!hit) continue
      const full = path.join(dir, hit)
      const ok = await canRun(full)
      if (ok.ok) return { bin: full, source: "comfyui", version: ok.version }
    } catch { /* continue */ }
  }
  return r
 }

/** 跑 ffmpeg，返回 { code, stderr }。 */
function runFfmpeg(bin, args, timeoutMs = 30 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let err = "";
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stderr.on("data", (d) => { err += d.toString("utf8"); });
    child.on("error", (e) => { clearTimeout(timer); reject(new Error(`无法启动 ffmpeg：${e.message}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) return reject(new Error(`ffmpeg 超时（${timeoutMs / 1000}s）`));
      resolve({ code, stderr: err });
    });
  });
}

/**
 * 探测一段媒体有没有音轨。
 * 用 ffmpeg -i 读 stderr（本机没单独装 ffprobe）。
 */
async function probeMedia(bin, file) {
  const r = await new Promise((resolve, reject) => {
    const child = spawn(bin, ["-hide_banner", "-i", file], { windowsHide: true });
    let out = "";
    child.stderr.on("data", (d) => { out += d.toString("utf8"); });
    child.on("error", reject);
    child.on("close", () => resolve(out));
  });
  const durM = r.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  const vLine = (r.split("\n").find((l) => /Video:/.test(l)) ?? "").replace(/\([^)]*\)/g, " ");
  const sizeM = /(\d{2,5})x(\d{2,5})/.exec(vLine);
  return {
    hasAudio: /Audio:/.test(r),
    hasVideo: /Video:/.test(r),
    width: sizeM ? Number(sizeM[1]) : null,
    height: sizeM ? Number(sizeM[2]) : null,
    durationSec: durM ? Number(durM[1]) * 3600 + Number(durM[2]) * 60 + Number(durM[3]) : null,
  };
}

/**
 * ★ 把成片引用解析成【本地文件路径】。
 * 实测踩过的坑（2026-10-17 e2e）：
 * host 直接把 rendered.url（= /api/view?filename=...）喂给 ffmpeg，
 * 报 "Error opening input: No such file or directory" ——
 * 那是 ComfyUI 的 HTTP 接口，不是磁盘文件。
 * 三种情况：
 * ① path 是本地绝对路径且存在  → 直接用
 * ② url 是 http(s)              → 下载到缓存目录再用
 * ③ url 是相对路径              → 拼 ComfyUI 的 origin 再下载
 */
async function materialize(clip, { comfyOrigin, cacheDir, index }) {
  const r = clip.rendered ?? {};

  if (r.path && fs.existsSync(r.path)) return { file: r.path, kind: guessKind(r.path) };

  const ref = r.url ?? r.path;
  if (!ref) throw new Error(`片段「${clip.name}」没有成片引用`);

  let url;
  if (/^https?:\/\//.test(ref)) url = ref;
  else url = String(comfyOrigin).replace(/\/+$/, "") + (ref.startsWith("/") ? ref : "/" + ref);

  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

  let base = r.filename;
  if (!base) {
    try { base = new URL(url).searchParams.get("filename"); } catch { /* fall through */ }
  }
  if (!base) base = `clip-${index}`;
  const ext = guessKindExt(base);
  const dest = path.join(cacheDir, `src-${String(index).padStart(3, "0")}-${Date.now()}${ext}`);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载成片失败 HTTP ${res.status}：${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error(`下载到 0 字节：${url}`);
  fs.writeFileSync(dest, buf);
  return { file: dest, kind: guessKind(dest) };
}

function guessKindExt(name) {
  const m = /\.[a-z0-9]+$/i.exec(String(name ?? ""));
  return m ? m[0].toLowerCase() : ".bin";
}

function guessKind(p) {
  const e = guessKindExt(p);
  if ([".png", ".jpg", ".jpeg", ".webp", ".bmp"].includes(e)) return "image";
  if ([".mp4", ".webm", ".mov", ".mkv"].includes(e)) return "video";
  if ([".m4a", ".mp3", ".wav", ".aac", ".flac"].includes(e)) return "audio";
  return "unknown";
}

/**
 * ★ 图片要“拉长”成视频才能拼进时间轴。
 * 实测（2026-10-17 e2e）：krea2 出的是 PNG 静态图，
 * 直接当视频素材喂给 concat 会失败（没有时长概念）。
 * ⇒ 先用 ffmpeg 把图转成「指定时长的视频」再用。
 */
async function imageToVideo(bin, imagePath, outPath, durationSec, fps = 24) {
  const args = [
    "-y", "-loop", "1", "-i", imagePath,
    "-t", String(durationSec),
    "-vf", `scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=${fps},format=yuv420p`,
    "-r", String(fps),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    outPath,
  ];
  const r = await runFfmpeg(bin, args);
  if (r.code !== 0) {
    const tail = r.stderr.split("\n").filter(Boolean).slice(-6).join("\n");
    throw new Error(`图片转视频失败：${tail}`);
  }
  return outPath;
}

export async function apply(ctx, config = {}) {
  const log = ctx?.logger ?? console;
  const prefix = config.routePrefix ?? "/timeline";
  const comfyPrefix = config.comfyPrefix ?? "/comfy-bridge";
  const pollMs = config.pollMs ?? 2000;
  /**
   * 产物与存档目录。
   *
   * ★ 2026-10-18 修真缺陷（重启丢数据）：
   *   原来写 `path.join(process.cwd(), "outputs")` —— 依赖宿主进程的工作目录。
   *   实测：Start-Process 起的 DSH 没指定 cwd，于是写到了别处，
   *   重启后 ser 找不到存档 ⇒ 时间轴变空（实测 snapshot video(0)，
   *   而磁盘上明明有 4 段）。
   *
   *   改成【基于本文件位置】推导，与 cwd 无关：
   *     src/index-host.mjs → 往上三级 = 工作区根（D:\主工作区）
   *   也兼容显式配置：config.outputDir / 环境变量 TIMELINE_OUT_DIR。
   *
   * ★ 还要兜旧路径：之前已经写到过 cwd/outputs 与 dsh-editor/outputs 两处，
   *   直接换路径会让老存档「消失」。所以启动时按优先级找第一个存在的。
   */
  /**
   * ★★ 2026-10-23 修：中文路径被 URL 编码 ⇒ outDir 落到不存在的目录
   *
   *   原来写的是：
   *     new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")
   *
   *   `.pathname` 【不做 percent-decoding】。包一旦放在含中文的路径下
   *   （如 D:\主工作区\DSH视频工作台\packages\dsh-editor），得到的是：
   *     D:\%E4%B8%BB%E5%B7%A5%E4%BD%9C%E5%8C%BA\...\outputs
   *   ⇒ pickOutDir() 的候选目录全都不存在，
   *     assets.json 读不到 ⇒ /timeline/assets 恒为 0、src=editor 恒 0 条。
   *   实测印证：[DIAG] outDir=D:\%E4%B8%BB%E5%B7%A5...\outputs
   *
   *   ⇒ 改用官方 API fileURLToPath()，它内部做 percent-decoding。
   *     ★ .pathname 只适合 URL 内部处理，不能当文件路径用。
   */
  const HERE_DIR = path.dirname(fileURLToPath(import.meta.url));
  const WORKSPACE_ROOT = path.resolve(HERE_DIR, "..", "..", "..");
  const PKG_DIR = path.resolve(HERE_DIR, "..");

  function pickOutDir() {
    if (config.outputDir) return config.outputDir;
    if (process.env.TIMELINE_OUT_DIR) return process.env.TIMELINE_OUT_DIR;
    // 候选（按优先级）：工作区根 / 插件包目录 / 旧 cwd
    const cands = [
      path.join(WORKSPACE_ROOT, "outputs"),
      path.join(PKG_DIR, "outputs"),
      path.join(process.cwd(), "outputs"),
    ];
    const fsMod = fs;   // 顶部已 import
    for (const c of cands) {
      try {
        if (fsMod.existsSync(path.join(c, "timeline-state.json"))) return c;
      } catch { /* 忽略 */ }
    }
    return cands[0];   // 都没有 → 用工作区根
  }
  const outDir = pickOutDir();
  // ★ 缓存目录在 apply 作用域里定义 —— onExport 与 splitAudioFor 都要用
  //   （第一版把它定义在 onExport 内部，splitAudioFor 引用时会 undefined）
  const cacheDir = path.join(outDir, ".cache");

  const store = createTimelineStore({ log });
  // ★ bridge 需要【绝对 URL】——host 侧没有 origin，
  //   fetch("/comfy-bridge/generate") 会报
  //   "Failed to parse URL from /comfy-bridge/generate"（实测踩过）
  const ownPort = ctx?.webServer?.port ?? process.env.DSH_WEB_PORT ?? "19387";
  const ownBase = config.selfBaseUrl ?? `http://127.0.0.1:${ownPort}`;
  const bridge = createBridge(comfyPrefix, ownBase);
  log.info?.(`[${name}] 自指地址 ${ownBase}（用于调 /comfy-bridge/*）`);

  // ★ 本轮暴露的真问题（2026-10-17）：store 在内存里，
  const stateFile = config.stateFile ?? path.join(outDir, "timeline-state.json");
  const persister = createPersister({ file: stateFile, store, log, debounceMs: 1500 });
  const restored = persister.load();
  if (restored.ok) {
    log.info?.(`[${name}] 已从 ${stateFile} 恢复 ${restored.clips} 段`);
  } else {
    log.info?.(`[${name}] 无历史存档（${restored.reason}），从空开始`);
  }

  // ★ 索引与时间轴状态分开存
  const assetIndex = config.assetIndex ?? path.join(outDir, "assets.json");
  const assets = createAssetLibrary({ indexFile: assetIndex, log });
  const al = assets.load();
  if (al.ok) log.info?.(`[${name}] 素材库已加载 ${al.count} 项`);
  else log.info?.(`[${name}] 素材库为空（${al.reason}）`);

  // ④ SSE
  const disposeSse = registerSse(ctx, store, {
    prefix, log, assets, outDir, cacheDir,
    // ★ 允许预览工作区里的素材（docs/evidence 等）
    // ★ 不放开任意路径 —— 只靠 outputs/.cache/素材库白名单，
    //   ① 只允许 outputs → docs/evidence 403（实测）
    //   ② 用 process.cwd() 兜底 → DSH 进程 cwd 不是项目根，还是 403（实测）
    extraAllowedDirs: config.extraAllowedDirs ?? [],
    // ★ 预览要用绝对 origin 拼 /api/view —— host 侧没有相对路径的概念
    get comfyOrigin() { return bridge.comfyOrigin; },
  });

  // ② 导出：时间轴 → ffmpeg → 成片
  // ★ 为什么导出要等「全部段都就绪」
  const onExport = async (snapshot, summaryInfo, exportOpts = {}) => {
    if (!summaryInfo.exportable) {
      throw new Error(
        `还不能导出：${summaryInfo.pending} 段未生成 / ${summaryInfo.failed} 段失败 / ${summaryInfo.running} 段在跑`
      );
    }
    const resolved = await resolveFfmpeg(log);
    const bin = resolved.bin;
    if (!bin) throw new Error(missingHint(resolved));

    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

    // ★ 步骤 1：把所有成片引用解析成【本地文件】
    //   （URL 不能直接喂 ffmpeg，实测报 No such file or directory）
    const videoTracks = snapshot.tracks.filter((t) => t.kind === "video");
    const srcTrack = videoTracks[0];
    if (!srcTrack) throw new Error("没有视频轨");

    const prepared = [];
    for (let i = 0; i < srcTrack.clips.length; i++) {
      const c = srcTrack.clips[i];
      const m = await materialize(c, { comfyOrigin: bridge.comfyOrigin, cacheDir, index: i });
      let file = m.file;
      let kind = m.kind;

      // ★ 步骤 2：图片要转成视频
      //   krea2 出 PNG，没有时长概念，必须先做成指定时长的视频
      if (kind === "image") {
        const dur = (c.out - c.in) / (c.speed || 1);
        const vidPath = path.join(cacheDir, `img2vid-${i}-${Date.now()}.mp4`);
        await imageToVideo(bin, file, vidPath, Math.max(0.1, dur), snapshot.fps ?? 24);
        file = vidPath;
        kind = "video";
      }
      if (kind !== "video" && kind !== "audio") {
        throw new Error(`片段「${c.name}」的类型不支持导出：${kind}（${file}）`);
      }
      // ★ 探测这段素材到底有没有音轨、以及尺寸
      const pr = await probeMedia(bin, file);
      prepared.push({ clip: c, file, kind, hasAudio: pr.hasAudio, w: pr.width, h: pr.height });
    }

    // ★ 步骤 3：用准备好的本地文件生成渲染命令
    //   注意 in/out 要改成「0 ~ 转换后的时长」——
    const audioTracks = snapshot.tracks.filter((t) => t.kind === "audio");
    const audioClips = audioTracks.flatMap((t) => t.clips);
    const preparedAudio = [];
    for (let i = 0; i < audioClips.length; i++) {
      const ac = audioClips[i];
      try {
        const m = await materialize(ac, { comfyOrigin: bridge.comfyOrigin, cacheDir, index: 500 + i });
        const e = ac.audioEdit ?? {};
        // ★ 按「淡入淡出 → 音量」的正确顺序算滤镜（见 audio-edit.mjs 注释）
        const base = (ac.out - ac.in) / (ac.speed > 0 ? ac.speed : 1);
        const dur = ac.trim
          ? Math.max(0, Math.min(ac.trim.endSec, base) - Math.min(ac.trim.startSec, base))
          : base;
        const filters = e.muted ? ["volume=0"] : (() => {
          const f = [];
          if (Number(e.fadeInSec) > 0) f.push(`afade=t=in:st=0:d=${Number(e.fadeInSec)}`);
          if (Number(e.fadeOutSec) > 0 && dur > 0) {
            f.push(`afade=t=out:st=${Math.max(0, dur - Number(e.fadeOutSec))}:d=${Number(e.fadeOutSec)}`);
          }
          return f;
        })();
        preparedAudio.push({
          src: m.file,
          in: 0,
          out: dur,
          speed: 1,
          trim: ac.trim,
          gain: Number(e.gain ?? 1),
          audioFilters: filters,
          hasAudio: true,
        });
      } catch (err) {
        log.warn?.(`[${name}] 准备音频片段失败（${ac.name}）：${err.message}`);
      }
    }

    // ★ 音画对齐：音频总长必须等于视频总长
    //
    // 实测踩到（2026-10-17）：视频 16s、音频只有 2.3s，
    // concat 后音画不等长，编码器报
    //   "Could not open encoder before EOF" / "Invalid argument" / 输出 0 字节
    // ⇒ 音频短就补静音，长就裁掉。
    const videoTotal = prepared.reduce(
      (s, p) => s + (p.clip.out - p.clip.in) / (p.clip.speed || 1), 0
    );
    const audioTotal = preparedAudio.reduce((s, a) => s + a.out, 0);

    if (videoTotal > 0.01 && Math.abs(audioTotal - videoTotal) > 0.05) {
      if (audioTotal < videoTotal) {
        const pad = Math.round((videoTotal - audioTotal) * 1000) / 1000;
        preparedAudio.push({
          src: null, in: 0, out: pad, speed: 1, trim: null, gain: 1,
          audioFilters: [], hasAudio: true, silent: true,
        });
        log.info?.(`[${name}] 音频比视频短 ${pad}s，补静音`);
      } else {
        // 太长就裁最后一段
        let excess = audioTotal - videoTotal;
        while (excess > 0.05 && preparedAudio.length) {
          const last = preparedAudio[preparedAudio.length - 1];
          if (last.out <= excess + 0.05) {
            excess -= last.out;
            preparedAudio.pop();
          } else {
            last.out = Math.max(0.05, last.out - excess);
            excess = 0;
          }
        }
        log.info?.(`[${name}] 音频比视频长，裁到 ${videoTotal.toFixed(2)}s`);
      }
    }

    // ★ 多段尺寸不一致时，concat 会报 size do not match（实测）
    //   统一到所有片段里的最大尺寸，保持比例（不足的补黑边）
    const sizes = prepared.map((p) => ({ w: p.w, h: p.h })).filter((s) => s.w && s.h);
    const targetSize = sizes.length > 1
      ? {
          w: Math.max(...sizes.map((s) => s.w)) & ~1,   // 偶数化，yuv420p 要求
          h: Math.max(...sizes.map((s) => s.h)) & ~1,
        }
      : null;

    const tl = {
      fps: snapshot.fps ?? 24,
      tracks: [
        {
          id: srcTrack.id, kind: "video", name: srcTrack.name,
          clips: prepared.map((p) => {
            const dur = (p.clip.out - p.clip.in) / (p.clip.speed || 1);
            return {
              src: p.file,
              in: 0,
              out: dur,
              speed: 1,               // 变速已在转换时体现，这里不再重复
              crop: null,             // 画面裁剪已在渲染命令里做（见下）
              gain: p.clip.gain,
              trim: p.clip.trim,
              hasAudio: p.hasAudio,   // ★ 渲染器据此决定用原音轨还是补静音
              _origCrop: p.clip.crop,
            };
          }),
        },
        ...(preparedAudio.length ? [{
          id: "audio-track", kind: "audio", name: "音频",
          clips: preparedAudio,
        }] : []),
      ],
    };

    const outFile = path.join(outDir, `roughcut-${Date.now()}.mp4`);
    // ★ 2026-10-18（F8）：把 transition 透传下去。不传 = 硬切，行为不变。
    const built = buildRenderCommand(tl, {
      out: outFile,
      targetSize,
      transition: exportOpts.transition ?? null,
    });

    log.info?.(
      `[${name}] 开始导出：${built.videoSegments} 段，期望 ${built.expectedDuration?.toFixed(2)}s` +
      (built.xfade ? `，转场 ${built.xfade.type}×${built.xfade.applied}（${built.xfade.sec}s）` : "")
    );
    const r = await runFfmpeg(bin, built.args);
    if (r.code !== 0) {
      const tail = r.stderr.split("\n").filter(Boolean).slice(-8).join("\n");
      throw new Error(`ffmpeg 退出 ${r.code}\n${tail}\n命令：${commandLine(bin, built.args)}`);
    }
    const size = fs.existsSync(outFile) ? fs.statSync(outFile).size : 0;
    log.info?.(`[${name}] 导出完成：${outFile}（${(size / 1024).toFixed(0)} KB）`);
    return {
      ok: true, path: outFile, sizeBytes: size,
      expectedDuration: built.expectedDuration,
      // ★ 2026-10-18（F8）：转场信息要回传，否则调用方不知道时长为什么变短了
      xfade: built.xfade ?? null,
      timelineDuration: built.timelineDuration ?? built.expectedDuration,
      durationSec: built.expectedDuration,
      segments: prepared.length,
      warn: built.warn,
    };
  };

  const disposeCmd = registerCommands(ctx, store, { prefix, log, bridge, onExport, assets });

  let disposeTools = () => {};
  let disposeGuard = () => {};
  if (typeof ctx?.tools?.register === "function") {
    const defineTool = ctx.tools.defineTool ?? globalThis.__dshDefineTool;
    if (typeof defineTool === "function") {
      try {
        const defs = buildTimelineTools(store, { defineTool, bridge });

        defs.push(defineTool({
          name: "timeline_export",
          description:
            "把整条时间轴合成成片（ffmpeg 一次渲染）。" +
            "★ 只有所有段都就绪才能导出 —— 有未生成/失败/在跑的段会报错并说明是哪几段。" +
            "可选加段间转场（xfade）；不加就是硬切。" +
            "★ 注意：转场会【缩短总时长】（每处吃掉 sec 秒），返回里会说明少了多少。",
          parameters: {
            type: "object",
            properties: {
              transition: {
                type: "object",
                description: "段间转场。不传=硬切。",
                properties: {
                  type: {
                    type: "string",
                    description: "fade/dissolve/slideleft/circleopen/fadeblack 等（共 58 种）",
                  },
                  sec: { type: "number", description: "每处转场时长（秒），默认 0.4" },
                },
                required: ["type"],
                additionalProperties: false,
              },
            },
            additionalProperties: false,
          },
          output: { schema: { type: "object" }, render: (a, v) => [{ type: "text", text: `已导出 ${v.path}` }] },
          execute: async ({ transition } = {}) => onExport(store.snapshot(), store.summary(), { transition }),
        }));

        // ★ 2026-10-18（F1 角色卡）：把角色定妆图自动填进参考图槽。
        defs.push(defineTool({
          name: "timeline_cast_characters",
          description:
            "把素材库里标了角色的定妆图自动填进某一镜的参考图槽。" +
            "素材在素材库里打上 tags: [\"role:character\", \"char:<角色名>\"] 即可被识别。" +
            "已占用的槽不会被覆盖（用户手选的图优先）。",
          parameters: {
            type: "object",
            properties: {
              clipId: { type: "string", description: "目标片段 id" },
              characters: { type: "array", items: { type: "string" }, description: "要上场的角色名（按顺序填槽）" },
              perCharacter: { type: "number", description: "每个角色最多用几张定妆图（默认 1）" },
            },
            required: ["clipId", "characters"],
            additionalProperties: false,
          },
          output: {
            schema: { type: "object" },
            render: (a, v) => textOut(v.summary ?? "角色已上场"),
          },
          execute: async ({ clipId, characters, perCharacter }) => {
            if (!assets) throw new Error("素材库未接入");
            const mod = await import("./characters.mjs");
            // ★ assets.list() 返回数组（不是 {items}）
            const items = assets.list({ limit: 100000 });
            const grouped = mod.groupByCharacter(items);

            const snap = store.snapshot();
            let clip = null;
            for (const t of snap.tracks ?? []) {
              const found = (t.clips ?? []).find((c) => c.id === clipId);
              if (found) { clip = found; break; }
            }
            if (!clip) throw new Error("找不到片段：" + clipId);

            const slots = ["ref_image_0","ref_image_1","ref_image_2","ref_image_3","ref_image_4","ref_image_5"];

            const r = mod.injectCharacters({
              characters: grouped,
              names: characters,
              slots,
              files: clip.shot?.media ?? {},
              perCharacter: perCharacter ?? 1,
            });

            if (r.assigned.length) {
              const media = { ...(clip.shot?.media ?? {}) };
              for (const [slot, val] of Object.entries(r.filled)) media[slot] = val;
              store.updateShot(clipId, { media }, "agent");
            }

            const names = r.assigned.map((x) => x.character).join("、");
            return Object.assign({}, r, {
              summary: r.ok
                ? "已上场 " + r.assigned.length + " 张定妆图：" + names
                : (r.warnings[0] ?? "没有可上场的角色"),
            });
          },
        }));
        defs.push(defineTool({
          name: "assets_scan",
          description:
            "扫描一个目录，把里面的文件批量登记进素材库。" +
            "用于「把 outputs 里的成片都收进来」或「导入一批参考图」。" +
            "⚠ 要按分类管理资产库，用 assets_scan_root 更合适（它只认根目录下的分类子目录）。",
          parameters: {
            type: "object",
            properties: {
              dir: { type: "string", description: "目录路径" },
              group: { type: "string", description: "分组名（可选，如 角色/场景/配音）" },
              exts: { type: "array", items: { type: "string" }, description: "只收这些扩展名（可选）" },
            },
            required: ["dir"],
            additionalProperties: false,
          },
          output: { schema: { type: "object" }, render: (a, v) => [{ type: "text", text: `登记 ${v.count} 项` }] },
          execute: async ({ dir, group, exts }) => {
            const added = assets.scanDir(dir, { group, exts, source: "import" });
            return { count: added.length, items: added.map((x) => ({ id: x.id, name: x.name, kind: x.kind })) };
          },
        }));

        // ★★ 2026-10-19 新增（主人：「资产库需要在一个可以指定的目录位置。
        //    这个目录做好分类，其他地方的不要弄进去」）
        //
        // 与 assets_scan 的分工：
        //   assets_scan_root  ← 推荐的日常入口，边界清晰（只认根目录 + 分类子目录）
        //   assets_scan       ← 临时收一批（比如刚导出的成片），不设边界
        defs.push(defineTool({
          name: "assets_scan_root",
          description:
            "按【资产库根目录】入库：只扫 <root>/图片、<root>/视频、<root>/音频、" +
            "<root>/文本、<root>/其他 五个分类子目录，以及根目录下的散落文件。" +
            "别处的文件不会被收进来 —— 要收就先移进这个根目录。" +
            "返回每一类的数量，便于确认分类是否正确。",
          parameters: {
            type: "object",
            properties: {
              root: { type: "string", description: "资产库根目录（绝对路径）" },
            },
            required: ["root"],
            additionalProperties: false,
          },
          output: {
            schema: { type: "object" },
            render: (a, v) => {
              const b = v.byKind ?? {};
              const parts = Object.entries(b).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`);
              return [{ type: "text", text: `登记 ${v.count} 项（${parts.join(" / ") || "无"}）` }];
            },
          },
          execute: async ({ root }) => {
            const r = assets.scanRoot(root);
            return {
              root: r.root,
              count: r.added.length,
              byKind: r.byKind,
              skipped: r.skipped.slice(0, 20),
              items: r.added.map((x) => ({ id: x.id, name: x.name, kind: x.kind, group: x.group })),
            };
          },
        }));

        defs.push(defineTool({
          name: "assets_list",
          description:
            "查询素材库。可按种类/分组/标签/关键字过滤。" +
            "返回每项的 id、路径、种类、大小、标签，用于后续引用或找成片。",
          parameters: {
            type: "object",
            properties: {
              kind: { type: "string", description: "image | video | audio | text | other" },
              group: { type: "string" },
              tag: { type: "string" },
              q: { type: "string", description: "关键字（匹配名字/路径/标签）" },
            },
            additionalProperties: false,
          },
          output: { schema: { type: "array" }, render: (a, v) => [{ type: "text", text: `共 ${v.length} 项` }] },
          execute: async ({ kind, group, tag, q }) => {
            return assets.list({ kind, group, tag, q }).map((a) => ({
              id: a.id, name: a.name, path: a.path, kind: a.kind,
              sizeMB: Math.round((a.sizeBytes / 1024 / 1024) * 10) / 10,
              group: a.group, tags: a.tags, source: a.source,
            }));
          },
        }));

        defs.push(defineTool({
          name: "assets_diagnose",
          description:
            "素材库体检：总览（数量/占用空间）、缺失文件（索引里有但磁盘没了）、重复文件（内容相同）。",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          output: { schema: { type: "object" }, render: (a, v) => [{ type: "text", text: `共 ${v.stats.total} 项，${v.stats.totalMB}MB` }] },
          execute: async () => ({
            stats: assets.stats(),
            missing: assets.findMissing().map((a) => ({ id: a.id, name: a.name, path: a.path })),
            duplicates: assets.findDuplicates(),
          }),
        }));

        defs.push(defineTool({
          name: "assets_use_in_timeline",
          description:
            "把一个素材挂到时间轴的指定片段上（单段替换）。" +
            "用于「这段用素材库里那个文件」或「把生成的成片换回来」。",
          parameters: {
            type: "object",
            properties: {
              assetId: { type: "string", description: "素材 id（从 assets_list 拿）" },
              clipId: { type: "string", description: "目标片段 id（从 timeline_list_clips 拿）" },
            },
            required: ["assetId", "clipId"],
            additionalProperties: false,
          },
          output: { schema: { type: "object" }, render: (a, v) => [{ type: "text", text: `已挂上 ${v.name}` }] },
          execute: async ({ assetId, clipId }) => {
            const a = assets.get(assetId);
            if (!a) throw new Error(`素材不存在：${assetId}`);
            if (!fs.existsSync(a.path)) throw new Error(`素材文件已不在：${a.path}`);
            const c = store.replaceRendered(clipId, { path: a.path, filename: a.name }, "agent");
            return { clipId: c.id, name: a.name, path: a.path };
          },
        }));

        const ds = defs.map((d) => ctx.tools.register(d));
        disposeTools = () => { for (const d of ds) d?.(); };
        log.info?.(`[${name}] 已注册 ${defs.length} 个工具`);
        // ★ 提示词闸门：拦 Agent 绕过校验直接改 prompt / 直接 generate
        disposeGuard = registerPromptGuard(ctx, { log });
      } catch (err) {
        log.warn?.(`[${name}] 工具注册失败：${err.message}`);
      }
    } else {
      log.warn?.(`[${name}] ctx.tools 无 defineTool，工具未注册`);
    }
  } else {
    log.warn?.(`[${name}] ctx.tools 不可用，工具未注册`);
  }

  // ★ 任务完成后不只改状态，还要【分离音轨】
  const fails = new Map();

/**
 * /**
 * 把一段视频的原声分离到音频轨。
 * 失败不致命（不阻断主流程），但会记警告。
 */
  async function splitAudioFor(clipId) {
    try {
      const snap = store.snapshot();
      let vClip = null;
      for (const tr of snap.tracks) {
        const c = tr.clips.find((x) => x.id === clipId);
        if (c) { vClip = c; break; }
      }
      if (!vClip?.rendered) return null;
      const aTracks = snap.tracks.filter((t) => t.kind === "audio");
      if (aTracks.some((t) => t.clips.some((c) => c.fromVideoClipId === clipId))) return null;

      const bin = (await resolveFfmpeg(log)).bin;
      if (!bin) return null;

      if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
      const m = await materialize(vClip, { comfyOrigin: bridge.comfyOrigin, cacheDir, index: 900 });
      const pr = await probeMedia(bin, m.file);
      if (!pr.hasAudio) return null;  // 这段本来就没声音（如图片转的）

      const audioPath = path.join(cacheDir, `audio-${clipId}-${Date.now()}.m4a`);
      const args = buildExtractAudioArgs(m.file, audioPath, {
        inSec: vClip.in,
        durSec: vClip.out - vClip.in,
      });
      const r = await runFfmpeg(bin, args);
      if (r.code !== 0) {
        const tail = r.stderr.split("\n").filter(Boolean).slice(-4).join("\n");
        log.warn?.(`[${name}] 分离音轨失败 clip=${clipId}：${tail}`);
        return null;
      }

      const ap = await probeMedia(bin, audioPath);
      store.addAudioFromVideo(clipId, {
        path: audioPath,
        filename: path.basename(audioPath),
        durationSec: ap.durationSec,
      }, "host");
      log.info?.(`[${name}] 已分离音轨 clip=${clipId} → ${path.basename(audioPath)}（${ap.durationSec?.toFixed(2) ?? "?"}s）`);
      return audioPath;
    } catch (err) {
      log.warn?.(`[${name}] 分离音轨异常 clip=${clipId}：${err.message}`);
      return null;
    }
  }

  const timer = setInterval(async () => {
    for (const { jobId, clipId } of store.runningJobs()) {
      try {
        const h = await bridge.job(jobId);
        // ★★ 2026-10-19 修：completed 现在表示「结束了吗」，包含 error/failed/cancelled。
        //   必须再看 statusStr 才能区分「成功结束」与「失败结束」。
        const okEnd = h.completed && (h.statusStr ?? "success") === "success";
        const badEnd = h.completed && !okEnd;
        if (okEnd) {
          store.completeJob(jobId, { outputs: h.outputs ?? [], elapsedMs: h.elapsedMs }, "host");
          log.info?.(`[${name}] 任务完成 job=${jobId} clip=${clipId}`);
          // ★ 完成后立刻分离音轨
          splitAudioFor(clipId).catch(() => {});
        } else if (badEnd) {
          store.failJob(jobId, `生成失败（ComfyUI status=${h.statusStr ?? "?"}）`, "host");
          log.warn?.(`[${name}] 任务失败 job=${jobId} clip=${clipId} status=${h.statusStr}`);
          fails.delete(jobId);
        } else if (h.lost) {
          // ★★ 2026-10-19 修（真缺陷）：任务「已失去」必须当失败处理。
          //
          //   bridge 的 job() 有这个分支（index.js:469）：
          //     任务既不在 running 也不在 pending，且没有 history
          //     ⇒ { completed: false, statusStr: "lost", lost: true,
          //         reason: "任务已不在 ComfyUI 队列里，且没有 history" }
          //     它修的是「interrupt 不写 history ⇒ 前端永久轮询」。
          //
          //   但本文件的轮询器只判 h.completed：
          //     if (completed) {...} else { progressJob() }
          //   ⇒ lost 被当成「还在跑」⇒ progressJob 把 status 标成 running
          //   ⇒ clip 永远停在 running ⇒ exportable 永远 false
          //   ⇒ 用户导不出片，界面显示「生成中」，无从判断。
          //
          //   bridge 修了一半，store 这一半没接上。
          store.failJob(jobId, h.reason ?? "任务已不在 ComfyUI 队列里（可能被中断或重启清掉）", "host");
          log.warn?.(`[${name}] 任务已失去 job=${jobId} clip=${clipId}：${h.reason ?? "lost"}`);
          fails.delete(jobId);
        } else {
          store.progressJob(jobId);
        }
        fails.delete(jobId);
      } catch (err) {
        const n = (fails.get(jobId) ?? 0) + 1;
        fails.set(jobId, n);
        if (n >= 3) {
          store.failJob(jobId, err.message, "host");
          fails.delete(jobId);
          log.warn?.(`[${name}] 任务失败 job=${jobId}：${err.message}`);
        }
      }
    }
  }, pollMs);
  if (typeof timer.unref === "function") timer.unref();

  // ★ cordis 不允许直接往 ctx 上挂属性：
  //     → Error: cannot set property "timelineStore" without provide
  //   （实测 2026-10-17 在 comfy-test 实例上踩到）
  //   ⇒ 必须走 ctx.provide(name, value)，它内部用 fiber.effect 注册，
  if (typeof ctx?.provide === "function") {
    ctx.provide("timelineStore", store);
    ctx.provide("timelineBridge", bridge);
  } else if (typeof ctx?.reflect?.provide === "function") {
    ctx.reflect.provide("timelineStore", store);
    ctx.reflect.provide("timelineBridge", bridge);
  } else {
    log.warn?.(`[${name}] 没有 provide，状态未对外暴露（不影响 SSE 与工具）`);
  }

  log.info?.(`[${name}] 就绪：前缀 ${prefix}，轮询 ${pollMs}ms，导出目录 ${outDir}`);

  return () => {
    clearInterval(timer);
    try { persister.dispose(); } catch { /* ignore */ }
    disposeGuard();
    disposeTools();
    disposeCmd();
    disposeSse();
  };
}

export { createTimelineStore, createBridge, buildTimelineTools, registerSse, registerCommands };


