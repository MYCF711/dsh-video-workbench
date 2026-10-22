#!/usr/bin/env node
/**
 * 把 ffmpeg 下载到插件自己的 bin/ 目录。
 *
 * 为什么不用 ffmpeg-static：
 *   它的二进制靠 postinstall 下载，而宿主（DSH/pnpm）默认禁止执行
 *   依赖的 install 脚本，装了也拿不到二进制。
 *   本脚本由用户显式执行，不受该策略限制。
 *
 * 用法：
 *   node scripts/install-ffmpeg.mjs            # 自动选平台
 *   node scripts/install-ffmpeg.mjs --force    # 覆盖已存在的
 *   FFMPEG_MIRROR=https://... node scripts/install-ffmpeg.mjs
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.join(HERE, "..");
const BIN_DIR = path.join(PLUGIN_ROOT, "bin");
const IS_WIN = process.platform === "win32";
const EXE = IS_WIN ? "ffmpeg.exe" : "ffmpeg";
const TARGET = path.join(BIN_DIR, EXE);
const FORCE = process.argv.includes("--force");

/**
 * 下载源。按可达性排序：国内镜像优先，GitHub 兜底。
 * 都指向静态构建，解压即用。
 */
function sources() {
  const custom = process.env.FFMPEG_MIRROR;
  const list = [];

  if (custom) {
    list.push({
      name: `自定义镜像 ${custom}`,
      url: `${custom.replace(/\/+$/, "")}/${archiveName()}`,
      kind: "zip",
      inner: innerPattern(),
    });
  }

  if (IS_WIN) {
    // npmmirror 镜像（国内可达）
    list.push({
      name: "npmmirror",
      url: "https://registry.npmmirror.com/-/binary/ffmpeg-static/ffmpeg-master-latest-win64-gpl.zip",
      kind: "zip",
      inner: /ffmpeg-master-latest-win64-gpl\/bin\/ffmpeg\.exe$/,
    });
    // GitHub 源（境外可达时更快）
    list.push({
      name: "BtbN GitHub",
      url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
      kind: "zip",
      inner: /ffmpeg-master-latest-win64-gpl\/bin\/ffmpeg\.exe$/,
    });
  } else if (process.platform === "darwin") {
    list.push({
      name: "evermeet macOS",
      url: "https://evermeet.cx/ffmpeg/getrelease/zip",
      kind: "zip",
      inner: /ffmpeg$/,
    });
  } else {
    list.push({
      name: "johnvansickle linux64",
      url: "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz",
      kind: "tarxz",
      inner: /ffmpeg-\d+\.\d+.*-amd64-static\/ffmpeg$/,
    });
  }

  // 最后一条兜底：从本机 Python 环境里复制（很多机器装了 ComfyUI/imageio_ffmpeg）
  list.push({ name: "本机 Python 环境", kind: "local" });
  return list;
}

function archiveName() {
  if (IS_WIN) return "ffmpeg-master-latest-win64-gpl.zip";
  if (process.platform === "darwin") return "ffmpeg.zip";
  return "ffmpeg-release-amd64-static.tar.xz";
}

function innerPattern() {
  if (IS_WIN) return /ffmpeg-master-latest-win64-gpl\/bin\/ffmpeg\.exe$/;
  if (process.platform === "darwin") return /ffmpeg$/;
  return /ffmpeg-\d+\.\d+.*-amd64-static\/ffmpeg$/;
}

/** 从本机 Python 环境找现成的 ffmpeg 并复制过来。 */
function fromLocalPython() {
  const candidates = [];
  const envs = [process.env.PYTHON_HOME, process.env.CONDA_PREFIX, process.env.VIRTUAL_ENV, process.env.COMFYUI_PATH];
  for (const e of envs) if (e) candidates.push(e);

  // 常见安装位置
  candidates.push("C:/Python312", "C:/Python311", "C:/Python310");

  for (const base of candidates) {
    if (!base || !fs.existsSync(base)) continue;
    const dirs = [
      path.join(base, "Lib/site-packages/imageio_ffmpeg/binaries"),
      path.join(base, ".venv/Lib/site-packages/imageio_ffmpeg/binaries"),
      path.join(base, "venv/Lib/site-packages/imageio_ffmpeg/binaries"),
    ];
    for (const d of dirs) {
      try {
        if (!fs.existsSync(d)) continue;
        const hit = fs.readdirSync(d).find((n) => /^ffmpeg.*\.exe$|^ffmpeg$/.test(n));
        if (!hit) continue;
        return path.join(d, hit);
      } catch { /* continue */ }
    }
  }
  return null;
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  const chunks = [];
  let got = 0;
  let lastPct = -1;

  for await (const chunk of res.body) {
    chunks.push(chunk);
    got += chunk.length;
    if (total > 0) {
      const pct = Math.floor((got / total) * 100);
      if (pct >= lastPct + 10) {
        lastPct = pct;
        process.stdout.write(`\r    下载中 ${pct}%  (${(got / 1024 / 1024).toFixed(1)}/${(total / 1024 / 1024).toFixed(1)} MB)`);
      }
    }
  }
  process.stdout.write("\r" + " ".repeat(60) + "\r");
  const buf = Buffer.concat(chunks);
  if (buf.length === 0) throw new Error("下载到 0 字节");
  fs.writeFileSync(dest, buf);
  return buf.length;
}

/** 从压缩包里抽出 ffmpeg 可执行文件。 */
function extract(archivePath, kind, innerPattern, outPath) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-ffmpeg-"));
  try {
    if (kind === "zip") {
      if (IS_WIN) {
        // Windows 自带 Expand-Archive，但用 tar 更稳（Win10+ 内置 bsdtar）
        execFileSync("tar", ["-xf", archivePath, "-C", work], { stdio: "pipe" });
      } else {
        execFileSync("unzip", ["-o", archivePath, "-d", work], { stdio: "pipe" });
      }
    } else if (kind === "tarxz") {
      execFileSync("tar", ["-xJf", archivePath, "-C", work], { stdio: "pipe" });
    }

    // 在解出的树里找目标
    const found = [];
    const walk = (d) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (innerPattern.test(full.replace(/\\/g, "/"))) found.push(full);
      }
    };
    walk(work);

    if (found.length === 0) throw new Error("压缩包里没找到 ffmpeg 可执行文件");
    fs.copyFileSync(found[0], outPath);
    if (!IS_WIN) fs.chmodSync(outPath, 0o755);
    return found[0];
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function verify(bin) {
  try {
    const out = execFileSync(bin, ["-version"], { encoding: "utf8", timeout: 15000 });
    const m = /ffmpeg version (\S+)/.exec(out);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

async function main() {
  console.log(`  ffmpeg 安装脚本`);
  console.log(`  平台 ${process.platform}/${os.arch()}`);
  console.log(`  目标 ${TARGET}`);

  if (fs.existsSync(TARGET) && !FORCE) {
    const v = verify(TARGET);
    if (v) {
      console.log(`  ✓ 已存在（${v}），跳过。要覆盖请加 --force`);
      return;
    }
  }

  if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });

  const archivePath = path.join(os.tmpdir(), `dsh-ffmpeg-${Date.now()}${IS_WIN ? ".zip" : ""}`);
  let lastErr = null;

  for (const src of sources()) {
    try {
      console.log(`\n  尝试 ${src.name}`);

      if (src.kind === "local") {
        const hit = fromLocalPython();
        if (!hit) { console.log(`    未找到`); continue; }
        fs.copyFileSync(hit, TARGET);
        if (!IS_WIN) fs.chmodSync(TARGET, 0o755);
        const v = verify(TARGET);
        if (!v) throw new Error("复制过来的文件无法执行");
        console.log(`  ✓ 从 ${hit} 复制，版本 ${v}`);
        return;
      }

      const bytes = await download(src.url, archivePath);
      console.log(`    已下载 ${(bytes / 1024 / 1024).toFixed(1)} MB`);
      console.log(`    解压…`);
      extract(archivePath, src.kind, src.inner, TARGET);
      const v = verify(TARGET);
      if (!v) throw new Error("解出的文件无法执行");
      console.log(`  ✓ 安装完成，版本 ${v}`);
      fs.rmSync(archivePath, { force: true });
      return;
    } catch (err) {
      lastErr = err;
      console.log(`    ✗ ${err.message}`);
      try { fs.rmSync(archivePath, { force: true }); } catch { /* ignore */ }
    }
  }

  console.error(`\n  全部下载源都失败：${lastErr?.message ?? "未知"}`);
  console.error(`  可以手动下载 ffmpeg 并放到：${TARGET}`);
  process.exit(1);
}

main().catch((e) => {
  console.error(`  ✗ ${e.message}`);
  process.exit(1);
});
