/** 变异测试：verify-progress-bus.mjs 必须能抓住「进度不动」。 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUS = "src/progress-bus.mjs";

const MUTANTS = [
  { name: "删掉 lastExecutingPromptId 声明", file: BUS, from: "let lastExecutingPromptId = null;", to: "" },
  { name: "executing 退回「必须带 prompt_id」", file: BUS, from: "const pid = data.prompt_id ?? lastExecutingPromptId;", to: "const pid = data.prompt_id; if (!pid) return;" },
  { name: "不记当前 prompt", file: BUS, from: "if (data.prompt_id) lastExecutingPromptId = data.prompt_id;", to: "void 0;" },
  { name: "不处理 progress_state", file: BUS, from: 'if (type === "progress_state") {', to: 'if (type === "progress_state_disabled") {' },
  { name: "progress_state 不累计", file: BUS, from: "if (Number.isFinite(nv) && Number.isFinite(nm)) { v += nv; m += nm; }", to: "void 0;" },
  { name: "progress_state 不判 allDone", file: BUS, from: 'if (n?.state !== "finished") allDone = false;', to: "void 0;" },
  { name: "全部完成不设 done", file: BUS, from: "...(allDone ? { done: true } : {}),", to: "..." },
  { name: "去掉过期判定", file: BUS, from: "Date.now() - (p.updatedAt || 0) > 10000", to: "false" },
];

let caught = 0;
console.log("\n=== 变异测试：verify-progress-bus.mjs ===\n");
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
      execFileSync(process.execPath, ["verify-progress-bus.mjs"], { cwd: HERE, stdio: "pipe", timeout: 60_000 });
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
