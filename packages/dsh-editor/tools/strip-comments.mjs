/**
 * 清理插件源码里的注释 —— 只留「不看会写出 bug」的部分。
 *
 * 保留判据（命中任一即保留）：
 *   · 含 ffmpeg / 浏览器 / 框架 的硬性约束（会报错的那种）
 *   · 含「必须 / 不能 / 注意 / 会报错 / 实测」等警告词
 *   · @param / @returns 之类的 API 契约
 *   · 单行的行尾注释（多半是解释某个魔数）
 *
 * 删除判据：
 *   · 文件头的大段设计思路（保留一行标题）
 *   · 「为什么这样做」的论证段
 *   · 显而易见的说明（如 "// 设置状态"、"// 返回结果"）
 *
 * 用法：node tools/strip-comments.mjs [--dry]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "src");
const DRY = process.argv.includes("--dry");

/** 保留标记：出现这些词的行所在的注释块整体保留。 */
const KEEP_PATTERNS = [
  /必须/, /不能/, /不要/, /会报/, /报错/, /失败/, /实测/, /注意/,
  /★/, /⚠/, /否则/, /禁止/, /错位/, /丢失/, /绕过/,
  /@param/, /@returns/, /@type/, /@typedef/,
  /ffmpeg/, /EventSource/, /cordis/, /React/, /Hook/, /useCallback/,
  /MEDIA_ELEMENT/, /Stream specifier/, /Invalid effect/, /provide/,
  /concat/, /setpts/, /fps=/, /anullsrc/, /rubberband/, /afade/,
  /Range/, /SSE/, /undefined/, /null/,
];

/** 删除标记：纯设计说明/故事，即使命中保留词也删。 */
const DROP_PATTERNS = [
  /^★\s*设计要点/, /^★\s*设计决策/, /^★\s*需求/, /^★\s*为什么/,
  /^★\s*分离策略/, /^★\s*对齐规则/, /^★\s*三条设计/,
  /^★\s*这里踩过/, /^★\s*铁律/,
];

function shouldKeepBlock(blockText) {
  const lines = blockText.split("\n");
  // 纯设计说明区块整体删
  for (const l of lines) {
    const t = l.replace(/^\s*\*?\s*/, "").trim();
    if (DROP_PATTERNS.some((p) => p.test(t))) return false;
  }
  // 命中警告词的保留
  for (const l of lines) {
    const t = l.replace(/^\s*\*?\s*/, "").trim();
    if (KEEP_PATTERNS.some((p) => p.test(t))) return true;
  }
  return false;
}

/** 精简一个块注释：去掉空行与装饰，只保留实质行。 */
function compactBlock(comment) {
  const inner = comment
    .replace(/^\/\*\*?/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\*?\s?/, "").trim())
    .filter((l) => l.length > 0);
  if (inner.length === 0) return "";
  if (inner.length === 1) return `/** ${inner[0]} */`;
  return "/**\n" + inner.map((l) => ` * ${l}`).join("\n") + "\n */";
}

let changedFiles = 0;
let removedLines = 0;

for (const name of fs.readdirSync(SRC).filter((n) => n.endsWith(".mjs"))) {
  const file = path.join(SRC, name);
  const src = fs.readFileSync(file, "utf8");
  const lines = src.split("\n");
  const out = [];
  let i = 0;
  let removedHere = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // 块注释开始
    if (trimmed.startsWith("/*")) {
      const start = i;
      let end = i;
      while (end < lines.length && !lines[end].includes("*/")) end += 1;
      const block = lines.slice(start, end + 1).join("\n");

      if (shouldKeepBlock(block)) {
        const compact = compactBlock(block);
        const origCount = end - start + 1;
        const newCount = compact.split("\n").length;
        removedHere += origCount - newCount;
        out.push(...compact.split("\n"));
      } else {
        removedHere += end - start + 1;
      }
      i = end + 1;
      continue;
    }

    // 单行 // 注释
    if (trimmed.startsWith("//")) {
      const keep = shouldKeepBlock(trimmed);
      if (keep) {
        out.push(line);
      } else {
        removedHere += 1;
      }
      i += 1;
      continue;
    }

    out.push(line);
    i += 1;
  }

  if (removedHere > 0) {
    changedFiles += 1;
    removedLines += removedHere;
    if (!DRY) {
      // 收掉连续空行
      const cleaned = out.join("\n").replace(/\n{3,}/g, "\n\n");
      fs.writeFileSync(file, cleaned, "utf8");
    }
    console.log(`  ${name.padEnd(24)} -${removedHere} 行`);
  }
}

console.log(`\n  ${DRY ? "[dry] " : ""}处理 ${changedFiles} 个文件，删除 ${removedLines} 行注释`);
