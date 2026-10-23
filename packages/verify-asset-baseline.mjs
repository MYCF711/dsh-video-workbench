#!/usr/bin/env node
/**
 * 资产库基线对比 —— 替代「凭印象数总数」
 *
 * 为什么有这个脚本：
 *   2026-10-21 我三次向主人报「数字对得上」，三次用的口径都不同
 *   （-File / -Recurse / API 返回），结果三次都「对上了」，
 *   实际上是和三个不同的东西比。主人问「差 3 项在哪」，我算不出来。
 *
 *   判据：「数字对得上」必须能补全成
 *        「用 <口径 X> 数出来的 A，与用 <同一口径 X> 数出来的 B 相等」。
 *        只说「对得上」而不说口径 ⇒ 等于没验。
 *
 * 用法：
 *   node verify-asset-baseline.mjs              # 与基线对比，打印差集
 *   node verify-asset-baseline.mjs --save       # 把当前状态存成新基线
 *   node verify-asset-baseline.mjs --json       # 输出 JSON（给别的脚本用）
 *
 * 退出码：
 *   0  与基线一致
 *   1  有差异（增/删都会报）
 *   2  无法取到数据（服务没起 / 鉴权失败）
 */

import fs from "node:fs";
import { TOKEN as TEST_TOKEN } from "./tools/test-env.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.resolve(HERE, "..", "docs", "基线-资产库-20261021.json");

/**
 * ★ 口径写死在这里，不允许换：
 *   POST /comfy-assets/library?limit=3000 返回的 items 数组，按 id 排序。
 *
 * 为什么不用磁盘文件数：
 *   磁盘含 VRGDG_TEMP/TextFiles/*.txt 这类中间过程文件（12 个），
 *   资产库有意不收录它们 ⇒ 两边本来就不该相等。
 *   「资产库有多少项」只有一个权威口径，就是 API 返回的 items。
 */
const LIMIT = 3000;

function getBase() {
  return process.env.COMFY_WB_BASE ?? "http://127.0.0.1:19499";
}

/**
 * ★ 2026-10-23 D3 去敏：改用 tools/test-env.mjs 的统一读取。
 *
 *   原来候选列表里写死了 C:\Users\<本机用户>\dsh-tok.txt ——
 *   它虽然也支持 DSH_TOKEN 环境变量，但默认值仍然是本机专属路径。
 */
function getToken() {
  return TEST_TOKEN ?? "";
}

async function fetchLibrary() {
  const base = getBase();
  const tok = getToken();
  const headers = {};
  if (tok) headers.Cookie = `dsh-auth-CK36o8O6fn6VWHrnbEp0bsjzKPKRmilHp-TBfPBH65k=${tok}`;
  const url = `${base}/comfy-assets/library?limit=${LIMIT}`;
  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  } catch (e) {
    return { error: `请求失败：${e?.message ?? e}` };
  }
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const j = await res.json();
  const items = Array.isArray(j?.items) ? j.items : [];
  if (!items.length) return { error: "返回 0 项（服务可能没起，或鉴权失败）" };

  const bySrc = {};
  for (const it of items) bySrc[it.src ?? "?"] = (bySrc[it.src ?? "?"] ?? 0) + 1;

  return {
    items,
    snapshot: {
      记录时间: new Date().toISOString(),
      口径: `POST ${base}/comfy-assets/library?limit=${LIMIT} 返回的 items 数组，按 id 排序`,
      总数: items.length,
      按来源: bySrc,
      ids: items.map((x) => x.id).sort(),
    },
  };
}

const argv = process.argv.slice(2);
const save = argv.includes("--save");
const asJson = argv.includes("--json");

const got = await fetchLibrary();
if (got.error) {
  console.error(`  ✗ 取不到数据：${got.error}`);
  process.exit(2);
}

const cur = got.snapshot;

if (save) {
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
  fs.writeFileSync(BASELINE, JSON.stringify(cur, null, 2), "utf8");
  console.log(`  ✓ 基线已保存：${BASELINE}`);
  console.log(`    总数 ${cur.总数}（${Object.entries(cur.按来源).map(([k, v]) => `${k} ${v}`).join(" / ")}）`);
  process.exit(0);
}

// ── 对比 ────────────────────────────────────────────────────────────
if (!fs.existsSync(BASELINE)) {
  console.error(`  ✗ 没有基线文件：${BASELINE}`);
  console.error(`    先跑一次 --save 建立基线`);
  process.exit(1);
}

const base = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
const baseIds = new Set(base.ids ?? []);
const curIds = new Set(cur.ids ?? []);

const added = [...curIds].filter((x) => !baseIds.has(x));
const removed = [...baseIds].filter((x) => !curIds.has(x));

const result = {
  基线总数: base.总数,
  当前总数: cur.总数,
  增加: added.length,
  减少: removed.length,
  增加的明细: added.slice(0, 50),
  减少的明细: removed.slice(0, 50),
};

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(added.length || removed.length ? 1 : 0);
}

console.log(`  基线：${base.总数} 项（${base.记录时间?.slice(0, 19) ?? "?"}）`);
console.log(`  当前：${cur.总数} 项`);
console.log(`  按来源：${Object.entries(cur.按来源).map(([k, v]) => `${k} ${v}`).join(" / ")}`);

if (!added.length && !removed.length) {
  console.log(`  ✅ 差集为空 —— 与基线完全一致`);
  process.exit(0);
}

/**
 * ★ 关键判断：变多 与 变少 不是同一件事。
 *
 *   变多（output 里新产物）→ 正常使用的结果，只提示
 *   变少                    → 文件消失，必须报警
 *
 *   如果再细分：新增里带 wb_ 前缀或落在 input/ 的，
 *   可能是测试残留 —— 也提示，但不当失败（因为工作台上传本来就会增加）。
 */
const suspicious = added.filter((x) => {
  // 验收脚本的副产物，AGENTS §6.37 记录过
  if (/wb_ref_image_0_(src|ok)_/.test(x)) return true;
  return false;
});

console.log("");
if (added.length) {
  console.log(`  + 新增 ${added.length} 项（正常增长，不算失败）：`);
  added.slice(0, 20).forEach((x) => console.log(`      ${x}`));
  if (added.length > 20) console.log(`      ……还有 ${added.length - 20} 项`);
  if (suspicious.length) {
    console.log(`  ⚠ 其中 ${suspicious.length} 项像验收副产物（应清理）：`);
    suspicious.slice(0, 10).forEach((x) => console.log(`      ${x}`));
  }
}
if (removed.length) {
  console.log(`  ✗ 减少 ${removed.length} 项 —— 文件消失了，这是异常：`);
  removed.slice(0, 20).forEach((x) => console.log(`      ${x}`));
  if (removed.length > 20) console.log(`      ……还有 ${removed.length - 20} 项`);
}

// ★ 只有「减少」才让验收变红。新增是使用的结果，不该挡住验收。
if (removed.length) {
  console.log(``);
  console.log(`  ❌ 有 ${removed.length} 项从资产库消失（删除 / 移动 / 扫描失败）`);
  process.exit(1);
}
console.log(``);
console.log(`  ✅ 没有减少项（新增 ${added.length} 项属正常增长）`);
console.log(`     确认这些新增没问题后，可跑 --save 更新基线`);
process.exit(0);

