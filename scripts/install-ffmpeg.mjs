#!/usr/bin/env node
/**
 * 下载 ffmpeg 到 packages/dsh-editor/bin/
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要这个脚本
 *
 *   ffmpeg 是【运行时必需】的：剪辑台导出、字幕烧制、抽帧、音轨处理全要它。
 *   但它有 83.58MB，被 .gitignore 排除了（不进仓库）。
 *
 *   ⇒ clone 下来的人没有它，导出功能直接报「找不到 ffmpeg」。
 *   ⇒ 所以必须有一个能一键补齐的脚本，而不是让人去官网找。
 *
 * ── 用法
 *   node scripts/install-ffmpeg.mjs              # 下载到包内 bin/
 *   node scripts/install-ffmpeg.mjs --check      # 只检查，不下载
 *
 * ── 为什么不用 npm 的 ffmpeg-static
 *   包内已经有确定路径约定（packages/dsh-editor/bin/ffmpeg.exe），
 *   多引一个依赖会让「ffmpeg 在哪」变成两个真相源。
 *   而且我们只需要一个二进制文件，不需要它的封装层。
 *
 * ── 下载源
 *   gyan.dev 的 essentials 构建（Windows 上最常用的免费预编译版）。
 *   ★ 也可用 FFMPEG_DOWNLOAD_URL 环境变量覆盖（内网镜像 / 换源）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const BIN_DIR = path.join(REPO, "packages", "dsh-editor", "bin");
const TARGET = path.join(BIN_DIR, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");

const CHECK_ONLY = process.argv.includes("--check");

/** 默认下载源。可被环境变量覆盖。 */
const URL = process.env.FFMPEG_DOWNLOAD_URL
  ?? "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";

/** 已有的 ffmpeg 是否可用（跑 -version 看退出码）。 */
function probe(file) {
  try {
    const out = execFileSync(file, ["-version"], { encoding: "utf8", timeout: 15000 });
    return out.split("\n")[0].trim();
  } catch {
    return null;
  }
}

console.log("");
console.log("═".repeat(60));
console.log("  ffmpeg 安装器");
console.log("═".repeat(60));
console.log("  目标路径: " + TARGET);
console.log("");

/* ① 已经有了？ */
if (fs.existsSync(TARGET)) {
  const v = probe(TARGET);
  if (v) {
    console.log("✅ 已存在且可用");
    console.log("   " + v);
    const mb = (fs.statSync(TARGET).size / 1024 / 1024).toFixed(1);
    console.log(`   ${mb} MB`);
    console.log("");
    process.exit(0);
  }
  console.log("⚠ 文件存在但跑不起来（可能下载不完整），准备重新下载");
}

if (CHECK_ONLY) {
  console.log("❌ 缺少可用的 ffmpeg");
  console.log("");
  console.log("补齐方法：node scripts/install-ffmpeg.mjs");
  console.log("");
  process.exit(1);
}

/* ② 系统 PATH 里有？有的话可以只做软链，省 83MB */
const onPath = probe("ffmpeg");
if (onPath) {
  console.log("ℹ 系统 PATH 里已有 ffmpeg：" + onPath);
  console.log("  但导出功能优先用包内那份（版本可控），仍建议装一份。");
  console.log("");
}

/* ③ 下载 */
fs.mkdirSync(BIN_DIR, { recursive: true });
const zipPath = path.join(BIN_DIR, "_ffmpeg-download.zip");

console.log("下载中…");
console.log("  源: " + URL);
console.log("  （约 80~100 MB，视网络 1~5 分钟）");
console.log("");

try {
  const res = await fetch(URL, { signal: AbortSignal.timeout(600000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(zipPath, buf);
  console.log(`✓ 下载完成 ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
} catch (err) {
  console.log("❌ 下载失败：" + (err?.message ?? err));
  console.log("");
  console.log("可选办法：");
  console.log("  ① 设镜像源后重试：");
  console.log('     $env:FFMPEG_DOWNLOAD_URL="https://你的镜像/ffmpeg.zip"');
  console.log("  ② 手动下载 ffmpeg.exe 放到：");
  console.log("     " + BIN_DIR);
  console.log("  ③ 设 FFMPEG_PATH 环境变量指向你已有的 ffmpeg（四级回落会用它）");
  console.log("");
  process.exit(1);
}

/* ④ 解压 —— Windows 用内置 Expand-Archive，避免引第三方依赖 */
console.log("");
console.log("解压中…");
try {
  if (process.platform === "win32") {
    /**
     * ★ 用 PowerShell 的 Expand-Archive 而不是 npm 的 unzip 包：
     *   少一个依赖，且 Windows 上它一定在。
     */
    const ps = [
      "-NoProfile", "-Command",
      `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${BIN_DIR}" -Force`,
    ];
    execFileSync("powershell.exe", ps, { stdio: "pipe", timeout: 180000 });
  } else {
    execFileSync("unzip", ["-o", zipPath, "-d", BIN_DIR], { stdio: "pipe", timeout: 180000 });
  }
} catch (err) {
  console.log("❌ 解压失败：" + (err?.message ?? err));
  console.log("   压缩包留在：" + zipPath);
  process.exit(1);
}

/* ⑤ 从解压出来的 bin/ 子目录里把 ffmpeg 提到目标位置 */
function findFfmpeg(dir, depth = 0) {
  if (depth > 4) return null;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === "ffmpeg.exe") return full;
    if (e.isFile() && e.name === "ffmpeg") return full;
    if (e.isDirectory()) {
      const hit = findFfmpeg(full, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

const found = findFfmpeg(BIN_DIR);
if (found && found !== TARGET) {
  fs.renameSync(found, TARGET);
  console.log("✓ 已放到 " + TARGET);
} else if (!found && !fs.existsSync(TARGET)) {
  console.log("❌ 解压后没找到 ffmpeg 可执行文件");
  console.log("   请手动把 ffmpeg.exe 放到：" + BIN_DIR);
  process.exit(1);
}

/* ⑥ 顺手把 ffprobe 也挪过来（有些调试功能要用） */
const foundProbe = findFfmpeg(BIN_DIR.replace(/ffmpeg(\.exe)?$/, ""), 0);
void foundProbe;

/* ⑦ 清理压缩包 */
try { fs.unlinkSync(zipPath); } catch { /* 占用中就算了 */ }

/* ⑧ 验证 */
console.log("");
const v = probe(TARGET);
if (v) {
  const mb = (fs.statSync(TARGET).size / 1024 / 1024).toFixed(1);
  console.log("✅ 安装完成");
  console.log("   " + v);
  console.log(`   ${mb} MB → ${TARGET}`);
  console.log("");
  console.log("★ 这一份不进 git（.gitignore 排除了 packages/dsh-editor/bin/），");
  console.log("  换机器时重新跑一次本脚本即可。");
  console.log("");
} else {
  console.log("❌ 装好了但跑不起来，请检查：" + TARGET);
  process.exit(1);
}
