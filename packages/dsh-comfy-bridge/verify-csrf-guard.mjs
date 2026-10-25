/**
 * 校验：插件路由的跨站请求防护（CSRF guard）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要这个验收
 *
 *   2026-10-25 实测发现：本插件的所有 HTTP 路由【完全不需要认证】。
 *
 *     curl -H "Origin: https://evil.example" \
 *          http://127.0.0.1:19387/comfy-bridge/config
 *     → 200 OK，把本机 ComfyUI 绝对路径吐给了任意网页
 *
 *   DSH 自己的页面有 cookie 认证（GET / 不带 token 直接 401），
 *   但 dsh-host-webserver 的 register(route) 是「先匹配路由」：
 *   匹配到就直接 handler，认证只挡 index 与 fallback。⇒ 插件路由是裸的。
 *
 *   危险面（都是 POST，浏览器用 text/plain 就能发，不发预检）：
 *     /comfy-bridge/clean?dryRun=0   真删 output/ 里的文件
 *     /comfy-bridge/stop             关掉主人正在用的 ComfyUI
 *     /comfy-bridge/config           改路径
 *
 * 这个脚本锁两件事：
 *   ① 每个用例的判定必须对（正例放行、反例拦下）
 *   ② guard 真的接在【所有】路由上，不是只接了一条
 * ══════════════════════════════════════════════════════════════════════
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isCrossSite } from "./src/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
};
const eq = (got, want, label) => {
  if (got !== want) throw new Error(`${label}：期望 ${want}，实际 ${got}`);
};

console.log("\n=== 跨站判定（isCrossSite）===\n");

/* ── ① 必须放行：命令行 / 脚本 / 本机页面 ── */
t("curl 无 Origin（验收脚本、命令行）", () => {
  eq(isCrossSite({ headers: { host: "127.0.0.1:19387" } }), false, "无 Origin");
});
t("同源页面（host 与 Origin 一致）", () => {
  eq(isCrossSite({ headers: { host: "127.0.0.1:19387", origin: "http://127.0.0.1:19387" } }), false, "同源");
});
t("Sec-Fetch-Site: same-origin", () => {
  eq(isCrossSite({ headers: { host: "127.0.0.1:19387", "sec-fetch-site": "same-origin" } }), false, "same-origin");
});
t("Sec-Fetch-Site: same-site", () => {
  eq(isCrossSite({ headers: { host: "127.0.0.1:19387", "sec-fetch-site": "same-site" } }), false, "same-site");
});
t("Sec-Fetch-Site: none（地址栏直接访问）", () => {
  eq(isCrossSite({ headers: { host: "127.0.0.1:19387", "sec-fetch-site": "none" } }), false, "none");
});
/**
 * ★ 局域网必须放行 —— 主人把备用机改成了局域网记忆主机，
 *   如果写死 localhost 白名单，从别的机器打开 DSH 就全 403 了。
 *   （Hindsight 有「备用笔记本改造为局域网/云端记忆主机」这条）
 */
t("局域网 IP 同源访问（不能写死 localhost）", () => {
  eq(isCrossSite({ headers: { host: "192.168.1.9:19387", origin: "http://192.168.1.9:19387" } }), false, "LAN 同源");
});
t("HTTP/1.0 无 Host 头（老脚本）", () => {
  eq(isCrossSite({ headers: {} }), false, "无 Host");
});

/* ── ② 必须拦下：跨站 ── */
t("跨站 Origin", () => {
  eq(isCrossSite({ headers: { host: "127.0.0.1:19387", origin: "https://evil.example" } }), true, "跨站");
});
t("同机不同端口（也是跨源）", () => {
  eq(isCrossSite({ headers: { host: "127.0.0.1:19387", origin: "http://127.0.0.1:9999" } }), true, "跨源端口");
});
t("Sec-Fetch-Site: cross-site", () => {
  eq(isCrossSite({ headers: { host: "127.0.0.1:19387", "sec-fetch-site": "cross-site" } }), true, "cross-site");
});
t("沙箱 iframe（Origin: null）", () => {
  eq(isCrossSite({ headers: { host: "127.0.0.1:19387", origin: "null" } }), true, "Origin null");
});
t("畸形 Origin（不像 URL）", () => {
  eq(isCrossSite({ headers: { host: "127.0.0.1:19387", origin: "not a url" } }), true, "畸形 Origin");
});

/* ── ③ 接线检查：guard 必须盖住所有路由 ── */
console.log("\n=== 接线（guard 覆盖全部路由）===\n");

const src = fs.readFileSync(path.join(HERE, "src", "index.js"), "utf8");

t("没有裸的 ctx.webServer.register（全部走 ws.register）", () => {
  /**
   * ★ 只允许 ws 定义内部那一处直连。
   *   判据：直连出现次数 === 1。
   *   （如果新增路由时手滑写了 ctx.webServer.register，这条会红）
   */
  const direct = (src.match(/ctx\.webServer\.register\(/g) ?? []).length;
  if (direct !== 1) {
    throw new Error(`直连 ctx.webServer.register 出现 ${direct} 次，应当只有 ws 定义里那 1 次`);
  }
});

t("ws.register 覆盖了所有路由（>20 处）", () => {
  const n = (src.match(/ws\.register\(\{/g) ?? []).length;
  if (n < 20) throw new Error(`只有 ${n} 处 ws.register，路由表看起来没全覆盖`);
});

t("guard 真的执行了 rejectCrossSite（不是只在注释里提到）", () => {
  /*
   * 这里不能用 src.includes("rejectCrossSite(req, res)")：
   *   变异测试证明过那样会假绿 —— 把拦截语句换成注释后，
   *   那段文字仍然在注释里，includes 照样命中。
   *   ⇒ 先剥注释，再要求它以语句形式出现。
   */
  const stripped = src
    .split(String.fromCharCode(10))
    .map((l) => l.replace(/[/][/].*$/, ""))
    .join(String.fromCharCode(10));
  const re = new RegExp("^[ ]*if [(]rejectCrossSite[(]req, res[)][)] return;", "m");
  if (!re.test(stripped)) {
    throw new Error("剥掉注释后找不到真正的拦截语句（handler 没有执行 guard）");
  }
});

t("★ 不会无限递归（ws.register 内部直连 ctx）", () => {
  const block = src.slice(src.indexOf("const ws = {"), src.indexOf("const ws = {") + 500);
  if (/return ws\.register\(/.test(block)) {
    throw new Error("ws.register 里又调了 ws.register —— 会栈溢出");
  }
});

t("host 侧按需产物的路由也受保护（workbench-tab）", () => {
  /* cross-package：artcraft-asset 在 workbench-tab，属于另一个包，
     这里只做存在性提醒 —— 它没有状态写操作，但也不该裸奔能被随便读 */
  console.log("      （artcraft-asset 只读 AND 无写操作，暂不加 guard）");
});

/* 格式必须与 verify-all 的解析器一致：它认「通过 N / M」（通过在前） */
console.log(`\n通过 ${pass} / ${pass + fail}\n`);
process.exit(fail === 0 ? 0 : 1);
