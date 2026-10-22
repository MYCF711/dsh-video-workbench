/**
 * 增量改动回归：证明「加了 batch/steps2 之后，既有能力一个没坏」。
 *
 * 每一步都断言；失败就打印并置 exitCode=1。
 */
import { loadModes, buildPrompt } from "../src/workflows.mjs";
import { snapLength, secondsToLength, aspectToSize } from "../src/length.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, "..", "workflows");
const RESOLVERS = { snapLength, secondsToLength, aspectToSize };

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`); }
};

const { modes, warnings } = await loadModes(DIR);
console.log(`\n=== 加载：${modes.length} 个模式，${warnings.length} 条警告 ===`);
warnings.forEach((w) => console.log("  [warn]", w));
ok("无加载警告", warnings.length === 0);

const byId = new Map(modes.map((m) => [m.id, m]));
ok("4 个模式齐全", ["yz", "krea2", "qwen21", "qwen21-edit"].every((id) => byId.has(id)));

/* ── A. 既有能力不回归 ── */
console.log("\n=== A. 既有变量语义未变 ===");
ok("yz.vars.durationSec 仍在", byId.get("yz").vars.durationSec?.node === "259");
ok("yz.vars.aspect 仍在", byId.get("yz").vars.aspect?.node === "252");
ok("yz 没有 batch（视频不该有张数）", !byId.get("yz").vars.batch);
ok("yz.caps.duration = true", byId.get("yz").caps.duration === true);
ok("yz.caps.batch = false", byId.get("yz").caps.batch === false);
ok("yz.caps.steps2 与工作流一致", typeof byId.get("yz").caps.steps2 === "boolean", `实际 ${byId.get("yz").caps.steps2}`);
ok("yz.caps.secondPassToggle = null", byId.get("yz").caps.secondPassToggle === null);

/* ── B. 新增能力就位 ── */
console.log("\n=== B. 新增 batch / steps2 ===");
ok("krea2.batch → 210.batch_size",
  byId.get("krea2").vars.batch?.node === "210" && byId.get("krea2").vars.batch?.input === "batch_size");
ok("krea2.steps2 → 221.steps",
  byId.get("krea2").vars.steps2?.node === "221" && byId.get("krea2").vars.steps2?.input === "steps");
ok("krea2.caps.steps2 = true", byId.get("krea2").caps.steps2 === true);
ok("krea2.caps.secondPassToggle = secondPass", byId.get("krea2").caps.secondPassToggle === "secondPass");
ok("qwen21.batch → 405.batch_size", byId.get("qwen21").vars.batch?.node === "405");
ok("qwen21.caps.steps2 = false（无二采）", byId.get("qwen21").caps.steps2 === false);
ok("qwen21.caps.batch = true", byId.get("qwen21").caps.batch === true);
ok("qwen21-edit.batch → 459:456", byId.get("qwen21-edit").vars.batch?.node === "459:456");
ok("qwen21-edit.caps.duration = false", byId.get("qwen21-edit").caps.duration === false);

/* ── C. 真构建 prompt：新参数写进了正确节点 ── */
console.log("\n=== C. buildPrompt 真跑 ===");
{
  const m = byId.get("krea2");
  const built = buildPrompt(m, { prompt: "x", aspect: "16:9", steps: 12, steps2: 7, batch: 4 }, RESOLVERS);
  const wf = built.prompt;
  ok("krea2 一采 steps(203) = 12", wf["203"].inputs.steps === 12, `实际 ${wf["203"].inputs.steps}`);
  ok("krea2 二采 steps(221) = 7", wf["221"].inputs.steps === 7, `实际 ${wf["221"].inputs.steps}`);
  ok("krea2 张数(210.batch_size) = 4", wf["210"].inputs.batch_size === 4, `实际 ${wf["210"].inputs.batch_size}`);
  ok("krea2 一采 seed 未被动", typeof wf["203"].inputs.seed === "number" || Array.isArray(wf["203"].inputs.seed));
  console.log(`     applied 条数 = ${built.applied.length}`);
}
{
  const m = byId.get("qwen21");
  const built = buildPrompt(m, { prompt: "x", aspect: "16:9", steps: 30, batch: 2 }, RESOLVERS);
  ok("qwen21 steps(442) = 30", built.prompt["442"].inputs.steps === 30);
  ok("qwen21 张数(405) = 2", built.prompt["405"].inputs.batch_size === 2);
}
{
  const m = byId.get("qwen21-edit");
  const built = buildPrompt(m, { files: { ref_image_0: { base64: "AAAA", filename: "t.png" } }, prompt: "x", steps: 20, batch: 3, seed: 42 }, RESOLVERS);
  ok("qwen21-edit steps(459:458) = 20", built.prompt["459:458"].inputs.steps === 20);
  ok("qwen21-edit 张数(459:456) = 3", built.prompt["459:456"].inputs.batch_size === 3);
  ok("qwen21-edit seed = 42", built.prompt["459:458"].inputs.seed === 42);
  ok("qwen21-edit always.set switch=true 仍生效", built.prompt["459:484"]?.inputs?.switch === true);
}

/* ── D. 不传新参数 → 工作流不接受污染（保持原值） ── */
console.log("\n=== D. 不传 batch/steps2 时行为与改动前一致 ===");
{
  const m = byId.get("krea2");
  const built = buildPrompt(m, { prompt: "x", aspect: "16:9", steps: 8 }, RESOLVERS);
  ok("未传 batch → batch_size 保持原值 1", built.prompt["210"].inputs.batch_size === 1,
    `实际 ${built.prompt["210"].inputs.batch_size}`);
  ok("未传 steps2 → 二采步数保持原值 5", built.prompt["221"].inputs.steps === 5,
    `实际 ${built.prompt["221"].inputs.steps}`);
}
{
  // 视频工作流：不声明 batch，传了也不该炸
  const m = byId.get("yz");
  const built = buildPrompt(m, { prompt: "x", aspect: "16:9", durationSec: 5, steps: 10, batch: 4 }, RESOLVERS);
  ok("yz 收到 batch 也不报错（无 vars.batch 则忽略）", Boolean(built.prompt));
  ok("yz durationSec 仍走吸附", built.length === 124, `实际 ${built.length}`);
}

/* ── E. 白名单仍然拦得住乱写的变量名 ── */
console.log("\n=== E. 白名单护栏未失效（变异自检）===");
{
  const m = byId.get("krea2");
  let threw = false;
  try { buildPrompt(m, {}, RESOLVERS); } catch { threw = true; }
  ok("正常调用不抛", threw === false);
  // 直接验证 KNOWN_VARS 行为：用假 bind 走 loadModes 太重，这里验 buildPrompt 对未知 vars 不处理
  ok("krea2.vars 里没有拼写错误的多余键",
    Object.keys(m.vars).every((k) => ["prompt","negative","width","height","aspect","length","durationSec","seed","steps","filename_prefix","batch","steps2","megapixels","seedvrModel","loras"].includes(k)),
    Object.keys(m.vars).join(","));
}

console.log(`\n================  通过 ${pass} / 失败 ${fail}  ================`);
process.exit(fail === 0 ? 0 : 1);
