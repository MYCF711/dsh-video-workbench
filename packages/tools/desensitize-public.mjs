/**
 * 公开仓库前的脱敏 —— 把机器专属标识替换成占位符。
 *
 * ★ 主人要求：建公开仓库，脱敏即可。
 *
 * ── 替换规则（保留可读性，只去掉机器指纹）
 *
 *   C:/Users/Administrator        → <HOME>            （Windows 用户名）
 *   C:\Users\Administrator        → <HOME>
 *   D:/主工作区/DSH视频工作台     → <REPO>            （仓库绝对路径）
 *   D:\主工作区\DSH视频工作台     → <REPO>
 *   D:/主工作区/DSH视频工作站     → <OLD_REPO>        （旧仓库）
 *   D:/主工作区/_upstream         → <UPSTREAM>
 *   D:\主工作区\_upstream         → <UPSTREAM>
 *   D:/主工作区                   → <WORKSPACE>
 *   D:\主工作区                   → <WORKSPACE>
 *   192.168.1.6:8888              → <HINDSIGHT_HOST> （内网记忆服务）
 *   D:\Comfy-Desktop\...          → <COMFY_ROOT>\...  （ComfyUI 安装路径）
 *   D:/Comfy-Desktop/...          → <COMFY_ROOT>/...
 *
 * ★ 顺序很重要：长串先替换，否则 `<REPO>` 会把 `<WORKSPACE>` 切坏。
 *
 * ★ 不动的：
 *   · 代码里的相对路径（本来就该保留）
 *   · `dsh-tok.txt` 这个【文件名】——它不含机器信息，且是文档说明的一部分
 *   · 端口 19499 / 8188 等 —— 那是产品约定，不是机器指纹
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REPO = "D:\\主工作区\\DSH视频工作台";

/** 按「长串优先」排序 */
const RULES = [
  /* 仓库路径（最长的先） */
  [/D:[\\/]主工作区[\\/]DSH视频工作台/g, "<REPO>"],
  [/D:[\\/]主工作区[\\/]DSH视频工作站/g, "<OLD_REPO>"],
  [/D:[\\/]主工作区[\\/]_upstream/g, "<UPSTREAM>"],
  /* 用户名 */
  [/C:[\\/]Users[\\/]Administrator/g, "<HOME>"],
  /* ComfyUI 安装路径 */
  [/D:[\\/]Comfy-Desktop([\\/][^\s"'`\)\]<]*)?/g, (m, rest) => "<COMFY_ROOT>" + (rest ?? "").replace(/\\/g, "/")],
  /* 剩下的一般工作区 */
  [/D:[\\/]主工作区/g, "<WORKSPACE>"],
  /* 内网服务 */
  [/192\.168\.1\.6:8888/g, "<HINDSIGHT_HOST>"],
];

/** 只扫这些扩展名（二进制跳过） */
const TEXT_EXT = /\.(md|mjs|js|cjs|json|jsonc|yml|yaml|ps1|txt|html|css)$/;

const files = spawnSync("git", ["-c", "core.quotepath=false", "ls-files"], {
  cwd: REPO, encoding: "utf8",
}).stdout.split("\n").filter(Boolean);

let changed = 0;
const touched = [];

for (const rel of files) {
  if (!TEXT_EXT.test(rel)) continue;
  const full = path.join(REPO, rel);
  if (!fs.existsSync(full)) continue;
  let src = fs.readFileSync(full, "utf8");
  const before = src;
  for (const [re, rep] of RULES) src = src.replace(re, rep);
  if (src === before) continue;
  fs.writeFileSync(full, src, "utf8");
  changed += 1;
  touched.push(rel);
}

console.log(`脱敏：${changed} 个文件被改`);
for (const t of touched.slice(0, 25)) console.log(`  · ${t}`);
if (touched.length > 25) console.log(`  …还有 ${touched.length - 25} 个`);
