/**
 * 异常输入验收 —— 把「输入校验」变成可自动复跑的断言。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要这一套
 *
 *   2026-10-19 我主动测了 17 项异常输入，发现 5 个真实缺陷：
 *     · 空提示词 / 纯空格     → 一路提交到 CLIPTextEncode，出一张随机图
 *     · 伪装成图的文本        → 被当成图片传上去
 *     · 非法 base64           → Buffer.from 静默截断，传垃圾字节
 *     · 不存在的槽名          → 被静默忽略，用户以为传上了
 *     · 单图 50MB             → 没有大小上限
 *
 *   命中率约 30%（5/17）—— 每测 3 项就有一个真缺陷。
 *   ⇒ 值得做成常驻验收：改代码后自动复测，防止修好的又坏回去。
 *
 * ══════════════════════════════════════════════════════════════════════
 *
 * 检查原则：**异常输入必须被明确拒绝，且拒绝理由要说人话。**
 *   不接受「静默忽略」「静默用默认值」「传到下游才失败」。
 *
 * 用法：
 *   node verify-bad-input.mjs
 *   node verify-bad-input.mjs --base http://127.0.0.1:19499
 *
 * 退出码：有没被拒绝的 → 1
 */

import fs from "node:fs";
import path from "node:path";

// ★ 2026-10-21：符号类字符的判定是【纯校验逻辑】，
//   直接调这个函数，不走网络（原因见下方「符号类字符不被误拒」的注释）。
import { hasVisibleText } from "./src/text-guard.mjs";

// ★ 2026-10-19：跑之前记下 ComfyUI input 目录的快照，跑完删掉新增的。
//   原因见下方 cleanup 的注释 —— 验收不该留垃圾。
const INPUT_DIR = "D:\\Comfy-Desktop\\ComfyUI-Shared\\input";
const SNAPSHOT = (() => {
  try { return new Set(fs.readdirSync(INPUT_DIR)); } catch { return new Set(); }
})();

const args = process.argv.slice(2);
const argOf = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const BASE = argOf("--base", "http://127.0.0.1:19499");

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, detail = "") {
  pass++;
  console.log(`  ✅ ${name}${detail ? "  " + detail : ""}`);
}
function bad(name, detail = "") {
  fail++;
  failures.push(name);
  console.log(`  ❌ ${name}${detail ? "  " + detail : ""}`);
}

/** 提交一次 generate，返回 { accepted, error, promptId } */
async function tryGenerate(body) {
  const res = await fetch(`${BASE}/comfy-bridge/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* 非 JSON */ }
  if (res.ok && j && !j.error) {
    return { accepted: true, promptId: j.promptId };
  }
  return { accepted: false, error: j?.error ?? text.slice(0, 120) };
}

/**
 * 本次测试上传到 ComfyUI input 目录的文件 —— 跑完要删掉。
 *
 * ★★ 2026-10-19 加（实测发现）：
 *   verify-bad-input.mjs 的「⑤ 正常输入仍能通过」组必须提交真实请求，
 *   而真实请求会上传文件到 ComfyUI 的 input 目录。
 *   每跑一次验收就多一个 wb_ref_image_0_ok_xxxxxx.png。
 *
 *   实测：验收前 108 个文件 → 验收后 109 个。
 *   （我先前手工清过一次 46 个，就是历次验收累积的。）
 *
 *   ⇒ cancel() 只撤队列，撤不掉已落盘的文件。这里补一个删除。
 */
const uploaded = [];
function noteUpload(body) {
  // 从 body.files 里推断我们会写出什么文件名 —— 与 index.js 的命名规则一致：
  //   wb_<slot>_<safeBase>_<随机6位><ext>
  // 但随机段在服务端生成，客户端不知道。
  // ⇒ 换个办法：跑之前记下 input 目录的快照，跑完对比新增。
}

/** 撤掉刚提交的任务，别占队列 */
async function cancel(promptId) {
  if (!promptId) return;
  try {
    await fetch("http://127.0.0.1:8188/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delete: [promptId] }),
    });
  } catch { /* 忽略 */ }
}

// 1×1 的合法 PNG（67 字节）
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

console.log("═".repeat(62));
console.log("  异常输入验收（必须全部被拒，且理由说人话）");
console.log("═".repeat(62));
console.log(`  实例 ${BASE}`);

// ─── A. 提示词校验 ──────────────────────────────────────────────
console.log("\n① 提示词");

{
  const r = await tryGenerate({ modeId: "krea2", prompt: "", steps: 4 });
  if (r.accepted) bad("空提示词被拒", "★ 被接受了 —— 会生成随机的图");
  else ok("空提示词被拒", r.error.slice(0, 40));
  await cancel(r.promptId);
}
{
  const r = await tryGenerate({ modeId: "krea2", prompt: "    ", steps: 4 });
  if (r.accepted) bad("纯空格提示词被拒", "★ 被接受了");
  else ok("纯空格提示词被拒", r.error.slice(0, 40));
  await cancel(r.promptId);
}

// ★ 2026-10-19 加（独立复核第二轮发现）：
//   1. 不可见字符的「类别」要覆盖全 —— U+2800(So) / U+00AD(Cf) 曾穿透黑名单
//   2. 长度要有上限 —— 实测 100000 / 1050000 字符都曾被接受
//   3. 符号不能误拒 —— 我改白名单时漏了 \p{S}，$ + = < > 全被拒
{
  const invisibles = [
    ["U+2800 盲文空白", "\u2800"],
    ["U+00AD 软连字符", "\u00ad"],
    ["混合不可见", "\u2060\u2800\u00ad\ufeff"],
    ["U+3164 韩文填充", "\u3164"],
  ];
  for (const [name, ch] of invisibles) {
    const r = await tryGenerate({ modeId: "krea2", prompt: ch, steps: 4 });
    if (r.accepted) bad(`${name}被拒`, "★ 被接受了 —— 会生成随机的图");
    else ok(`${name}被拒`);
    await cancel(r.promptId);
  }
}
{
  /**
   * ★★ 2026-10-21 改（总验收里这条报红，我查明原因后改的）
   *
   * —— 原来的写法：对每个符号调 tryGenerate（真实提交到 ComfyUI），
   *   只要 accepted === false 就记「被误拒」。
   *
   * —— 问题：这把【校验逻辑】和【网络可达性】耦合了。
   *   ComfyUI 一关，tryGenerate 必然返回 accepted:false
   *   ⇒ 14 个符号全被记成「误拒」⇒ 断言红。
   *   而实际上校验函数是对的 —— 我单独实测 hasVisibleText：
   *     $ + = < > | ~ ^ ∑ ℃ √ ∞ ≈ ≠   全部返回 true
   *
   * —— 这条断言真正要验的是【校验逻辑】，不是【能不能提交】。
   *   ⇒ 直接调 hasVisibleText（纯函数，零网络）。
   *     真实提交的可用性由「⑤ 正常输入仍能通过」那组负责。
   */
  const syms = ["$", "+", "=", "<", ">", "|", "~", "^", "∑", "℃", "√", "∞", "≈", "≠"];
  const rejected = [];
  for (const s of syms) {
    if (!hasVisibleText(s)) rejected.push(s);          // 光有符号也算有内容
    if (!hasVisibleText(`符号 ${s}`)) rejected.push(`${s}(混合)`);  // 混在文字里更算
  }
  if (rejected.length === 0) {
    ok("符号类字符不被误拒", `${syms.length} 项全过（纯函数，不依赖 ComfyUI）`);
  } else {
    bad("符号类字符不被误拒", `★ 误拒 ${rejected.length} 个：${rejected.join(" ")}`);
  }
}
{
  const r1 = await tryGenerate({ modeId: "krea2", prompt: "a".repeat(100000), steps: 4 });
  if (r1.accepted) bad("超长提示词被拒", "★ 100000 字符被接受了");
  else ok("超长提示词被拒", r1.error.slice(0, 40));
  await cancel(r1.promptId);
}

// ─── B. 数值越界（ComfyUI schema 应挡住）────────────────────────
console.log("\n② 数值越界");
const numericCases = [
  ["steps=0", { modeId: "krea2", prompt: "x", steps: 0 }],
  ["steps=-1", { modeId: "krea2", prompt: "x", steps: -1 }],
  ["steps=99999", { modeId: "krea2", prompt: "x", steps: 99999 }],
  ["batch=0", { modeId: "krea2", prompt: "x", steps: 4, batch: 0 }],
  ["batch=-5", { modeId: "krea2", prompt: "x", steps: 4, batch: -5 }],
  ["megapixels=0", { modeId: "krea2", prompt: "x", steps: 4, megapixels: 0 }],
  ["megapixels=999", { modeId: "krea2", prompt: "x", steps: 4, megapixels: 999 }],
  ["aspect=100:1", { modeId: "krea2", prompt: "x", steps: 4, aspect: "100:1" }],
];
for (const [name, body] of numericCases) {
  const r = await tryGenerate(body);
  if (r.accepted) bad(`${name} 被拒`, "★ 被接受了");
  else ok(`${name} 被拒`);
  await cancel(r.promptId);
}

// ─── C. 模式校验 ────────────────────────────────────────────────
console.log("\n③ 模式");
{
  const r = await tryGenerate({ modeId: "nope", prompt: "x" });
  if (r.accepted) bad("未知模式被拒", "★ 被接受了");
  else ok("未知模式被拒", r.error.slice(0, 40));
  await cancel(r.promptId);
}

// ─── D. 素材校验（2026-10-19 新增的四道）────────────────────────
console.log("\n④ 素材");

{
  // 伪装成图的文本 —— 魔数不对
  const r = await tryGenerate({
    modeId: "qwen21-edit", prompt: "x", steps: 4,
    files: { ref_image_0: { base64: Buffer.from("hello world").toString("base64"), filename: "fake.png" } },
  });
  if (r.accepted) bad("伪装成图的文本被拒", "★ 被接受了");
  else ok("伪装成图的文本被拒", r.error.slice(0, 50));
  await cancel(r.promptId);
}
{
  // 非法 base64 —— 长度对不上
  const r = await tryGenerate({
    modeId: "qwen21-edit", prompt: "x", steps: 4,
    files: { ref_image_0: { base64: "!!!not-base64!!!", filename: "a.png" } },
  });
  if (r.accepted) bad("非法 base64 被拒", "★ 被接受了");
  else ok("非法 base64 被拒", r.error.slice(0, 50));
  await cancel(r.promptId);
}
{
  // 不存在的槽名 —— krea2 没有 media 槽
  const r = await tryGenerate({
    modeId: "krea2", prompt: "x", steps: 4,
    files: { bogus_slot: { base64: PNG_1PX, filename: "a.png" } },
  });
  if (r.accepted) bad("未知槽名被拒", "★ 被接受了（会被静默忽略）");
  else ok("未知槽名被拒", r.error.slice(0, 50));
  await cancel(r.promptId);
}
{
  // 必填槽缺失 —— qwen21-edit 的原图
  const r = await tryGenerate({ modeId: "qwen21-edit", prompt: "x", steps: 4 });
  if (r.accepted) bad("必填素材缺失被拒", "★ 被接受了（会用内置示例图跑）");
  else ok("必填素材缺失被拒", r.error.slice(0, 50));
  await cancel(r.promptId);
}

// ─── E. 正常输入仍应通过（防止校验过头）─────────────────────────
console.log("\n⑤ 正常输入仍能通过（防止校验过头）");
{
  const r = await tryGenerate({ modeId: "krea2", prompt: "a cat", steps: 4 });
  if (r.accepted) ok("正常文本生图");
  else bad("正常文本生图", `★ 被误拒：${r.error.slice(0, 60)}`);
  await cancel(r.promptId);
}
{
  const r = await tryGenerate({
    modeId: "qwen21-edit", prompt: "make it red", steps: 4,
    files: { ref_image_0: { base64: PNG_1PX, filename: "ok.png" } },
  });
  if (r.accepted) ok("正常改图（带合法 PNG）");
  else bad("正常改图", `★ 被误拒：${r.error.slice(0, 60)}`);
  await cancel(r.promptId);
}

// ─── 清理本次上传的文件 ────────────────────────────────────────
//   办法：跑之前已经记了 input 目录快照（见文件开头的 SNAPSHOT），
//   这里对比出新增文件并删掉。
/**
 * ★ 2026-10-21 修：原来是异步 IIFE，脚本不等它就退出。
 *   实测：跑完 input/ 里还留 wb_ref_image_0_src_*.png。
 *   ⇒ 改成 await + 先等 1 秒（让最后的上传请求落地）。
 *
 * ★★ 2026-10-23 三修 —— 前两版都没修对，根因在别处
 *
 *   【错误的第一版】固定 sleep 1000ms
 *     「赌上传写完了」。负载高、或放进 verify-all 里跑就赌输。
 *
 *   【错误的第二版】轮询「目录内容连续两次相同」
 *     仍然漏。实测证据（决定性）：
 *       报「清理了 1 / 1」，但跑完目录里还有一个，
 *       而且文件名从 x0sku8 变成另一个，时间戳 17:03:53 → 17:06:22。
 *     ⇒ 它删掉的是【上一轮遗留】的文件，本轮真正上传的那个
 *       在删除动作【之后】才落地。
 *
 *   【真正的根因】桥的上传是「先回 HTTP 200，再写盘」——
 *     本脚本收到 200 就继续往下跑，此时桥还没开始写。
 *     「目录稳定」这个判据在这里没用：写盘之前目录本来就很稳定。
 *
 *   ⇒ 正确判据：必须【看到新文件出现】，然后等它稳定（mtime 不再变）。
 *     只看到「目录没变化」不算数。
 *
 *   ★ 这是「等异步动作完成」的通用教训：
 *     判据要盯【预期出现的那个变化】，不是盯【没有变化】。
 */
async function waitForUploadLanded(expectedNew, maxMs = 15000, intervalMs = 200) {
  const t0 = Date.now();
  let stableSince = null;
  let lastSig = null;
  while (Date.now() - t0 < maxMs) {
    let names = [];
    try { names = fs.readdirSync(INPUT_DIR); } catch { return; }
    const fresh = names.filter((n) => !SNAPSHOT.has(n));

    /* 还没看到任何新文件 —— 继续等（这就是上一版漏掉的那段） */
    if (fresh.length === 0) {
      stableSince = null;
      lastSig = null;
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }

    /* 看到了：再看它稳不稳定（名字集合 + mtime 都不再变） */
    const sig = fresh
      .map((n) => {
        try {
          const st = fs.statSync(path.join(INPUT_DIR, n));
          return `${n}:${st.size}:${st.mtimeMs}`;
        } catch { return `${n}:?`; }
      })
      .sort()
      .join("|");

    if (sig === lastSig) {
      if (stableSince === null) stableSince = Date.now();
      /* ★ 新文件出现后还要再稳 1.2 秒，防「先建 0 字节再写内容」 */
      if (Date.now() - stableSince >= 1200) return fresh.length;
    } else {
      lastSig = sig;
      stableSince = null;
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
  /* 超时：把看到的都算上，下面照样会尝试删 */
  try {
    const n = fs.readdirSync(INPUT_DIR).filter((x) => !SNAPSHOT.has(x)).length;
    if (n > 0) console.log(`  ⚠ 等待上传落地超时（${maxMs}ms），但已看到 ${n} 个新文件`);
    else console.log(`  ⚠ 等待上传落地超时（${maxMs}ms），没看到新文件`);
    return n;
  } catch { return 0; }
}

const landed = await waitForUploadLanded();
void landed;

try {
  const now = new Set(fs.readdirSync(INPUT_DIR));
  const created = [...now].filter((n) => !SNAPSHOT.has(n));
  if (created.length) {
    let gone = 0;
    for (const n of created) {
      try { fs.unlinkSync(path.join(INPUT_DIR, n)); gone++; } catch { /* 删不掉就算了 */ }
    }
    console.log(`\n  清理了 ${gone} / ${created.length} 个本次上传的文件`);
    if (gone < created.length) {
      console.log(`  ⚠ 有 ${created.length - gone} 个没删掉（可能被占用）`);
    }
  }
} catch { /* input 目录读不到就算了 */ }

/**
 * ★★ 2026-10-23 补：清理 output 目录（原来只清 input）
 *
 *   实测污染：每跑一次完整验收，output 里多 1 张 Krea2-2ST-*.png。
 *
 *   根因：本脚本第 ⑤ 组「正常输入不被误拒」必须发【真实 krea2 生成请求】，
 *        而真实生成会往 output 写文件。原来只做 input 清理，
 *        output 从来没清。
 *
 *     AGENTS §6.37「验收的第三个维度：副作用」我当年只覆盖了 input 那一半。
 *     §6.44b「写两边就清两边」的又一次现身。
 *
 *   ⇒ 补 output 快照 + 稳定等待 + 清理，与 input 对称。
 *
 *   ★ 「等落盘」不能用固定 sleep：双采工作流有两个保存节点，
 *     固定 1.2 秒不够（verify-krea2 实测漏过）。改成观察目录数量稳定。
 */
const OUTPUT_DIR = "D:\\Comfy-Desktop\\ComfyUI-Shared\\output";
const OUT_SNAPSHOT = (() => {
  try { return new Set(fs.readdirSync(OUTPUT_DIR)); } catch { return new Set(); }
})();

/** 等 output 目录落盘稳定（连续 3 次采样数量不变），最多 8 秒。 */
async function waitOutStable(ms = 8000, interval = 400, needStable = 3) {
  const t0 = Date.now();
  let last = -1;
  let stable = 0;
  while (Date.now() - t0 < ms) {
    let n = -1;
    try { n = fs.readdirSync(OUTPUT_DIR).length; } catch { /* 继续等 */ }
    if (n === last) {
      stable += 1;
      if (stable >= needStable) return true;
    } else {
      stable = 0;
      last = n;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

try {
  await waitOutStable();
  const nowOut = new Set(fs.readdirSync(OUTPUT_DIR));
  const madeOut = [...nowOut].filter((n) => !OUT_SNAPSHOT.has(n));
  if (madeOut.length) {
    let gone = 0;
    for (const n of madeOut) {
      try { fs.unlinkSync(path.join(OUTPUT_DIR, n)); gone++; } catch { /* 删不掉就算了 */ }
    }
    console.log(`  清理了 ${gone} / ${madeOut.length} 个本次生成的产物`);
  } else {
    console.log("  （本次没有往 output 写文件）");
  }
} catch { /* output 目录读不到就算了 */ }

console.log("\n" + "═".repeat(62));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  异常输入验收全过");

