/** 变异测试：verify-seed-repro.mjs 必须能抓住「种子不可见/不可复现」。 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WF = "../dsh-comfy-bridge/src/workflows.mjs";
const IDX = "../dsh-comfy-bridge/src/index.js";
const WB = "src/WorkbenchView.js";

const MUTANTS = [
  { name: "留空不生成随机种子（沿用固定值）", file: WF, from: ": Math.floor(Math.random() * 2147483647);", to: ": 12345;" },
  { name: "生成了却不写进节点", file: WF, from: "setInput(mode.vars.seed.node, mode.vars.seed.input, usedSeed);", to: "void 0;" },
  { name: "buildPrompt 不返回 seed", file: WF, from: "skipped, seed: usedSeed };", to: "skipped };" },
  { name: "generate/job 都不带 seed", file: IDX, from: "seed: built.seed ?? null,", to: "seed: undefined," },
  { name: "buildPrompt 的 seed 恒为 null", file: WF, from: "seed: usedSeed };", to: "seed: null };" },
  { name: "前端不回填种子", file: WB, from: "        setSeed(String(r.seed));", to: "        void 0;" },
  { name: "seedIsBlank 恒为 true（覆盖用户手填值）", file: WB, from: 'const seedIsBlank = seed === "" || seed === null || seed === undefined;', to: "const seedIsBlank = true;" },
  { name: "判空退回 String().trim()", file: WB, from: "const seedIsBlank = seed === \"\" || seed === null || seed === undefined;", to: "const seedIsBlank = String(seed ?? \"\").trim() === \"\";" },
  { name: "骰子填死一个数字（语义反了）", file: WB, from: 'onClick: () => setSeed(""),', to: 'onClick: () => setSeed(String(Math.random())),' },
  { name: "骰子 title 不说换一张", file: WB, from: 'title: "换一张（清空种子，下次随机）",', to: 'title: "随机种子",' },
];

let caught = 0;
console.log("\n=== 变异测试：verify-seed-repro.mjs ===\n");
for (const m of MUTANTS) {
  const f = path.join(HERE, m.file);
  const bak = f + ".mbak";
  fs.copyFileSync(f, bak);
  try {
    const before = fs.readFileSync(f, "utf8");
    if (!before.includes(m.from)) {
      console.log(`  !! ${m.name}\n     锚点不存在 —— 未验证`);
      continue;
    }
    fs.writeFileSync(f, before.split(m.from).join(m.to), "utf8");
    let red = false;
    try {
      execFileSync(process.execPath, ["verify-seed-repro.mjs"], { cwd: HERE, stdio: "pipe", timeout: 60_000 });
    } catch { red = true; }
    if (red) { caught++; console.log(`  OK 变红：${m.name}`); }
    else console.log(`  NG 仍然绿：${m.name}   <- 有盲区`);
  } finally {
    fs.copyFileSync(bak, f);
    fs.unlinkSync(bak);
  }
}
console.log(`\n${caught} / ${MUTANTS.length} 个缺陷被抓住\n`);
process.exit(caught === MUTANTS.length ? 0 : 1);
