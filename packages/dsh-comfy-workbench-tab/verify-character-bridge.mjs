import { fileURLToPath, pathToFileURL } from "node:url";
/**
 * ★ 2026-10-23 D2 去敏：HERE 从本文件位置推导。
 *   ★ pathToFileURL 也要 import —— 第一版漏了，运行时报
 *     `ReferenceError: pathToFileURL is not defined`。
 *     静态语法检查抓不到（Identifier 是合法的），只有真跑才暴露。
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
/**
 * 角色卡桥验收（2026-10-20 新增）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 背景：两个项目各有一套资产库，但扫的是同一个 ComfyUI output 目录
 *
 *   工作台  DSH视频工作台/.state/asset-library.json
 *           id = "output:<文件名>"（路径派生，稳定）
 *           我这一轮加的 role / folder 存这里
 *
 *   工作站  D:\主工作区\outputs\assets.json
 *           id = uid()（随机，每次扫描都变）
 *           tags = ["role:character", "char:<名字>", "view:<视角>"]
 *
 *   ⇒ 角色卡的标签只存在工作站那一份，工作台的 @ 搜索看不到 ——
 *     所以「@韩立」搜不到。不是功能没有，是数据没接过来。
 *
 *   实测重合度：工作台 output 697 项 / 工作站 529 项 / 同名交集 517（98%）
 *   ⇒ 按 basename 对齐。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 本脚本验什么
 *
 *   ① loadCharacterTags 能读、能解析三种标签
 *   ② 没打 role:character 的图不进结果
 *   ③ 只有 role:character 没写 char:<名字> 的也跳过（无法归到角色）
 *   ④ basename 对齐正确（工作站的完整路径 vs 工作台的纯文件名）
 *   ⑤ mergeLibrary 把 character / charView 挂到资产上
 *   ⑥ filterItems 能让角色名参与搜索（这是「@韩立」能搜到的关键）
 *   ⑦ 文件不存在 / 坏 JSON 时降级为空，不抛
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * ★ 2026-10-23 D2 去敏：原来写死 file:///D:/主工作区/... 绝对 URL。
 *   改用 pathToFileURL 从本文件推导 —— 别的机器 clone 下来也能跑。
 */
const MOD = pathToFileURL(path.resolve(HERE, "lib", "asset-scan.js")).href;
const { loadCharacterTags, mergeLibrary, filterItems } = await import(MOD);

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
console.log("  角色卡桥（工作台 ⇄ 工作站）");
console.log("═".repeat(66));

/* ── 造一个临时 assets.json ──────────────────────────────── */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-charbridge-"));
const tmpFile = path.join(tmpDir, "assets.json");

const FIXTURE = {
  version: 1,
  savedAt: 1,
  assets: [
    // ① 正常角色定妆图（带视角）
    { id: "a_1", name: "hanli-front.png", path: "D:\\Comfy-Output\\output\\2026-10-15\\hanli-front.png",
      tags: ["role:character", "char:韩立", "view:front"] },
    // ② 同一角色的另一张（无视角）
    { id: "a_2", name: "hanli-side.png", path: "D:\\Comfy-Output\\output\\hanli-side.png",
      tags: ["role:character", "char:韩立"] },
    // ③ 另一个角色
    { id: "a_3", name: "xiaoming.png", path: "D:\\x\\xiaoming.png",
      tags: ["role:character", "char:小明", "view:closeup"] },
    // ④ 普通素材（没角色标签）→ 不该进结果
    { id: "a_4", name: "plain.png", path: "D:\\x\\plain.png", tags: ["fav"] },
    // ⑤ 有 role:character 但没写角色名 → 无法归类，跳过
    { id: "a_5", name: "orphan.png", path: "D:\\x\\orphan.png", tags: ["role:character"] },
    // ⑥ 完全没有 tags 字段 → 不该崩
    { id: "a_6", name: "notags.png", path: "D:\\x\\notags.png" },
  ],
};
fs.writeFileSync(tmpFile, JSON.stringify(FIXTURE, null, 2), "utf8");

/* ─── ① 能读能解析 ───────────────────────────────────────── */
console.log("\n① loadCharacterTags 解析三种标签");
{
  const r = loadCharacterTags(tmpFile);
  t("读取成功", r.stats.ok === true, r.stats);
  t("total = 6（全部资产）", r.stats.total === 6, r.stats.total);
  t("chars = 3（三张定妆图）", r.stats.chars === 3, r.stats.chars);
  t("识别出 2 个角色", r.stats.characters.length === 2, r.stats.characters);
  t("角色名是「小明」「韩立」",
    r.stats.characters.includes("小明") && r.stats.characters.includes("韩立"),
    r.stats.characters);

  t("hanli-front.png 有 front 视角", r.byBasename["hanli-front.png"]?.view === "front",
    r.byBasename["hanli-front.png"]);
  t("hanli-side.png 视角为 null", r.byBasename["hanli-side.png"]?.view === null,
    r.byBasename["hanli-side.png"]);
  t("xiaoming.png 视角是 closeup", r.byBasename["xiaoming.png"]?.view === "closeup",
    r.byBasename["xiaoming.png"]);
}

/* ─── ② 过滤正确 ─────────────────────────────────────────── */
console.log("\n② 不该进的没进");
{
  const r = loadCharacterTags(tmpFile);
  t("普通素材 plain.png 不在结果里", !("plain.png" in r.byBasename), Object.keys(r.byBasename));
  t("只有 role:character 无角色名的 orphan.png 不在结果里",
    !("orphan.png" in r.byBasename), Object.keys(r.byBasename));
  t("没有 tags 字段的 notags.png 不在结果里（且不崩）",
    !("notags.png" in r.byBasename), Object.keys(r.byBasename));
}

/* ─── ③ basename 对齐 ────────────────────────────────────── */
console.log("\n③ basename 对齐（工作站完整路径 → 工作台纯文件名）");
{
  const r = loadCharacterTags(tmpFile);
  // 工作站的 path 带子目录 2026-10-15，工作台只有文件名
  t("带日期子目录的路径也按 basename 索引",
    !!r.byBasename["hanli-front.png"], Object.keys(r.byBasename));
  t("不带子目录的也行", !!r.byBasename["hanli-side.png"]);
}

/* ─── ④ mergeLibrary 挂上字段 ────────────────────────────── */
console.log("\n④ mergeLibrary 把 character / charView 挂到资产上");
{
  const charTags = loadCharacterTags(tmpFile);
  const state = {
    raw: { hidden: {}, alias: {}, fav: {}, role: {}, folder: {} },
  };
  const merged = mergeLibrary({
    products: [
      { id: "output:hanli-front.png", name: "hanli-front.png", rel: "hanli-front.png", src: "output", kind: "image" },
      { id: "output:plain.png", name: "plain.png", rel: "plain.png", src: "output", kind: "image" },
    ],
    uploads: [],
    editor: [],
    state,
    charTags,
  });
  const hit = merged.find((x) => x.name === "hanli-front.png");
  const miss = merged.find((x) => x.name === "plain.png");
  t("命中角色的资产带 character=韩立", hit?.character === "韩立", hit?.character);
  t("命中角色的资产带 charView=front", hit?.charView === "front", hit?.charView);
  t("没命中的资产 character 是 null（不是 undefined）",
    miss?.character === null, miss?.character);
  t("JSON 序列化后 character 字段仍在（null 不会消失）",
    JSON.parse(JSON.stringify(miss)).character === null);
}

/* ─── ⑤ filterItems 让角色名参与搜索 ────────────────────── */
console.log("\n⑤ filterItems：@角色名 能搜到（这是「@韩立」的关键）");
{
  const items = [
    { displayName: "hanli-front.png", name: "hanli-front.png", rel: "hanli-front.png",
      kind: "image", src: "output", character: "韩立" },
    { displayName: "other.png", name: "other.png", rel: "other.png",
      kind: "image", src: "output", character: null },
    { displayName: "xiaoming.png", name: "xiaoming.png", rel: "xiaoming.png",
      kind: "image", src: "output", character: "小明" },
  ];
  const byChar = filterItems(items, { q: "韩立" });
  t("搜「韩立」只命中 1 项", byChar.length === 1, byChar.map((x) => x.name));
  t("命中的是 hanli-front.png", byChar[0]?.name === "hanli-front.png", byChar[0]?.name);

  // 文件名里没有「小明」三个字，但角色名有
  const byChar2 = filterItems(items, { q: "小明" });
  t("搜「小明」也能命中（文件名里没有这三个字）",
    byChar2.length === 1 && byChar2[0].name === "xiaoming.png", byChar2.map((x) => x.name));

  // 不影响原有搜索
  const byName = filterItems(items, { q: "other" });
  t("按文件名搜仍然有效", byName.length === 1 && byName[0].name === "other.png");

  // 空查询返回全部
  t("空查询返回全部", filterItems(items, {}).length === 3);
}

/* ─── ⑥ 降级不抛 ─────────────────────────────────────────── */
console.log("\n⑥ 异常降级（读不到就当没有角色卡，不阻断主流程）");
{
  const missing = loadCharacterTags(path.join(tmpDir, "no-such-file.json"));
  t("文件不存在 → ok:false", missing.stats.ok === false, missing.stats.ok);
  t("文件不存在 → byBasename 是空对象", Object.keys(missing.byBasename).length === 0);
  t("文件不存在 → 不抛异常（有 reason）", typeof missing.stats.reason === "string", missing.stats.reason);

  const badFile = path.join(tmpDir, "bad.json");
  fs.writeFileSync(badFile, "{ this is not json", "utf8");
  const bad = loadCharacterTags(badFile);
  t("坏 JSON → ok:false", bad.stats.ok === false);
  t("坏 JSON → 不抛异常", typeof bad.stats.reason === "string", bad.stats.reason);

  // mergeLibrary 在 charTags 缺失时也要能用
  const merged = mergeLibrary({
    products: [{ id: "x", name: "a.png", rel: "a.png", src: "output", kind: "image" }],
    uploads: [], editor: [],
    state: { raw: { hidden: {}, alias: {}, fav: {}, role: {}, folder: {} } },
    charTags: undefined,
  });
  t("charTags 未传时 mergeLibrary 照常工作", merged.length === 1 && merged[0].character === null);
}

/* ─── 清理 ───────────────────────────────────────────────── */
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 系统会清 */ }

console.log("\n" + "═".repeat(66));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  角色卡桥验收全过");
