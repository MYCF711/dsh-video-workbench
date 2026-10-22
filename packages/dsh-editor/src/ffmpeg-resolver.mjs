/**
 * 找到或准备 ffmpeg。
 *
 * 按优先级：
 *   1. FFMPEG_PATH 环境变量（用户显式指定）
 *   2. 插件自带的 bin/ffmpeg(.exe)（安装时下载到插件目录）
 *   3. 依赖的 ffmpeg-static（若宿主允许 postinstall）
 *   4. PATH 里的 ffmpeg
 *
 * 顺序的理由：
 *   前两项在插件自己的地盘，不受宿主安装策略影响；
 *   后两项是兜底，能跑就用。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.join(HERE, "..");
const BIN_DIR = path.join(PLUGIN_ROOT, "bin");

const IS_WIN = process.platform === "win32";
const EXE = IS_WIN ? "ffmpeg.exe" : "ffmpeg";

/** 插件自带二进制的路径。 */
export function bundledPath() {
  return path.join(BIN_DIR, EXE);
}

/** 检查一个可执行文件能不能用（跑 -version）。 */
export function canRun(bin) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const p = spawn(bin, ["-version"], { windowsHide: true });
      let out = "";
      p.stdout.on("data", (d) => { out += d.toString(); });
      p.stderr.on("data", (d) => { out += d.toString(); });
      p.on("error", () => finish({ ok: false, reason: "无法执行" }));
      p.on("close", (code) => {
        const m = /ffmpeg version (\S+)/.exec(out);
        finish({ ok: code === 0 && !!m, version: m?.[1] ?? null });
      });
      setTimeout(() => { try { p.kill(); } catch { /* ignore */ } finish({ ok: false, reason: "超时" }); }, 8000);
    } catch {
      finish({ ok: false, reason: "异常" });
    }
  });
}

/**
 * 解析 ffmpeg 路径。
 * @returns {Promise<{bin:string|null, source:string, version?:string}>}
 */
export async function resolveFfmpeg(opts = {}) {
  const log = opts.log ?? console;

  // 1. 环境变量
  const env = process.env.FFMPEG_PATH;
  if (env && fs.existsSync(env)) {
    const r = await canRun(env);
    if (r.ok) return { bin: env, source: "env", version: r.version };
    log.warn?.(`[ffmpeg] FFMPEG_PATH=${env} 无法执行，跳过`);
  }

  // 2. 插件自带
  const bundled = bundledPath();
  if (fs.existsSync(bundled)) {
    const r = await canRun(bundled);
    if (r.ok) return { bin: bundled, source: "bundled", version: r.version };
    log.warn?.(`[ffmpeg] 自带的 ${bundled} 无法执行，跳过`);
  }

  // 3. ffmpeg-static（如果宿主允许了 postinstall）
  try {
    const mod = await import("ffmpeg-static");
    const p = mod.default ?? mod;
    if (typeof p === "string" && fs.existsSync(p)) {
      const r = await canRun(p);
      if (r.ok) return { bin: p, source: "ffmpeg-static", version: r.version };
    }
  } catch { /* 没装就跳过 */ }

  // 4. PATH
  const r = await canRun("ffmpeg");
  if (r.ok) return { bin: "ffmpeg", source: "path", version: r.version };

  return { bin: null, source: "none" };
}

/**
 * 给用户看的缺失说明。
 */
export function missingHint(resolved) {
  const lines = [
    "找不到可用的 ffmpeg。",
    "",
    "三种解决方式（任选一种）：",
    `  ① 运行安装脚本，把 ffmpeg 下载到插件目录：`,
    `       node node_modules/dsh-editor/scripts/install-ffmpeg.mjs`,
    `  ② 设置环境变量指向已有的 ffmpeg：`,
    `       FFMPEG_PATH=/path/to/ffmpeg`,
    `  ③ 把 ffmpeg 放进 PATH。`,
    "",
    `插件期望的路径：${bundledPath()}`,
  ];
  if (resolved?.source && resolved.source !== "none") {
    lines.push(`（当前探测结果：${resolved.source}）`);
  }
  return lines.join("\n");
}
