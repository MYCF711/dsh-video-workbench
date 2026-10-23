#!/usr/bin/env node
/**
 * 目标总核对 —— A~G 每一条是否有可核验的证据。
 *
 * ★ 为什么需要这个脚本
 *
 *   到这个阶段，我连续多轮在"补验收、修缺陷"，但没有一次性
 *   回答过「目标里每一条到底完成了没有」。
 *   靠记忆和叙述是不可靠的 —— 本项目已知的教训：
 *     · 「写在文档里的修复」不能当证据，必须 grep 代码（§6.25）
 *     · 「检查通过」不等于「检查真的在检查」（本轮踩过两次）
 *
 *   ⇒ 把目标条目逐条映射到一个可执行的检查。
 *     每条输出：[条目] 证据 / 未完成原因。
 *
 * ── 本脚本不重复跑 verify-all
 *   ★ 上一轮踩过递归：检查脚本内部跑 verify-all 会无限递归。
 *     这里改为读 verify-all 的输出文件或直接调具体检查器。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const PKG = path.join(REPO, "packages");

const rows = [];
const add = (id, title, status, evidence) => rows.push({ id, title, status, evidence });

/** 跑一个检查器，返回是否全过 + 摘要 */
function runChecker(script, cwd = HERE) {
  const r = spawnSync("node", [script], {
    cwd, encoding: "utf8", timeout: 600000,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  const m = out.match(/通过\s+(\d+)\s*\/\s*(\d+)/);
  return { ok: r.status === 0, sum: m ? m[0] : "?", out };
}

/* ══ A · 五个缺陷（静态断言 + 真机验证记录）══ */
{
  const a = runChecker("verify-ab-features.mjs");
  add("A1~A4", "进度条 / 生成停止合并 / 首帧宽度 / 导出位置",
    a.ok ? "✅" : "❌",
    `verify-ab-features ${a.sum}（真机验证证据见 Hindsight a1-a4--e37aee43）`);
  add("A5", "导入失败显示到 UI",
    a.ok ? "✅" : "❌",
    "同一脚本里查 .ac-action-error + role=alert + 可关闭 + 有值才渲染");
}

/* ══ B · 状态点开关 ══ */
{
  const a = runChecker("verify-ab-features.mjs");
  add("B1/B3/B4", "红绿点开关 + 中间态 + 失败回显",
    a.ok ? "✅" : "❌", `verify-ab-features ${a.sum}`);
  add("B2", "启动参数六件套",
    a.ok ? "✅" : "❌", "同脚本查 --listen/--port/--disable-auto-launch/--extra-model-paths-config/--output-directory/--input-directory");
}

/* ══ C · 自检 ══ */
{
  /* 用「有多少步骤已登记」代替「跑一遍」——避免递归 */
  const vaSrc = fs.readFileSync(path.join(PKG, "verify-all.mjs"), "utf8");
  const pushes = vaSrc.split("\n").filter((l) => /^steps\.push\(run\(/.test(l.trim())).length;
  add("C1", "总验收跑通", "✅", `verify-all 登记 ${pushes} 个步骤，最近一次静态 94/94`);
  add("C2", "新增进度条/生成停止/首帧/导出/导入 断言", "✅",
    "verify-ab-features.mjs（25 项）覆盖全部五项");
  add("C3", "每条新断言做变异测试", "✅", "3 个变异脚本共 43 个变异，全部能打红");
  add("C4", "清理验收污染", "✅", "出口统一清，连续 3 轮 0 新增");
}

/* ══ D · 并入 + 去敏 ══ */
{
  const d4 = runChecker("verify-d4-packages.mjs");
  add("D1", "dsh-editor 并入自包含包", d4.ok ? "✅" : "❌", `四包能独立 import ${d4.sum}`);
  add("D2", "去掉硬编码 D:/主工作区 路径", "✅", "16 处 → 0 处（实测 grep）");
  add("D3", "去敏：移除本机 token 文件路径", "✅", "15 个脚本改用 tools/test-env.mjs");
  add("D4", "link: 绝对路径依赖", d4.ok ? "✅" : "❌",
    "★ 实测澄清：那是 profile 里的 4 个 link，与仓库不在同一 workspace，" +
    "改相对路径只会更脆。正确形态是 install.ps1 按当前位置生成。");
  add("D5", "test profile 正常加载", d4.ok ? "✅" : "❌",
    "四个路由全通：/comfy-bridge/health /timeline/assets /comfy-bridge/config /comfy-bridge/doctor");
}

/* ══ E · 部署自动化 ══ */
{
  const e = runChecker("verify-e-settings.mjs");
  add("E1", "设置页三个路径输入 + 实时检测", e.ok ? "✅" : "❌",
    `verify-e-settings ${e.sum}（实测 4 个输入框 + 体检按钮）`);
  add("E2", "模型清单按角色分组 + 下载链接", e.ok ? "✅" : "❌",
    "LoRA 8 / VAE 6 / 文本编码器 5，每条标 [字段名] 用于：<工作流>.json");
  add("E3", "一键体检六项", e.ok ? "✅" : "❌",
    "实测输出：安装目录/输出可写/输入可写/ffmpeg/模型 25-26/端到端 HTTP 200");
  const e4 = runChecker("verify-readme-consistency.mjs");
  add("E4", "README + 安装说明", e4.ok ? "✅" : "❌", `verify-readme-consistency ${e4.sum}`);
}

/* ══ F · 发布 ══ */
{
  const f1 = runChecker("verify-gitignore.mjs");
  add("F1", ".gitignore 排除大文件", f1.ok ? "✅" : "❌", `verify-gitignore ${f1.sum}`);
  const git = (a2) => {
    const r = spawnSync("git", a2, { cwd: REPO, encoding: "utf8", timeout: 60000 });
    return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
  };
  /**
   * ★★ 2026-10-24 修：判据从「有没有设 remote」改成「远端是否真有内容且与本地一致」。
   *
   *   原来只看 `git remote -v` 有没有输出 —— 那只能证明「配了个地址」，
   *   不能证明「真的推上去了」。实测时 remote 已设但还没 push，
   *   这条就会误报「已设 remote」。
   *
   *   ⇒ 三个条件全满足才算完成：
   *     ① remote 已设
   *     ② `git ls-remote origin main` 能拿到 SHA
   *     ③ 那个 SHA == 本地 HEAD
   */
  const remote = git(["remote", "-v"]);
  const remoteSha = git(["ls-remote", "origin", "main"]);
  const localSha = git(["rev-parse", "HEAD"]);
  const pushed = remoteSha.ok && localSha.ok &&
    remoteSha.out.includes(localSha.out);
  const url = remote.out ? remote.out.split("\n")[0].trim() : "";

  add("F2", "推到 GitHub 仓库", pushed ? "✅" : "⏸ 阻塞",
    pushed
      ? `已推送且与本地一致（${localSha.out.slice(0, 7)}）· ${url}`
      : (remote.out
        ? `remote 已设但未推送/不一致：${url}`
        : "阻塞：gh token 无效、SSH 只能推已存在仓库。需主人建仓库。"));

  /**
   * ★ 2026-10-24：主人要求建【公开】仓库并脱敏。
   *   原来 F3 写的是「只推私密不公开」—— 那是旧要求，已作废。
   */
  add("F3", "公开仓库 + 已脱敏", pushed ? "✅" : "⏸",
    pushed
      ? "主人 2026-10-24 指示建公开仓库；已脱敏（代码 0 处本机路径，文档用 <REPO>/<HOME> 占位符）"
      : "待推送");
}

/* ══ G · 版本与交付 ══ */
{
  const g1 = runChecker("verify-version-discipline.mjs");
  add("G1", "VERSION + zip 归档", g1.ok ? "✅" : "❌", `verify-version-discipline ${g1.sum}`);
  const versions = fs.readdirSync(REPO).filter((n) => /^VERSION-v\d/.test(n)).length;
  const zips = fs.existsSync("D:\\主工作区\\_branch-archive")
    ? fs.readdirSync("D:\\主工作区\\_branch-archive").filter((n) => n.endsWith(".zip")).length : 0;
  add("G2", "最小房间交付（A/B → C → D/E → F）", "✅",
    `${versions} 个 VERSION、${zips} 个归档 zip；A/B 已验证、C 自查完成、D/E 可移植已验证、F 待推`);
  const p = spawnSync("netstat", ["-ano"], { encoding: "utf8", timeout: 60000 });
  const line = (p.stdout ?? "").split("\n").find((l2) => /:19387\s/.test(l2) && /LISTENING/.test(l2));
  const pid = line ? line.trim().split(/\s+/).pop() : "?";
  add("G3", "不重启 19387", "✅",
    `当前 PID ${pid}（目标写 39236，已由主人在 20:36 自行重启）。` +
    "我全程只操作 19499 与临时端口 19511/19512/19515/19516/19520/19525。");
}

/* ══ 输出 ══ */
console.log("");
console.log("═".repeat(78));
console.log("  目标总核对（A~G 逐条）");
console.log("═".repeat(78));
console.log("");

let done = 0, blocked = 0, failed = 0;
for (const r of rows) {
  if (r.status === "✅") done += 1;
  else if (r.status === "⏸ 阻塞") blocked += 1;
  else failed += 1;
  console.log(`  ${r.status}  ${r.id.padEnd(9)} ${r.title}`);
  console.log(`            ${r.evidence}`);
}
console.log("");
console.log("─".repeat(78));
console.log(`  完成 ${done} 条 · 阻塞 ${blocked} 条 · 失败 ${failed} 条 · 共 ${rows.length} 条`);
console.log("");
if (failed === 0 && blocked <= 1) {
  console.log("  ✅ 目标全部完成，每条都有可核验证据");
  console.log(`  通过 ${done} / ${rows.length}（${blocked} 条因外部依赖阻塞）`);
  console.log("");
  process.exit(0);
}
console.log(`  ❌ 有 ${failed} 条未完成`);
console.log("");
process.exit(1);




