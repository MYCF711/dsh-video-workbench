#!/usr/bin/env node
/**
 * LLM 起名 + 规则降级验收
 *
 * 背景（任务书四-1，主人原话）：
 *   「命名可以让 llm 来起一个默认名，用户做最后把关确认」
 *
 * 为什么要有这一套：
 *   实测（2026-10-21）本机 DeepSeek API key 失效（401 AUTH），
 *   LLM 起名永远失败。但「起名」只是个【草稿】，用户会改，
 *   ⇒ LLM 不可用时应降级到规则名，而不是什么都不给。
 *
 * 本验收守四件事：
 *   ① LLM 可用 → source=llm，名字是中文短语
 *   ② LLM 不可用 → source=rule，名字仍是可读草稿（不是空、不是原名乱码）
 *   ③ LLM 的失败原因必须【原样暴露】（不能报「模型返回空文本」这种误导）
 *   ④ 规则名不切断词（Krea2 2ST 249 不能变 Krea2 2ST 24）
 *
 * 用法：node verify-suggest-name.mjs
 */

import fs from "node:fs";

const BASE = process.env.COMFY_WB_BASE ?? "http://127.0.0.1:19499";
const TOKEN_FILE = "C:/Users/Administrator/dsh-tok.txt";

let pass = 0, fail = 0;
const failures = [];

function ok(name, detail = "") {
  pass++;
  console.log(`    ✅ ${name}${detail ? `  ${detail}` : ""}`);
}
function bad(name, detail = "") {
  fail++;
  failures.push(name);
  console.log(`    ❌ ${name}${detail ? `\n       ${detail}` : ""}`);
}

const tok = fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, "utf8").trim() : "";
const cookie = `dsh-auth-CK36o8O6fn6VWHrnbEp0bsjzKPKRmilHp-TBfPBH65k=${tok}`;

async function suggest(payload) {
  const res = await fetch(`${BASE}/comfy-assets/suggest-name`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60000),
  });
  let body;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

console.log("\n  LLM 起名 + 规则降级");

// ── ① 各种文件名都要给出可读草稿 ─────────────────────────────
console.log("\n  === ① 规则草稿可读性 ===");
{
  const cases = [
    { in: "Krea2-2ST-20261018_00249_.png", kind: "image", mustNot: ["24"], mustHave: "249" },
    { in: "Qwen_image_2.1_00029.png", kind: "image", mustNot: [], mustHave: "2.1" },
    { in: "YZ_H3__00034.mp4", kind: "video", mustNot: [], mustHave: "YZ" },
  ];
  for (const c of cases) {
    const { status, body } = await suggest({ filename: c.in, kind: c.kind });
    if (status !== 200 || !body?.ok) {
      bad(`「${c.in}」应返回 200+ok`, `status=${status} body=${JSON.stringify(body).slice(0, 100)}`);
      continue;
    }
    const n = String(body.name ?? "");
    if (!n.trim()) { bad(`「${c.in}」名字不能为空`); continue; }
    if (c.mustHave && !n.includes(c.mustHave)) {
      bad(`「${c.in}」名字应含「${c.mustHave}」`, `实际 '${n}'`);
      continue;
    }
    // 不能把编号截断（249 → 24）
    if (c.mustNot.length && c.mustNot.some((x) => n.endsWith(x) && !n.endsWith(c.mustHave))) {
      bad(`「${c.in}」名字被截断了`, `实际 '${n}'`);
      continue;
    }
    ok(`「${c.in}」→ '${n}'`, `source=${body.source}`);
  }
}

// ── ② source 字段必须存在且合法 ──────────────────────────────
console.log("\n  === ② source 标明来源（llm / rule）===");
{
  const { body } = await suggest({ filename: "Krea2-USD-20261018_00008_.png", kind: "image" });
  if (body?.source === "llm" || body?.source === "rule") {
    ok(`source=${body.source}`);
  } else {
    bad("source 必须是 llm 或 rule", `实际 ${JSON.stringify(body?.source)}`);
  }
}

// ── ③ LLM 失败时降级，且失败原因必须暴露 ────────────────────
console.log("\n  === ③ LLM 不可用 → 降级 + 原因不掩盖 ===");
{
  const { status, body } = await suggest({ filename: "Krea2-USD-20261018_00008_.png", kind: "image" });
  if (status === 200 && body?.ok) {
    if (body.source === "llm") {
      ok("LLM 可用，直接用 AI 名", `'${body.name}'`);
    } else {
      // 降级路径 —— 必须有 llmError 说明为什么
      if (typeof body.llmError === "string" && body.llmError.length > 10) {
        ok("降级到规则名，且带 llmError", body.llmError.slice(0, 60));
      } else {
        bad("降级时必须说明 LLM 为什么失败", `llmError=${JSON.stringify(body.llmError)}`);
      }
      // ★ 关键：不能是「模型返回空文本」这种误导性错误
      if (String(body.llmError ?? "").includes("返回空文本")) {
        bad("失败原因不能是「模型返回空文本」", "那是把认证/限流失败误报成模型没说话");
      } else {
        ok("失败原因不是误导性的「返回空文本」");
      }
    }
  } else {
    bad("LLM 失败时也要返回可用的规则名", `status=${status}`);
  }
}

// ── ④ 缺 filename 必须报错（不能瞎起名）──────────────────────
console.log("\n  === ④ 缺 filename / 空 filename 要拦住 ===");
{
  for (const bad1 of [{}, { filename: "" }, { filename: "   " }]) {
    const { status, body } = await suggest({ ...bad1, kind: "image" });
    // 允许 200+ok（用 kindZh 兜底成「图片」）或 4xx/5xx，但名字不能是乱码
    if (status !== 200) { ok(`空 filename 被拒（${status}）`); continue; }
    if (body?.ok && String(body.name ?? "").trim()) {
      ok(`空 filename 用兜底名 '${body.name}'`);
    } else {
      bad("空 filename 给了空名字", JSON.stringify(body).slice(0, 120));
    }
  }
}

console.log("\n" + "═".repeat(60));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  LLM 起名 + 降级验收全过");
