/** 变异测试：verify-lazy-ux.mjs 的四类缺陷都必须能被抓住。 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = "../dsh-comfy-preset/skills/comfy-mode-dispatch/SKILL.md";
const WB = "src/WorkbenchView.js";
const BR = "../dsh-comfy-bridge/src/index.js";

const MUTANTS = [
  { name: "技能里删掉 krea2-prompt-suite", file: SKILL, from: "krea2-prompt-suite", to: "不存在A" },
  { name: "技能里删掉 h3-prompt-writing", file: SKILL, from: "h3-prompt-writing", to: "不存在B" },
  { name: "技能里删掉 qwen-image-2-1-prompter", file: SKILL, from: "qwen-image-2-1-prompter", to: "不存在C" },
  { name: "key 不拼 sessionId（退回写死）", file: WB, from: "return `${PERSIST_KEY}:${sid}`;", to: "return PERSIST_KEY;" },
  { name: "loadPersisted 不接 sessionId", file: WB, from: "function loadPersisted(sessionId) {", to: "function loadPersisted() {" },
  { name: "savePersisted 不传 sessionId", file: WB, from: "      savePersisted(sessionId, {", to: "      savePersisted({" },
  { name: "去掉旧值迁移", file: WB, from: "key !== PERSIST_KEY", to: "false" },
  { name: "后端删掉 /jobs 路由", file: BR, from: 'path: prefix + "/jobs",', to: 'path: prefix + "/jobs-off",' },
  { name: "不记录 finishedAt", file: BR, from: "job.finishedAt ??= Date.now();", to: "void 0;" },
  { name: "不标记失败任务", file: BR, from: "job.failed = true;", to: "void 0;" },
  { name: "前端不拉 /jobs", file: WB, from: 'fetch("/comfy-bridge/jobs"', to: 'fetch("/comfy-bridge/jobs-off"' },
  { name: "不过滤已完成任务", file: WB, from: "filter((x) => x && !x.done)", to: "filter((x) => x)" },
  { name: "接管时不调 startPoll", file: WB, from: "startPoll(newest.jobId);", to: "void 0;" },
  { name: "接管提示共用 fillNotice（会 8 秒消失）", file: WB, from: "setResumeNotice(", to: "setFillNotice(" },
  { name: "任务结束不收 resumeNotice", file: WB, from: "          setResumeNotice(null);", to: "          void 0;" },
  { name: "resumeNotice 块不渲染", file: WB, from: "      resumeNotice", to: "      null && resumeNotice" },
  { name: "接管闸门恒拦截（切 tab 后不再接管）", file: WB, from: "        if (alreadyFollowing) return;", to: "        if (jobRef.current !== undefined) return;" },
  { name: "alreadyFollowing 不读 jobRef", file: WB, from: "          jobRef.current?.jobId", to: "          null" },
  { name: "jobRef 不随 job 更新", file: WB, from: "  useEffect(() => { jobRef.current = job; }, [job]);", to: "  useEffect(() => {}, [job]);" },
];

let caught = 0;
console.log("\n=== 变异测试：verify-lazy-ux.mjs ===\n");
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
      execFileSync(process.execPath, ["verify-lazy-ux.mjs"], { cwd: HERE, stdio: "pipe", timeout: 60_000 });
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
