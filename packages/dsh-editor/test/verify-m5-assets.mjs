/**
 * M5 素材库验收。
 *
 * 关键判据：
 *   ① 登记不复制文件（只建引用）—— 不重复占空间
 *   ② 按内容 hash 去重（不是文件名）
 *   ③ 删素材默认不删文件（防误删）
 *   ④ 能发现「索引里有但文件已不在」
 *   ⑤ 扫描目录能批量登记
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createAssetLibrary, kindOf, fileHash } from "../src/assets.mjs";

let pass = 0, fail = 0;
const failures = [];
function t(desc, fn) {
  try {
    const r = fn();
    if (r === true || r === undefined) { console.log(`  ✅ ${desc}`); pass++; }
    else { console.log(`  ❌ ${desc}\n     ${r}`); fail++; failures.push(desc); }
  } catch (err) {
    console.log(`  ❌ ${desc}\n     ${err.message}`); fail++; failures.push(desc);
  }
}

const TMP = path.join(os.tmpdir(), `dsh-assets-test-${Date.now()}`);
fs.mkdirSync(TMP, { recursive: true });
const MEDIA = path.join(TMP, "media");
fs.mkdirSync(MEDIA);
const IDX = path.join(TMP, "assets.json");
const silent = { info() {}, warn() {} };

// 造素材
const f1 = path.join(MEDIA, "a.png");
const f2 = path.join(MEDIA, "b.mp4");
const f3 = path.join(MEDIA, "c.m4a");
const f4 = path.join(TMP, "d.txt");
fs.writeFileSync(f1, Buffer.from("PNGDATA-1".repeat(100)));
fs.writeFileSync(f2, Buffer.from("MP4DATA-2".repeat(200)));
fs.writeFileSync(f3, Buffer.from("M4ADATA-3".repeat(50)));
fs.writeFileSync(f4, "纯文本内容");

// 同名不同内容（测去重不能靠文件名）
const f1copy = path.join(TMP, "a-copy.png");
fs.copyFileSync(f1, f1copy);

console.log("═══ ① 种类推断 ═══");
t("图片扩展名 → image", () => kindOf("x.PNG") === "image" ? true : kindOf("x.PNG"));
t("视频扩展名 → video", () => kindOf("x.mp4") === "video" ? true : kindOf("x.mp4"));
t("音频扩展名 → audio", () => kindOf("x.m4a") === "audio" ? true : kindOf("x.m4a"));
t("文本扩展名 → text", () => kindOf("x.json") === "text" ? true : kindOf("x.json"));
t("未知扩展名 → other", () => kindOf("x.xyz") === "other" ? true : kindOf("x.xyz"));

console.log("\n═══ ② fileHash ═══");
t("同内容不同路径 → 同 hash", () => {
  const h1 = fileHash(f1);
  const h2 = fileHash(f1copy);
  return h1 && h1 === h2 ? true : `${h1} vs ${h2}`;
});
t("不同内容 → 不同 hash", () => {
  return fileHash(f1) !== fileHash(f2) ? true : "hash 撞了";
});
t("hash 是 16 位十六进制", () => {
  const h = fileHash(f1);
  return /^[0-9a-f]{16}$/.test(h) ? true : h;
});

console.log("\n═══ ③ 登记与查询 ═══");
let lib;
t("建库 + 无索引时 load 返回 false", () => {
  lib = createAssetLibrary({ indexFile: IDX, log: silent });
  const r = lib.load();
  return r.ok === false ? true : JSON.stringify(r);
});

t("登记 4 个素材", () => {
  lib.add({ path: f1, group: "角色", tags: ["鲸鱼", "参考"], source: "gen" });
  lib.add({ path: f2, group: "输出", tags: ["成片"], source: "gen" });
  lib.add({ path: f3, group: "配音", tags: ["原声"], source: "gen" });
  lib.add({ path: f4, group: "剧本", source: "upload" });
  return lib.stats().total === 4 ? true : lib.stats().total;
});

t("★ 登记不复制文件（只建引用）", () => {
  const before = fs.statSync(f1).size;
  lib.add({ path: f1copy });
  const after = fs.statSync(f1).size;
  // 原文件不变，且没有产生副本
  const filesInMedia = fs.readdirSync(MEDIA).length;
  return before === after && filesInMedia === 3 ? true : `media 里 ${filesInMedia} 个文件`;
});

t("同路径重复登记 → 更新不新增", () => {
  const n1 = lib.stats().total;
  // ★ 用 f2（不是 f1）—— f1 的标签后面还要用来测 tag 过滤，
  //   这里覆盖掉会导致下游断言失败（实测踩过）。
  lib.add({ path: f2, tags: ["新标签"] });
  const n2 = lib.stats().total;
  if (n2 !== n1) return `从 ${n1} 变成 ${n2}`;
  const a = lib.list({ q: "b.mp4" }).find((x) => x.path === f2);
  return a.tags.includes("新标签") ? true : JSON.stringify(a.tags);
});

t("按 kind 过滤", () => {
  const imgs = lib.list({ kind: "image" });
  return imgs.every((a) => a.kind === "image") ? true : "混进了别的种类";
});

t("按 group 过滤", () => {
  const g = lib.list({ group: "角色" });
  return g.length >= 1 && g.every((a) => a.group === "角色") ? true : g.length;
});

t("按 tag 过滤", () => {
  // ★ 注意顺序：下面的「更新标签」测试会把标签改掉，
  //   所以这条必须放在它之前。第一版写在后面，导致搜不到（测试写法问题，不是代码问题）。
  const g = lib.list({ tag: "鲸鱼" });
  if (g.length < 1) return `找到 ${g.length} 个`;
  return g.every((a) => a.tags.includes("鲸鱼")) ? true : "混进了没有该标签的";
});

t("按关键字搜索（名字/路径/标签）", () => {
  const byTag = lib.list({ q: "鲸鱼" });
  const byName = lib.list({ q: "a.png" });
  const byPath = lib.list({ q: "media" });
  return byTag.length >= 1 && byName.length >= 1 && byPath.length >= 1
    ? true : `标签 ${byTag.length} / 名 ${byName.length} / 路径 ${byPath.length}`;
});

console.log("\n═══ ④ ★ 按内容去重 ═══");
t("同一张图两个路径 → 能找到重复", () => {
  const dups = lib.findDuplicates();
  const one = dups.find((d) => d.assets.some((a) => a.path === f1));
  return one && one.assets.length === 2 ? true : JSON.stringify(dups.map((d) => d.assets.map((a) => a.name)));
});

t("不同内容的文件不算重复", () => {
  const dups = lib.findDuplicates();
  const bad = dups.find((d) => d.assets.some((a) => a.path === f2));
  return !bad ? true : "把不同内容判成重复了";
});

console.log("\n═══ ⑤ 更新与删除 ═══");
let aid;
t("更新标签", () => {
  aid = lib.list({ group: "角色" })[0].id;
  const a = lib.update(aid, { tags: ["改过", "角色"] });
  return a.tags.join(",") === "改过,角色" ? true : a.tags.join(",");
});

t("非法字段被拒", () => {
  try { lib.update(aid, { path: "/x" }); } catch { return true; }
  return "非法字段没被拒";
});

t("★ 删素材默认【不删文件】", () => {
  const before = fs.existsSync(f3);
  lib.remove(lib.list({ kind: "audio" })[0].id);
  const after = fs.existsSync(f3);
  return before && after ? true : "★ 文件被删了（不该）";
});

t("显式 deleteFile=true 才删文件", () => {
  const target = lib.list({ q: "a-copy" })[0];
  if (!target) return "找不到副本";
  lib.remove(target.id, { deleteFile: true });
  return !fs.existsSync(f1copy) ? true : "文件还在";
});

console.log("\n═══ ⑥ 缺失检测 ═══");
t("外部删文件后能被发现", () => {
  fs.unlinkSync(f4);
  const missing = lib.findMissing();
  return missing.length === 1 && missing[0].path === f4 ? true : `${missing.length} 个缺失`;
});

t("stats 里 missing 计数对", () => {
  return lib.stats().missing === 1 ? true : lib.stats().missing;
});

console.log("\n═══ ⑦ 目录扫描 ═══");
t("扫描目录批量登记", () => {
  const lib2 = createAssetLibrary({ indexFile: path.join(TMP, "idx2.json"), log: silent });
  const added = lib2.scanDir(MEDIA, { group: "批量" });
  return added.length === 3 ? true : `扫到 ${added.length} 个`;
});

t("按扩展名过滤", () => {
  const lib3 = createAssetLibrary({ indexFile: path.join(TMP, "idx3.json"), log: silent });
  const added = lib3.scanDir(MEDIA, { exts: [".png"] });
  return added.length === 1 && added[0].kind === "image" ? true : `${added.length} 个`;
});

t("目录不存在时抛错", () => {
  try { lib.scanDir(path.join(TMP, "no-such-dir")); } catch { return true; }
  return "没抛错";
});

console.log("\n═══ ⑧ 持久化 ═══");
t("重开新库能 load 出之前的数据", () => {
  const lib4 = createAssetLibrary({ indexFile: IDX, log: silent });
  const r = lib4.load();
  return r.ok === true && r.count === lib.stats().total ? true : JSON.stringify(r);
});

t("load 后统计一致", () => {
  const lib5 = createAssetLibrary({ indexFile: IDX, log: silent });
  lib5.load();
  return lib5.stats().total === lib.stats().total ? true : "不一致";
});

// 清理
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }

console.log("\n" + "═".repeat(58));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  M5 素材库验收全过");
