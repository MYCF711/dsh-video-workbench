/**
 * 变异测试：verify-preset-discovery.mjs 是否真的会变红
 *
 * 这三条缺陷当初都是【静默】的 —— 所以每条都必须证明
 * 「改回错误写法 ⇒ 验收会红」。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BAK = (f) => f + ".mutant-bak";

const MUTANTS = [
  {
    name: "package.json 改回 dsh.agentPreset（DSH 发现不了）",
    file: "package.json",
    from: '"bundle": {',
    to: '"agentPreset": { "entry": "agent.cordis.yml" }, "bundle": {',
  },
  {
    name: "功能字段名改回 dirs（技能静默不注册）",
    file: "cordis.patch.yml",
    from: "customSkillDirs:",
    to: "dirs:",
  },
  {
    name: "技能路径改回 ./skills（指向 profile 目录）",
    file: "cordis.patch.yml",
    from: "!!js process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:path').dirname(process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('dsh-comfy-preset/package.json')), 'skills')",
    to: "./skills",
  },
  {
    name: "去掉 insert 里的 agent-preset 行（预设不注册）",
    file: "cordis.patch.yml",
    from: "name: '@deepseek-ai/dsh-agent-preset'",
    to: "name: '@deepseek-ai/dsh-noop'",
  },
  {
    name: "技能里删掉 comfy_workbench_fill 说明（会用了但不会用）",
    file: "skills/comfy-mode-dispatch/SKILL.md",
    from: "comfy_workbench_fill",
    to: "某个不存在的工具",
  },
];

let caught = 0;
const total = MUTANTS.length;
console.log("\n=== 变异测试：verify-preset-discovery.mjs ===\n");

for (const m of MUTANTS) {
  const f = path.join(HERE, m.file);
  fs.copyFileSync(f, BAK(f));
  try {
    const before = fs.readFileSync(f, "utf8");
    if (!before.includes(m.from)) {
      console.log(`  !! ${m.name}\n     锚点不存在 —— 未验证`);
      continue;
    }
    fs.writeFileSync(f, before.split(m.from).join(m.to), "utf8");
    let red = false;
    try {
      execFileSync(process.execPath, ["verify-preset-discovery.mjs"], { cwd: HERE, stdio: "pipe", timeout: 60_000 });
    } catch { red = true; }
    if (red) { caught++; console.log(`  OK 变红：${m.name}`); }
    else console.log(`  NG 仍然绿：${m.name}   <- 有盲区`);
  } finally {
    fs.copyFileSync(BAK(f), f);
    fs.unlinkSync(BAK(f));
  }
}

console.log(`\n${caught} / ${total} 个缺陷被抓住\n`);
process.exit(caught === total ? 0 : 1);
