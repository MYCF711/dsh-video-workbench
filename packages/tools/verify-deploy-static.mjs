#!/usr/bin/env node
/**
 * 「从零装一个新实例能不能真跑」的实测记录与重复验证。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要这个
 *
 *   到这一轮，「可部署」一直只有【静态证据】（install.ps1 写的配置对不对、
 *   包能不能 import）。但从没验证过：**装出来的实例能不能真的生成东西**。
 *
 *   2026-10-24 实测（deploy-test profile）：
 *     ① 跑 install.ps1 -Profile deploy-test → 4 个包 + 3 个 bundles 全装上
 *     ② dsh plugin install → Already up to date
 *     ③ 起实例（端口 19530）→ 无 skipping、无 error
 *     ④ 四个路由全通：
 *          /comfy-bridge/health  ok=True modes=4
 *          /timeline/assets      total=529
 *          /comfy-bridge/config  ✅
 *          /comfy-bridge/modes   4 个工作流
 *     ⑤ **真实生成**：提交 krea2 → 17 节点 → 2 个产物（约 35 秒）
 *
 *   ⇒ 这是「可部署」的最终证据：从零安装 → 起实例 → 真出图。
 *
 * ── 本脚本做什么
 *
 *   ★ 它不能自动化整个流程（要起实例、要 ComfyUI、要等生成），
 *     那是 `deploy-verify.ps1` 的事（见仓库根）。
 *     这里做的是【可重复的低成本部分】：
 *       ① 检查 install.ps1 写的配置确实自洽（复用 verify-install-config）
 *       ② 检查上面那次实测的证据是否留档
 *       ③ 检查部署脚本存在且能跑（--check 模式）
 *
 *   ★ 为什么不每轮都跑完整部署测试：
 *     完整流程 = 建 profile + 装包 + 起实例 32 秒 + 生成 35 秒 + 清理
 *     ≈ 1.5 分钟，且会占用 ComfyUI 队列。
 *     每轮都跑会拖慢验收、也会污染 output。
 *     ⇒ 实测一次、留档证据、之后用静态检查防回退。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const PKG = path.join(REPO, "packages");

let pass = 0;
const fails = [];
const check = (name, ok, detail = "") => {
  if (ok) { pass++; return; }
  fails.push({ name, detail });
};

console.log("");
console.log("═".repeat(70));
console.log("  部署实测（从零装 → 起实例 → 真出图）");
console.log("═".repeat(70));
console.log("");

/* ── ① install.ps1 的关键步骤都在 ── */
{
  const p = path.join(REPO, "install.ps1");
  check("install.ps1 存在", fs.existsSync(p));
  const src = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  for (const [what, re] of [
    ["写 link: 依赖", /link:/],
    ["追加 bundles", /bundles/],
    ["建 node_modules 软链", /node_modules/],
    ["卸载模式", /Uninstall|-Uninstall/],
  ]) {
    check(`install.ps1 含「${what}」`, re.test(src));
  }
}

/* ── ② 部署实测脚本存在（供需要时重复）── */
{
  const p = path.join(REPO, "scripts", "deploy-verify.ps1");
  check("scripts/deploy-verify.ps1 存在", fs.existsSync(p),
    "完整部署实测要建 profile/装包/起实例/生成，不能塞进每轮验收");
}

/* ── ③ 实测证据留档 ── */
{
  const p = path.join(REPO, "docs", "部署实测-20261024.md");
  check("部署实测证据留档", fs.existsSync(p),
    "docs/部署实测-20261024.md 记录 2026-10-24 那次完整实测的原始输出");
  if (fs.existsSync(p)) {
    const d = fs.readFileSync(p, "utf8");
    /* ★ 产物名形如 Krea2-2ST-20261018_00358_.png（前缀含日期，末尾有下划线）*/
    check("证据含真实生成的产物名", /Krea2-2ST-\d+_\d+_\.png/.test(d));
    check("证据含四个路由的输出", /modes=4/.test(d) || /total=529/.test(d));
  }
}

/* ── ④ 四个包能 import（复用已有检查，不重复实现）── */
{
  const r = spawnSync("node", ["verify-d4-packages.mjs"], {
    cwd: HERE, encoding: "utf8", timeout: 300000,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  const m = ((r.stdout ?? "") + (r.stderr ?? "")).match(/通过\s+(\d+)\s*\/\s*(\d+)/);
  check("四个包能独立 import", r.status === 0, m ? m[0] : "?");
}

console.log("");
if (fails.length === 0) {
  console.log("  ✅ 部署链路完整（静态部分）");
  console.log(`  通过 ${pass} / ${pass}`);
  console.log("");
  console.log("  ★ 完整实测（起实例 + 真生成）需要 ComfyUI 在线，");
  console.log("    用 scripts/deploy-verify.ps1 手动跑。");
  console.log("    已实测一次：install → 起实例 → krea2 真出图 2 个产物。");
  console.log("");
  process.exit(0);
}
for (const f of fails) {
  console.log(`  ✗ ${f.name}${f.detail ? "：" + f.detail : ""}`);
}
console.log("");
console.log(`  ❌ ${pass} 通过 / ${fails.length} 失败`);
console.log(`  通过 ${pass} / ${pass + fails.length}`);
console.log("");
process.exit(1);

