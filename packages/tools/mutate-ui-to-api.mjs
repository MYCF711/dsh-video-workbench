// 对 ui-to-api 五条判据做变异测试
/**
 * ★ 2026-10-23 D2 去敏：本文件原来写死了 D:/主工作区/... 绝对路径。
 *   别人 clone 到别的盘就全失效 ⇒ 改成从本文件位置推导。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const SRC = path.join(HERE, "ui-to-api.mjs");
const VERIFY = path.join(HERE, "verify-ui-to-api.mjs");
const orig = fs.readFileSync(SRC, "utf8");

const mutations = [
  {
    name: "① 改回「只取 link===null」",
    from: `  const widgets = ins.filter((x) => {
    const s = lookup(x.name);
    /* ★ 拿不到定义时保守跳过 —— 宁可少一个也别错位 */
    if (!s) return false;
    return isWidgetSpec(s);
  }).map((x) => x.name);`,
    to: `  const widgets = ins.filter((x) => x.link == null).map((x) => x.name);`,
  },
  {
    name: "② 去掉 COMBO 家族判断",
    from: `  if (/COMBO/i.test(t)) return true;`,
    to: ``,
  },
  {
    name: "③ 不处理 control_after_generate",
    from: `    if (opts && opts.control_after_generate) out.push("control_after_generate");`,
    to: ``,
  },
  {
    name: "④ 不处理对象形式的 widgets_values",
    from: `    } else if (n.widgets_values && typeof n.widgets_values === "object" && !Array.isArray(n.widgets_values)) {`,
    to: `    } else if (false) {`,
  },
  {
    name: "⑤ 不去掉虚拟节点",
    from: `const VIRTUAL = new Set(["Reroute", "SetNode", "GetNode", "PrimitiveNode", "Note", "MarkdownNote"]);`,
    to: `const VIRTUAL = new Set(["Note", "MarkdownNote"]);`,
  },
];

let pass = 0, fail = 0;
for (const m of mutations) {
  if (!orig.includes(m.from)) {
    console.log(`  ⚠ 未匹配：${m.name}`);
    fail++;
    continue;
  }
  fs.writeFileSync(SRC, orig.replace(m.from, m.to), "utf8");
  const r = spawnSync("node", [VERIFY], { encoding: "utf8" });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  const red = r.status !== 0 || /✗/.test(out);
  console.log(`  ${red ? "✅ 变红" : "❌ 假通过"}  ${m.name}`);
  red ? pass++ : fail++;
}

fs.writeFileSync(SRC, orig, "utf8");
console.log("");
console.log(`变异测试：${pass} / ${pass + fail} 能变红`);

// 复原后复跑
const r = spawnSync("node", [VERIFY], { encoding: "utf8" });
const ok = r.status === 0;
console.log(ok ? "复原后验收：全部通过" : "复原后验收：❌ 有失败");
process.exit(ok && fail === 0 ? 0 : 1);
