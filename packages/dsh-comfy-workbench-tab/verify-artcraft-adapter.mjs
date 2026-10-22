/**
 * ArtCraft 适配层验收（2026-10-20）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 验什么
 *
 *   主人定的架构原则：「工作流是作为一个可替换的模块接入我们的插件的，
 *   你的所有东西都应该让工作流对号入座」、「先做后端，再匹配前端 ui」。
 *
 *   ⇒ 这份验收只测【后端契约】，不测 UI：
 *     我们的数据转成 ArtCraft 认的形状，必须严格符合它 adapters/types.ts
 *     里声明的接口。UI 之后照这个契约实现。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么接口要严格对
 *
 *   ArtCraft 的 MediaKind 只有三种："video" | "audio" | "image"。
 *   我们资产库有 6 种（image/video/audio/text/other...）。
 *   ⇒ 多出来的必须【过滤掉】，不能硬塞 ——
 *     塞进去它会在媒体箱里出现一个永远拖不进时间轴的幽灵条目。
 */

import {
  assetToSelection, handleToResolved, mimeOf, filterByKinds,
} from "./src/artcraft-adapter.mjs";

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else {
    fail++; failures.push(name);
    console.log(`  ❌ ${name}${extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 200) : ""}`);
  }
}

console.log("═".repeat(66));
console.log("  ArtCraft 适配层（后端契约）");
console.log("═".repeat(66));

/* 模拟真实资产（字段照 mergeLibrary 的输出） */
const ITEMS = [
  { id: "output:Krea2-USD-20261018_00008_.png", name: "Krea2-USD-20261018_00008_.png",
    displayName: "HD重绘-验收藏顶", kind: "image", src: "output", rel: "Krea2-USD-20261018_00008_.png" },
  { id: "output:clip-A.webm", name: "clip-A.webm", kind: "video",
    src: "output", rel: "2026-10-15/clip-A.webm" },
  { id: "input:voice.wav", name: "voice.wav", kind: "audio", src: "input", rel: "voice.wav" },
  { id: "output:notes.txt", name: "notes.txt", kind: "text", src: "output", rel: "notes.txt" },
  { id: "output:blob.bin", name: "blob.bin", kind: "other", src: "output", rel: "blob.bin" },
];

/* ─── ① 资产 → MediaPickerSelection ─────────────────────── */
console.log("\n① 资产 → MediaPickerSelection（ArtCraft 的 openPicker 返回项）");
{
  const img = assetToSelection(ITEMS[0]);
  t("图片能转", img !== null, img);
  t("handle.id = 我们的资产 id", img?.handle?.id === ITEMS[0].id, img?.handle);
  t("handle.kind = image", img?.handle?.kind === "image");
  t("name 用 displayName 不是机器名", img?.name === "HD重绘-验收藏顶", img?.name);

  const vid = assetToSelection(ITEMS[1]);
  t("视频 kind = video", vid?.handle?.kind === "video", vid?.handle);
  t("没 displayName 时退回 name", vid?.name === "clip-A.webm", vid?.name);

  const aud = assetToSelection(ITEMS[2]);
  t("音频 kind = audio", aud?.handle?.kind === "audio", aud?.handle);

  /**
   * ★★ 最关键的两条：text / other 必须被过滤掉。
   *   ArtCraft 的 MediaKind 只有 image/video/audio 三种，
   *   塞进去会在媒体箱里出现一个永远拖不进时间轴的幽灵条目。
   */
  t("text 被过滤（返回 null）", assetToSelection(ITEMS[3]) === null);
  t("other 被过滤（返回 null）", assetToSelection(ITEMS[4]) === null);
  t("空输入不崩", assetToSelection(null) === null && assetToSelection(undefined) === null);
}

/* ─── ② MediaHandle → ResolvedMedia ─────────────────────── */
console.log("\n② MediaHandle → ResolvedMedia（ArtCraft 的 resolveMedia）");
{
  const r = handleToResolved({ id: ITEMS[0].id, kind: "image" }, ITEMS);
  t("能解析出 url", typeof r.url === "string" && r.url.length > 0, r.url);
  t("走同源代理 /comfy-assets/file", r.url.startsWith("/comfy-assets/file?"), r.url);
  t("带上 src=output", r.url.includes("src=output"), r.url);
  t("带上 rel", r.url.includes("rel=Krea2-USD"), r.url);
  t("mime = image/png", r.mime === "image/png", r.mime);

  // 带子目录的 rel 要做 URL 编码（2026-10-15/clip-A.webm 里的 / 必须编码）
  const rv = handleToResolved({ id: ITEMS[1].id, kind: "video" }, ITEMS);
  t("带日期子目录的 rel 被正确编码", rv.url.includes("rel=2026-10-15%2Fclip-A.webm"), rv.url);
  t("mime = video/webm", rv.mime === "video/webm", rv.mime);

  const ra = handleToResolved({ id: ITEMS[2].id, kind: "audio" }, ITEMS);
  t("音频 src=input 也对", ra.url.includes("src=input"), ra.url);
  t("mime = audio/wav", ra.mime === "audio/wav", ra.mime);

  // 找不到必须抛错，不能静默返回空
  let threw = false;
  try { handleToResolved({ id: "no:such", kind: "image" }, ITEMS); } catch { threw = true; }
  t("找不到资产时抛错（不静默）", threw);
}

/* ─── ③ mime 推断 ───────────────────────────────────────── */
console.log("\n③ mime 推断（资产库没有可靠的 mime 字段）");
{
  const cases = [
    ["a.png", "image/png"], ["a.jpg", "image/jpeg"], ["a.WEBP", "image/webp"],
    ["a.mp4", "video/mp4"], ["a.webm", "video/webm"], ["a.mov", "video/quicktime"],
    ["a.mp3", "audio/mpeg"], ["a.wav", "audio/wav"], ["a.flac", "audio/flac"],
  ];
  const bad = cases.filter(([n, want]) => mimeOf({ name: n }) !== want);
  t(`${cases.length} 种扩展名都对`, bad.length === 0, bad);
  t("未知扩展名给 octet-stream", mimeOf({ name: "a.xyz" }) === "application/octet-stream");
  t("大写扩展名也认", mimeOf({ name: "A.PNG" }) === "image/png");
  t("无扩展名不崩", typeof mimeOf({ name: "noext" }) === "string");
}

/* ─── ④ 按 kinds 过滤 ──────────────────────────────────── */
console.log("\n④ openPicker({ kinds }) 的过滤");
{
  const all = filterByKinds(ITEMS, []);
  t("不传 kinds → 返回全部可用的 3 个", all.length === 3, all.map((x) => x.name));

  const onlyVid = filterByKinds(ITEMS, ["video"]);
  t("只要 video → 1 个", onlyVid.length === 1, onlyVid.map((x) => x.name));
  t("且是 clip-A.webm", onlyVid[0]?.name === "clip-A.webm", onlyVid[0]);

  const vidAud = filterByKinds(ITEMS, ["video", "audio"]);
  t("要 video+audio → 2 个", vidAud.length === 2, vidAud.map((x) => x.name));

  const onlyImg = filterByKinds(ITEMS, ["image"]);
  t("只要 image → 1 个（text/other 不混进来）", onlyImg.length === 1, onlyImg.map((x) => x.name));

  t("空资产库 → 空数组", filterByKinds([], ["image"]).length === 0);
  t("undefined 不崩", filterByKinds(undefined, ["image"]).length === 0);
}

/* ─── ⑤ 契约字段完整性 ──────────────────────────────────── */
console.log("\n⑤ 输出字段严格符合 ArtCraft 的 types.ts");
{
  const sel = assetToSelection(ITEMS[0]);
  t("MediaPickerSelection 只有 handle + name",
    Object.keys(sel).sort().join(",") === "handle,name", Object.keys(sel));
  t("MediaHandle 只有 id + kind",
    Object.keys(sel.handle).sort().join(",") === "id,kind", Object.keys(sel.handle));

  const res = handleToResolved({ id: ITEMS[0].id }, ITEMS);
  const allowed = new Set(["url", "mime", "durationMs"]);
  const extra = Object.keys(res).filter((k) => !allowed.has(k));
  t("ResolvedMedia 没有多余字段", extra.length === 0, extra);
  t("ResolvedMedia 必有 url 与 mime", !!res.url && !!res.mime);

  const kindOk = ["image", "video", "audio"].includes(sel.handle.kind);
  t("kind 在 MediaKind 三种之内", kindOk, sel.handle.kind);
}

/* ─── 汇总 ─────────────────────────────────────────────── */
console.log("\n" + "═".repeat(66));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  ArtCraft 适配层后端契约全过");
