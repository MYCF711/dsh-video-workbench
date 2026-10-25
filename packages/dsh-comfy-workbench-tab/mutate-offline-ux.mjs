/** 变异测试：verify-offline-ux.mjs 必须能抓住「服务挂掉时骗人」。 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BR = "../dsh-comfy-bridge/src/index.js";
const WB = "src/WorkbenchView.js";

const MUTANTS = [
  { name: "后端不探连通性（回到抛异常）", file: BR, from: "const reachable = await comfy.probe().then(() => true).catch(() => false);", to: "const reachable = true;" },
  { name: "unreachable 不带 reason", file: BR, from: 'reason: "ComfyUI 现在连不上，暂时拿不到这个任务的进度。启动 ComfyUI 后会自动继续。",', to: "reason: \"\",", },
  { name: "job 一律 404（误导成任务不存在）", file: BR, from: "const code = /未知任务/.test(msg) ? 404", to: "const code = /永远不会匹配/.test(msg) ? 404" },
  { name: "前端不识别 unreachable", file: WB, from: 'if (j?.unreachable || st === "unreachable") {', to: 'if (false) {' },
  { name: "unreachable 时停轮询（重启后接不上）", file: WB, from: "          return;   // ★ 不 stopPoll —— 它可能只是重启", to: "          stopPoll(); return;" },
  { name: "busy 不排除 unreachable（按钮锁死）", file: WB, from: "&& !job.lost && !job.unreachable)", to: "&& !job.lost)" },
  { name: "lost 不在终态", file: WB, from: '["error", "failed", "cancel", "lost"]', to: '["error", "failed", "cancel"]' },
  { name: "lost 不给用户出路", file: WB, from: "点「生成」重跑一次即可。", to: "。" },
  { name: "终态不收 resumeNotice", file: WB, from: "          setResumeNotice(null);", to: "          void 0;" },
];

let caught = 0;
console.log("\n=== 变异测试：verify-offline-ux.mjs ===\n");
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
      execFileSync(process.execPath, ["verify-offline-ux.mjs"], { cwd: HERE, stdio: "pipe", timeout: 60_000 });
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
