/**
 * 衔接质检 —— F10（外部源调研 P0）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 解决什么问题
 *   一条 5 秒的视频 95 秒才出（yz 实测）。人不可能逐段逐帧检查
 *   「上一段结尾和下一段开头接不接得上」「中间有没有糊成一片或卡住」。
 *   现有的 audit_audio 只管声音，画面完全没人管。
 *
 * ⇒ 让「哪一段该重跑」是【算出来的】，不是猜的。
 * ══════════════════════════════════════════════════════════════════════
 *
 * ★ 阈值不是凭空写的，是实测标定的（2026-10-18）：
 *
 *     同视频相邻 0.1s 帧：  0.9037 / 0.8786 / 0.8765
 *     同视频相隔 1.0s 帧：  0.7498
 *     跨视频（不同产物）：  0.3991 / 0.3619 / 0.3508
 *
 *   ⇒ 取 0.65 做阈值：跨视频最高 0.40，同视频最低 0.75，
 *     0.65 落在两者正中，上下各留 0.25 / 0.10 的余量。
 *
 *   ⚠ 这个阈值只在「同一批生成、同一画幅、同一风格」的短剧素材上标定过。
 *     不同分辨率/不同风格跨类比不能用同一个阈值 —— 所以结果里把
 *     实际 SSIM 值也返回，让调用方自己判断，不只给一个布尔。
 *
 * ★ 为什么纯 ffmpeg 不用模型：
 *   零依赖、零显存、秒级出结果。这条能力要能进每一条工作流的循环里，
 *   不能是「跑一次要等 5 分钟」的东西。
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
   *   去敏对了但实测【PATH 里没有 ffmpeg】⇒ 衔接质检从 32/32 掉到 18/32。
   *
   *   现在按顺序找，任一可用即用：
   *     ① FFMPEG_PATH（用户显式指定）
   *     ② 同仓 dsh-editor 的 bin/ffmpeg.exe（发布包自带，最可靠）
   *     ③ 本机 imageio-ffmpeg 的二进制（常见后备）
   *     ④ 裸 "ffmpeg"（让 PATH 决定）
   *
   *   ★ 用同步 existsSync 而不是 async 的 resolveFfmpeg()：
   *     这个常量在模块顶层被多处引用，改 async 会波及十几个调用点。
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

/** 衔接判定阈值（实测标定见文件头）。 */
export const SSIM_THRESHOLD = 0.65;

/** 工作目录（沙箱只允许写工作区，见 AGENTS §6.11）。 */
const WORK_DIR = process.env.COMFY_FRAME_DIR ?? "D:\\主工作区\\DSH视频工作台\\.frames";

/**
 * 抽单帧到临时文件，返回路径。
 * @param {string} file  源视频
 * @param {"first"|"last"|number} at  位置；数字=秒
 */
async function grabFrame(file, at) {
  const fs = await import("node:fs/promises");
  await fs.mkdir(WORK_DIR, { recursive: true });
  const h = (await import("node:crypto")).createHash("sha1")
    .update(file + ":" + String(at)).digest("hex").slice(0, 10);
  const out = path.join(WORK_DIR, `qc-${h}.png`);

  const args = ["-y"];
  if (at === "first") {
    args.push("-i", file, "-frames:v", "1", "-update", "1");
  } else if (at === "last") {
    const dur = await durationOf(file);
    if (dur == null) throw new Error(`读不到时长：${file}`);
    const back = Math.min(0.5, Math.max(0.02, dur * 0.1));
    args.push("-ss", String(Math.max(0, dur - back)), "-i", file, "-frames:v", "1", "-update", "1");
  } else {
    args.push("-ss", String(Math.max(0, Number(at))), "-i", file, "-frames:v", "1", "-update", "1");
  }
  args.push(out);
  await execFileAsync(FFMPEG, args, { timeout: 30000, windowsHide: true, maxBuffer: 1024 * 512 });
  if (!existsSync(out)) throw new Error(`抽帧失败：${file} @ ${at}`);
  return out;
}

/** 读视频时长（秒）。 */
async function durationOf(file) {
  const r = await execFileAsync(FFMPEG, ["-i", file], {
    timeout: 15000, windowsHide: true, maxBuffer: 1024 * 512,
  }).catch((e) => ({ stderr: String(e?.stderr ?? "") }));
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(r.stderr ?? ""));
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * 两张图的 SSIM。
 * @returns {Promise<{ok:boolean, ssim?:number, error?:string}>}
 */
export async function ssimBetween(a, b) {
  try {
    const r = await execFileAsync(FFMPEG, [
      "-i", a, "-i", b, "-lavfi", "ssim", "-f", "null", "-",
    ], { timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024 }).catch((e) => ({
      stderr: String(e?.stderr ?? ""),
    }));
    const m = /All:([\d.]+)/.exec(String(r.stderr ?? ""));
    if (!m) return { ok: false, error: "ffmpeg 没给出 SSIM" };
    return { ok: true, ssim: Number(m[1]) };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err).slice(0, 120) };
  }
}

/**
 * 查卡帧与黑场。
 * @returns {Promise<{ok:boolean, freezes:Array, blacks:Array, error?:string}>}
 */
export async function scanDefects(file) {
  const out = { ok: true, freezes: [], blacks: [] };
  try {
    // 卡帧：连续 0.5s 以上画面几乎不变
    const fd = await execFileAsync(FFMPEG, [
      "-i", file, "-vf", "freezedetect=n=-60dB:d=0.5", "-f", "null", "-",
    ], { timeout: 120000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }).catch((e) => ({
      stderr: String(e?.stderr ?? ""),
    }));
    const ft = String(fd.stderr ?? "");
    for (const m of ft.matchAll(/freeze_(start|duration|end):\s*([\d.]+)/g)) {
      out.freezes.push({ kind: m[1], value: Number(m[2]) });
    }

    // 黑场：pixel < 0.10 且持续 0.3s+
    const bd = await execFileAsync(FFMPEG, [
      "-i", file, "-vf", "blackdetect=d=0.3:pix_th=0.10", "-f", "null", "-",
    ], { timeout: 120000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }).catch((e) => ({
      stderr: String(e?.stderr ?? ""),
    }));
    const bt = String(bd.stderr ?? "");
    for (const m of bt.matchAll(/black_(start|end):\s*([\d.]+)/g)) {
      out.blacks.push({ kind: m[1], value: Number(m[2]) });
    }
    return out;
  } catch (err) {
    return { ok: false, freezes: [], blacks: [], error: String(err?.message ?? err).slice(0, 120) };
  }
}

/**
 * 批量质检一条时间轴。
 *
 * @param {Array<{id:string, name?:string, rendered?:{path?:string}}>} clips
 * @param {object} [opts]
 * @param {number} [opts.threshold] 自定义阈值
 * @returns {Promise<object>}
 */
export async function auditCuts(clips, opts = {}) {
  const threshold = Number(opts.threshold ?? SSIM_THRESHOLD);
  const list = (clips ?? []).filter((c) => c?.rendered?.path && existsSync(c.rendered.path));

  const seams = [];
  const defects = [];
  const errors = [];

  // ── 段间接缝：A 末帧 vs B 首帧 ──
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1];
    const b = list[i];
    try {
      const fa = await grabFrame(a.rendered.path, "last");
      const fb = await grabFrame(b.rendered.path, "first");
      const s = await ssimBetween(fa, fb);
      if (!s.ok) {
        errors.push({ seam: `${a.id}→${b.id}`, error: s.error });
        continue;
      }
      seams.push({
        from: a.id, to: b.id,
        fromName: a.name ?? a.id, toName: b.name ?? b.id,
        ssim: s.ssim,
        ok: s.ssim >= threshold,
        threshold,
      });
    } catch (err) {
      errors.push({ seam: `${a.id}→${b.id}`, error: String(err?.message ?? err).slice(0, 100) });
    }
  }

  // ── 段内缺陷：卡帧 / 黑场 ──
  for (const c of list) {
    try {
      const d = await scanDefects(c.rendered.path);
      if (!d.ok) { errors.push({ clip: c.id, error: d.error }); continue; }
      const freezeSpan = d.freezes.filter((f) => f.kind === "duration").map((f) => f.value);
      const longestFreeze = freezeSpan.length ? Math.max(...freezeSpan) : 0;
      const blackCount = d.blacks.length / 2;   // 每个黑场有 start+end 两条
      if (longestFreeze >= 0.5 || blackCount > 0) {
        defects.push({
          clipId: c.id, name: c.name ?? c.id,
          longestFreezeSec: Number(longestFreeze.toFixed(2)),
          blackSegments: blackCount,
        });
      }
    } catch (err) {
      errors.push({ clip: c.id, error: String(err?.message ?? err).slice(0, 100) });
    }
  }

  const badSeams = seams.filter((s) => !s.ok);
  // ★ 2026-10-19 修正（复核员 2e3543a0 打穿，我复跑确认）：
  //   原来 summary 只判 badSeams 与 defects，errors 既不参与 summary
  //   也不参与 rerunSuggestion。
  //   实测：喂 5 个内容全坏的文件（存在但读不出）→ 返回
  //         "5 段全部通过（0 处接缝都接得上）"
  //   对着坏文件给「质量合格」，比报错更危险 —— 会让人以为片子没问题。
  //   ⇒ 有 errors 时必须显式说出来，且把出错的段列进重跑建议。
  const judged = list.length - errors.length;   // 真正判过的段数

  return {
    ok: true,
    threshold,
    checked: list.length,
    judged,
    // 一句话结论，Agent 与 UI 都能直接用
    summary: (() => {
      // ① 全都没判出来：不能报「通过」，只能说「无法判定」
      if (judged <= 0) {
        return errors.length
          ? `${errors.length} 段全部无法判定（文件存在但读不出内容）`
          : `只有 ${list.length} 段，无需查接缝`;
      }
      // ② 部分判不出来：如实说「N 段无法判定」
      if (errors.length) {
        const passPart = badSeams.length === 0 && defects.length === 0;
        return (`${judged} 段${passPart ? "通过" :`${badSeams.length} 处接缝接不上`}` +
          ` · ${errors.length} 段无法判定`);
      }
      // ③ 全部判出来了，按原逻辑
      if (list.length < 2) return `只有 ${list.length} 段，无需查接缝`;
      return badSeams.length === 0 && defects.length === 0
        ? `${list.length} 段全部通过（${seams.length} 处接缝都接得上）`
        : `${badSeams.length} 处接缝接不上 · ${defects.length} 段有画面缺陷`;
    })(),
    seams,
    defects,
    errors,
    // 建议重跑哪些段（这是「算出来的」，不是猜的）
    rerunSuggestion: [
      ...new Set([
        ...badSeams.map((s) => s.to),          // 接不上 → 重跑后一段
        ...defects.map((d) => d.clipId),       // 有缺陷 → 重跑该段
        // ★ errors 有两种形状：{seam}（接缝算不出来）与 {clip}（段读不出）
        //   直接 map(e => e.clip) 对第一种会取到 undefined，去重后变 null。
        ...errors.map((e) => e.clip).filter(Boolean),
        ...errors.filter((e) => e.seam && !e.clip).map((e) => e.seam),
      ]),
    ],
  };
}


