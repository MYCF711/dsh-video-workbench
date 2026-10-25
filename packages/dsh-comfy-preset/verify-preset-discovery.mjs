/**
 * 校验：dsh-comfy-preset 真的能被 DSH 发现，且技能挂载写法正确
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要这个验收
 *
 *   2026-10-25 实测发现这个预设【三重失效】，而所有既有验收都是绿的：
 *
 *   ① package.json 用 `dsh.agentPreset` 字段
 *      → 以为 DSH 会自动扫它。**它不会。**
 *        asar 里 @deepseek-ai/dsh-agent-preset 是个 cordis 插件，
 *        靠组合里的一行 insert 去 ctx.agentPresets.register(config)。
 *      实测：装到 comfy-test 后 agentPresets/list 只有
 *            standard / ptc / minimal / cordis 四个内置。
 *
 *   ② install.ps1 的包清单里根本没有它
 *      → 连装都没装。
 *
 *   ③ 技能挂载写了 `config.dirs: [./skills]`
 *      → 字段名错（正确是 customSkillDirs），路径基准也错
 *        （baseUrl 实测是 profile 目录，不是预设包目录）。
 *        而 skill-filesystem 对不存在的根【直接跳过，不报错】。
 *
 *   这三条共同点：**静默失效**。界面上没有任何异常，
 *   只是对话框里的 LLM 不知道该怎么选工作流、不知道有 comfy_workbench_fill。
 *
 *   本脚本把这三条锁死。
 * ══════════════════════════════════════════════════════════════════════
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(HERE, "..", "dsh-comfy-preset");
const REPO = path.join(HERE, "..", "..");

let pass = 0, fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
};
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

console.log("\n=== 预设能被发现（① dsh.bundle.patch）===\n");

const pkgJson = JSON.parse(fs.readFileSync(path.join(PKG, "package.json"), "utf8"));

t("package.json 声明 dsh.bundle.patch（不是 dsh.agentPreset）", () => {
  must(pkgJson?.dsh?.bundle?.patch, "缺 dsh.bundle.patch —— DSH 不会发现这个预设");
  /**
   * ★ 旧的错误写法必须彻底消失。
   *   如果两个字段都在，DSH 仍然只认 bundle，而那会让人困惑
   *   「为什么我写了 agentPreset 却没生效」。
   */
  must(!pkgJson?.dsh?.agentPreset, "还在用 dsh.agentPreset 字段 —— 它不会被任何代码读取");
});

t("patch 文件存在且被 files 字段带上（发布时不会漏）", () => {
  const p = path.join(PKG, "cordis.patch.yml");
  must(fs.existsSync(p), "cordis.patch.yml 不存在");
  must(
    Array.isArray(pkgJson.files) && pkgJson.files.includes("cordis.patch.yml"),
    "files 里没列 cordis.patch.yml —— npm pack 会丢掉它"
  );
});

console.log("\n=== patch 内容正确（② 注册行 + ③ 技能挂载）===\n");

const patch = fs.readFileSync(path.join(PKG, "cordis.patch.yml"), "utf8");

t("用 insert 插入 @deepseek-ai/dsh-agent-preset", () => {
  must(/insert:/.test(patch), "没有 insert 块");
  must(
    /name:\s*'@deepseek-ai\/dsh-agent-preset'/.test(patch),
    "没有 name: '@deepseek-ai/dsh-agent-preset' —— 预设不会被注册"
  );
});

t("config 有 id / name / description / order / plugins 五项", () => {
  for (const k of ["id", "name", "description", "order", "plugins"]) {
    must(new RegExp(`^\\s+${k}:`, "m").test(patch), `config 缺 ${k}`);
  }
});

t("★ 技能用 customSkillDirs（不是 dirs）", () => {
  /**
   * ★ 这是最隐蔽的一条：`dirs` 不是有效字段名，
   *   skill-filesystem 收到未知字段不会报错，只是不加载任何技能。
   */
  must(/customSkillDirs:/.test(patch), "没有 customSkillDirs —— 技能会全部静默不注册");
  must(
    !/^\s+dirs:\s*$/m.test(patch),
    "还残留 `dirs:` 字段 —— 它不是 customSkillDirs，不会生效"
  );
});

t("★ 技能路径用 createRequire 解析包名（不用 ./skills 相对路径）", () => {
  /**
   * ★ 实测：ctx.baseUrl = <DSH_HOME>/profiles/<profile>/，不是预设包目录。
   *   `./skills` 会解析成 profiles/<profile>/skills/（不存在），
   *   而 skill-filesystem 对不存在的根【直接跳过，不报错】。
   *   ⇒ 必须用官方那种 createRequire(baseUrl).resolve('<包名>/package.json')。
   */
  must(
    /createRequire\(baseUrl\)/.test(patch),
    "技能路径没用 createRequire(baseUrl) —— ./skills 会指向 profile 目录，静默失效"
  );
  must(
    /resolve\('dsh-comfy-preset\/package\.json'\)/.test(patch),
    "createRequire 解析的包名不是 dsh-comfy-preset"
  );
  must(
    !/^\s+-\s+\.\/skills\s*$/m.test(patch),
    "还残留 `- ./skills` 相对路径"
  );
});

t("技能目录真实存在且含技能文件", () => {
  const dir = path.join(PKG, "skills");
  must(fs.existsSync(dir), "skills/ 目录不存在");
  const files = fs.readdirSync(dir, { recursive: true })
    .map(String).filter((f) => f.endsWith("SKILL.md"));
  must(files.length > 0, "skills/ 下没有 SKILL.md");
});

t("★ comfy-mode-dispatch 技能里有 comfy_workbench_fill 的用法", () => {
  /**
   * ★ 工具有了、技能里不写 = LLM 不知道怎么用。
   *   这是「装了但不会用」的静默失效，和字段名写错一样坏。
   */
  const f = path.join(PKG, "skills", "comfy-mode-dispatch", "SKILL.md");
  must(fs.existsSync(f), "comfy-mode-dispatch/SKILL.md 不存在");
  const s = fs.readFileSync(f, "utf8");
  must(s.includes("comfy_workbench_fill"), "技能里没提 comfy_workbench_fill");
  must(/不自动生成|不会自动生成/.test(s), "技能里没说明「填完不自动生成」这条关键约定");
});

console.log("\n=== 安装清单包含它（③ 装得上）===\n");

t("install.ps1 的 $pkgs 里有 dsh-comfy-preset", () => {
  const s = fs.readFileSync(path.join(REPO, "install.ps1"), "utf8");
  const m = s.match(/\$pkgs\s*=\s*@\(([\s\S]*?)\)/);
  must(m, "读不到 $pkgs");
  must(/dsh-comfy-preset/.test(m[1]), "install.ps1 的 $pkgs 里没有 dsh-comfy-preset");
});

t("install.ps1 的 $bundleNames 里有 dsh-comfy-preset", () => {
  /**
   * ★ 只在 dependencies 里、不在 bundles 里 = 装了但 apply() 从不执行
   *   = dsh.bundle.patch 不会被应用 = 预设还是不出现。
   */
  const s = fs.readFileSync(path.join(REPO, "install.ps1"), "utf8");
  const m = s.match(/\$bundleNames\s*=\s*@\(([\s\S]*?)\)/);
  must(m, "读不到 $bundleNames");
  must(/dsh-comfy-preset/.test(m[1]), "bundleNames 里没有它 —— 装了也不会生效");
});

console.log(`\n通过 ${pass} / ${pass + fail}\n`);
if (fail) console.log("★ 预设不可用 —— 对话框里的 LLM 将不知道有 comfy_workbench_fill。\n");
process.exit(fail === 0 ? 0 : 1);
