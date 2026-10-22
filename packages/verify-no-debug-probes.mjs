/**
 * verify-no-debug-probes.mjs · 生产代码里不许留调试探针
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么要有这个脚本
 *
 * 本项目已经三次留下「临时诊断探针」：
 *   ① window.__AT_DEBUG__       （AssetLibrary.js，注释写「查完删」，没删）
 *   ② window.__CHIP_DEBUG__     （2026-10-20 诊断 chip 没缩略图，没删）
 *   ③ window.__LAST_GROUP_BIND__（2026-10-20 诊断整组引用，没删）
 *
 * 三者的共同点：诊断结束、结论已经落进验收和 AGENTS，
 * 但探针还挂在 window 上。害处是三条：
 *   ① 每次渲染/绑定都往全局写，长会话累积
 *   ② 把用户数据（资产名、用途 id、绑定内容）复制到全局变量
 *   ③ 后来读代码的人以为它有用，不敢删
 *
 * ⇒ 靠人记得删不可靠。这个脚本把「不许有」变成断言。
 *
 * ══════════════════════════════════════════════════════════════════════
 * ★ 白名单：不是所有 window.__ 都是探针
 *
 *   window.__ModuleLoader__      插件加载器入口，DSH 要求，必须留
 *   window.__DSH_BOOT__          DSH 引导，同上
 *   window.__ARTCRAFT_*__        我们自己的调试出口，但【也是探针】——
 *                                它在 dsh-entry 里，本轮不删（跑冒烟要用），
 *                                登记为「已知例外」而不是「合规」
 *   window.__egoCursorSync       ego-browser 注入的鼠标同步，不是我们的代码
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = HERE;   // 本脚本在 packages/ 下

/* 要扫的包（只扫我们自己的四个活跃包） */
const TARGET_PKG = [
  "dsh-comfy-workbench-tab",
  "dsh-artcraft-tab",
  "dsh-comfy-bridge",
];

/* 合规的全局挂载（DSH 要求 / 外部注入） */
const ALLOWED = new Set([
  "window.__ModuleLoader__",
  "window.__DSH_BOOT__",
  "window.__DSH_",
  "window.__egoCursorSync",
]);

/* 已知例外：确实是探针，但本轮保留（有意的技术债，不是遗漏）
   ★ 判据：每一处要在注释里写明「为什么还留着」和「什么时候能删」

   ★★ 范围修正（本轮踩了一次）：
     第一版把 window.__ARTCRAFT__ 系列全列进来，结果报出 18 处，
     其中大部分是【误报】：
       · lib/client.js 是压缩后的构建产物，一个物理行里挤着整个模块，
         正则会把同一行里的多个 token 都报出来，且分不清是注释还是代码
       · window.__ARTCRAFT__ 本身是【正常的功能出口】—— client 把
         ArtCraft 的 module.exports 挂上去，后续 new Function 要用它，
         这不是探针，删了功能就坏
     ⇒ 修正两条：
       ① 只扫 src/（源码），不扫 lib/（产物）。产物是 src 的镜像，
          查 src 就够了；查产物只会产生压缩噪声。
       ② 把「功能出口」与「诊断出口」分开命名：
          ARTCRAFT / ARTCRAFT_EDITOR / ARTCRAFT_HOST_RENDERED /
          ARTCRAFT_APPLY / ARTCRAFT_STEPS 是功能与冒烟需要，
          ARTCRAFT_FATAL / ARTCRAFT_RESOLVE 是诊断残留 —— 后者要清。 */
const KNOWN_EXCEPTION = new Map([
  ["window.__ARTCRAFT__",              "功能出口：client 把 ArtCraft 的 module.exports 挂这里，new Function 求值要用。删了功能坏"],
  ["window.__ARTCRAFT_EDITOR__",       "功能出口：暴露 editor 给自动化验收（verify 里查轨道数/时长用它）"],
  ["window.__ARTCRAFT_HOST_RENDERED__","冒烟标记：宿主渲染完成，execute 阶段判定用"],
  ["window.__ARTCRAFT_APPLY__",        "冒烟标记：求值阶段，判断是否走到 apply"],
  ["window.__ARTCRAFT_STEPS__",        "冒烟标记：阶段追踪，AGENTS 里用它定位挂载时序"],
  ["window.__ARTCRAFT_TRACE__",        "冒烟标记：同 STEPS"],
  ["window.__DSH_PROOF_MOUNTED__",     "冒烟标记：proof 挂载完成"],
  /**
   * ★ 2026-10-21：这是【功能实现】，不是调试探针。
   *
   *   用途：资产卡「更多操作」浮层的全局单例状态。
   *   修之前：连续点两张卡的「更多」会出现两个浮层同时挂着
   *           （实测一个在 y=603，一个在 y=1461 完全在屏幕外，第一个不消失）。
   *   根因：onDown 里 closest("[data-wb-card-more]") 会放过「另一张卡的按钮」。
   *   ⇒ 用一个全局记录「当前谁打开着」，任何卡打开时通知上一个关掉。
   *
   *   判据：这个变量保存的是那个卡的 instanceId；配套事件名 "wb:card-more-open"。
   *   验收：packages/dsh-artcraft-tab/verify-popover-singleton.mjs（11/11）
   *
   *   ★ 若将来改成不挂全局的方案（Context / zustand），
   *     改完记得同步改 verify-popover-singleton.mjs 的断言。
   */
  ["window.__WB_CARD_MORE_OPEN__",     "功能实现：资产卡浮层单例状态（不是诊断探针，见注释）"],
]);

/* 要清掉的（诊断遗留，不属例外）—— 列出来是为了让报错更明确 */
const MUST_REMOVE_HINT = {
  "window.__ARTCRAFT_FATAL__":   "诊断出口：记录 ArtCraft 求值异常。现在错误已经走 React 边界 + console，不必再挂全局",
  "window.__ARTCRAFT_RESOLVE__": "诊断出口：记录 resolveMedia 的调用轨迹。那次诊断已完成（结论：ArtCraft 不走 resolveMedia，用已注册资产表）",
  "window.__CHIP_DEBUG__":       "诊断出口：chip 缩略图诊断，2026-10-21 已删",
  "window.__LAST_GROUP_BIND__":  "诊断出口：整组引用诊断，2026-10-21 已删",
};

const findings = [];
const exceptionsUsed = [];

function scanFile(file, pkg) {
  const src = fs.readFileSync(file, "utf8");
  const lines = src.split(/\r?\n/);

  lines.forEach((line, i) => {
    // 收集形如 window.__XXX__ 的挂载
    for (const m of line.matchAll(/window\.__[A-Za-z0-9_]+/g)) {
      const token = m[0];
      if ([...ALLOWED].some((a) => token.startsWith(a) || token === a)) continue;
      if (KNOWN_EXCEPTION.has(token)) {
        exceptionsUsed.push({ token, file, line: i + 1 });
        continue;
      }
      // 注释里出现的也算 —— 因为文档化的探针同样会误导后来者，
      // 但只在该行【不是注释】时才算违规（注释说明历史可以留）
      const trimmed = line.trim();
      const isComment = trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
      if (isComment) continue;
      findings.push({ pkg, file: path.basename(file), line: i + 1, token, text: trimmed.slice(0, 80) });
    }
  });
}

function walk(dir, pkg) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      walk(p, pkg);
    } else if (/\.(js|mjs)$/.test(e.name)) {
      // ★ 跳过 .bak 与生成的 payload（payload 是 10MB base64，扫它没意义且很慢）
      if (/\.bak|_artcraft-payload|_artcraft-css/.test(e.name)) continue;
      scanFile(p, pkg);
    }
  }
}

for (const pkg of TARGET_PKG) {
  const dir = path.join(PKG, pkg);
  // ★ 只扫 src/。lib/ 是构建产物（压缩后一行可能几千字符），
  //   扫它只会产生压缩噪声；而且产物是 src 的镜像，查 src 就够。
  walk(path.join(dir, "src"), pkg);
}

/* ── 汇总 ─────────────────────────────────────────────────────── */

console.log("");
if (findings.length === 0) {
  console.log(`  ✓ 无调试探针残留（扫描 ${TARGET_PKG.length} 个包的 src/）`);
  if (exceptionsUsed.length > 0) {
    const uniq = [...new Set(exceptionsUsed.map((e) => e.token))];
    console.log(`    已知例外 ${uniq.length} 个（都是功能/冒烟必需，不是遗漏）：`);
    for (const u of uniq) console.log(`      · ${u} — ${KNOWN_EXCEPTION.get(u)}`);
  }
  process.exit(0);
}

console.log(`  ✗ 发现 ${findings.length} 处调试探针残留：\n`);
for (const f of findings) {
  console.log(`    ${f.pkg}/${f.file}:${f.line}`);
  console.log(`      ${f.token}   ${f.text}`);
  if (MUST_REMOVE_HINT[f.token]) console.log(`      为什么该删：${MUST_REMOVE_HINT[f.token]}`);
}
console.log("");
console.log("  处理方式（二选一）：");
console.log("    ① 删掉它 —— 如果那次诊断已经结束、结论已进 AGENTS 与验收");
console.log("    ② 加进本脚本的 KNOWN_EXCEPTION 并在代码注释里写明「为什么还留、什么时候能删」");
console.log("");
process.exit(1);
