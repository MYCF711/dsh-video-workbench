/**
 * verify-progress.mjs · 实时进度总线验收（2026-10-22）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 主人：「是不是需要有一个任务队列，或者任务状态？实时显示进度之类的？」
 *       → 选了「只做进度 + 位次」
 *
 * ── 为什么需要 WS
 *   · `/queue`   只给排队位次，没有进度
 *   · `/history` 只在任务【结束】时才有数据
 *   · 中间的「第 15/30 步」ComfyUI 只在 WebSocket 上推
 *
 * ── 协议实证（不是凭记忆）
 *   D:\Comfy-Desktop\ComfyUI-Installs\My_Comfy_UI\ComfyUI\main.py:450-464
 *     progress = {"value": value, "max": total, "prompt_id": prompt_id, "node": node_id}
 *     server_instance.send_sync("progress", progress, ...)
 *
 * ── 本脚本测什么
 *   ① 消息解析：progress / executing / execution_error / status
 *   ② 除零保护：max=0 时 pct 必须是 null（不是 Infinity / NaN）
 *   ③ 过期判定：10 秒没更新就不报（防「卡在 45%」的假象）
 *   ④ 懒连接：没人 watch 就不连
 *   ⑤ 前后端契约：后端返回 progress 字段，前端会读它
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProgressBus } from "../dsh-comfy-bridge/src/progress-bus.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(p, "utf8");
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const norm = (s) => s.replace(/\r\n/g, "\n");
const code = (s) => norm(stripComments(s));

let pass = 0;
const fails = [];
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ✅ ${name}`); return; }
  fails.push({ name, detail });
  console.log(`  ❌ ${name}${detail ? "\n      " + detail : ""}`);
};

const silentLog = { info() {}, warn() {}, error() {} };
const mkBus = () => createProgressBus({ base: "http://127.0.0.1:8188", log: silentLog });
const feed = (bus, obj) => bus._internal.handleMessage(JSON.stringify(obj));

/* ══ ① 消息解析 ══════════════════════════════════════════════════════ */
console.log("\n① 消息解析（按 main.py:461 的真实字段）");

{
  const bus = mkBus();
  feed(bus, { type: "progress", data: { value: 15, max: 30, prompt_id: "p1", node: "12" } });
  const p = bus.get("p1");
  check("progress 事件被正确解析", p && p.value === 15 && p.max === 30);
  check("百分比算对（15/30 = 50）", p && p.pct === 50, `实际 ${p?.pct}`);
  check("node 字段保留", p && p.node === "12");
  bus.close();
}

{
  const bus = mkBus();
  feed(bus, { type: "progress", data: { value: 7, max: 30, prompt_id: "p2" } });
  const p = bus.get("p2");
  check("不含 node 时也不崩", p && p.pct === 23, `实际 ${p?.pct}`);
  bus.close();
}

{
  const bus = mkBus();
  feed(bus, { type: "executing", data: { node: null, prompt_id: "p3" } });
  const p = bus.get("p3");
  check("executing(node:null) ⇒ 标记完成、100%", p && p.done === true && p.pct === 100);
  bus.close();
}

{
  const bus = mkBus();
  feed(bus, { type: "execution_error", data: { prompt_id: "p4" } });
  const p = bus.get("p4");
  check("execution_error ⇒ 标记 error", p && p.error === true);
  bus.close();
}

{
  const bus = mkBus();
  feed(bus, { type: "status", data: { status: { exec_info: { queue_remaining: 3 } } } });
  check("status ⇒ 记下 queue_remaining", bus.stats().queueRemaining === 3);
  bus.close();
}

/* ══ ② 鲁棒性 ════════════════════════════════════════════════════════ */
console.log("\n② 鲁棒性（坏输入不能把总线弄崩）");

{
  const bus = mkBus();
  let threw = false;
  try {
    bus._internal.handleMessage("not json at all");
    bus._internal.handleMessage(JSON.stringify({ type: "progress" }));            // 缺 data
    bus._internal.handleMessage(JSON.stringify({ type: "progress", data: {} }));  // 缺 prompt_id
    bus._internal.handleMessage(JSON.stringify(null));
    bus._internal.handleMessage(JSON.stringify({ type: "unknown_event" }));
  } catch (e) { threw = true; }
  check("坏 JSON / 缺字段 / 未知事件都不抛", !threw);
  bus.close();
}

{
  /**
   * ★★ 2026-10-22 补：缺 prompt_id 时【不该往 Map 里写垃圾】
   *
   *   第一版只测「不抛」，而变异测试（删掉一处 if (!pid) return）
   *   仍然通过 —— 因为源码里有多处同样的判空，删一个不影响。
   *   ⇒ 改成测**可观察的行为**：喂一条没有 prompt_id 的 progress，
   *     trackedPrompts 不能增加（不能写出一个 key=undefined 的记录）。
   */
  const bus = mkBus();
  const before = bus.stats().trackedPrompts;
  feed(bus, { type: "progress", data: { value: 5, max: 10 } });   // 无 prompt_id
  const after = bus.stats().trackedPrompts;
  check("缺 prompt_id 时不写入记录（不产生 undefined key）",
    after === before,
    `写入前 ${before} 条，写入后 ${after} 条`);
  bus.close();
}

{
  const bus = mkBus();
  /* ★ max=0 的除零保护 —— 某些节点不报总步数 */
  feed(bus, { type: "progress", data: { value: 5, max: 0, prompt_id: "z" } });
  const p = bus.get("z");
  check("max=0 时 pct 是 null（不是 Infinity/NaN）",
    p && p.pct === null,
    `实际 ${JSON.stringify(p?.pct)}`);
  bus.close();
}

{
  const bus = mkBus();
  feed(bus, { type: "progress", data: { value: 40, max: 30, prompt_id: "over" } });
  const p = bus.get("over");
  check("value > max 时 pct 不超过 100", p && p.pct === 100, `实际 ${p?.pct}`);
  bus.close();
}

/* ══ ③ 过期判定 ══════════════════════════════════════════════════════ */
console.log("\n③ 过期判定（防「卡在 45%」的假象）");

{
  const bus = mkBus();
  feed(bus, { type: "progress", data: { value: 15, max: 30, prompt_id: "old" } });
  /* 手动把 updatedAt 改到 11 秒前 */
  const rec = bus.get("old");
  check("刚收到时能读到", rec !== null);
  /* 通过再喂一条并篡改内部 —— 这里用 stats 间接验证不了，直接测 10s 逻辑 */
  const src = read(path.join(HERE, "..", "dsh-comfy-bridge", "src", "progress-bus.mjs"));
  check("超过 10 秒未更新 ⇒ 返回 null（代码里有这个判断）",
    /Date\.now\(\)\s*-\s*\(p\.updatedAt\s*\|\|\s*0\)\s*>\s*10000/.test(code(src)));
  bus.close();
}

{
  const bus = mkBus();
  check("未知 promptId ⇒ null（不是 {} / 0）", bus.get("nonexistent") === null);
  check("空 promptId ⇒ null", bus.get(null) === null);
  bus.close();
}

/* ══ ④ 懒连接 ════════════════════════════════════════════════════════ */
console.log("\n④ 懒连接（没人看就不连，别占资源）");

{
  const src = read(path.join(HERE, "..", "dsh-comfy-bridge", "src", "progress-bus.mjs"));
  const c = code(src);
  check("有 watchers 计数", /let watchers = 0/.test(c));
  check("没人看时 close 不重连", /if \(watchers > 0\) scheduleRetry\(\)/.test(c));
  check("subscribe 才 connect", /const watch = \(\) => \{\s*watchers \+= 1;\s*connect\(\)/.test(c));
  check("退避重连有上限", /Math\.min\(10000/.test(c));
  check("重连定时器 unref（不阻止进程退出）", /retryTimer\.unref/.test(c) || /\.unref\?\./.test(c));
  check("error 里也复位 connecting（否则连不上就永远卡住）",
    /**
     * ★★ 2026-10-22 实测：ComfyUI 未运行时，Node 内建 WebSocket 只发 error、
     *   不发 close ⇒ connecting 永远是 true ⇒ 后续重连全被挡掉。
     *   实测现象：stats() 一直返回 { connecting: true, lastError: "WebSocket error" }，
     *   等 10 秒都不变。
     */
    /addEventListener\("error"[\s\S]{0,600}connecting = false/.test(c));

}

{
  const src = read(path.join(HERE, "..", "dsh-comfy-bridge", "src", "progress-bus.mjs"));
  check("用内建 WebSocket（bridge 零依赖）",
    /new WebSocket\(/.test(code(src)) &&
    !/from ["']ws["']/.test(src),
    "Node v24 内建 WebSocket，不该引入 ws 包");
}

/* ══ ⑤ 前后端契约 ════════════════════════════════════════════════════ */
console.log("\n⑤ 前后端契约（生产方产出、消费方必须接）");

{
  const bridgeSrc = read(path.join(HERE, "..", "dsh-comfy-bridge", "src", "index.js"));
  check("后端 job handler 返回 progress 字段",
    /progress:\s*progressBus\.get\(job\.promptId\)/.test(code(bridgeSrc)),
    "AGENTS §6.38：生产方产出、消费方没接是常见缺陷");

  check("后端有 /progress/status 路由（驱动 WS 连接）",
    /prefix \+ "\/progress\/status"/.test(bridgeSrc));

  check("后端有 /progress/<id> 路由",
    /prefix \+ "\/progress"/.test(bridgeSrc));

  const wbSrc = read(path.join(HERE, "src", "WorkbenchView.js"));
  check("前端会读 job.progress",
    /const pg = job\.progress/.test(code(wbSrc)));

  check("前端只在 pct 是数字时才显示（null 就不显示）",
    /pg && Number\.isFinite\(pg\.pct\)/.test(code(wbSrc)),
    "显示 0% 会让人以为卡住，比不显示更糟");

  check("前端显示步数而不只是百分比",
    /步 · \$\{pg\.pct\}%|步 ·/.test(wbSrc),
    "不同节点总步数不同，只看百分比看不出「在动」");

  check("前端已接队列位次",
    /排队第 \$\{ahead \+ 1\} 位/.test(wbSrc));

  /**
   * ★★ 2026-10-22：订阅必须幂等，且任务结束要释放
   *
   *   第一版我在 /job handler 里不 watch（怕计数只增不减），
   *   结果没有任何地方驱动连接 ⇒ 进度永远是 null。
   *   现在的做法是按 jobId 记账，同一个任务只 watch 一次。
   */
  check("后端有 ensureWatched（幂等订阅）",
    /function ensureWatched\(jobId\)/.test(code(bridgeSrc)) &&
    /const existing = watchedJobs\.get\(jobId\)/.test(code(bridgeSrc)));

  check("任务完成时释放订阅",
    /if \(h\.completed\) \{\s*releaseWatch\(/.test(code(bridgeSrc)),
    "不释放 ⇒ watchers 永不归零 ⇒ WS 连接永不关闭");

  check("取消时也释放订阅",
    /releaseWatch\(jobId\);\s*progressBus\.forget/.test(code(bridgeSrc)));

  check("诊断接口无副作用（不驱动连接）",
    /**
     * 第一版 /progress/status 每次请求都 connect()，
     * 导致诊断永远显示「正在连接中」—— 我因此误判 connecting 卡死，查了半小时。
     */
    !/progressBus\._internal\.connect\(\);\s*\/\/ 确保连接已建立/.test(bridgeSrc));
}

/* ══ 汇总 ════════════════════════════════════════════════════════════ */
console.log("");
const total = pass + fails.length;
if (fails.length === 0) {
  console.log(`  ✅ 全部通过：${pass} / ${total}`);
  process.exit(0);
}
console.log(`  ❌ ${fails.length} 项失败，通过 ${pass} / ${total}`);
for (const f of fails) console.log(`     · ${f.name}`);
process.exit(1);
