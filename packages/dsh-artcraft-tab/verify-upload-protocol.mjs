/**
 * verify-upload-protocol.mjs · 上传协议必须与服务端一致
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么有这个脚本
 *
 * 主人报：「这两个还是导入不了本地的视频」。
 *
 * 根因（2026-10-21 实测）：协议不匹配，两端各自都正确：
 *   适配器（dsh-artcraft-tab/src/adapters.js:uploadLocalFile）
 *     发 multipart/form-data：
 *       const fd = new FormData(); fd.append("file", file);
 *       fetch("/comfy-assets/upload", { body: fd })
 *   服务端（dsh-comfy-workbench-tab/lib/index.js:1288-1304）
 *     只接受 JSON：
 *       body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
 *       catch { return json(res, 400, { error: "请求体不是合法 JSON" }) }
 *       const filename = String(body.filename ?? "").trim();
 *       const base64 = String(body.base64 ?? "");
 *   ⇒ FormData 被当成「不合法 JSON」打回 400。
 *
 * 实测对照（同一个 1×1 PNG）：
 *   multipart/form-data  → 400 {"error":"请求体不是合法 JSON"}
 *   application/json     → 200 {"ok":true,"id":"input:wb_probe-json_xxx.png",...}
 *
 * ══════════════════════════════════════════════════════════════════════
 * 这个脚本检查什么（静态）
 *
 *   ① 两个 uploadLocalFile 实现都发 JSON，不再用 FormData
 *   ② 都按【扁平响应】取 id（j.id），不是 j.item.id
 *   ③ 服务端那条路由仍然只解析 JSON（防止有人把它改成 multipart 而适配器没跟）
 *
 * ★ 它不能验证「真的传上去了」——那要活实例。运行时验证见
 *   docs/进度-明日待看-20261021.md 里的实测记录。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// ★ 本脚本在 packages/dsh-artcraft-tab/ 下，
//   而它要检查的另一个包在 packages/dsh-comfy-workbench-tab/。
//   第一版写成 path.join(HERE, "dsh-artcraft-tab", ...) —— HERE 已经是
//   dsh-artcraft-tab 目录，导致路径多套一层。用 PKG 作为 packages 根。
const PKG_ROOT = path.dirname(HERE);

let pass = 0;
const fails = [];
const check = (name, ok, detail = "") => {
  if (ok) { pass++; return; }
  fails.push({ name, detail });
};

/* 两个客户端实现 + 一个服务端实现 */
const CLIENTS = [
  {
    label: "dsh-artcraft-tab / adapters.js",
    path: path.join(HERE, "src", "adapters.js"),
  },
  {
    label: "dsh-comfy-workbench-tab / artcraft-wire.mjs",
    path: path.join(PKG_ROOT, "dsh-comfy-workbench-tab", "src", "artcraft-wire.mjs"),
  },
];
const SERVER = path.join(PKG_ROOT, "dsh-comfy-workbench-tab", "lib", "index.js");

/* ── ① 客户端必须发 JSON ─────────────────────────────────────── */

for (const c of CLIENTS) {
  if (!fs.existsSync(c.path)) {
    check(`${c.label} 存在`, false, c.path);
    continue;
  }
  const src = fs.readFileSync(c.path, "utf8");

  // 取 uploadLocalFile 函数体
  const idx = src.indexOf("async uploadLocalFile");
  check(`${c.label} 有 uploadLocalFile`, idx >= 0);
  if (idx < 0) continue;
  const body = src.slice(idx, idx + 3000);

  check(`${c.label} 不再用 FormData`,
    !/new FormData\(\)/.test(body),
    "FormData 会被服务端当成「不合法 JSON」打回 400");

  check(`${c.label} 发 Content-Type: application/json`,
    /"Content-Type":\s*"application\/json"/.test(body),
    "缺这个头，服务端按 JSON.parse 失败");

  check(`${c.label} 请求体含 filename 与 base64`,
    /filename:/.test(body) && /base64/.test(body),
    "服务端只认 { filename, base64 } 两个字段");

  check(`${c.label} 按扁平响应取 id（j.id），不是 j.item.id`,
    /j\.id\s*\?\?/.test(body) || /\bj\.id\b/.test(body),
    "实测响应是扁平的：{ok, id, absPath, filename, sizeBytes}，没有嵌套 item");

  check(`${c.label} 有大小上限保护`,
    /MAX_BYTES/.test(body) || /file\.size\s*>/.test(body),
    "base64 会膨胀 1/3，超限应给明确提示而不是等 413");
}

/* ── ② 服务端仍按 JSON 解析 ──────────────────────────────────── */

if (fs.existsSync(SERVER)) {
  const srv = fs.readFileSync(SERVER, "utf8");
  const upIdx = srv.indexOf('prefix + "/upload"');
  check("服务端有 /upload 路由", upIdx >= 0);
  if (upIdx >= 0) {
    // ★ 窗口给到 6000：实测服务端那条 handler 有大小校验、扩展名白名单、
    //   文件名清洗、落盘、返回 JSON 六大段，2500 字符只覆盖到一半，
    //   会把「返回扁平结构」误判成失败。
    const upBody = srv.slice(upIdx, upIdx + 6000);
    check("服务端用 JSON.parse 解析请求体",
      /JSON\.parse\(/.test(upBody),
      "如果改成 multipart，客户端也要跟着改");
    check("服务端读 body.filename / body.base64",
      /body\.filename/.test(upBody) && /body\.base64/.test(upBody));
    check("服务端返回扁平结构（顶层 id）",
      /\bid:\s*\`?input:|\bid:\s*String\(|\{\s*ok:\s*true/.test(upBody),
      "客户端按扁平结构取 id（j.id），不是 j.item.id");
  }
} else {
  check("找到服务端 lib/index.js", false, SERVER);
}

/* ── 汇总 ─────────────────────────────────────────────────────── */

const total = pass + fails.length;
console.log("");
if (fails.length === 0) {
  console.log(`  ✓ upload-protocol  ${pass}/${total} 全过`);
  console.log("");
  console.log("  ⚠ 本脚本验的是协议约定，不是真的传上去了。");
  console.log("    运行时实测记录（2026-10-21）：");
  console.log("      JSON+base64 → 200 {ok:true, id:\"input:wb_verify-upload_xxx.png\"}");
  process.exit(0);
}
console.log(`  ✗ upload-protocol  ${pass}/${total}，失败 ${fails.length} 项：`);
for (const f of fails) console.log(`      · ${f.name}${f.detail ? `\n        ${f.detail}` : ""}`);
process.exit(1);
