/**
 * F1 角色卡 · 单测。
 */
import {
  TAG_ROLE,
  CHAR_PREFIX,
  VIEW_PREFIX,
  VIEWS,
  parseCharacterTag,
  groupByCharacter,
  withCharacterTag,
  injectCharacters,
  toRefSpecs,
} from "../src/characters.mjs";

let pass = 0;
let fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name}${extra !== undefined ? "  " + JSON.stringify(extra) : ""}`); }
}

console.log("═".repeat(58));
console.log("  F1 角色卡");
console.log("═".repeat(58));

// ─── ① 常量 ────────────────────────────────────────────────
console.log("\n① 标签常量");
t("TAG_ROLE", TAG_ROLE === "role:character");
t("CHAR_PREFIX", CHAR_PREFIX === "char:");
t("VIEW_PREFIX", VIEW_PREFIX === "view:");
t("VIEWS 有 5 个", VIEWS.length === 5, VIEWS);

// ─── ② parseCharacterTag ─────────────────────────────────
console.log("\n② 解析标签");
t("非角色图 → null", parseCharacterTag({ tags: ["foo"] }) === null);
t("空 tags → null", parseCharacterTag({}) === null);
t("null → null", parseCharacterTag(null) === null);
{
  const c = parseCharacterTag({ tags: [TAG_ROLE, "char:小明", "view:front"] });
  t("解析出名字", c.name === "小明", c);
  t("解析出视角", c.view === "front", c);
  t("isCharacter", c.isCharacter === true);
  const c2 = parseCharacterTag({ tags: [TAG_ROLE] });
  t("只有 role → name=null", c2.name === null && c2.isCharacter === true);
}

// ─── ③ groupByCharacter ──────────────────────────────────
console.log("\n③ 分组");
{
  const assets = [
    { id: "a1", name: "小明-侧.png", path: "D:\\a1.png", tags: [TAG_ROLE, "char:小明", "view:side"] },
    { id: "a2", name: "小明-正.png", path: "D:\\a2.png", tags: [TAG_ROLE, "char:小明", "view:front"] },
    { id: "a3", name: "小红.png", path: "D:\\a3.png", tags: [TAG_ROLE, "char:小红"] },
    { id: "a4", name: "背景.png", path: "D:\\a4.png", tags: ["scene"] },
    { id: "a5", name: "无名.png", path: "D:\\a5.png", tags: [TAG_ROLE] },
  ];
  const g = groupByCharacter(assets);
  t("三个键（含 _unnamed）", Object.keys(g).length === 3, Object.keys(g));
  t("小明 2 张", g["小明"].length === 2);
  t("front 排第一", g["小明"][0].view === "front", g["小明"].map((x) => x.view));
  t("无名的进 _unnamed", (g["_unnamed"] ?? []).length === 1);
  t("背景图不计入", !g["背景"] && !g["scene"]);
}

// ─── ④ withCharacterTag ──────────────────────────────────
console.log("\n④ 打标签");
{
  const r1 = withCharacterTag(["x"], "小明", "side");
  t("含 role", r1.includes(TAG_ROLE));
  t("含 char", r1.includes("char:小明"));
  t("含 view", r1.includes("view:side"));
  t("保留原标签", r1.includes("x"));

  const r2 = withCharacterTag(["char:旧", TAG_ROLE], "新");
  t("替换旧名字", r2.includes("char:新") && !r2.includes("char:旧"));

  const r3 = withCharacterTag(["x", TAG_ROLE, "char:小明"], "小明", null, false);
  t("off 时移除角色标记", !r3.includes(TAG_ROLE) && !r3.some((x) => x.startsWith(CHAR_PREFIX)));
  t("off 时保留原标签", r3.includes("x"));

  const r4 = withCharacterTag(null, "小明");
  t("null tags 不崩", Array.isArray(r4) && r4.includes("char:小明"));
}

// ─── ⑤ injectCharacters ──────────────────────────────────
console.log("\n⑤ 注入槽位");
{
  const g = groupByCharacter([
    { id: "1", name: "小明.png", path: "D:\\1.png", tags: [TAG_ROLE, "char:小明", "view:front"] },
    { id: "2", name: "小红.png", path: "D:\\2.png", tags: [TAG_ROLE, "char:小红"] },
  ]);
  const slots = ["ref_image_0", "ref_image_1", "ref_image_2"];

  const r1 = injectCharacters({ characters: g, names: ["小明", "小红"], slots });
  t("填 2 个槽", r1.assigned.length === 2, r1.assigned);
  t("第一个是小明", r1.assigned[0].character === "小明");
  t("role 固定 subject.character（H3 新 id）", Object.values(r1.filled).every((f) => f.role === "subject.character"));
  t("无警告", r1.warnings.length === 0, r1.warnings);

  // 已占用不覆盖
  const r2 = injectCharacters({
    characters: g, names: ["小明", "小红"], slots,
    files: { ref_image_0: { filename: "用户选的.png" } },
  });
  t("跳过已占用槽", !r2.filled.ref_image_0, Object.keys(r2.filled));
  t("从 ref_image_1 起", r2.assigned[0].slot === "ref_image_1");

  // 缺角色
  const r3 = injectCharacters({ characters: g, names: ["不存在"], slots });
  t("缺角色 → ok=false", r3.ok === false);
  t("missing 有它", r3.missing.includes("不存在"));
  t("有警告", r3.warnings.some((w) => /没有定妆图/.test(w)), r3.warnings);

  // 槽不够
  const r4 = injectCharacters({ characters: g, names: ["小明", "小红"], slots: ["ref_image_0"] });
  t("槽不够 → unfilled 非空", r4.unfilled.length > 0, r4.unfilled);
  t("槽不够 → 有警告", r4.warnings.some((w) => /槽位不够/.test(w)));

  // 角色过多
  const many = {};
  for (const n of ["A", "B", "C", "D"]) many[n] = [{ id: n, name: n + ".png", path: "p", view: null }];
  const r5 = injectCharacters({ characters: many, names: ["A", "B", "C", "D"], slots });
  t("4 角色 → 提示 Subject", r5.warnings.some((w) => /Subject/.test(w)), r5.warnings);

  // 边界
  t("没角色名 → ok=false", injectCharacters({ characters: g, names: [], slots }).ok === false);
  t("没槽位 → ok=false", injectCharacters({ characters: g, names: ["小明"], slots: [] }).ok === false);
  t("重名只占一槽", injectCharacters({ characters: g, names: ["小明", "小明"], slots }).assigned.length === 1);
  t("perCharacter=2 占 2 槽",
    injectCharacters({ characters: groupByCharacter([
      { id: "1", name: "a.png", path: "p", tags: [TAG_ROLE, "char:小明", "view:front"] },
      { id: "2", name: "b.png", path: "p", tags: [TAG_ROLE, "char:小明", "view:side"] },
    ]), names: ["小明"], slots, perCharacter: 2 }).assigned.length === 2);
}

// ─── ⑥ toRefSpecs ────────────────────────────────────────
console.log("\n⑥ toRefSpecs");
{
  const specs = toRefSpecs([
    { slot: "ref_image_0", character: "小明", filename: "a.png", view: "front" },
  ]);
  t("role 是 subject.character（与 injectCharacters 一致）", specs[0].role === "subject.character");
  t("kind 是 image", specs[0].kind === "image");
  t("note 带角色名", specs[0].note.includes("小明"), specs[0]);
  t("空输入 → 空数组", toRefSpecs([]).length === 0 && toRefSpecs(null).length === 0);
}

console.log("\n" + "═".repeat(58));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  F1 角色卡验收全过");
