/**
 * 公开仓库前的脱敏 —— 把机器专属标识替换成占位符。
 *
 * ★ 主人要求：建公开仓库，脱敏即可。
 *
 * ── 替换规则（保留可读性，只去掉机器指纹）
 *
 *   C:/Users/<name>                 → <HOME>      （Windows 用户名，运行时取本机登录名）
 *   <工作区>/<repo>                 → <REPO>      （仓库绝对路径）
 *   <工作区>/_upstream              → <UPSTREAM>
 *   <工作区>                        → <WORKSPACE>
 *   <密钥目录>                      → <KEYS>      （密钥目录，只留占位）
 *   <DSH 安装目录>                  → <DSH_HOME>
 *   <DSH 临时目录>                  → <TMP>
 *   192.168.x.x[:port]              → <LAN_HOST>  （内网主机）
 *   <ComfyUI 安装目录>...          → <COMFY_ROOT>...
 *   eyJ...<jwt>                     → <JWT>       （任何真凭证都不进仓库）
 *
 * ★ 顺序很重要：长串先替换，否则 `<REPO>` 会把 `<WORKSPACE>` 切坏。
 *
 * ★ 精确值（EXACT）：个人手机号 / 邮箱 / QQ。文档里换成 <PHONE>/<EMAIL>/<QQ>，
 *   代码与测试里换成假值（13800138000 / user@example.com / 100000000），
 *   这样测试仍能跑、断言仍成立。
 *
 * ★ 不动的：
 *   · 代码里的相对路径（本来就该保留）
 *   · `dsh-tok.txt` 这个【文件名】——它不含机器信息，且是文档说明的一部分
 *   · 端口 19499 / 8188 等 —— 那是产品约定，不是机器指纹
 *   · 本文件自己（SELF）—— 规则表里本来就写着这些值，扫自己会把规则改坏
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** 仓库根 = 本文件所在目录的上两级；也可用 DESENS_REPO 覆盖 */
const REPO = process.env.DESENS_REPO
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SELF = path.relative(REPO, fileURLToPath(import.meta.url)).split(path.sep).join("/");

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const USER = os.userInfo().username.replace(/[\\/]/g, "");

/** 按「长串优先」排序 */
const RULES = [
  /* 仓库路径（最长的先） */
  [/D:[\\/]主工作区[\\/]DSH视频工作台/g, "<REPO>"],
  [/D:[\\/]主工作区[\\/]DSH视频工作站/g, "<OLD_REPO>"],
  [/D:[\\/]主工作区[\\/]_upstream/g, "<UPSTREAM>"],
  /* 用户名（运行时取本机登录名，仓库里不写具体值） */
  [new RegExp(`C:[\\\\/]Users[\\\\/](?:${escapeRe(USER)}|Administrator)`, "g"), "<HOME>"],
  /* ComfyUI 安装路径 */
  [/D:[\\/]Comfy-Desktop([\\/][^\s"'`\)\]<]*)?/g, (m, rest) => "<COMFY_ROOT>" + (rest ?? "").replace(/\\/g, "/")],
  /* 剩下的一般工作区 */
  [/D:[\\/]{1,4}主工作区/gi, "<WORKSPACE>"],
  /* 其他本机目录 */
  [/D:[\\/]MyKey/g, "<KEYS>"],
  [/E:[\\/]Documents[\\/]deepseek-harness/g, "<DSH_HOME>"],
  [/D:[\\/]DSH[\\/]tmp/g, "<TMP>"],
  /* 内网服务 */
  [/192\.168\.1\.6:8888/g, "<HINDSIGHT_HOST>"],
  [/192\.168\.\d{1,3}\.\d{1,3}(?::\d+)?/g, "<LAN_HOST>"],
  /* 凭证字样 */
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g, "<JWT>"],
];

/** 精确值：个人手机号 / 邮箱 / QQ（长串先）。
 *  ★ 真值不进仓库：放在 packages/tools/.desens-exact.json（已 .gitignore），
 *    文件形如 [["18500001111","PHONE"],["someone@example.com","MAIL"],["123456789","QQ"]] */
const EXACT_FILE = path.join(REPO, "packages", "tools", ".desens-exact.json");
const EXACT = (() => {
  try {
    const raw = JSON.parse(fs.readFileSync(EXACT_FILE, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
})();
const SUB = {
  md: { MAIL: "<EMAIL>", PHONE: "<PHONE>", QQ: "<QQ>" },
  code: { MAIL: "user@example.com", PHONE: "13800138000", QQ: "100000000" },
};

/** 只扫这些扩展名（二进制跳过） */
const TEXT_EXT = /\.(md|mjs|js|cjs|ts|tsx|json|jsonc|yml|yaml|ps1|txt|html|css|patch)$/;

const files = spawnSync("git", ["-c", "core.quotepath=false", "ls-files"], {
  cwd: REPO, encoding: "utf8",
}).stdout.split("\n").filter(Boolean);

let changed = 0;
const touched = [];

for (const rel of files) {
  if (!TEXT_EXT.test(rel) || rel === SELF) continue;
  const full = path.join(REPO, rel);
  if (!fs.existsSync(full)) continue;
  let src = fs.readFileSync(full, "utf8");
  const before = src;
  const sub = /\.(md|txt)$/i.test(rel) ? SUB.md : SUB.code;
  for (const [val, kind] of EXACT) if (src.includes(val)) src = src.split(val).join(sub[kind]);
  for (const [re, rep] of RULES) src = src.replace(re, rep);
  if (src === before) continue;
  fs.writeFileSync(full, src, "utf8");
  changed += 1;
  touched.push(rel);
}

console.log(`脱敏：${changed} 个文件被改`);
for (const t of touched.slice(0, 25)) console.log(`  · ${t}`);
if (touched.length > 25) console.log(`  …还有 ${touched.length - 25} 个`);
