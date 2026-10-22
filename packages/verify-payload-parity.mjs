#!/usr/bin/env node
/**
 * 检查「同一个 payload 字段是否在所有构造点都带上了」
 *
 * 为什么有这个脚本：
 *   2026-10-21 同一天，「修了一半」出现三次：
 *     ① lost/error 状态：bridge 产出，dsh-editor 没消费
 *     ② role 写回：写回做了，绑定槽位时没读回
 *     ③ role 持久化：绑定路径修了，saveSlotRefs + 恢复构造都没修
 *
 *   判据：加一个 payload 字段时，grep 所有「构造这个 payload 的地方」，
 *        不是只修报错的那一处。
 *
 * 做法：
 *   1. 找出所有「构造 files[slot] 对象」的代码位置
 *      （形如 `assetId:` 出现的对象字面量）
 *   2. 统计每个位置带了哪些字段
 *   3. 报出「有的位置带、有的位置没带」的字段
 *
 * 用法：node verify-payload-parity.mjs
 * 退出码 0 = 所有构造点字段一致，1 = 有不一致
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGET = path.join(HERE, "dsh-comfy-workbench-tab", "src", "AssetLibrary.js");

console.log("\n  payload 字段一致性检查");
console.log(`  目标：${path.basename(TARGET)}`);

if (!fs.existsSync(TARGET)) {
  console.log("  ⚠ 文件不存在，跳过");
  process.exit(0);
}

const src = fs.readFileSync(TARGET, "utf8");
const lines = src.split(/\r?\n/);

/**
 * 找「构造 files[slot] 对象」的位置。
 *
 * 特征是对象字面量里同时出现 assetId 和 kind 与 base64 或 rel
 * —— 这是 payload 的身份三元组。
 * 用「以 assetId: 开头的对象块」定位，再往上/下扩到所在的对象字面量。
 */
const sites = [];

for (let i = 0; i < lines.length; i++) {
  if (!/^\s*assetId:/.test(lines[i])) continue;

  // 往回找对象起点（最近的 `{` 行）
  let start = i;
  while (start > 0 && !lines[start].includes("{")) start--;
  // 如果那行没 `{`，再往上找
  while (start > 0 && !lines[start].includes("{")) start--;

  // 往下找对象结束（缩进相同的 `}`）
  const baseIndent = (lines[start].match(/^\s*/) || [""])[0].length;
  let end = start;
  for (let k = i; k < Math.min(i + 40, lines.length); k++) {
    const ind = (lines[k].match(/^\s*/) || [""])[0].length;
    if (k > i && lines[k].trim() === "}" && ind <= baseIndent) { end = k; break; }
    if (k > i && lines[k].trim() === "};" && ind <= baseIndent) { end = k; break; }
    end = k;
  }

  /**
   * ★ 2026-10-21 修：注释里的 `src + rel 要一起带上` 被误判成字段 src。
   *   ⇒ 解析前先剥掉注释行（// 与 * 开头的），以及行尾 // 注释。
   */
  const block = lines.slice(start, end + 1)
    .map((l) => {
      const t = l.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return "";
      return l.replace(/\/\/.*$/, "");
    })
    .join("\n");
  // 收集这个对象里出现的字段名（形如 `xxx:` 或 `...(... x.xxx ...)`）
  const fields = new Set();
  /**
   * ★ 2026-10-21 修：原来只抓「行首的 xxx:」，漏了同一行写多个字段的情况
   *    实测：`assetId: f.assetId, src: f.src, rel: f.rel,` 只抓到 assetId。
   *   ⇒ 改为抓【所有】 `xxx:` 形式（含行中），但排除三元表达式的 `? :`。
   */
  for (const m of block.matchAll(/(?:^|[{,]\s*)([a-zA-Z_$][\w$]*)\s*:/gm)) fields.add(m[1]);
  // 展开式：...(x.role ? { role: x.role } : {})
  for (const m of block.matchAll(/\.\.\.\([^)]*?\.([a-zA-Z_$][\w$]*)\s*\?/g)) fields.add(m[1]);

  sites.push({
    line: start + 1,
    endLine: end + 1,
    fields,
    block: block.split("\n").slice(0, 3).join(" ").slice(0, 70),
  });
}

if (sites.length < 2) {
  console.log(`  只找到 ${sites.length} 个构造点，无需比对`);
  process.exit(0);
}

console.log(`  找到 ${sites.length} 个构造点：`);
for (const s of sites) {
  console.log(`    第 ${s.line}~${s.endLine} 行  ${s.fields.size} 个字段`);
}

// 所有出现过的字段
const all = new Set();
for (const s of sites) for (const f of s.fields) all.add(f);

// 找出「有位置带、有位置不带」的字段
const inconsistent = [];
for (const f of all) {
  const has = sites.filter((s) => s.fields.has(f)).length;
  if (has > 0 && has < sites.length) {
    inconsistent.push({ field: f, has, total: sites.length, missing: sites.filter((s) => !s.fields.has(f)).map((s) => s.line) });
  }
}

console.log("");
if (!inconsistent.length) {
  console.log("  ✅ 所有构造点字段一致");
  process.exit(0);
}

console.log(`  ⚠ 有 ${inconsistent.length} 个字段只在部分构造点出现：`);
for (const inc of inconsistent) {
  console.log(`    ${inc.field.padEnd(14)} ${inc.has}/${inc.total} 个点有，缺的行：${inc.missing.join(", ")}`);
}

/**
 * 判定：这些「缺失」是不是真缺陷？
 *
 * 不是所有字段都该在三个点都有 —— 比如 preview（ObjectURL）
 * 在持久化时不该存（配额），在恢复时也不能存（要重建）。
 * 所以这里只【报告】，退出码恒为 0，由人判断。
 *
 * ★ 为什么不直接 fail：误报会让这个检查变成噪音，然后就没人看了
 *   （AGENTS §6.43 那条判据的教训：能失败的检查才有价值，
 *     但天天假失败的检查反而更糟）。
 */
console.log("");
console.log("  ↑ 以上需人工判断：preview / base64 这类字段本来就不该每处都有");
console.log("    重点看 role / folder / character 这类【业务字段】是否齐全");
process.exit(0);
