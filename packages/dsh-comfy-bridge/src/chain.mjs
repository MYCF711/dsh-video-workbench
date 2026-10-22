/**
 * 首尾帧衔接（chain_from）—— 学 YUH Studio 的 canvas 节点 chain_from。
 *
 * ★ 来源：YUH 的 video 节点有 `chain_from` 参数：「上一镜来源」。
 *   这是多镜一致性的关键做法：
 *     上一镜的尾帧 → 下一镜的首帧 / 参考图
 *   它把「取尾帧」和「接上去」做成两步原子操作，Agent 能精确编排。
 *
 * ★ 我这里的落法：
 *   时间轴上的 clip 已经有 `shot`（含 media）与 `rendered`（含 path）。
 *   衔接 = 从上一镜的 rendered.path 抽尾帧 → 存成一个资产 →
 *         写进下一镜 shot.media 的指定槽。
 *
 *   不新增数据结构，复用现有的 `media` 槽机制 —— 越简单越不容易坏。
 *
 * ★ 为什么不在前端做：
 *   抽帧要 ffmpeg（host 侧），浏览器做不到。所以这个能力必须在 M1。
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { extractFrame } from "./frames.mjs";

/** 尾帧缓存目录（同 frames.mjs 的理由：沙箱只允许写工作区）。 */
const FRAME_DIR = process.env.COMFY_FRAME_DIR ?? "D:\\主工作区\\DSH视频工作台\\.frames";

/**
 * 给一镜取上一镜的尾帧，返回可写进 media 槽的对象。
 *
 * @param {object} opts
 * @param {string} opts.prevVideo   上一镜的产物路径（clip.rendered.path）
 * @param {string} opts.slot        要写到哪个槽（如 "ref_image_0"）
 * @returns {Promise<{ok:boolean, slot?:string, media?:object, error?:string}>}
 */
export async function chainFromPrev(opts) {
  const { prevVideo, slot } = opts;

  if (!prevVideo || !existsSync(prevVideo)) {
    return { ok: false, error: `上一镜产物不存在：${prevVideo}` };
  }
  if (!slot) {
    return { ok: false, error: "没指定槽位（如 ref_image_0）" };
  }

  const r = await extractFrame({ file: prevVideo, position: "last" });
  if (!r.ok) {
    return { ok: false, error: `抽尾帧失败：${r.error}` };
  }

  // ★ 2026-10-18 修（复核员指出的 P0，我核实成立）：
  //   原来只返回 { filename, path }，没有 base64。
  //   而桥的 index.js:144 是 `if (!payload?.base64) continue;` ——
  //   没有 base64 就直接跳过该槽 ⇒ files 里没有这一项 ⇒
  //   workflows.mjs 判定「未提供」⇒ prunedNodes.add(节点) 把槽节点剪掉。
  //   结果：界面报「已接上一镜」，生成结果和没点完全一样。纯 UI 表演。
  //
  //   修法：这里把抽出的帧读成 base64 一起返回。
  //   帧文件不大（1~2MB，base64 膨胀 33%），随 /chain 响应一起回给前端，
  //   前端原样存进 shot.media，生成时桥就能走上传链路。
  //
  //   ⚠ 为什么不改成「桥自己按 path 读盘」：
  //     桥与 dsh-editor 是两个插件，media 里的 path 在 dsh-editor 侧生成，
  //     桥读任意本地路径等于开了个文件读取口子。走 base64 更安全。
  const fsp = await import("node:fs/promises");
  let base64 = null;
  let bytes = 0;
  try {
    const buf = await fsp.readFile(r.path);
    base64 = buf.toString("base64");
    bytes = buf.length;
  } catch (err) {
    return { ok: false, error: `抽帧成功但读不回文件：${String(err?.message ?? err).slice(0, 80)}` };
  }
  return {
    ok: true,
    slot,
    media: { filename: r.filename, path: r.path, base64 },
    bytes,
    note: `取自 ${path.basename(prevVideo)} 的尾帧`,
  };
}

/**
 * 批量：给一串镜头接通衔接链。
 *
 * 规则：第 N 镜的尾帧 → 第 N+1 镜的槽。
 * 只处理【已经渲染成功】的镜头；没渲染的跳过，不报错（免得整条链挂掉）。
 *
 * @param {Array<{id:string, rendered?:{path?:string}, shot?:{media?:object}}>} clips
 * @param {string} slot
 * @returns {Promise<{ok:boolean, patched:number, skipped:number, details:Array}>}
 */
export async function chainAll(clips, slot = "ref_image_0") {
  const details = [];
  let patched = 0;
  let skipped = 0;

  for (let i = 1; i < clips.length; i++) {
    const prev = clips[i - 1];
    const cur = clips[i];
    const prevPath = prev?.rendered?.path;

    if (!prevPath || !existsSync(prevPath)) {
      skipped++;
      details.push({ clip: cur?.id, reason: "上一镜没有产物，跳过" });
      continue;
    }

    const r = await chainFromPrev({ prevVideo: prevPath, slot });
    if (!r.ok) {
      skipped++;
      details.push({ clip: cur?.id, reason: r.error });
      continue;
    }
    patched++;
    details.push({ clip: cur?.id, slot, filename: r.media.filename, from: prev?.id });
  }

  return { ok: true, patched, skipped, details, slot, frameDir: FRAME_DIR };
}
