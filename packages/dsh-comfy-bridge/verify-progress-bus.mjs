/**
 * 校验：ComfyUI 进度总线（WebSocket）真的能报进度
 *
 * ══════════════════════════════════════════════════════════════════════
 * 这条验收存在的理由：**进度条一直不动，但没有任何报错**。
 *
 * 【实测发现】2026-10-25，用 node 脚本直连 ws://127.0.0.1:8188/ws
 * 抓到的 ComfyUI 0.40.0 原始消息：
 *
 *   {"type":"status","data":{"status":{"exec_info":{"queue_remaining":2}},"sid":"dsh-comfy-bridge"}}
 *   {"type":"executing","data":{"node":"397"}}                    ← 没有 prompt_id！
 *   {"type":"progress_state","data":{"prompt_id":"ebda…","nodes":{…}}}
 *   {"type":"progress","data":{"value":12,"max":20,"prompt_id":"ebda…","node":"397"}}
 *   {"type":"executing","data":{"node":null}}                     ← 也没有 prompt_id
 *
 * 而原来的代码是：
 *   if (type === "executing") {
 *     const pid = data.prompt_id;
 *     if (!pid) return;          ← **每一条 executing 都被丢掉**
 *     ...
 *   }
 *
 * 后果链（全部静默，界面上看不出来）：
 *   · `done: true` 永远设不上
 *   · 进度条走不到 100%，「收尾中…」不出现
 *   · 采样完成 → 落盘那段完全看不到，只能靠 /history 兜底
 *   · 用户看到的是「已提交，等待产出…」一动不动
 *
 * 实测修复后（同一台机器、同一个任务）：
 *   pct=10 → 20 → 40 → 55 → 75 → 90 → 60（新节点重算）→ 100 → completed
 *
 * 判据：**外部协议的真实形状要靠抓包确认**，不能假设它「应该带 prompt_id」。
 * ══════════════════════════════════════════════════════════════════════
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const BUS = path.join(REPO, "packages", "dsh-comfy-bridge", "src", "progress-bus.mjs");

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
};
const must = (c, m) => { if (!c) throw new Error(m); };
const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

const src = fs.readFileSync(BUS, "utf8");
const code = strip(src);

console.log("\n=== ① executing 消息不能要求 prompt_id ===\n");

t("★ 有 lastExecutingPromptId 兜住「消息不带 prompt_id」", () => {
  must(
    /let lastExecutingPromptId = null/.test(code),
    "没有 lastExecutingPromptId —— executing 消息不带 prompt_id 时就没人记了"
  );
});

t("★ node===null（跑完）时用兜底 id，不再直接 return", () => {
  const i = code.indexOf('if (type === "executing")');
  must(i > 0, "找不到 executing 分支");
  const seg = code.slice(i, i + 1400);
  must(
    !/const pid = data\.prompt_id;\s*if \(!pid\) return;/.test(seg),
    "还在「拿不到 prompt_id 就 return」—— 完成事件会被丢掉"
  );
  must(
    /data\.prompt_id \?\? lastExecutingPromptId/.test(seg),
    "没有用 lastExecutingPromptId 兜底 —— done 标记永远设不上"
  );
});

t("收到带 node 的 executing 会记下当前 prompt", () => {
  const i = code.indexOf('if (type === "executing")');
  const seg = code.slice(i, i + 1400);
  must(
    /lastExecutingPromptId = data\.prompt_id/.test(seg),
    "没有记住「当前在跑哪个 prompt」"
  );
});

console.log("\n=== ② 用 progress_state 当权威来源 ===\n");

t("处理 progress_state 消息", () => {
  must(/type === "progress_state"/.test(code), "没处理 progress_state —— 它才是带 prompt_id 的全量状态");
});

t("progress_state 累计所有节点算总进度", () => {
  const i = code.indexOf('type === "progress_state"');
  must(i > 0, "找不到 progress_state 分支");
  const seg = code.slice(i, i + 1200);
  must(/Object\.values\(data\.nodes\)/.test(seg), "没有遍历 nodes");
  must(/v \+= nv/.test(seg) && /m \+= nm/.test(seg), "没有累计 value/max");
  must(/pct:\s*Math\.min\(100/.test(seg), "没有算百分比");
});

t("progress_state 全部 finished ⇒ done", () => {
  const i = code.indexOf('type === "progress_state"');
  const seg = code.slice(i, i + 1200);
  /**
   * ★★ 2026-10-25 变异测试抓出的盲区：
   *   原来只判「出现过 allDone」和「出现过 done: true」。
   *   把 `if (n?.state !== "finished") allDone = false;` 删掉后，
   *   allDone 恒为初始值 true ⇒ 一收到进度就标 done（进度条秒到 100%），
   *   而断言照绿。
   *
   *   ⇒ 必须检查三件事：初始为真 + 有失败分支 + 最终用于 done。
   */
  must(/let\s+v\s*=\s*0,\s*m\s*=\s*0,\s*allDone\s*=\s*true/.test(seg),
    "allDone 没有初始化为 true（否则永远不 done）");
  must(/if \(n\?\.state !== "finished"\) allDone = false;/.test(seg),
    "没有「发现未完成节点就置 false」的分支 —— allDone 会恒为 true，进度条秒到 100%");
  must(/\.\.\.\(allDone \? \{ done: true \} : \{\}\)/.test(seg),
    "全部完成时没有设 done");
});

console.log("\n=== ③ 除零与大值保护 ===\n");

t("max 为 0 时不算出 NaN 百分比", () => {
  must(
    /max > 0/.test(code) || /m > 0/.test(code),
    "没有 max>0 保护 —— 某些节点不报总步数，会算出 NaN%"
  );
});

t("百分比夹在 0~100", () => {
  must(/Math\.min\(100/.test(code), "百分比没有上限保护");
});

console.log("\n=== ④ 进度过期要停报（不能永远显示 45%） ===\n");

t("超过 10 秒没更新就不返进度", () => {
  const i = code.indexOf("const get = (promptId)");
  must(i > 0, "找不到 get()");
  const seg = code.slice(i, i + 900);
  must(/10000/.test(seg), "没有过期判定 —— 任务被中断后会一直显示旧百分比，像卡住");
  must(/return null/.test(seg), "过期时没有返回 null");
});

console.log(`\n通过 ${pass} / ${pass + fail}\n`);
if (fail) console.log("★ 进度条不动 = 用户以为卡死，而实际上在正常生成。\n");
process.exit(fail === 0 ? 0 : 1);
