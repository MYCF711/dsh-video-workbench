/**
 * ArtCraft 接入 · 端到端验证（2026-10-20）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 这一步验什么
 *
 *   前一步（verify-artcraft-adapter.mjs）只验了纯逻辑：我们的资产能转成
 *   ArtCraft 认的形状。但那还不能证明【真的能用】。
 *
 *   这一步验真实链路：
 *     ① 后端的资产库 API 真的返回了 ArtCraft 要的字段
 *     ② 我们生成的 url 真的能取到字节（不是 404 / 403）
 *     ③ 取到的字节真是媒体（PNG 有 PNG 头、MP4 有 ftyp、音频有 RIFF/ID3）
 *
 *   ★ 为什么必须验第 ③ 条：
 *     HTTP 200 不等于「拿到的是媒体」。ComfyUI 代理出错时会返回 HTML 错误页
 *     但状态码仍是 200。只看状态码会被骗。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 用法：node verify-artcraft-e2e.mjs
 * 前提：19499 测试实例在跑
 */

import { assetToSelection, handleToResolved, filterByKinds } from "./src/artcraft-adapter.mjs";

const BASE = "http://127.0.0.1:19499";
/**
 * ★ 2026-10-23 D3 去敏：token 从环境变量/约定位置读，不写死本机路径。
 *
 *   原来写的是 const TOK_FILE = 'C:/Users/<本机用户>/dsh-tok.txt';
 *   ⇒ 别人 clone 下来跑，全部失败且看不出是「路径没配」。
 *
 *   现在：DSH_TEST_TOKEN > DSH_TEST_TOKEN_FILE > $DSH_HOME/.test-token > 家目录约定
 *   拿不到就【跳过】而不是失败 —— 跳过=今天不适用，失败=功能坏了。
 */
import { TOKEN, skipWithoutToken } from "../tools/test-env.mjs";
if (!TOKEN) skipWithoutToken("verify-artcraft-e2e.mjs");

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else {
    fail++; failures.push(name);
    console.log(`  ❌ ${name}${extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 220) : ""}`);
  }
}

console.log("═".repeat(66));
console.log("  ArtCraft 接入 · 端到端");
console.log("═".repeat(66));

/* ─── 读 token 与资产库 ─────────────────────────────────── */
import fs from "node:fs";
let token = "";
try { token = TOKEN; } catch { /* 无 token 就裸请求 */ }
const HDR = token
  ? { Cookie: `dsh-auth-CK36o8O6fn6VWHrnbEp0bsjzKPKRmilHp-TBfPBH65k=${token}` }
  : {};

console.log("\n① 后端资产库 API");
let items = [];
{
  let r;
  try {
    r = await fetch(`${BASE}/comfy-assets/library?limit=300`, { headers: HDR });
  } catch (e) {
    t("资产库接口可达", false, String(e?.message ?? e).slice(0, 100));
  }
  if (r) {
    t("资产库接口可达", r.ok, `HTTP ${r.status}`);
    const j = await r.json().catch(() => null);
    t("返回 ok:true", j?.ok === true, j?.ok);
    items = j?.items ?? [];
    t("有资产（>0）", items.length > 0, items.length);

    // ArtCraft 需要的字段是否齐
    const one = items[0];
    const need = ["id", "name", "kind", "src", "rel"];
    const missing = need.filter((k) => one?.[k] === undefined);
    t("资产项带 ArtCraft 需要的全部字段", missing.length === 0, missing);
  }
}

/* ─── ② 转换成 ArtCraft 形状 ────────────────────────────── */
console.log("\n② 转换成 ArtCraft 的 MediaPickerSelection");
{
  const sels = filterByKinds(items, []);
  t("能转出条目", sels.length > 0, sels.length);

  const kinds = new Set(sels.map((s) => s.handle.kind));
  const bad = [...kinds].filter((k) => !["image", "video", "audio"].includes(k));
  t("所有 kind 都在 ArtCraft 的三种之内", bad.length === 0, [...kinds]);

  // 资产库里 text/other 应该被排除
  const total = items.length;
  t("跳过了 text/other（转换数 ≤ 总数）", sels.length <= total, { sels: sels.length, total });

  // 抽查一条：名字不能是空的
  const emptyName = sels.filter((s) => !s.name || !s.name.trim());
  t("每条都有非空 name", emptyName.length === 0, emptyName.slice(0, 3));
}

/* ─── ③ url 真能取到字节，且真的是媒体 ─────────────────── */
console.log("\n③ resolveMedia 产出的 url 真能取到媒体字节");
{
  // 每种 kind 找一条来验
  const byKind = {};
  for (const it of items) {
    if (!byKind[it.kind]) byKind[it.kind] = it;
  }

  const MAGIC = {
    // 各格式的文件头（前几字节）
    png:  [0x89, 0x50, 0x4e, 0x47],
    jpg:  [0xff, 0xd8, 0xff],
    webp: [0x52, 0x49, 0x46, 0x46],       // RIFF（webp 也是 RIFF 容器）
    gif:  [0x47, 0x49, 0x46],
    mp4:  null,                            // mp4 的 ftyp 在第 4 字节起
    webm: [0x1a, 0x45, 0xdf, 0xa3],       // EBML
    wav:  [0x52, 0x49, 0x46, 0x46],       // RIFF
    mp3:  null,                            // ID3 或 0xFFFB
  };

  for (const kind of ["image", "video", "audio"]) {
    const it = byKind[kind];
    if (!it) { console.log(`  · ${kind}: 资产库里没有，跳过`); continue; }

    const res = handleToResolved({ id: it.id, kind }, items);
    let r;
    try {
      r = await fetch(`${BASE}${res.url}`, { headers: HDR });
    } catch (e) {
      t(`${kind}: url 可达`, false, String(e?.message ?? e).slice(0, 80));
      continue;
    }
    t(`${kind}: url 可达（HTTP 200）`, r.ok, `HTTP ${r.status}`);

    const ct = String(r.headers.get("content-type") ?? "");
    t(`${kind}: Content-Type 是媒体（不是 text/html）`,
      !ct.includes("text/html"), ct);

    // 读前 16 字节验魔数
    const buf = new Uint8Array(await r.arrayBuffer());
    const head = Array.from(buf.slice(0, 16));
    const ascii = String.fromCharCode(...buf.slice(0, 16));

    let magicOk = null;
    let magicWhy = "";
    if (kind === "image") {
      const png = head.slice(0, 4).join(",") === MAGIC.png.join(",");
      const jpg = head.slice(0, 3).join(",") === MAGIC.jpg.join(",");
      const webp = ascii.startsWith("RIFF") && ascii.includes("WEBP");
      const gif = ascii.startsWith("GIF");
      magicOk = png || jpg || webp || gif;
      magicWhy = ascii.slice(0, 8);
    } else if (kind === "video") {
      const isMp4 = ascii.slice(4, 8) === "ftyp";
      const isWebm = head.slice(0, 4).join(",") === MAGIC.webm.join(",");
      const isMkv = isWebm;
      magicOk = isMp4 || isWebm || isMkv;
      magicWhy = ascii.slice(0, 12);
    } else {
      const isRiff = ascii.startsWith("RIFF");
      const isId3 = ascii.startsWith("ID3");
      const isOgg = ascii.startsWith("OggS");
      const isFlac = ascii.startsWith("fLaC");
      const isM4a = ascii.slice(4, 8) === "ftyp";
      magicOk = isRiff || isId3 || isOgg || isFlac || isM4a;
      magicWhy = ascii.slice(0, 8);
    }
    t(`${kind}: 字节头真的是该格式（不是错误页）`, magicOk === true, {
      head: magicWhy, bytes: head.slice(0, 8),
    });
  }
}

/* ─── ④ Range 支持（ArtCraft 拖时间轴要用）──────────────── */
console.log("\n④ Range 请求（ArtCraft 播视频/音频要拖进度条）");
{
  const vid = items.find((x) => x.kind === "video") || items.find((x) => x.kind === "audio");
  if (!vid) {
    console.log("  · 资产库里没有视频/音频，跳过");
  } else {
    const res = handleToResolved({ id: vid.id, kind: vid.kind }, items);
    const r = await fetch(`${BASE}${res.url}`, { headers: { ...HDR, Range: "bytes=0-99" } });
    t("支持 Range（206 Partial Content）", r.status === 206, `HTTP ${r.status}`);
    const ar = String(r.headers.get("accept-ranges") ?? "");
    t("声明 Accept-Ranges: bytes", ar.includes("bytes"), ar);
    const len = r.headers.get("content-length");
    t("返回的就是 100 字节", String(len) === "100", len);
  }
}

/* ─── 汇总 ─────────────────────────────────────────────── */
console.log("\n" + "═".repeat(66));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  ArtCraft 接入端到端全过");
