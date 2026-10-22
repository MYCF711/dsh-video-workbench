/**
 * LibraryPanel pickMode 的静态验收（2026-10-20）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么写静态验收而不是浏览器验收
 *
 *   pickMode 是 LibraryPanel 的一个【可选参数】，它的入口在 ArtCraft 里
 *   （artcraft-storage 的 openPicker）。ArtCraft 编辑器还没接进 DSH slot，
 *   现在没法从 UI 上触发它。
 *
 *   ⇒ 验两层：
 *     ① 源码层：pickMode 的分支真的存在、且默认值不影响原有行为
 *     ② 数据层：pickKinds 的过滤逻辑（复用 artcraft-adapter 的 filterByKinds）
 *
 *   ★ 这不能替代浏览器实测。浏览器实测等 ArtCraft 接进 slot 之后做。
 *     现在如实标为「未验证」的部分写在这份文件末尾。
 */

import fs from "node:fs";
import path from "node:path";
import { filterByKinds } from "./src/artcraft-adapter.mjs";

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else {
    fail++; failures.push(name);
    console.log(`  ❌ ${name}${extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 240) : ""}`);
  }
}

const SRC = "src/AssetLibrary.js";
const src = fs.readFileSync(SRC, "utf8");

console.log("═".repeat(66));
console.log("  LibraryPanel pickMode（源码层 + 数据层）");
console.log("═".repeat(66));

/* ─── ① 参数声明 ────────────────────────────────────────── */
console.log("\n① 参数声明：不传时必须与之前完全一致");
{
  const m = src.match(/function LibraryPanel\(\{([^}]+)\}\)\s*\{/);
  t("LibraryPanel 签名能解析到", !!m, m?.[1]?.slice(0, 120));
  const params = (m?.[1] ?? "").split(",").map((s) => s.trim());
  for (const p of ["lib", "onClose", "onInsert", "media", "files", "t"]) {
    t(`原有参数 ${p} 还在（不破坏兼容）`, params.includes(p), params);
  }
  for (const p of ["pickMode", "pickKinds", "onPickConfirm"]) {
    t(`新增参数 ${p}`, params.includes(p), params);
  }
  // 新增的三个都不能有默认值 —— 有默认值意味着「不传也会进 pickMode」
  t("新增参数都没有默认值（不传 = 普通模式）",
    !/pickMode\s*=\s*(true|"|\{)/.test(m?.[1] ?? ""), m?.[1]);
}

/* ─── ② pickAllowed 的过滤 ──────────────────────────────── */
console.log("\n② pickAllowed：pickKinds 为空时不过滤任何东西");
{
  t("有 pickAllowed 的 useMemo", /const pickAllowed = useMemo\(/.test(src));
  t("pickMode 为假时返回 null", /if \(!pickMode\) return null;/.test(src));
  t("pickKinds 空时返回 null（不误杀）",
    /Array\.isArray\(pickKinds\)\s*&&\s*pickKinds\.length\s*\?\s*pickKinds\s*:\s*null/.test(src),
    "检查 pickAllowed 的写法");
  t("在 kind 筛选之前生效",
    src.indexOf("if (pickAllowed) out = out.filter") < src.indexOf('if (kind !== "all") out = out.filter'));
  t("pickAllowed 进了 items 的依赖数组",
    /\[lib\.items, kind, src, q, favOnly, pickAllowed\]/.test(src));
}

/* ─── ③ 卡片按钮分支 ────────────────────────────────────── */
console.log("\n③ 卡片按钮：pickMode 走「选择」，普通走「@引用」");
{
  t("有 pickMode 三元分支", /pickMode\s*\n?\s*\?\s*h\("button"/.test(src));
  t("pickMode 分支有「选择」文案", src.includes('"选择"'));
  t("pickMode 分支有「✓ 已选」", src.includes("✓ 已选"));
  t("普通分支保留「@引用」", src.includes('"@引用"'));
  t("用了 aria-pressed（可访问性）", src.includes('"aria-pressed": picked.has(it.id)'));
  t("选中状态用 Set（O(1) 判断）", /const \[picked, setPicked\] = useState\(\(\) => new Set\(\)\)/.test(src));
}

/* ─── ④ 底部确认栏 ──────────────────────────────────────── */
console.log("\n④ 底部确认栏：只在 pickMode 出现");
{
  t("确认栏有 pickMode 守卫", /pickMode\s*\n?\s*\?\s*h\("div"/.test(src));
  t("有「取消」", src.includes('}, "取消")'));
  t("有「清空」", src.includes('}, "清空")'));
  t("确认按钮文案随选中数变化", /picked\.size \? `用这 \$\{picked\.size\} 项` : "用这些"/.test(src));
  t("没选中时确认按钮禁用", /disabled: !picked\.size/.test(src));
  t("确认时返回完整 item（不是 id）",
    /\(lib\.items \?\? \[\]\)\.filter\(\(x\) => picked\.has\(x\.id\)\)/.test(src),
    "上层要 name/kind 才能转成 MediaPickerSelection");
}

/* ─── ⑤ 标题切换 ────────────────────────────────────────── */
console.log("\n⑤ 标题：pickMode 下是「选择资产」，否则「全局资产库」");
{
  t("标题有三元分支", /pickMode \? "选择资产" : "全局资产库"/.test(src));
  t("pickMode 下统计报「可选择 N 项」", /可选择 \$\{items\.length\} 项/.test(src));
  t("有「已选 N」徽标", /`已选 \$\{picked\.size\}`/.test(src));
}

/* ─── ⑥ useAssetPicker ─────────────────────────────────── */
console.log("\n⑥ useAssetPicker：给 ArtCraft 用的入口");
{
  t("有导出", /export function useAssetPicker\(\)/.test(src));
  t("返回 open/node/close", /return \{ open, node, close \}/.test(src));
  t("open 返回 Promise（能 await）", /return new Promise\(\(resolve\) =>/.test(src));
  t("取消时 resolve 空数组（不是 reject）",
    /req\?\.resolve\?\.\(\[\]\)/.test(src),
    "ArtCraft 拿空数组 = 没选；reject 会让它以为出错了");
  t("面板传了 pickMode: true", /pickMode: true/.test(src));
  t("面板传了 pickKinds", /pickKinds: req\.kinds/.test(src));
}

/* ─── ⑦ 数据层：filterByKinds 与 pickKinds 语义对齐 ────── */
console.log("\n⑦ 数据层：ArtCraft 的 kinds 与我们的 kind 映射");
{
  const ITEMS = [
    { id: "o:a.png", name: "a.png", kind: "image", src: "output", rel: "a.png" },
    { id: "o:b.mp4", name: "b.mp4", kind: "video", src: "output", rel: "b.mp4" },
    { id: "o:c.wav", name: "c.wav", kind: "audio", src: "input", rel: "c.wav" },
    { id: "o:d.txt", name: "d.txt", kind: "text", src: "output", rel: "d.txt" },
  ];
  t("kinds=['video'] 只出视频", filterByKinds(ITEMS, ["video"]).length === 1);
  t("kinds=[] 出三种（text 排除）", filterByKinds(ITEMS, []).length === 3);
  t("text 永远不出", !filterByKinds(ITEMS, ["text"]).some((x) => x.handle.kind === "text"));
}

/* ─── 汇总 ─────────────────────────────────────────────── */
/* ─── ⑧ firstFreeSlotFor：@ 引用后绑到哪个槽 ──────────────────── */
console.log("\n⑧ firstFreeSlotFor：@ 引用后绑到哪个槽（★ 变异测试发现的盲区）");
{
  /**
   * ★★ 2026-10-21 加：这一组是被 verify-can-catch.mjs 找出来的。
   *
   *   变异「firstFreeSlotFor 永远返回 null」注入后，
   *   本验收【仍然通过】—— 说明它从没测过这个函数。
   *
   *   那是个真缺口：这个函数决定「@ 引用的图进不进生成参数」。
   *   返回 null ⇒ 图只在正文里出现，不会送去生成。
   *   用户看到 @ 成功了，实际模型没收到那张图。
   *
   *   ★ 为什么用源码断言而不是调用函数：
   *     这个文件 import 了 react（AssetLibrary.js 是 JSX 组件文件），
   *     在 node 里 import 会失败。和本文件其它组一样走源码层。
   */
  const src = fs.readFileSync(
    path.join(process.cwd(), "src", "AssetLibrary.js"), "utf8");

  // ① 必须真的遍历槽位，不能短路返回 null
  const fnBody = (() => {
    const i = src.indexOf("export function firstFreeSlotFor");
    if (i < 0) return "";
    const j = src.indexOf("\n}", i);
    return j > i ? src.slice(i, j) : "";
  })();
  t("firstFreeSlotFor 存在", fnBody.length > 0);
  t("它遍历了 media 条目", /Object\.entries\(media/.test(fnBody));
  t("它在遍历里返回 { slot, ... }（而不是直接 null）",
    /return\s*\{\s*slot/.test(fnBody), fnBody.slice(0, 120));
  t("只有遍历完才 return null", /}\s*return null;?\s*$/.test(fnBody.trimEnd()));

  // ② kind 过滤：不同 kind 的槽不能被选
  t("按 spec.kind 过滤不匹配的槽",
    /spec\?\.kind\s*&&\s*spec\.kind\s*!==\s*kind/.test(fnBody), fnBody);

  // ③ 已占用的槽跳过
  t("跳过已被占用的槽（files[slot] 有值）",
    /!\s*files\?\.\[slot\]/.test(fnBody), fnBody);

  /* ── 纯逻辑复刻：验证语义本身（不依赖 React） ── */
  const firstFreeSlotFor = (media, files, kind) => {
    for (const [slot, spec] of Object.entries(media ?? {})) {
      if (spec?.kind && spec.kind !== kind) continue;
      if (!files?.[slot]) return { slot, label: spec?.label ?? slot, spec };
    }
    return null;
  };

  const MEDIA = {
    ref_image_0: { kind: "image", label: "参考图1" },
    ref_image_1: { kind: "image", label: "参考图2" },
    ref_video_0: { kind: "video", label: "参考视频" },
    ref_audio_0: { kind: "audio", label: "参考音频" },
  };

  t("空槽时返回第一个匹配 kind 的槽",
    firstFreeSlotFor(MEDIA, {}, "image")?.slot === "ref_image_0",
    firstFreeSlotFor(MEDIA, {}, "image"));

  t("第一个被占则返回第二个",
    firstFreeSlotFor(MEDIA, { ref_image_0: "x" }, "image")?.slot === "ref_image_1",
    firstFreeSlotFor(MEDIA, { ref_image_0: "x" }, "image")?.slot);

  t("kind=video 只挑视频槽",
    firstFreeSlotFor(MEDIA, {}, "video")?.slot === "ref_video_0",
    firstFreeSlotFor(MEDIA, {}, "video")?.slot);

  t("kind=audio 只挑音频槽",
    firstFreeSlotFor(MEDIA, {}, "audio")?.slot === "ref_audio_0",
    firstFreeSlotFor(MEDIA, {}, "audio")?.slot);

  t("全部占满时返回 null（不是抛错）",
    firstFreeSlotFor(MEDIA, {
      ref_image_0: "x", ref_image_1: "x",
      ref_video_0: "x", ref_audio_0: "x",
    }, "image") === null);

  t("没有对应 kind 的槽时返回 null",
    firstFreeSlotFor({ a: { kind: "image" } }, {}, "audio") === null);

  t("spec 没有 kind 的槽通配任何 kind",
    firstFreeSlotFor({ any: { label: "万能槽" } }, {}, "audio")?.slot === "any");

  t("label 缺失时回退成 slot 名",
    firstFreeSlotFor({ s1: {} }, {}, "image")?.label === "s1");
}

console.log("\n" + "═".repeat(66));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  源码层 + 数据层全过");
console.log("");
console.log("  ⚠ 未验证（等 ArtCraft 接进 DSH slot 后做浏览器实测）：");
console.log("    · 点「选择」后视觉是否真的变成主色底");
console.log("    · 长列表下多选是否丢状态");
console.log("    · 确认栏在窄屏是否被挤");
