/**
 * check-css-template.mjs · CSS 模板字符串检查（2026-10-22）
 *
 * ══════════════════════════════════════════════════════════════════════
 * ★★ 为什么需要这个脚本（同一个坑一天踩了五次，最后一次是致命的）
 *
 *   editor.css.js 的外层是一个模板字符串，里面放 CSS 原文。
 *   有两类字符会破坏它，而且报错位置永远指向看起来毫无问题的注释：
 *
 *   坑 A · 注释里出现反引号
 *     → 提前闭合模板
 *     → esbuild 报 Expected ";" but found xxx，指向注释位置
 *
 *   坑 B · 注释【正文】里出现注释结束符（星号紧跟斜杠的那两个字符）
 *     → 提前结束注释块
 *     → 后面的 CSS 声明与规则被当成非法内容整段丢弃
 *     → 编译不报错、页面不报错，只是样式没生效
 *
 *   坑 B 是致命的：它不报错。我因此把「导入按钮看不见」修了三次都没对。
 *   浏览器里实测到的现象：
 *     style 标签的 textContent 里明明有这条规则
 *     但 sheet.cssRules 里找不到它
 *     getComputedStyle 拿到透明背景 ⇒ 白字白底 ⇒ 按钮看不见
 *
 *   ⇒ 把两类检查固化。人对注释没有记性，脚本有。
 *
 * ── 判据
 *   · 反引号必须恰好 2 个（模板开闭各一）
 *   · 第一个在 export default 那一行，最后一个在闭合行
 *   · 注释行里不许有反引号
 *   · 注释正文里不许出现注释结束符（行尾作为块结束是合法的）
 *   · 注释块必须全部闭合
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "src");

/** 所有「整份内容是 CSS 模板字符串」的文件。 */
const TARGETS = ["editor.css.js"];

/**
 * ★ 把会提前闭合的字符组合用【运行时拼接】表示，
 *   避免本文件自己踩同一个坑（写死就会把本文件破坏）。
 */
const BT = String.fromCharCode(96);       // 反引号
const CLOSE = "*" + "/";                  // 注释结束符
const OPEN = "/" + "*";                   // 注释起始符

let pass = 0;
const fails = [];
const check = (name, ok, detail = "") => {
  if (ok) { pass++; return; }
  fails.push({ name, detail });
};

for (const f of TARGETS) {
  const p = path.join(SRC, f);
  if (!fs.existsSync(p)) {
    check(`${f} 存在`, false, p);
    continue;
  }
  const src = fs.readFileSync(p, "utf8");
  const lines = src.split("\n");

  /* ── ① 反引号总数 ── */
  const btPositions = [];
  lines.forEach((ln, i) => {
    const n = ln.split(BT).length - 1;
    if (n > 0) btPositions.push({ line: i + 1, n, text: ln.trim().slice(0, 70) });
  });
  const btTotal = btPositions.reduce((s, x) => s + x.n, 0);

  check(
    `${f} 反引号恰好 2 个（模板开闭）`,
    btTotal === 2,
    btTotal === 2 ? "" : `实际 ${btTotal} 个，出现位置：\n` +
      btPositions.map((x) => `   L${x.line} (${x.n} 个): ${x.text}`).join("\n")
  );

  /* ── ② 反引号位置 ── */
  if (btTotal === 2) {
    const first = btPositions[0];
    const last = btPositions[btPositions.length - 1];
    check(
      `${f} 第一个反引号在 export default 行`,
      /export\s+default/.test(lines[first.line - 1] || ""),
      `L${first.line}: ${(lines[first.line - 1] || "").trim().slice(0, 60)}`
    );
    check(
      `${f} 最后一个反引号在闭合行`,
      (lines[last.line - 1] || "").trim().startsWith(BT),
      `L${last.line}: ${(lines[last.line - 1] || "").trim().slice(0, 60)}`
    );
  }

  /* ── ③ 注释行里不许有反引号 ── */
  const btInComments = [];
  lines.forEach((ln, i) => {
    if (/^\s*(\*|\/\*)/.test(ln) && ln.includes(BT)) {
      btInComments.push({ line: i + 1, text: ln.trim().slice(0, 70) });
    }
  });
  check(
    `${f} 注释里没有反引号`,
    btInComments.length === 0,
    btInComments.length === 0 ? "" :
      "这些注释里的反引号会提前闭合模板：\n" +
      btInComments.map((x) => `   L${x.line}: ${x.text}`).join("\n")
  );

  /* ── ④ ★ 注释正文里不许有注释结束符（坑 B，不报错但样式全丢） ── */
  const earlyClose = [];
  let inComment = false;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!inComment) {
      const oi = ln.indexOf(OPEN);
      if (oi >= 0) {
        inComment = true;
        const afterOpen = ln.slice(oi + 2);
        const ci = afterOpen.indexOf(CLOSE);
        if (ci >= 0) {
          /* 同一行内开了又闭：只有闭合符在行尾才算正常 */
          const tail = afterOpen.slice(ci + 2).trim();
          if (tail.length > 0) {
            earlyClose.push({ line: i + 1, text: ln.trim().slice(0, 80) });
          }
          inComment = false;
        }
      }
      continue;
    }
    /* 在注释块内 */
    const ci = ln.indexOf(CLOSE);
    if (ci >= 0) {
      const tail = ln.slice(ci + 2).trim();
      if (tail.length > 0) {
        earlyClose.push({ line: i + 1, text: ln.trim().slice(0, 80) });
      }
      inComment = false;
    }
  }
  check(
    `${f} 注释正文里没有提前结束符`,
    earlyClose.length === 0,
    earlyClose.length === 0 ? "" :
      "这些行里的注释结束符会提前结束注释注释块，后面整段 CSS 被悄悄丢弃：\n" +
      earlyClose.map((x) => `   L${x.line}: ${x.text}`).join("\n")
  );

  /* ── ⑤ 注释开后必须有对应闭合 ── */
  check(`${f} 注释块全部闭合`, !inComment,
    inComment ? "文件结束时仍在注释中 ⇒ 后面所有 CSS 都被吞了" : "");
}

/* ── 汇总 ── */
console.log("");
if (fails.length === 0) {
  console.log(`  ✅ CSS 模板检查通过：${pass}/${pass}`);
  process.exit(0);
}
console.log("  ❌ CSS 模板检查失败");
for (const f of fails) {
  console.log(`   · ${f.name}`);
  if (f.detail) console.log(f.detail.split("\n").map((l) => "     " + l).join("\n"));
}
console.log(`\n   通过 ${pass} / ${pass + fails.length}`);
process.exit(1);
