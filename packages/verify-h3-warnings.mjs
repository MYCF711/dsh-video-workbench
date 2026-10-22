#!/usr/bin/env node
/**
 * H3 警告逻辑的实测 —— 每条警告都要能真的触发，也要能不误触发
 *
 * 任务书一-5 主人要求：「警告逻辑按新分类重写（现有「所有图片都被标成角色/物体外观」这类）」
 *
 * 为什么写这个脚本：
 *   之前验收 verify-h3-labels.mjs 测的是「警告文案的字数/不含内部标签名」，
 *   是【格式约束】，不是【触发条件】。
 *   ⇒ 从来没有验证过「什么情况下该出哪条警告」。
 *
 *   判据（AGENTS §验收自检）：断言必须能变红。
 *   所以每条警告都要有【该出】和【不该出】两组用例。
 */

import { buildSubjectDefinitions } from "./dsh-comfy-workbench-tab/src/h3-labels.js";

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`    ✅ ${name}${detail ? "  " + detail : ""}`); }
  else { fail++; console.log(`    ❌ ${name}${detail ? "  " + detail : ""}`); }
}

/** 造 refs 数组：[{slot, name, kind, role, hasAudio?}] */
function mk(items) {
  return items.map((x, i) => ({
    slot: `ref_image_${i}`,
    name: x.name ?? `素材${i}`,
    kind: x.kind ?? "image",
    role: x.role,
    hasAudio: x.hasAudio === true,
  }));
}

function warnsOf(refs) {
  const r = buildSubjectDefinitions(refs);
  return r.warnings ?? [];
}

/** 找包含某关键词的警告条数 */
function has(list, kw) {
  return list.some((w) => w.includes(kw));
}

console.log("\n  H3 警告触发条件实测");

// ── ① 只有外观、没有帧 ─────────────────────────────────────
{
  const w = warnsOf(mk([{ role: "subject.character" }]));
  ok("① 只有角色外观 → 提示「没指定开头画面」", has(w, "开头画面"), `(${w.length} 条)`);
}
{
  const w = warnsOf(mk([{ role: "subject.character" }, { role: "picture.first" }]));
  ok("① 有外观 + 有首帧 → 不该出这条", !has(w, "开头画面"));
}

// ── ② 只有帧、没有外观 ─────────────────────────────────────
{
  const w = warnsOf(mk([{ role: "picture.first" }]));
  ok("② 只有首帧 → 提示「没指定人物长相」", has(w, "没有指定人物"), `(${w.length} 条)`);
}
{
  const w = warnsOf(mk([{ role: "picture.first" }, { role: "subject.character" }]));
  ok("② 有帧 + 有外观 → 不该出这条", !has(w, "没有指定人物"));
}

// ── ③ 有动作、没外观 ───────────────────────────────────────
{
  const w = warnsOf(mk([{ role: "subject.motion", kind: "video" }, { role: "picture.first" }]));
  ok("③ 动作 + 帧、无外观 → 提示「人物会变成另一个人」", has(w, "另一个人"), `(${w.length} 条)`);
}
{
  const w = warnsOf(mk([{ role: "subject.motion", kind: "video" }, { role: "subject.character" }]));
  ok("③ 动作 + 外观 → 不该出这条", !has(w, "另一个人"));
}

// ── ④ 主体超过 3 个 ────────────────────────────────────────
{
  const w = warnsOf(mk([
    { role: "subject.character" }, { role: "subject.character" },
    { role: "subject.object" }, { role: "subject.scene" },
  ]));
  ok("④ 4 个主体 → 提示合并", has(w, "合并"), `(${w.length} 条)`);
}
{
  const w = warnsOf(mk([{ role: "subject.character" }, { role: "subject.object" }]));
  ok("④ 2 个主体 → 不该出这条", !has(w, "合并"));
}

// ── ⑤ 参考视频有声音但没引音频 ─────────────────────────────
{
  const w = warnsOf(mk([{ role: "video.source", kind: "video", hasAudio: true }]));
  ok("⑤ 带音轨的视频、无音频引用 → 提示要另外引", has(w, "自带声音"), `(${w.length} 条)`);
}
{
  const w = warnsOf(mk([
    { role: "video.source", kind: "video", hasAudio: true },
    { role: "audio.sfx", kind: "audio" },
  ]));
  ok("⑤ 已引音频 → 不该出这条", !has(w, "自带声音"));
}
{
  const w = warnsOf(mk([{ role: "video.source", kind: "video", hasAudio: false }]));
  ok("⑤ 无声视频 → 不该出这条", !has(w, "自带声音"));
}

// ── ⑥ 全部齐全时不该有任何警告 ─────────────────────────────
{
  const w = warnsOf(mk([
    { role: "subject.character" },
    { role: "picture.first" },
    { role: "video.source", kind: "video", hasAudio: false },
  ]));
  ok("⑥ 外观+首帧+视频 齐全 → 零警告", w.length === 0, `${w.length} 条`);
}

// ── ⑦ 格式约束（AGENTS 已定的硬要求）──────────────────────
{
  const all = [
    ...warnsOf(mk([{ role: "subject.character" }])),
    ...warnsOf(mk([{ role: "picture.first" }])),
    ...warnsOf(mk([{ role: "subject.motion", kind: "video" }, { role: "picture.first" }])),
    ...warnsOf(mk([{ role: "subject.character" }, { role: "subject.character" }, { role: "subject.object" }, { role: "subject.scene" }])),
    ...warnsOf(mk([{ role: "video.source", kind: "video", hasAudio: true }])),
  ];
  const badTag = all.filter((w) => /<(Subject|Picture|Video|Audio)\s*\d*>/i.test(w));
  ok("⑦ 文案里不出现内部标签名", badTag.length === 0, badTag.length ? `违规：${badTag[0].slice(0, 30)}` : "");
  const tooLong = all.filter((w) => w.length > 80);
  ok("⑦ 每条 ≤ 80 字", tooLong.length === 0, tooLong.length ? `最长 ${Math.max(...all.map((w) => w.length))} 字` : "");
  const tooMany = all.filter((w) => (w.match(/[。！？]/g) || []).length > 2);
  ok("⑦ 每条 ≤ 2 句", tooMany.length === 0, tooMany.length ? `违规：${tooMany[0].slice(0,50)}` : "");
}

console.log(`\n  通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
