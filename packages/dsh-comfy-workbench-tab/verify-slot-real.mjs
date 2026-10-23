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
import { TOKEN, authCookie } from "../tools/test-env.mjs";
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
/**
 * ★ 2026-10-23 D3 去敏：token 与 cookie 名都从 tools/test-env.mjs 取。
 *
 *   原来写死 C:/Users/<本机用户>/dsh-tok.txt 和固定的 cookie 名 ——
 *   别人 clone 下来这一节永远走「跳过」分支，等于这段从没被验过。
 */
let modes = [];
try {
  if (!TOKEN) throw new Error("没有测试实例的 token（设 DSH_TEST_TOKEN 或 DSH_TEST_TOKEN_FILE）");
  const res = await fetch(`${BASE}/comfy-bridge/modes`, {
    headers: { Cookie: authCookie(TOKEN) },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  modes = await res.json();
} catch (e) {
  console.log(`\n  ⏭ 拿不到 /comfy-bridge/modes（${e.message}）—— 跳过真实数据部分`);
  console.log("     起测试实例后重跑，或设 DSH_TEST_TOKEN=<token>");
  process.exit(fail ? 1 : 0);
}

console.log(`\n② 真实数据：${modes.length} 个工作流`);
{
  const byId = Object.fromEntries(modes.map((m) => [m.id, m]));
  t("有 yz（多参 H3）", !!byId.yz);
  /**
   * ★★ 2026-10-23 改：不再写死槽数
   *
   *   v1 是 10 个（6 图 / 1 视频 / 3 音频），v2 是 15 个（9 / 3 / 3）。
   *   写死数字会让「工作流正常升级」变成「验收变红」（AGENTS §3.7）。
   *
   *   ⇒ 锁结构约束，不锁快照：
   *     · 每类至少有一个槽（否则分栏会空）
   *     · 槽总数 ≥ 10（v1 的底线）
   */
  const yzMedia = Object.values(byId.yz?.media ?? {});
  const nImg = yzMedia.filter((x) => x.kind === "image").length;
  const nVid = yzMedia.filter((x) => x.kind === "video").length;
  const nAud = yzMedia.filter((x) => x.kind === "audio").length;
  t("yz 至少 10 个 media 槽", yzMedia.length >= 10, yzMedia.length);
  t("yz 三类槽都有（图 / 视频 / 音频）",
    nImg > 0 && nVid > 0 && nAud > 0,
    `${nImg} image / ${nVid} video / ${nAud} audio`);
  t("yz 的图片槽最多（分栏主位）", nImg >= nVid && nImg >= nAud, `${nImg} 个图片槽`);
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

  /**
   * ★★ 2026-10-23 改：不再写死「6 个图片槽」
   *
   *   判据是【占满后返回 null，不越界塞进别的 kind】，
   *   而不是「恰好有 6 个」。v2 有 9 个图槽，写死 6 会漏测 3 个。
   */
  const imgSlots = Object.keys(media).filter((k) => media[k].kind === "image");
  const fullImg = {};
  for (const k of imgSlots) fullImg[k] = "x";
  t(`全部 ${imgSlots.length} 个图片槽占满后 → null（不越界塞进视频/音频槽）`,
    firstFreeSlotFor(media, fullImg, "image") === null,
    firstFreeSlotFor(media, fullImg, "image"));

  t("此时再 @ 视频仍能绑到 ref_video_0",
    firstFreeSlotFor(media, fullImg, "video")?.slot === "ref_video_0");

  t("@ 音频 → ref_audio_0（不会错绑到图片槽）",
    firstFreeSlotFor(media, {}, "audio")?.slot === "ref_audio_0");

  /**
   * ★★ 关键一条：图片槽满时不许占用视频槽。
   *   如果 kind 过滤失效，这里会返回 ref_video_0 ⇒
   *   提交时前端把图片当视频素材传，后端类型不匹配。
   */
  t("@ 图片时绝不会返回 video 槽",
    firstFreeSlotFor(media, fullImg, "image")?.slot !== "ref_video_0");

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


