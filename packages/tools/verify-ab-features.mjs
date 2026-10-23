#!/usr/bin/env node
/**
 * A5 与 B1/B3/B4 的静态验收 —— 导入失败要显示到 UI、状态点要真是开关。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要这个
 *
 *   C2 要求「新增验收：进度条渲染、生成/停止切换、宽度首帧、
 *   导出按钮位置、导入字段」。我逐条查了覆盖情况：
 *
 *     进度条      5 处 ✅（verify-editor-console / verify-artcraft-e2e）
 *     生成/停止   1 处 ✅（verify-editor-console:817）
 *     首帧        17 处 ✅
 *     导出按钮    3 处 ✅（verify-editor-console:313/725）
 *     导入字段    0 处 ❌
 *     状态点      0 处 ❌
 *
 *   ⇒ 后两项从来没被断言过。它们都已实现（我读代码确认了），
 *     但「实现存在」和「有断言盯着」是两件事 —— 后者才防回退。
 *
 * ── 断言的对象（都已在本机读代码核实）
 *
 *   A5 导入失败要显示到 UI：
 *     ArtCraftTab.js 里 callbacks.actionError → .ac-action-error 红色错误条
 *     （注释写明：不用 alert 是因为会打断操作、不可样式化、点掉就忘）
 *
 *   B1 状态点是真开关：
 *     client.js 里 onClick 按 state.s 决定发 /comfy-bridge/stop 还是 /ensure
 *   B3 绿点点击 = 关闭（省设备损耗）
 *   B4 中间态「启动中…/关闭中…」+ 失败原因回显
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, "..");
const TAB = path.join(PKG_ROOT, "dsh-comfy-workbench-tab", "src");

let pass = 0;
const fails = [];
const check = (name, ok, detail = "") => {
  if (ok) { pass++; return; }
  fails.push({ name, detail });
};

/** 读文件；顺便剥注释，避免注释里的描述被当成实现（AGENTS §7.5）。 */
const readRaw = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "");
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

/* ══ A5：导入失败必须显示到 UI ══ */
console.log("");
console.log("[A5] 导入失败显示到 UI");
{
  const p = path.join(TAB, "editor", "ArtCraftTab.js");
  const raw = readRaw(p);
  const code = stripComments(raw);

  check("ArtCraftTab.js 存在", raw.length > 0);

  /* ① 有错误条元素（class 名在代码里，不在注释里） */
  check("有 .ac-action-error 错误条", /ac-action-error/.test(code),
    "导入失败要有一行红字，不能只 console.warn");

  /* ② 有 role=alert（无障碍：屏幕阅读器要能播报） */
  check("错误条有 role=alert", /role:\s*["']alert["']/.test(code));

  /* ③ 有可关闭按钮（不弹 alert，用可关闭的内联条） */
  check("错误条可关闭", /onDismissError/.test(code));

  /**
   * ④ + ⑤ 合并成一条：既「文案来自回调」又「有值才渲染」
   *
   * ★★ 2026-10-23 变异测试抓到的假通过：
   *
   *   原来拆成两条：
   *     ④ /callbacks\??\.actionError/          ← 太宽
   *     ⑤ /actionError\s*\n?\s*\?|if\s*\(.../  ← 与④判的是同一件事
   *
   *   变异「把 callbacks?.actionError 换成 null」后：
   *     ④ 仍然为真 —— 因为文件里别处还有 callbacks?.actionError
   *                    （onDismissError 那行附近也有）
   *     ⑤ 变红
   *   ⇒ 结果是「报错了但报的不是我以为的那条」。
   *
   *   ⇒ 合成一条：必须出现 `callbacks?.actionError` 后面紧跟三元或 if，
   *     也就是「它被用作渲染条件」这个事实本身。
   */
  check("actionError 是渲染条件的一部分（不是写死的文案）",
    /callbacks\??\.actionError\s*\)?\s*\n?\s*\?/.test(code) ||
    /if\s*\(\s*callbacks\??\.actionError\s*\)/.test(code),
    "错误条必须「有值才显示」，且文案来自回调而不是写死");
}

/* ══ B1/B3/B4：状态点开关 ══ */
console.log("");
console.log("[B1/B3/B4] ComfyUI 状态点开关");
{
  const p = path.join(TAB, "client.js");
  const raw = readRaw(p);
  const code = stripComments(raw);

  check("client.js 存在", raw.length > 0);

  /* B1：红点点击启动 */
  check("B1 关闭态点击发 /comfy-bridge/ensure", /\/comfy-bridge\/ensure/.test(code),
    "红点点击要启动 ComfyUI");
  /* B1 + B3：绿点点击关闭 */
  check("B1/B3 已连接态点击发 /comfy-bridge/stop", /\/comfy-bridge\/stop/.test(code),
    "绿点点击要关闭 —— 主人要求长时间不用能关掉省设备损耗");

  /* B1：两个 URL 由同一个三元选择（防止只实现一半） */
  check("两个动作由同一处 state.s 判定",
    /state\.s\s*===\s*["']ok["']\s*\?[^;]{0,80}stop[^;]{0,80}:[\s\S]{0,80}ensure/.test(code),
    "必须是「已连接→stop / 否则→ensure」，不能各写一处各判一次");

  /* B4：中间态文案 */
  check("B4 有「启动中…」中间态", /启动中/.test(raw),
    "点击到生效之间有 16 秒启动期，必须告诉用户在等");
  check("B4 有「关闭中…」中间态", /关闭中/.test(raw));

  /* B4：busy 期间禁用按钮（防止连点发起两次启动） */
  check("B4 有 busy 态", /busy/.test(code));
  check("B4 busy 时按钮 disabled", /disabled:\s*busy/.test(code),
    "连点会并发发起两次启动");

  /* B4：失败原因回显 */
  check("B4 失败原因回显到 hint", /setHint\(/.test(code) && /reason/.test(code),
    "失败要显示原因，不能静默");

  /* B2：启动参数完整（这条在 host 侧，检查 comfy-launcher） */
  const launcher = path.join(PKG_ROOT, "dsh-comfy-bridge", "src", "comfy-launcher.mjs");
  if (fs.existsSync(launcher)) {
    const lsrc = stripComments(fs.readFileSync(launcher, "utf8"));
    for (const arg of [
      "--listen", "--port", "--disable-auto-launch",
      "--extra-model-paths-config", "--output-directory", "--input-directory",
    ]) {
      check(`B2 启动参数含 ${arg}`, lsrc.includes(`"${arg}"`) || lsrc.includes(`'${arg}'`),
        "缺参数会导致 ComfyUI 找不到模型或输出目录错位");
    }
  }
}

/* ══ A3：--ac-follow-w 必须在 .ac-scope 自己身上，不能在 :root ══ */
console.log("");
console.log("[A3] 剪辑台首帧宽度不闪烁（CSS 变量作用域）");
{
  /**
   * ★★ 2026-10-23 实测（真机）：
   *   把 --ac-follow-w 声明在 :root 上 ⇒ 首帧 .ac-scope 顶格满宽，然后跳到 832px。
   *
   *   根因：CSS 自定义属性的 var() 在【声明所在的元素】上解析。
   *     :root 这一层没有 --dsh-composer-card-max-width（它定义在 viewArea 上），
   *     于是 var(..., 100%) 落成【字面量 100%】⇒ 首帧满宽。
   *
   *   ⇒ 断言两件事：
   *     ① 源码里不能在 :root 或 html/body 选择器上声明 --ac-follow-w
   *     ② 必须有 setProperty("--ac-follow-w", ...) 设在具体元素上
   */
  const tabSrc = path.join(PKG_ROOT, "dsh-comfy-workbench-tab", "src");

  /**
   * ★★ 2026-10-23 变异测试抓到两条假通过 —— 两处都是【路径写错】：
   *
   *   idxRaw  用的是 src/index.js，实际在 src/editor/index.js
   *   cssRaw  用的是 src/editor.css.js，实际在 src/editor/editor.css.js
   *
   *   后果：readRaw() 对不存在的文件返回 ""，
   *   于是 /setProperty\(...\)/.test("") === false、
   *        badRootDecl 也是 false，
   *   ⇒ 「不在 :root 上声明」这条【永远为真】，永远抓不到复发。
   *
   *   ⇒ 教训：读文件的断言必须先确认文件存在。
   *     文件读不到时应该【报错】而不是当成「内容为空所以没问题」。
   */
  const wbPath = path.join(tabSrc, "WorkbenchView.js");
  const idxPath = path.join(tabSrc, "editor", "index.js");
  const cssPath = path.join(tabSrc, "editor", "editor.css.js");

  check("A3 WorkbenchView.js 存在", fs.existsSync(wbPath), wbPath);
  check("A3 editor/index.js 存在", fs.existsSync(idxPath), idxPath);
  check("A3 editor/editor.css.js 存在", fs.existsSync(cssPath), cssPath);

  /* ② 必须有 setProperty 设在元素上 */
  const wbRaw = readRaw(wbPath);
  const idxRaw = readRaw(idxPath);

  /**
   * ★★ 2026-10-23 变异测试抓到的第三个假通过，也是最难发现的：
   *
   *   原断言：/setProperty\(\s*["']--ac-follow-w["']/.test(src)
   *   变异：  el.style.setProperty(...) → void 0 && el.style.setProperty(...)
   *   结果：  断言【仍为真】—— 因为那段文本还在，只是被短路了。
   *
   *   ⇒ 根本问题：我检测的是「代码里有没有这个字符串」，
   *     而不是「这行会不会被执行」。
   *
   *   ⇒ 修：要求 `el.style.setProperty("--ac-follow-w"` 这一整串出现，
   *     且【前面不能紧跟】`&&` / `||` / `if (false)` 之类的短路前缀。
   */
  const realCall = /(?<!&&\s*|(?:\|\|\s*))(?:el|scope|node)\.style\.setProperty\(\s*["']--ac-follow-w["']/;
  const anySetProp = realCall.test(wbRaw) || realCall.test(idxRaw);
  check("A3 --ac-follow-w 用 setProperty 设在具体元素上", anySetProp,
    "必须设在 .ac-scope 自己身上，不能只靠 :root 继承（也不能被短路）");

  /* ① 不能在任何 CSS 模板里对 :root/html/body 声明它 */
  const cssRaw = readRaw(cssPath);
  const cssCode = stripComments(cssRaw);
  /* 粗判：:root { ... --ac-follow-w ... } 这种块 */
  const badRootDecl = /(:root|html|body)\s*\{[^}]*--ac-follow-w\s*:/.test(cssCode);
  check("A3 不在 :root/html/body 上声明 --ac-follow-w", !badRootDecl,
    "★ 在 :root 上声明会让首帧变字面量 100% ⇒ 顶格闪烁。实测过两次。");
}

console.log("");
console.log("═".repeat(70));
console.log("  A3 首帧宽度 · A5 导入失败提示 · B1/B3/B4 状态点开关（静态）");
console.log("═".repeat(70));
console.log("");

if (fails.length === 0) {
  console.log("  ✅ 全部实现到位");
  console.log(`  通过 ${pass} / ${pass}`);
  console.log("");
  process.exit(0);
}
for (const f of fails) {
  console.log(`  ✗ ${f.name}${f.detail ? "：" + f.detail : ""}`);
}
console.log("");
console.log(`  ❌ ${pass} 通过 / ${fails.length} 失败`);
console.log(`  通过 ${pass} / ${pass + fails.length}`);
console.log("");
process.exit(1);

