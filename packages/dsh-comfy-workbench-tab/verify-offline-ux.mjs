/**
 * 校验：ComfyUI 掉线 / 任务丢失时的「人和机器人」体验
 *
 * ══════════════════════════════════════════════════════════════════════
 * 这一条是最容易漏测的场景：**服务挂了之后界面长什么样**。
 *
 * 实测（2026-10-25，关掉 ComfyUI 后刷新页面）发现两个真缺陷：
 *
 *   ① 状态条永远停在「已提交，等待产出」，按钮永远是「停止」
 *      ⇒ 那台 ComfyUI 早就关了，任务不可能再回来，
 *        而用户既看不到真相、也点不了重试 —— 只能干等。
 *      根因：/job 在 ComfyUI 不可达时抛异常 → 路由回 404 →
 *            前端 catch 到「HTTP 404 / ComfyUI 未运行」，只 setError，
 *            【不停止轮询也不解除 busy】。
 *
 *   ② 提示文案是「ComfyUI 未运行或不可达：…（fetch failed）（HTTP 404）」
 *      ⇒ 前半句没错，但「HTTP 404」的语义是「这个任务不存在」，
 *        真实情况是「服务暂时连不上」。用户会以为任务丢了。
 *
 *   还有第三条是排查第 ② 条时顺带发现的：
 *
 *   ③ ComfyUI 重启后任务变 lost，但 lost 不在前端终态列表里
 *      ⇒ 轮询不停、提示条挂着旧文案，而任务永远不会回来。
 *
 * 判据：**服务不可用 ≠ 任务还在跑，也 ≠ 任务没了** ——
 *       三种状态（unreachable / lost / 正常）必须分开表达，
 *       而且每种都要告诉用户「现在能做什么」。
 * ══════════════════════════════════════════════════════════════════════
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const BRIDGE = path.join(REPO, "packages", "dsh-comfy-bridge", "src", "index.js");
const WB = path.join(HERE, "src", "WorkbenchView.js");

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
};
const must = (c, m) => { if (!c) throw new Error(m); };
const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

const bs = strip(fs.readFileSync(BRIDGE, "utf8"));
const ws = strip(fs.readFileSync(WB, "utf8"));

console.log("\n=== ① 后端：不可达 ≠ 任务不存在 ===\n");

t("job() 先探连通性，不可达时返回 unreachable（不是抛异常）", () => {
  must(
    /const reachable = await comfy\.probe\(\)/.test(bs),
    "job() 里没有连通性探测 —— ComfyUI 关掉后会抛异常，前端只能看到 500"
  );
  must(
    /statusStr:\s*"unreachable"/.test(bs),
    "没有 unreachable 这个状态 —— 前端分不出「暂时问不到」和「任务出事了」"
  );
});

t("unreachable 的返回里带人话 reason", () => {
  const i = bs.indexOf('statusStr: "unreachable"');
  must(i > 0, "找不到 unreachable 分支");
  const seg = bs.slice(i, i + 500);
  must(/reason:\s*"/.test(seg), "unreachable 没有 reason —— 用户不知道为什么");
  must(/启动|重启|连不上/.test(seg), "reason 没有告诉用户该做什么");
});

t("★ /job 按原因给状态码（不可达 → 503，不是 404）", () => {
  const i = bs.indexOf('prefix + "/job"');
  must(i > 0, "找不到 /job 路由");
  const seg = bs.slice(i, i + 1400);
  must(/503/.test(seg), "/job 没有用 503 —— 不可达回 404 会让人以为任务不存在");
  must(/未知任务/.test(seg), "/job 没有区分「真不存在」（404）和「暂时连不上」（503）");
});

console.log("\n=== ② 前端：三种状态分开表达 ===\n");

t("前端识别 unreachable 并单独处理", () => {
  must(/j\?\.unreachable \|\| st === "unreachable"/.test(ws), "前端没有识别 unreachable");
});

t("★ unreachable 时【继续轮询】（服务可能只是重启）", () => {
  const i = ws.indexOf('st === "unreachable"');
  must(i > 0, "找不到 unreachable 处理分支");
  const seg = ws.slice(i, i + 500);
  must(!/stopPoll\(\)/.test(seg), "unreachable 时停了轮询 —— ComfyUI 重启后接不上进度了");
});

t("★ unreachable 时按钮从「停止」恢复成「生成」", () => {
  must(
    /!job\.unreachable/.test(ws),
    "busy 判定没有排除 unreachable —— 按钮会锁在「停止」，用户点不了重试"
  );
});

t("unreachable 时给用户可见的说明", () => {
  const i = ws.indexOf('st === "unreachable"');
  const seg = ws.slice(i, i + 600);
  must(/setResumeNotice|setError/.test(seg), "unreachable 没有任何用户可见提示");
});

console.log("\n=== ③ lost 必须是终态，且说清去哪儿重试 ===\n");

t("lost 在终态列表里", () => {
  must(
    /\["error",\s*"failed",\s*"cancel",\s*"lost"\]/.test(ws),
    "lost 不在终态列表 —— 轮询会永远转，提示条挂着旧文案"
  );
});

t("★ lost 时明确告诉用户「点生成重跑」", () => {
  /**
   * ★★ 2026-10-25 变异测试抓出的盲区：
   *   原来写的是 `/不在 ComfyUI 队列里/.test(ws) || /重跑一次即可/.test(ws)` ——
   *   把「重跑一次即可」删掉后，前半句仍命中 ⇒ 断言照绿，
   *   而用户已经不知道产物还会不会来了。
   *
   *   判据：可行动的指引必须【在同一个提示里】，不能靠两句孤立的话凑。
   */
  const i = ws.indexOf("不在 ComfyUI 队列里");
  must(i > 0, "lost 没有解释「为什么产物不会有了」");
  const seg = ws.slice(i, i + 400);
  must(/重跑一次即可/.test(seg), "lost 的解释里没有「点生成重跑」—— 用户无路可走");
});

t("lost 时收起「已接管」提示（任务已经不在了）", () => {
  const i = ws.indexOf("const isTerminal");
  must(i > 0, "找不到 isTerminal");
  const seg = ws.slice(i, i + 1600);
  must(/setResumeNotice\(null\)/.test(seg), "终态没有收起 resumeNotice —— 会说「正在跑」但任务没了");
});

console.log(`\n通过 ${pass} / ${pass + fail}\n`);
if (fail) console.log("★ 服务挂掉时界面会骗人，或用户无路可走。\n");
process.exit(fail === 0 ? 0 : 1);
