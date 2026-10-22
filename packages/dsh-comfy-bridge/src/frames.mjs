/**
 * 视频抽帧 —— 取首帧 / 取尾帧 / 指定时间点。
 *
 * ★ 来源：YUH Studio 的 `yuh_canvas_extract_frame`（取首帧 / 取尾帧）。
 *   它把这两个做成独立原子工具，因为「首尾帧衔接」是多镜一致性的关键：
 *     上一镜的尾帧 → 下一镜的首帧（或作为参考图）
 *   我原来只有「整段替换」，没有这种原子操作。
 *
 * ★ ffmpeg 用 dsh-editor 自带的那一份（实测 v7.1，83.6MB）：
 *   D:\主工作区\DSH视频工作站\packages\dsh-editor\bin\ffmpeg.exe
 *   不依赖 PATH —— 本机 PATH 里没有 ffmpeg（实测 Get-Command ffmpeg 失败）。
 *
 * ★ 安全：
 *   · 只读源文件，不删不改
 *   · 输出到固定目录，文件名带 hash 避免覆盖
 *   · 任何失败只返回错误，不抛（不拖累路由）
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const execFileAsync = promisify(execFile);

/** dsh-editor 自带的 ffmpeg。可用环境变量覆盖。 */
const FFMPEG =
  process.env.FFMPEG_PATH ??
  "D:\\主工作区\\DSH视频工作站\\packages\\dsh-editor\\bin\\ffmpeg.exe";

/**
 * 抽出来的帧放哪。
 *
 * ★ 实测（2026-10-18）：不能放 ComfyUI 的 input 目录。
 *   DSH 的文件沙箱只允许写工作区，写到
 *     C:\Users\Administrator\*.png   → Could not open file（I/O error）
 *     D:\Comfy-Desktop\ComfyUI-Shared\input\*.png → 同样失败
 *   写到工作区内的目录 → 成功。
 *
 *   ⇒ 落盘在工作区，之后走已有的 comfy.uploadImage() 传给 ComfyUI。
 *     那条链路本来就通（MediaSlots 上传就是这么走的）。
 */
const FRAME_DIR =
  process.env.COMFY_FRAME_DIR ??
  "D:\\主工作区\\DSH视频工作台\\.frames";

function ensureDir(d) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

/**
 * 探一个视频的时长与分辨率。
 *
 * ★ 2026-10-18 修（复核员指出，我核实成立）：
 *   原来只读 stdout，而 `ffmpeg -i <file>` 无输出文件时把信息全打在 stderr，
 *   且 .catch 里还把 stderr 丢成 {stdout:""} ⇒ raw 恒为空、ok 恒为 true。
 *   任何输入（包括不存在的文件）都返回 {ok:true, raw:""} —— 恒假成功。
 *   而且这个函数没有任何调用点，是死代码。
 *
 *   现在：读 stderr，解析真实字段；解析不到就明确 ok:false。
 */
export async function probeVideo(file) {
  if (!file || !existsSync(file)) {
    return { ok: false, error: `源文件不存在：${file}` };
  }
  // ffmpeg -i 对无输出文件的调用必然 exit!=0，信息在 stderr
  const r = await execFileAsync(FFMPEG, ["-i", file], {
    timeout: 15000, windowsHide: true, maxBuffer: 1024 * 512,
  }).catch((e) => ({ stdout: String(e?.stdout ?? ""), stderr: String(e?.stderr ?? "") }));
  const text = String(r.stderr || r.stdout || "");
  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  const vs = /Video:\s*([^,\s]+).*?(\d{2,5})x(\d{2,5})/.exec(text);
  if (!dur) {
    return { ok: false, error: "ffmpeg 读不出时长（文件可能不是视频）", raw: text.slice(0, 300) };
  }
  const seconds = Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]);
  return {
    ok: true,
    seconds,
    width: vs ? Number(vs[2]) : null,
    height: vs ? Number(vs[3]) : null,
    codec: vs ? vs[1] : null,
    raw: text.slice(0, 300),
  };
}

/**
 * 从视频抽一帧。
 *
 * @param {object} opts
 * @param {string} opts.file      源视频绝对路径
 * @param {"first"|"last"|"at"} opts.position
 * @param {number} [opts.seconds] position="at" 时用
 * @returns {Promise<{ok:boolean, path?:string, filename?:string, error?:string}>}
 */
export async function extractFrame(opts) {
  const { file, position = "first", seconds = 0 } = opts;

  if (!file || !existsSync(file)) {
    return { ok: false, error: `源文件不存在：${file}` };
  }
  // ★ 2026-10-18 修（自查发现）：position 传了非法值时原来会静默走 else 分支
  //   当成 at(0) 处理，抽回第一帧还返回 ok:true —— 调用方以为按自己要求取到了。
  //   语义错误比报错更坏，必须显式拒绝。
  if (!["first", "last", "at"].includes(position)) {
    return { ok: false, error: `position 只能是 first / last / at，收到 "${position}"` };
  }
  if (!existsSync(FFMPEG)) {
    return { ok: false, error: `找不到 ffmpeg：${FFMPEG}` };
  }

  let tailNote = null;
  ensureDir(FRAME_DIR);

  // 文件名：源文件 hash 前 8 位 + 位置，避免同名覆盖
  const h = crypto.createHash("sha1").update(file).digest("hex").slice(0, 8);
  const base = path.basename(file, path.extname(file)).replace(/[^\w\-]/g, "_").slice(0, 40);
  const tag = position === "at" ? `at${Math.round(seconds * 1000)}` : position;
  const filename = `frame-${base}-${tag}-${h}.png`;
  const out = path.join(FRAME_DIR, filename);

  // ★ 两个坑都踩过（2026-10-18）：
  //   ① ffmpeg 7.x 要求单图输出带 -update 1，否则报
  //      "does not contain an image sequence pattern ... Could not open file"
  //   ② -update 1 是【输出选项】，必须放在 -i 之后。
  //      放前面会变成 "Error opening input files: Option not found"，
  //      而且报错行写的是输入文件打不开，很容易误判成源文件坏了。
  const args = ["-y"];
  if (position === "first") {
    // 第一帧：seek 到 0，取 1 帧
    args.push("-i", file, "-frames:v", "1", "-update", "1");
  } else if (position === "last") {
    // 最后一帧：先 seek 到最后 1 秒再取最后一帧。
    // 不用 -sseof 是因为部分封装格式不支持；先读时长再算更稳。
    const dur = await videoDuration(file);
    if (dur == null) {
      return { ok: false, error: "读不到视频时长，无法取尾帧" };
    }
    // ★ 2026-10-18 修（复核员指出）：原来 seek = max(0, dur-0.5)。
    //   dur=0.3 时 seek=0 ⇒ 取到的是第一帧，而且没有任何提示 ——
    //   用户点「取尾帧」拿到的其实是首帧，语义完全错。
    //   现在：留出极小的回退量（不超过时长的 10%），并在响应里注明。
    const back = Math.min(0.5, Math.max(0.02, dur * 0.1));
    const seek = Math.max(0, dur - back);
    if (dur < 0.5) tailNote = `源视频仅 ${dur.toFixed(2)}s，尾帧与首帧可能非常接近`;
    args.push("-ss", String(seek), "-i", file, "-frames:v", "1", "-update", "1");
  } else {
    args.push("-ss", String(Math.max(0, seconds)), "-i", file, "-frames:v", "1", "-update", "1");
  }
  args.push(out);

  try {
    await execFileAsync(FFMPEG, args, {
      timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024,
    });
  } catch (err) {
    return { ok: false, error: `抽帧失败：${String(err?.message ?? err).slice(0, 200)}` };
  }

  if (!existsSync(out)) {
    return { ok: false, error: "ffmpeg 返回成功但文件不存在" };
  }
  return { ok: true, path: out, filename, dir: FRAME_DIR, note: tailNote ?? undefined };
}

/** 读视频时长（秒）。读不到返回 null。 */
async function videoDuration(file) {
  const r = await execFileAsync(FFMPEG, ["-i", file], {
    timeout: 15000, windowsHide: true, maxBuffer: 1024 * 512,
  }).catch((e) => ({ stderr: String(e?.stderr ?? "") }));
  const text = String(r.stderr || "");
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  if (!m) return null;
  const [, hh, mm, ss] = m;
  return Number(hh) * 3600 + Number(mm) * 60 + Number(ss);
}

/** 供路由用：确认环境就绪。 */
export async function ffmpegStatus() {
  if (!existsSync(FFMPEG)) {
    return { ok: false, error: `找不到 ffmpeg：${FFMPEG}` };
  }
  try {
    const { stdout, stderr } = await execFileAsync(FFMPEG, ["-version"], {
      timeout: 8000, windowsHide: true, maxBuffer: 1024 * 64,
    }).catch((e) => ({ stdout: "", stderr: String(e?.stderr ?? e?.message ?? "") }));
    const text = String(stdout || stderr);
    const v = /ffmpeg version (\S+)/.exec(text)?.[1] ?? null;
    return { ok: true, bin: FFMPEG, version: v, frameDir: FRAME_DIR };
  } catch (err) {
    return { ok: false, bin: FFMPEG, error: String(err?.message ?? err) };
  }
}
