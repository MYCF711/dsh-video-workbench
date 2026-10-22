/**
 * 资产库「指定根目录 + 分类」验收（2026-10-19）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 主人原话：
 *   「资产库需要在一个可以指定的目录位置。这个目录做好分类，
 *     其他地方的不要弄进去」
 *
 * ⇒ 这条验收的核心不是「能不能扫」，而是【边界】：
 *   根目录里、分类子目录里的要进来；
 *   根目录外的【绝对不能】被带进来。
 *
 * ══════════════════════════════════════════════════════════════════════
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAssetLibrary, CATEGORY_DIRS } from "../src/assets.mjs";

let pass = 0, fail = 0;
const failures = [];
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name}${extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 140) : ""}`); }
};

const TMP = path.join(os.tmpdir(), `assets-root-${Date.now()}`);
const ROOT = path.join(TMP, "资产库");
const OUTSIDE = path.join(TMP, "别处");

// 造目录：
//   资产库/图片/角色/a.png
//   资产库/视频/b.mp4
//   资产库/音频/c.m4a
//   资产库/文本/d.srt
//   资产库/散落.png            ← 根目录下的散落文件，应该被收
//   别处/不该进来.png           ← 根目录外，绝对不能进
fs.mkdirSync(path.join(ROOT, "图片", "角色"), { recursive: true });
fs.mkdirSync(path.join(ROOT, "视频"), { recursive: true });
fs.mkdirSync(path.join(ROOT, "音频"), { recursive: true });
fs.mkdirSync(path.join(ROOT, "文本"), { recursive: true });
fs.mkdirSync(OUTSIDE, { recursive: true });
for (const p of [
  path.join(ROOT, "图片", "角色", "a.png"),
  path.join(ROOT, "视频", "b.mp4"),
  path.join(ROOT, "音频", "c.m4a"),
  path.join(ROOT, "文本", "d.srt"),
  path.join(ROOT, "散落.png"),
  path.join(OUTSIDE, "不该进来.png"),
]) {
  fs.writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])); // 内容不重要
}

console.log("═".repeat(64));
console.log("  资产库「指定根目录 + 分类」验收");
console.log("═".repeat(64));

const lib = createAssetLibrary({ indexFile: path.join(TMP, "assets.json"), log: { warn() {} } });

// ─── ① 分类目录常量 ─────────────────────────────────────────
console.log("\n① 分类目录");
t("五个分类目录都有中文名", Object.keys(CATEGORY_DIRS).length === 5, Object.keys(CATEGORY_DIRS));
t("image → 图片", CATEGORY_DIRS.image === "图片");
t("audio → 音频", CATEGORY_DIRS.audio === "音频");

// ─── ② 扫根目录 ─────────────────────────────────────────────
console.log("\n② scanRoot 只收根目录内的");
const r = lib.scanRoot(ROOT);
t("返回结构完整（added/byKind/skipped/root）",
  !!r.added && !!r.byKind && Array.isArray(r.skipped) && r.root === ROOT);
t("共收 5 个（4 个分类 + 1 个散落）", r.added.length === 5, r.added.length);

// ─── ③ 分类正确 ─────────────────────────────────────────────
console.log("\n③ 分类归属");
t("图片 2 个（子目录 1 + 散落 1）", r.byKind.image === 2, r.byKind);
t("视频 1 个", r.byKind.video === 1, r.byKind);
t("音频 1 个", r.byKind.audio === 1, r.byKind);
t("文本 1 个", r.byKind.text === 1, r.byKind);

// ─── ④ 分组自动打上分类名 ───────────────────────────────────
console.log("\n④ 分组");
const items = lib.list({ limit: 1000 });
const audioItem = items.find((x) => x.name === "c.m4a");
t("分类目录里的文件 group = 分类名", audioItem?.group === "音频", audioItem?.group);
const loose = items.find((x) => x.name === "散落.png");
t("根目录散落文件 group 为空（不瞎猜）", loose?.group === null || loose?.group === undefined, loose?.group);

// ─── ⑤★ 边界：根目录外的绝不进来 ───────────────────────────
console.log("\n⑤ 边界（核心）");
const outsideIn = items.find((x) => x.name === "不该进来.png");
t("根目录外的文件【没有】进库", !outsideIn, outsideIn?.path);
t("库里所有 path 都在根目录下",
  items.every((x) => String(x.path).toLowerCase().startsWith(ROOT.toLowerCase())),
  items.filter((x) => !String(x.path).toLowerCase().startsWith(ROOT.toLowerCase())).map((x) => x.path));

// ─── ⑥ 重复扫描不重复登记 ───────────────────────────────────
console.log("\n⑥ 幂等");
const r2 = lib.scanRoot(ROOT);
t("第二次扫描新增 0 个", r2.added.length === 0, r2.added.length);
t("总数仍是 5", lib.list({ limit: 1000 }).length === 5, lib.list({ limit: 1000 }).length);

// ─── ⑦ 不存在的根目录要抛错 ─────────────────────────────────
console.log("\n⑦ 错误处理");
let threw = false, msg = "";
try { lib.scanRoot(path.join(TMP, "不存在的目录")); }
catch (e) { threw = true; msg = e.message; }
t("不存在的根目录抛错", threw);
t("错误信息说明是根目录不存在", /根目录不存在/.test(msg), msg.slice(0, 60));
t("不自动创建目录（避免拼错路径被静默当成空库）",
  !fs.existsSync(path.join(TMP, "不存在的目录")));

let threw2 = false;
try { lib.scanRoot(""); } catch { threw2 = true; }
t("空 root 抛错", threw2);

// ─── ⑧ 缺分类子目录也能工作 ─────────────────────────────────
console.log("\n⑧ 只有部分分类目录时");
const ROOT2 = path.join(TMP, "只有图片");
fs.mkdirSync(path.join(ROOT2, "图片"), { recursive: true });
fs.writeFileSync(path.join(ROOT2, "图片", "x.png"), Buffer.from([1, 2, 3]));
const lib2 = createAssetLibrary({ indexFile: path.join(TMP, "a2.json"), log: { warn() {} } });
const r3 = lib2.scanRoot(ROOT2);
t("不报错", !!r3);
t("收到 1 个图片", r3.byKind.image === 1, r3.byKind);

// ─── 清理 ───────────────────────────────────────────────────
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

console.log("\n" + "═".repeat(64));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  资产库根目录验收全过");
