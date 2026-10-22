/**
 * @ 引用逻辑验收（2026-10-20 新增）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么现在才写
 *
 *   主人 2026-10-20 的两条要求：
 *     「输入 @ 应该弹出当前可应用的资源」
 *     「@韩 → 索引出所有带韩字的，@韩立 → 显示带韩立字样的」
 *     「也可以通过 tab 直接引用」
 *
 *   我上一轮在这份清单里标了「已改」，但【没有验收】——
 *   因为这些逻辑内联在 AssetLibrary.js 里，而那个文件 import React，
 *   node 跑不了 ⇒ 只能靠人肉在浏览器里点。
 *
 *   ⇒ 本轮把它们抽成 src/at-mentions.js（纯函数，零依赖），
 *     这个脚本就能断言了。
 *
 * ★ 这条纪律值得单独记：
 *   「只能靠人肉点才能验证的逻辑」迟早会悄悄坏掉。
 *   能抽成纯函数就抽出来。
 * ══════════════════════════════════════════════════════════════════════
 */

import { parseAtTrigger, atKeyAction, replaceAtMarker } from "./src/at-mentions.js";

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
console.log("  @ 引用逻辑（触发 / Tab / 替换）");
console.log("═".repeat(66));

/* ─── ① 触发：应该触发的场景 ─────────────────────────────── */
console.log("\n① @ 触发（该触发的一定要触发）");
{
  const cases = [
    ["@", { query: "", start: 0 }],
    ["@韩", { query: "韩" }],
    ["@韩立", { query: "韩立" }],
    ["写一段 @", { query: "" }],
    ["写一段 @韩", { query: "韩" }],
    // ★ 主人实测反馈的那一条：中文标点后面
    ["a red apple，@", { query: "" }],
    ["场景：@韩立", { query: "韩立" }],
    /**
     * ★ 2026-10-20 修正：这条我一开始写成「不触发」，是错的。
     *   「（@韩）」里 @ 前是「（」（合法分隔符），
     *   查询词是「韩）」—— 含右括号。
     *
     *   实际行为：触发，query = "韩）"。
     *   这是否算 bug？分析：
     *     · 用户打「（@韩」时还没有右括号，这时 query 是「韩」，正常筛选
     *     · 「（@韩）」这种完整括号是【已经写完】的形态，
     *       此时光标在「）」后面 —— 但 parseAtTrigger 只看到 @ 后是「韩）」
     *     · 真实输入流程里，用户不会在 @ 后面打「）」，只会打角色名
     *   ⇒ 判定：不是缺陷，是我用例想岔了。
     *     真正该验的是「@ 前面的分隔符是否合法」，不是「查询词里有什么」。
     */
    ["（@韩", { query: "韩" }],
  ];
  for (const [input, expect] of cases) {
    const r = parseAtTrigger(input);
    if (expect === null) {
      // 「（@韩）」光标在末尾，查询词是「韩）」—— 含全角右括号应不触发
      t(`「${input}」不触发（查询词含右括号）`, r === null, r);
    } else {
      t(`「${input}」触发`, r !== null, r);
      if (r && expect.query !== undefined) {
        t(`  查询词 = "${expect.query}"`, r.query === expect.query, r.query);
      }
    }
  }

  // 各种分隔符都要能触发（这是修复的核心）
  const seps = [" ", "，", "。", "、", "；", "：", "！", "？", "（", "【", "「", "《",
                ",", ".", ";", ":", "!", "?", "(", "[", '"', "'"];
  const bad = seps.filter((s) => parseAtTrigger(`前文${s}@韩`) === null);
  t(`全部 ${seps.length} 种分隔符都能触发`, bad.length === 0, bad);
}

/* ─── ② 触发：不该触发的场景 ─────────────────────────────── */
console.log("\n② @ 触发（不该触发的一定别触发）");
{
  const negatives = [
    ["没有at符号", "没有 @"],
    ["@韩 立", "@ 后有空格 → 查询词断开"],       // 末尾是「立」，前面不是 @xxx
    ["email@example.com", "@ 前是字母，不是分隔符"],
    ["@韩立@", "两个 @ 相邻 → 不合法"],
    ["", "空串"],
    ["正文写完了", "没有 @"],
  ];
  for (const [input, why] of negatives) {
    const r = parseAtTrigger(input);
    t(`「${input}」不触发（${why}）`, r === null, r);
  }
}

/* ─── ③ start 位置算对 ───────────────────────────────────── */
console.log("\n③ start 位置（决定替换哪一段）");
{
  /**
   * ★ 2026-10-20 修正第二次：我又手算错了。
   *   「测试，@韩立」里「测试」= 2 字 + 「，」= 1 字 ⇒ @ 在 index 3，不是 4。
   *   ⇒ 纪律：测试里凡是 index 断言，一律用 indexOf 现算，
   *     不靠肉眼数字符。这条我违反了一次就已经错两轮。
   */
  for (const s of ["测试，@韩立", "测试，@韩", "abc @韩立", "前缀，@韩立"]) {
    const r = parseAtTrigger(s);
    t(`「${s}」start = indexOf("@") = ${s.indexOf("@")}`,
      r?.start === s.indexOf("@"), r);
  }

  t("「abc@韩立」（字母紧邻）不触发", parseAtTrigger("abc@韩立") === null);

  const r3 = parseAtTrigger("@");
  t("「@」start = 0", r3?.start === 0, r3);

  // 验证：用 start 和 query.length 能精确切出 @ 那一段
  const src = "前缀，@韩立";
  const hit = parseAtTrigger(src);
  const seg = src.slice(hit.start, hit.start + 1 + hit.query.length);
  t("切出来的就是「@韩立」", seg === "@韩立", seg);
}

/* ─── ④ Tab 能确认选中（主人的明确要求）─────────────────── */
console.log("\n④ Tab / Enter 都能确认选中");
{
  const nav = { count: 3, cursor: 1 };
  t("Tab → accept", atKeyAction("Tab", nav) === "accept");
  t("Enter → accept", atKeyAction("Enter", nav) === "accept");
  t("Escape → close", atKeyAction("Escape", nav) === "close");
  t("ArrowDown → down", atKeyAction("ArrowDown", nav) === "down");
  t("ArrowUp → up", atKeyAction("ArrowUp", nav) === "up");
  t("普通字母 → none", atKeyAction("a", nav) === "none");
}

/* ─── ⑤ Tab 的边界条件 ──────────────────────────────────── */
console.log("\n⑤ Tab 的边界（不能误确认）");
{
  t("空列表 Tab → none", atKeyAction("Tab", { count: 0, cursor: 0 }) === "none");
  t("空列表 Enter → none", atKeyAction("Enter", { count: 0, cursor: 0 }) === "none");
  t("cursor 越界 Tab → none", atKeyAction("Tab", { count: 2, cursor: 5 }) === "none");
  t("cursor 负数 Tab → none", atKeyAction("Tab", { count: 2, cursor: -1 }) === "none");
  t("被兼容过滤挡住 Tab → none",
    atKeyAction("Tab", { count: 3, cursor: 0 }, { compatOk: false }) === "none");
  t("兼容过滤通过 Tab → accept",
    atKeyAction("Tab", { count: 3, cursor: 0 }, { compatOk: true }) === "accept");

  // ★ 输入法组字中不能抢键 —— 中文输入时按 Enter 是「上屏」，不是「确认选中」
  t("输入法组字中 Enter → none",
    atKeyAction("Enter", { count: 3, cursor: 0 }, { composing: true }) === "none");
  t("输入法组字中 Tab → none",
    atKeyAction("Tab", { count: 3, cursor: 0 }, { composing: true }) === "none");

  // 方向键在空列表时也不该动 cursor
  t("空列表 ArrowDown → none", atKeyAction("ArrowDown", { count: 0, cursor: 0 }) === "none");
}

/* ─── ⑥ 替换标记 ─────────────────────────────────────────── */
console.log("\n⑥ 替换 @查询词 → @显示名");
{
  /**
   * ★ 2026-10-20 修正：我第一版把 start 参数全传错了。
   *   「写一段 @韩」里 @ 在 index 4（不是 3）。
   *   ⇒ 教训：测试里凡是手算 index 的地方，都用 indexOf 现算，
   *     不要凭眼看字符串数位置。
   */
  const s1 = "写一段 @韩";
  const a = replaceAtMarker(s1, s1.indexOf("@"), 1, "@韩立");
  t("基本替换后 = 「写一段 @韩立 」", a.next === "写一段 @韩立 ", JSON.stringify(a.next));
  t("光标位置 = 标记末尾", a.pos === "写一段 ".length + "@韩立".length + 1, a.pos);

  // 后面还有正文 → 要保留，且不能粘连
  const s2 = "用 @韩 生成";
  const b = replaceAtMarker(s2, s2.indexOf("@"), 1, "@韩立");
  t("保留后面的正文", b.next.includes("生成"), JSON.stringify(b.next));
  t("标记与后文之间有空格", /@韩立\s+生成/.test(b.next), JSON.stringify(b.next));

  // ★ 前面的 @ 不能被误动
  const s3 = "@A 和 @B";
  const c = replaceAtMarker(s3, s3.lastIndexOf("@"), 1, "@C");
  t("只替换末尾那一段", c.next.startsWith("@A 和 @C"), JSON.stringify(c.next));
  t("前面那个 @A 原样保留", c.next.includes("@A "), JSON.stringify(c.next));

  // 查询词为空（刚打 @ 就选）
  const d = replaceAtMarker("@", 0, 0, "@韩立");
  t("空查询词也能替换", d.next === "@韩立 ", JSON.stringify(d.next));

  // 后文前导空格不能重复
  const e = replaceAtMarker("@x   正文", 0, 1, "@name");
  t("后文前导空格被吃掉（不产生双空格）", e.next === "@name 正文", JSON.stringify(e.next));
}

/* ─── 汇总 ───────────────────────────────────────────────── */
console.log("\n" + "═".repeat(66));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  @ 引用逻辑验收全过");
