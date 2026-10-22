/**
 * 字幕生成 —— F9（外部源调研 P0）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 解决什么问题
 *   AI 生成的视频有音轨，但没人听得清说的是什么 —— 尤其短剧里
 *   手机外放/嘈杂环境下。字幕是最低成本的可读性提升。
 *   调研结论：「依赖全在本机、零云端、缺口 100%」。
 * ══════════════════════════════════════════════════════════════════════
 *
 * ★ 本机实测（2026-10-18）：
 *   · faster_whisper 1.2.1 可 import（Python 3.13）
 *   · 模型已在 HF 缓存里，不用下载：
 *       C:\Users\<user>\.cache\huggingface\hub\models--Systran--faster-whisper-small
 *       463.7MB，完整（model.bin 461.1MB + tokenizer + vocabulary）
 *   · 实测转写 yz 产物音轨：
 *       模型加载 14.1s / 转写 1.8s / 语言检测 zh p=1.00
 *       [0.00 -> 1.40] 好吧 那我先等着
 *
 * ★ 为什么不用 ComfyUI 的 VRGDG_TranscribeText：
 *   读了它的源码（custom_nodes/comfyui-vrgamedevgirl/nodes.py:1146）——
 *   它用 openai/whisper-large-v3（3.1GB，首次要下载），
 *   而且 RETURN_NAMES 只有一个 "transcription" 字符串，
 *   【没有时间轴】。字幕必须要 start/end，所以不能用它。
 *
 * ★ 为什么走子进程而不是 node 里直接调：
 *   faster-whisper 是 Python 库，node 没法直接 import。
 *   两条路：(a) 起 python 子进程跑脚本，(b) 常驻 Python 服务。
 *   选 (a)：一次转写加载模型 14s 可以接受，常驻服务要多管一个进程
 *   和端口，还多一处会挂的地方。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

/**
 * ★★ 2026-10-23 去敏：不再写死本机 ffmpeg 路径
 *
 *   原来默认值是 "D:\主工作区\DSH视频工作站\packages\dsh-editor\bin\ffmpeg.exe"
 *   —— 那是开发机位置，新 PC 上必然不存在。
 *
 *   现在顺序：
 *     ① 环境变量 FFMPEG_PATH（用户显式指定）
 *     ② dsh-editor 的 resolver（它会找：包内 bin/ → ComfyUI 的 imageio-ffmpeg → PATH）
 *     ③ 裸 "ffmpeg"（让系统 PATH 决定）
 *
 *   ★ 用同步的 bundledPath() 做「存在才用」，避免为了一个路径把整个模块改成 async。
 *     真正的完整解析（含 ComfyUI 兜底）在调用处通过 resolveFfmpeg() 完成。
 */
const FFMPEG = (() => {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  /**
   * ★★ 2026-10-23 修正：第一版简化成 process.env.FFMPEG_PATH ?? "ffmpeg"，
   *   去敏对了但实测【PATH 里没有 ffmpeg】⇒ hasAudioStream 恒返回 false
   *   ⇒ 转写接口报「这段视频没有音轨」，而视频明明有音轨。
   *
   *   顺序：FFMPEG_PATH → 同仓 dsh-editor/bin → imageio-ffmpeg → 裸 "ffmpeg"
   */
  const here = path.dirname(fileURLToPath(import.meta.url));
  const cands = [
    path.resolve(here, "..", "..", "dsh-editor", "bin", "ffmpeg.exe"),
    path.resolve(here, "..", "..", "dsh-editor", "bin", "ffmpeg"),
    "D:/image/venv/Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe",
  ];
  for (const c of cands) {
    try { if (existsSync(c)) return c; } catch { /* 忽略 */ }
  }
  return "ffmpeg";
})();

const PYTHON = process.env.PYTHON_BIN ?? "python";

const WORK_DIR =
  process.env.COMFY_FRAME_DIR ?? "D:\\主工作区\\DSH视频工作台\\.frames";

/** 默认模型档位。small 是中文可用性与体积的平衡点（463MB/实测可用）。 */
export const DEFAULT_MODEL = "small";

/**
 * 时间戳格式化成 SRT 的 `HH:MM:SS,mmm`。
 */
export function srtTime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(hh)}:${p(mm)}:${p(ss)},${p(ms, 3)}`;
}

/**
 * 片段数组 → SRT 文本。
 *
 * @param {Array<{start:number,end:number,text:string}>} segs
 * @returns {string}
 */
export function toSrt(segs) {
  const list = (segs ?? []).filter((s) => String(s?.text ?? "").trim());
  return list
    .map((s, i) => {
      const n = i + 1;
      return `${n}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${String(s.text).trim()}\n`;
    })
    .join("\n");
}

/**
 * 有没有音轨。
 *
 * ★ 为什么不靠 ffmpeg 报错来判断：`execFile` 抛出的 Error 上虽然会挂 stderr，
 *   但 promisify 之后的形状不稳定，靠字符串匹配容易漏。
 *   直接用 -map 0:a 试一次：有音轨则 exit 0，没有则 exit 1。
 */
export async function hasAudioStream(file) {
  try {
    await execFileAsync(FFMPEG, [
      "-v", "error", "-i", file, "-map", "0:a", "-frames:a", "1", "-f", "null", "-",
    ], { timeout: 30000, windowsHide: true, maxBuffer: 512 * 1024 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 从视频/音频抽出 16kHz 单声道 wav（whisper 要求）。
 */
async function extractAudio(file) {
  const fs = await import("node:fs/promises");
  await fs.mkdir(WORK_DIR, { recursive: true });
  const h = (await import("node:crypto")).createHash("sha1")
    .update(file).digest("hex").slice(0, 10);
  const out = path.join(WORK_DIR, `asr-${h}.wav`);
  await execFileAsync(FFMPEG, [
    "-y", "-i", file, "-vn", "-ac", "1", "-ar", "16000", out,
  ], { timeout: 120000, windowsHide: true, maxBuffer: 1024 * 1024 });
  if (!existsSync(out)) throw new Error("抽音频失败");
  return out;
}

/**
 * 转写一段视频/音频。
 *
 * @param {object} opts
 * @param {string} opts.file      源文件（视频或音频都行）
 * @param {string} [opts.language] 'zh' / 'en' / 不传=自动
 * @param {string} [opts.model]    tiny/base/small/medium/large-v3
 * @returns {Promise<{ok:boolean, segments?:Array, srt?:string, language?:string, text?:string, error?:string}>}
 */
export async function transcribe(opts) {
  const { file, language, model = DEFAULT_MODEL } = opts ?? {};
  if (!file || !existsSync(file)) {
    return { ok: false, error: `源文件不存在：${file}` };
  }

  // ★ 先探测音轨：没有音轨不是「失败」，是「这段本来就没声音」，要分开报。
  if (!(await hasAudioStream(file))) {
    return {
      ok: false,
      noAudio: true,
      error: "这段视频没有音轨（不是失败，是没有可转写的声音）",
    };
  }

  let wav;
  try {
    wav = await extractAudio(file);
  } catch (err) {
    // ★ 2026-10-18（实测踩到）：没有音轨的视频会让 ffmpeg 报
    //   "Output file does not contain any stream / Invalid argument"，
    //   直接把这段原文丢给用户等于没说。
    //   这种情况不是「坏了」，是「这段本来就没声音」——要明确区分。
    const raw = String(err?.stderr ?? err?.message ?? err);
    if (/does not contain any stream|does not contain any|Invalid argument/i.test(raw)) {
      return {
        ok: false,
        noAudio: true,
        error: "这段视频没有音轨（不是失败，是没有可转写的声音）",
      };
    }
    return { ok: false, error: `抽音频失败：${raw.slice(0, 120)}` };
  }

  // 子进程跑 python：一次性脚本，把结果以 JSON 打到 stdout
  const script = `
import sys, json
from faster_whisper import WhisperModel
model_name = ${JSON.stringify(model)}
lang = ${language ? JSON.stringify(language) : "None"}
m = WhisperModel(model_name, device="cpu", compute_type="int8")
segs, info = m.transcribe(${JSON.stringify(wav)}, language=lang, vad_filter=True)
out = []
for s in segs:
    t = (s.text or "").strip()
    if not t:
        continue
    out.append({"start": float(s.start), "end": float(s.end), "text": t})
print(json.dumps({"ok": True, "language": info.language, "segments": out}, ensure_ascii=False))
`;

  try {
    const { stdout } = await execFileAsync(PYTHON, ["-c", script], {
      timeout: 300000,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    // python 可能前面有别的输出，取最后一行 JSON
    const lines = String(stdout ?? "").trim().split(/\r?\n/).filter(Boolean);
    const last = lines[lines.length - 1];
    const j = JSON.parse(last);
    if (!j.ok) return { ok: false, error: "转写失败（子进程返回 ok=false）" };
    const segments = j.segments ?? [];
    return {
      ok: true,
      language: j.language,
      model,
      segments,
      count: segments.length,
      text: segments.map((s) => s.text).join(""),
      srt: toSrt(segments),
      wav,
    };
  } catch (err) {
    return {
      ok: false,
      error: `转写失败：${String(err?.message ?? err).slice(0, 180)}`,
      hint: "检查 python 能否 import faster_whisper；模型是否在 HF 缓存里",
    };
  }
}

/**
 * 把 SRT 烧进视频（硬字幕）。
 *
 * ★ 为什么用 subtitles 滤镜而不是 drawtext：
 *   drawtext 要对每句算 x/y 和显示时段，几十句就要写几十个滤镜链；
 *   subtitles 滤镜直接吃 SRT，一句话搞定，还能调样式。
 *
 * ⚠ 路径坑：ffmpeg 的 subtitles 滤镜里路径的冒号要转义（Windows 盘符 C: ），
 *   反斜杠要换成斜杠。实测写法见下面 escape。
 */
export async function burnSubtitles(opts) {
  const { video, srt, out, fontSize = 20, marginV = 40 } = opts ?? {};
  if (!video || !existsSync(video)) return { ok: false, error: `视频不存在：${video}` };
  if (!srt || !existsSync(srt)) return { ok: false, error: `字幕不存在：${srt}` };

  const fs = await import("node:fs/promises");
  await fs.mkdir(WORK_DIR, { recursive: true });
  const dest = out ?? path.join(
    WORK_DIR,
    `sub-${path.basename(video, path.extname(video))}-${Date.now()}.mp4`
  );

  // ffmpeg 滤镜里的路径：反斜杠→斜杠，盘符冒号→ \:
  const esc = srt.replace(/\\/g, "/").replace(/:/g, "\\:");
  const style = `FontSize=${fontSize},MarginV=${marginV},BorderStyle=1,Outline=1,Shadow=0`;
  const vf = `subtitles='${esc}':force_style='${style}'`;

  try {
    await execFileAsync(FFMPEG, [
      "-y", "-i", video, "-vf", vf, "-c:a", "copy", dest,
    ], { timeout: 600000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    if (!existsSync(dest)) return { ok: false, error: "ffmpeg 返回成功但文件不存在" };
    return { ok: true, path: dest, filename: path.basename(dest) };
  } catch (err) {
    return { ok: false, error: `烧字幕失败：${String(err?.message ?? err).slice(0, 200)}` };
  }
}

/** 供 UI/Agent 查环境是否就绪。 */
export async function asrStatus() {
  const out = { python: PYTHON, ffmpeg: FFMPEG, model: DEFAULT_MODEL };
  try {
    const { stdout } = await execFileAsync(PYTHON, [
      "-c",
      "import faster_whisper, json; print(json.dumps({'v': faster_whisper.__version__}))",
    ], { timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024 });
    const v = /"v":\s*"([^"]+)"/.exec(String(stdout ?? ""))?.[1] ?? null;
    out.fasterWhisper = v;
    out.ok = !!v;
  } catch (err) {
    out.ok = false;
    out.error = String(err?.message ?? err).slice(0, 120);
  }
  return out;
}



