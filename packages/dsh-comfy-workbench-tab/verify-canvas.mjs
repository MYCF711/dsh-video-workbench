/**
 * 画布式资产库 —— 验收脚本（M2 侧，纯前端行为 + host 代理）
 *
 * 用法：
 *   node verify-canvas.mjs                       # 默认打 19499
 *   node verify-canvas.mjs --base http://127.0.0.1:19499
 *
 * 检查的东西（对应主人四件事 / 六条验收）：
 *   1. /comfy-assets/view 代理能吐字节，且与 ComfyUI 直连的 sha256 一致
 *   2. download=1 带 Content-Disposition: attachment
 *   3. 代理拒绝路径穿越与非法的 type
 *   4. /comfy-assets/roles 能返回 nodeId → 角色 映射（这是「哪张是哪个产物」的真相源）
 *   5. 分类函数的判定符合实测文件名（node 202/220/186/174 → 一采/二采/高清重绘/SeedVR2）
 *   6. 构建产物 lib/client.js 里确实包含画布模块（防止「改了源码忘了 build」）
 *
 * ★ 前端交互（lightbox / 平移 / 缩放 / 自动弹出）没法在 node 里点 ——
 *   那部分走浏览器实测，截图在 docs/预览/_shots/。这里不假装测过。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const argOf = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const BASE = argOf("--base", "http://127.0.0.1:19499");
const COMFY = argOf("--comfy", "http://127.0.0.1:8188");
/** ★ 别用 new URL(...).pathname —— Windows 盘符与中文目录会被百分号编码。 */
const HERE = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0, skip = 0;
const ok = (name, detail = "") => { pass++; console.log(`  ✓ ${name}${detail ? "  " + detail : ""}`); };
const bad = (name, detail = "") => { fail++; console.log(`  ✗ ${name}${detail ? "  " + detail : ""}`); };
const miss = (name, why) => { skip++; console.log(`  – ${name}  （跳过：${why}）`); };

/** 找一条真实产物（从 ComfyUI history 里捞最近的 best-effort）。 */
async function pickRealOutput() {
  try {
    const r = await fetch(`${COMFY}/history?max_items=10`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const h = await r.json();
    for (const [, e] of Object.entries(h)) {
      if (e.status?.status_str !== "success") continue;
      for (const [nodeId, out] of Object.entries(e.outputs ?? {})) {
        for (const it of out.images ?? []) {
          return { nodeId, filename: it.filename, subfolder: it.subfolder ?? "", type: it.type ?? "output" };
        }
      }
    }
  } catch { /* 落到 null */ }
  return null;
}

const q = (o, withDownload) => {
  const p = new URLSearchParams({
    filename: o.filename, subfolder: o.subfolder, type: o.type,
  });
  if (withDownload) p.set("download", "1");
  return p.toString();
};

console.log(`\n=== 画布式资产库验收 ===`);
console.log(`  代理: ${BASE}/comfy-assets   ComfyUI: ${COMFY}\n`);

// ── 1/2. 代理字节一致性 + 下载头 ────────────────────────────────────
console.log("[1-2] 资产代理");
const real = await pickRealOutput();

/**
 * ★ 必须【串行】+ 重试。
 *   实测（2026-10-18）：一次性并发拉 direct / proxy / proxy-download
 *   三个请求打同一个大文件时，Node 的 undici 会报
 *   `TypeError: terminated ... SocketError: other side closed`
 *   （bytesRead 恰好卡在中间）。ComfyUI 是单线程 aiohttp，
 *   多个大图流式响应同时开着时容易把连接掐掉 —— 这是被测服务的特性，
 *   不是代理的 bug。串行 + 重试才是可信的测量方式。
 */
async function grab(url, label, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
      const b = Buffer.from(await r.arrayBuffer());
      return { r, b };
    } catch (err) {
      lastErr = err;
      await new Promise((res) => setTimeout(res, 400 * (i + 1)));
    }
  }
  throw new Error(`${label} 连续 ${tries} 次失败：${lastErr?.message}`);
}

if (!real) {
  miss("代理字节一致性", "ComfyUI history 里没有现成产物（先跑一次生成）");
  miss("下载头", "同上");
} else {
  try {
    const directUrl = `${COMFY}/api/view?${new URLSearchParams({ filename: real.filename, subfolder: real.subfolder, type: real.type })}`;
    const { r: rd, b: bd } = await grab(directUrl, "直连 ComfyUI");
    if (!rd.ok) {
      miss("代理字节一致性", `ComfyUI 直连返回 ${rd.status}`);
    } else {
      const { r: rp, b: bp } = await grab(`${BASE}/comfy-assets/view?${q(real, false)}`, "代理");
      const hd = createHash("sha256").update(bd).digest("hex");
      const hp = createHash("sha256").update(bp).digest("hex");
      if (rp.ok && hd === hp) ok("代理字节与 ComfyUI 直连一致", `${bp.length} bytes, sha256=${hp.slice(0, 16)}…`);
      else bad("代理字节与 ComfyUI 直连一致", `status=${rp.status} direct=${hd.slice(0, 8)} proxy=${hp.slice(0, 8)}`);
    }

    const { r: rdl } = await grab(`${BASE}/comfy-assets/view?${q(real, true)}`, "下载");
    const cd = rdl.headers.get("content-disposition") ?? "";
    if (rdl.ok && /^attachment;/.test(cd)) ok("download=1 返回 attachment", cd.slice(0, 60));
    else bad("download=1 返回 attachment", `status=${rdl.status} cd="${cd}"`);
  } catch (err) {
    bad("资产代理", err.message);
  }
}

// ── 3. 安全：路径穿越 / 非法 type ────────────────────────────────────
console.log("\n[3] 代理安全");
for (const [name, qs, want] of [
  ["拒绝 filename 里的 ..", "filename=..%2F..%2Fetc%2Fpasswd&type=output", 400],
  ["拒绝绝对路径", "filename=%2Fetc%2Fpasswd&type=output", 400],
  ["拒绝非法 type", "filename=x.png&type=evil", 400],
  ["拒绝空 filename", "filename=&type=output", 400],
]) {
  const r = await fetch(`${BASE}/comfy-assets/view?${qs}`, { signal: AbortSignal.timeout(8000) });
  if (r.status === want) ok(name, `→ ${r.status}`);
  else bad(name, `期望 ${want}，实际 ${r.status}`);
}

// ── 4. 角色映射 ─────────────────────────────────────────────────────
console.log("\n[4] /comfy-assets/roles");
let roles = null;
try {
  const r = await fetch(`${BASE}/comfy-assets/roles`, { signal: AbortSignal.timeout(8000) });
  roles = await r.json();
  if (roles.ok && roles.modes && Object.keys(roles.modes).length) {
    ok("返回角色映射", `工作流 ${Object.keys(roles.modes).length} 个`);
  } else {
    bad("返回角色映射", JSON.stringify(roles).slice(0, 120));
  }
} catch (err) {
  bad("返回角色映射", err.message);
}

// ── 5. 分类判定（复刻 AssetCanvas 的 classify，输入用实测数据）────────
console.log("\n[5] 来源归类（用实测文件名 + 角色表）");
const ROLE_META_LABEL = {
  image: "一采", imageTwoPass: "二采", imageUsd: "高清重绘", imageSeedvr: "SeedVR2", video: "视频",
};
const classify = (o, byNode) => {
  const nodeId = String(o.nodeId ?? "");
  const role = nodeId && byNode ? byNode[nodeId] : null;
  if (role && ROLE_META_LABEL[role]) return ROLE_META_LABEL[role];
  if (role) return role;
  if (String(o.type) === "temp") return "一采";
  if (/\.jpe?g$/i.test(o.filename)) return "附带";
  if (/mp4|webm/i.test(o.filename)) return "视频";
  return "产物";
};

const krea2Roles = roles?.modes?.krea2 ?? null;
// 实测数据（2026-10-18 直连 ComfyUI /history 取得，见 AssetCanvas.js 注释）
const samples = [
  { nodeId: "202", filename: "ComfyUI_temp_llghh_00001_.png", type: "temp", want: "一采" },
  { nodeId: "220", filename: "Krea2-2ST-20261018_00021_.png", type: "output", want: "二采" },
  { nodeId: "186", filename: "Krea2-USD-20261018_00005_.png", type: "output", want: "高清重绘" },
  { nodeId: "174", filename: "Krea2-SVR-20261018_00004_.png", type: "output", want: "SeedVR2" },
  // 实测里真出现过 node 220 的 prefix 被作者改成 zzz-renamed-220 的情况
  { nodeId: "220", filename: "zzz-renamed-220_00006_.png", type: "output", want: "二采" },
];
if (!krea2Roles) {
  miss("来源归类", "krea2 的角色表缺失（/roles 没给）");
} else {
  for (const s of samples) {
    const got = classify(s, krea2Roles);
    if (got === s.want) ok(`${s.filename} → ${got}`, `node ${s.nodeId}`);
    else bad(`${s.filename}`, `期望 ${s.want}，实际 ${got}`);
  }
}

// ── 6. 构建产物里确实有画布 ─────────────────────────────────────────
console.log("\n[6] 构建产物");
try {
  const lib = readFileSync(join(HERE, "lib", "client.js"), "utf8");
  const marks = [
    ["画布模块", /function AssetCanvas|AssetCanvas = /],
    ["来源标头条", /一采/],
    ["lightbox", /lightbox|99999/],
    ["portal 到 body", /createPortal/],
    ["下载走同源代理", /comfy-assets\/view/],
    ["角色表端点", /comfy-assets\/roles/],
    ["二采来源标记", /二采/],
  ];
  for (const [name, re] of marks) {
    if (re.test(lib)) ok(`lib/client.js 含 ${name}`);
    else bad(`lib/client.js 含 ${name}`, "—— 可能改了源码忘了 node build.mjs");
  }
  ok("lib/client.js 大小", `${(Buffer.byteLength(lib) / 1024).toFixed(1)} KB`);
} catch (err) {
  bad("读取 lib/client.js", err.message);
}

// ── 结论 ────────────────────────────────────────────────────────────
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 / ${skip} 跳过 ===`);
console.log(`\n注意：lightbox 打开/关闭、平移、缩放、生成后自动弹出属于浏览器交互，`);
console.log(`      node 里测不了 —— 那几条的证据是 docs/预览/_shots/ 下的截图 + console 读数，`);
console.log(`      不在本脚本范围内，不要当成「已验证」。\n`);
process.exit(fail ? 1 : 0);
