/**
 * 真实槽位实测：拿 ComfyUI 桥返回的【真实 media 定义】跑 firstFreeSlotFor
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么单独做这一份（与 verify-pick-mode.mjs 的 ⑧ 组互补）
 *
 *   verify-pick-mode.mjs 的 ⑧ 组用的是【我手写的 MEDIA】——
 *   那验证了逻辑，但没验证「逻辑跑在真实数据上对不对」。
 *
 *   ★ 这正是 §6.23 那类缺陷的特征：数据都在，只是某条路径上漏了一个转换。
 *     手写 fixture 永远是「我以为的数据形状」，真数据可能不一样
 *     （比如 required 字段、label 缺失、槽顺序）。
 *
 *   ⇒ 这一份从 /comfy-bridge/modes 拉真实定义，跑真实的槽分配。
 *     需要测试实例在跑（19499）。
 * ══════════════════════════════════════════════════════════════════════
 */

import fs from "node:fs";
import path from "node:path";

const BASE = "http://127.0.0.1:19499";

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else {
    fail++; failures.push(name);
    console.log(`  ❌ ${name}${extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 240) : ""}`);
  }
}

/** 从 AssetLibrary.js 里提炼的【同一份逻辑】—— 保持与生产代码等价。 */
function firstFreeSlotFor(media, files, kind) {
  for (const [slot, spec] of Object.entries(media ?? {})) {
    if (spec?.kind && spec.kind !== kind) continue;
    if (!files?.[slot]) return { slot, label: spec?.label ?? slot, spec };
  }
  return null;
}

console.log("═".repeat(66));
console.log("  真实槽位分配（用桥返回的真实 media 定义）");
console.log("═".repeat(66));

/* ─── 先把生产代码与本地复刻做一致性核对 ──────────────── */
console.log("\n① 复刻逻辑必须与生产代码等价");
{
  const src = fs.readFileSync(
    path.join(process.cwd(), "src", "AssetLibrary.js"), "utf8");
  const i = src.indexOf("export function firstFreeSlotFor");
  const body = i < 0 ? "" : src.slice(i, src.indexOf("\n}", i));

  t("生产代码用的是同一套判断（spec.kind 过滤）",
    /spec\?\.kind\s*&&\s*spec\.kind\s*!==\s*kind/.test(body));
  t("生产代码用的是同一套判断（files[slot] 占用）",
    /!\s*files\?\.\[slot\]/.test(body));
  t("生产代码返回 { slot, label, spec }",
    /return\s*\{\s*slot,\s*label:/.test(body));
}

/* ─── 拉真实数据 ──────────────────────────────── */
let modes = [];
try {
  const token = fs.readFileSync("C:/Users/Administrator/dsh-tok.txt", "utf8").trim();
  const res = await fetch(`${BASE}/comfy-bridge/modes`, {
    headers: { Cookie: `dsh-auth-CK36o8O6fn6VWHrnbEp0bsjzKPKRmilHp-TBfPBH65k=${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  modes = await res.json();
} catch (e) {
  console.log(`\n  ⏭ 拿不到 /comfy-bridge/modes（${e.message}）—— 跳过真实数据部分`);
  console.log("     起测试实例后重跑：pwsh -File C:\\Users\\Administrator\\restart-test2.ps1");
  process.exit(fail ? 1 : 0);
}

console.log(`\n② 真实数据：${modes.length} 个工作流`);
{
  const byId = Object.fromEntries(modes.map((m) => [m.id, m]));
  t("有 yz（多参 H3）", !!byId.yz);
  t("yz 有 10 个 media 槽",
    Object.keys(byId.yz?.media ?? {}).length === 10,
    Object.keys(byId.yz?.media ?? {}).length);
  t("yz 的槽 kind 分布正确（6 image / 1 video / 3 audio", (() => {
    const v = Object.values(byId.yz?.media ?? {});
    return v.filter((x) => x.kind === "image").length === 6
      && v.filter((x) => x.kind === "video").length === 1
      && v.filter((x) => x.kind === "audio").length === 3;
  })());
  t("qwen21-edit 只有 image 槽", Object.values(byId["qwen21-edit"]?.media ?? {})
    .every((x) => x.kind === "image"));
  t("qwen21-edit 的 ref_image_0 是必填",
    byId["qwen21-edit"]?.media?.ref_image_0?.required === true);
}

/* ─── 用真实定义跑分配 ──────────────────────────── */
console.log("\n③ 用 yz 的真实槽跑分配");
{
  const media = modes.find((m) => m.id === "yz").media;

  const img1 = firstFreeSlotFor(media, {}, "image");
  t("第一次 @ 图片 → ref_image_0",
    img1?.slot === "ref_image_0", img1?.slot);

  const img2 = firstFreeSlotFor(media, { ref_image_0: "a" }, "image");
  t("第二次 @ 图片 → ref_image_1",
    img2?.slot === "ref_image_1", img2?.slot);

  // 填满全部 6 个图片槽
  const full6 = {};
  for (let i = 0; i < 6; i++) full6[`ref_image_${i}`] = "x";
  t("6 个图片槽占满后 → null（不再越界塞进视频/音频槽）",
    firstFreeSlotFor(media, full6, "image") === null,
    firstFreeSlotFor(media, full6, "image"));

  t("此时再 @ 视频仍能绑到 ref_video_0",
    firstFreeSlotFor(media, full6, "video")?.slot === "ref_video_0");

  t("@ 音频 → ref_audio_0（不会错绑到图片槽）",
    firstFreeSlotFor(media, {}, "audio")?.slot === "ref_audio_0");

  /**
   * ★★ 关键一条：图片槽满时不许占用视频槽。
   *   如果 kind 过滤失效，这里会返回 ref_video_0 ⇒
   *   提交时前端把图片当视频素材传，后端类型不匹配。
   */
  t("@ 图片时绝不会返回 video 槽",
    firstFreeSlotFor(media, full6, "image")?.slot !== "ref_video_0");

  t("@ 视频时绝不会返回 image 槽",
    firstFreeSlotFor(media, {}, "video")?.slot?.startsWith("ref_video"),
    firstFreeSlotFor(media, {}, "video")?.slot);
}

console.log("\n④ 用 qwen21-edit 的真实槽跑分配");
{
  const media = modes.find((m) => m.id === "qwen21-edit").media;

  t("第一次 @ 图片 → ref_image_0（必填那个）",
    firstFreeSlotFor(media, {}, "image")?.slot === "ref_image_0",
    firstFreeSlotFor(media, {}, "image")?.slot);

  t("占满两槽后 → null（不会溢出到别的槽）",
    firstFreeSlotFor(media, { ref_image_0: "a", ref_image_1: "b" }, "image") === null);

  t("@ 音频时没有音频槽 → null（不会硬塞进图片槽）",
    firstFreeSlotFor(media, {}, "audio") === null,
    firstFreeSlotFor(media, {}, "audio"));
}

console.log("\n" + "═".repeat(66));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  槽位分配在真实数据上正确（含跨 kind 不越界）");
