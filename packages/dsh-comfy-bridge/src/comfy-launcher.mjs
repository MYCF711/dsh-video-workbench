/**
 * ComfyUI 开关 —— M1 host 侧的模块。
 *
 * ★ 主人 2026-10-18 定下的三条原则：
 *   ① 「comfyui 是我关的，你应该自己打开 comfyui，或者插件里面要自己会打开无头 comfy ui」
 *   ② 「应该是在使用工作台时才拉起，否则正常使用 dsh 都会在后台跑一个 comfyui，
 *       对设备是无意义的损耗」
 *   ③ 「那就加一个手动开关，不要自动拉起了…开关放在状态栏的 comfyui 那里应该不错」
 *      「而且没有关闭能力，应该做成开关」
 *   ⇒ 最终形态：底部状态栏的 ComfyUI 那一项是【开关】。
 *      关 → 点 → 无头启动；开 → 点 → 关掉。不点永远不动。
 *
 * ★ 不弹黑框（主人：「我点了，会弹黑框」）
 *   Windows 上 spawn 一个 .exe 会新建控制台窗口。
 *   windowsHide:true 只对「spawn 出来的那个进程」有效，而 python.exe 是
 *   控制台子系统程序，detached 后自带控制台 ⇒ 必须用 VBS 的
 *   WScript.Shell.Run(cmd, 0, False)。0 = SW_HIDE。这是 Windows 上唯一可靠的做法。
 *
 * ★ 关闭怎么做
 *   不能用 pkill python（会误杀别的 python）。
 *   做法：启动时记下 PID（VBS 用 sh.Exec 拿 ProcessID 不方便稳定），
 *   改用【端口反查】—— 关的时候只杀占用 8188 的那个 PID，
 *   这既精确又是我们启动的那个（因为启动前确认过端口没人占）。
 *   优雅关：先试 POST /free 释放显存，再 taskkill。
 *
 * ★ 路径（实测 2026-10-18）
 *   python 必须是 ComfyUI\.venv\Scripts\python.exe
 *   —— standalone-env\python.exe 里【没有 torch】
 *   —— ComfyUI 日志逐字："Python executable: ...\ComfyUI\.venv\Scripts\python.exe"
 *
 * ★ 模型目录
 *   Comfy-Desktop 的 30 个共享模型目录原本由 Electron 启动器动态注入，不落盘。
 *   手动无头启动必须靠 extra_model_paths.yaml 复现，否则模型列表为空。
 */

import { spawn, execFile } from "node:child_process";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";

const execFileAsync = promisify(execFile);

/**
 * ★★ 2026-10-23 去敏改造：路径全部改为【可配置】，不再硬编码本机绝对路径
 *
 *   原来这里写死：
 *     const DESKTOP_ROOT = "D:\\Comfy-Desktop\\ComfyUI-Installs\\My_Comfy_UI";
 *     const SHARED_OUTPUT = "D:\\Comfy-Desktop\\ComfyUI-Shared\\output";
 *   ⇒ 换一台机器就找不到 python，开关直接失效。
 *
 * ── 现在的解析顺序（从高到低）
 *   ① 显式传入的配置（来自 DSH 插件配置 / 设置页填的路径）
 *   ② 环境变量（COMFYUI_PATH / COMFYUI_OUTPUT / COMFYUI_INPUT）
 *   ③ 本机常见的几个位置（自动探测，纯属便利，不是依赖）
 *   ④ 都没有 ⇒ resolveComfyPaths() 返回 null，调用方给出「请先在设置里填路径」
 *
 *   ★ 判据：硬编码路径是「可移植性」的头号敌人。
 *     每一处硬编码都要有对应的配置项，且默认值不能是本机专有路径。
 */

/**
 * 自动探测候选（只是便利，不是依赖）。
 *
 * ★★ 2026-10-23 去敏：不再包含「本机专有」的绝对路径。
 *   原来这里有 "D:\\Comfy-Desktop\\ComfyUI-Installs\\My_Comfy_UI" ——
 *   那是我这台机器的安装位置，写进发布代码里毫无意义，
 *   还会让别人以为「必须装在 D 盘这个位置」。
 *
 *   现在只留【通用】位置：
 *     · 盘符根常见名（ComfyUI 便携版默认解压位置）
 *     · 用户主目录
 *   本机专有路径走配置（设置页）或环境变量 COMFYUI_PATH。
 */
const COMMON_ROOTS = (() => {
  const out = [];
  /* 各盘符的常见便携版位置（Windows） */
  for (const drive of ["C:", "D:", "E:"]) {
    out.push(`${drive}\\ComfyUI`);
    out.push(`${drive}\\ComfyUI_windows_portable\\ComfyUI`);
  }
  /* 用户目录（跨平台） */
  out.push(path.join(os.homedir(), "ComfyUI"));
  out.push(path.join(os.homedir(), "comfyui"));
  out.push(path.join(os.homedir(), "Documents", "ComfyUI"));
  return out;
})();

/** 在候选根目录里找「有 ComfyUI/main.py 且 .venv 有 python」的那个。 */
function findComfyRoot(explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.COMFYUI_PATH) candidates.push(process.env.COMFYUI_PATH);
  candidates.push(...COMMON_ROOTS);

  for (const root of candidates) {
    if (!root) continue;
    /* 允许两种形状：root/ComfyUI/main.py 或 root/main.py */
    for (const sub of ["ComfyUI", ""]) {
      const mainPy = path.join(root, sub, "main.py");
      if (!existsSync(mainPy)) continue;
      const py = path.join(root, sub, ".venv", "Scripts", "python.exe");
      const pyUnix = path.join(root, sub, ".venv", "bin", "python");
      const pyExe = existsSync(py) ? py : (existsSync(pyUnix) ? pyUnix : null);
      if (pyExe) return { root, base: path.join(root, sub), pyExe, mainPy };
    }
  }
  return null;
}

/**
 * 解析全部路径。返回 null 表示「没找到可用的 ComfyUI」。
 *
 * @param {object} [opts]
 * @param {string} [opts.comfyPath]    ComfyUI 安装目录（用户填）
 * @param {string} [opts.outputDir]    输出目录
 * @param {string} [opts.inputDir]     输入目录
 */
export function resolveComfyPaths(opts = {}) {
  const found = findComfyRoot(opts.comfyPath);
  if (!found) return null;

  /**
   * 输出/输入目录：
   *   ★ 必须显式指定 —— 实测（2026-10-18）不指定时产物写到
   *     <comfy>/output，而桌面版正常启动写到一个 Shared 目录，
   *     两批文件分家，资产库会漏。
   *   ⇒ 没配置时【回落到 <comfy>/output】，行为可预期，
   *     而不是猜一个本机专有路径。
   */
  const outputDir = opts.outputDir
    ?? process.env.COMFYUI_OUTPUT
    ?? path.join(found.base, "output");
  const inputDir = opts.inputDir
    ?? process.env.COMFYUI_INPUT
    ?? path.join(found.base, "input");

  /* extra_model_paths.yaml 是可选的 —— 存在才传 */
  const yamlCandidates = [
    path.join(found.root, "extra_model_paths.yaml"),
    path.join(path.dirname(found.root), "extra_model_paths.yaml"),
  ];
  const extraYaml = yamlCandidates.find((p) => existsSync(p)) ?? null;

  return {
    root: found.root,
    pyExe: found.pyExe,
    mainPy: found.mainPy,
    outputDir,
    inputDir,
    extraYaml,
  };
}

/** 探活。 */
export async function probe(base, timeoutMs = 2500) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(`${base.replace(/\/+$/, "")}/system_stats`, { signal: ac.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

// ── 单例 + 冷却 ────────────────────────────────────────────────
let inflight = null;
let lastFailAt = 0;
const FAIL_COOLDOWN_MS = 3 * 60 * 1000;

/**
 * 拉起 ComfyUI（无头、无窗口）。
 * @returns {Promise<{ok:boolean, started:boolean, reason:string}>}
 */
export async function ensureComfy(opts) {
  const { base, log = console, waitMs = 180_000 } = opts;
  const port = opts.port ?? Number(new URL(base).port || 8188);

  if (await probe(base)) {
    return { ok: true, started: false, reason: "已在运行" };
  }

  const coolLeft = FAIL_COOLDOWN_MS - (Date.now() - lastFailAt);
  if (lastFailAt && coolLeft > 0) {
    return {
      ok: false, started: false,
      reason: `失败冷却中，${Math.round(coolLeft / 1000)} 秒后可重试`,
    };
  }

  if (inflight) return inflight;

  /**
   * ★ 2026-10-23：路径在这里解析一次，传给 doStart。
   *   解析不到时 doStart 会返回 needSetup: true，前端据此引导用户去设置页。
   */
  const paths = resolveComfyPaths({
    comfyPath: opts.comfyPath,
    outputDir: opts.outputDir,
    inputDir: opts.inputDir,
  });

  inflight = doStart({ base, port, log, waitMs, paths })
    .finally(() => { inflight = null; });
  return inflight;
}

/** 用 VBS 静默启动（不弹黑框）。 */
function launchHidden(pyExe, args, cwd) {
  const vbsPath = path.join(os.tmpdir(), `comfy-launch-${Date.now()}.vbs`);
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const cmdLine = [q(pyExe), ...args.map(q)].join(" ");

  const vbs = [
    'Set sh = CreateObject("WScript.Shell")',
    `sh.CurrentDirectory = ${q(cwd)}`,
    `sh.Run ${q(cmdLine)}, 0, False`,
  ].join("\r\n");

  writeFileSync(vbsPath, vbs, "utf8");

  const child = spawn("wscript.exe", [vbsPath], {
    detached: true, stdio: "ignore", windowsHide: true,
  });
  child.unref();

  setTimeout(() => { try { unlinkSync(vbsPath); } catch { /* 占用中 */ } }, 5000);
}

async function doStart({ base, port, log, waitMs, paths }) {
  /**
   * ★★ 2026-10-23：路径全部来自 resolveComfyPaths()，不再读模块级硬编码常量。
   *
   *   原来的 doStart 直接用 DESKTOP_PY / DESKTOP_MAIN / EXTRA_YAML 这些常量，
   *   它们写死了本机路径 ⇒ 换机器必失效。
   *   ⇒ 现在由 ensureComfy 解析好后传进来。
   *
   *   解析不到时给出【可操作】的错误，不是「找不到 python: D:\...」。
   */
  const p = paths;
  if (!p) {
    const reason = "没找到 ComfyUI 安装目录。请在设置里填写 ComfyUI 路径（含 main.py 与 .venv 的目录），或设置环境变量 COMFYUI_PATH。"
    log.warn?.(`[comfy-launcher] ${reason}`);
    lastFailAt = Date.now();
    return { ok: false, started: false, reason, needSetup: true };
  }
  if (!existsSync(p.pyExe)) {
    const reason = `ComfyUI 目录里找不到 python：${p.pyExe}（期望在 .venv/Scripts 下）`;
    log.warn?.(`[comfy-launcher] ${reason}`);
    lastFailAt = Date.now();
    return { ok: false, started: false, reason, needSetup: true };
  }
  if (!existsSync(p.mainPy)) {
    const reason = `ComfyUI 目录里找不到 main.py：${p.mainPy}`;
    log.warn?.(`[comfy-launcher] ${reason}`);
    lastFailAt = Date.now();
    return { ok: false, started: false, reason, needSetup: true };
  }

  const args = [
    p.mainPy,
    "--listen", "127.0.0.1",
    "--port", String(port),
    "--disable-auto-launch",
  ];
  if (p.extraYaml) {
    args.push("--extra-model-paths-config", p.extraYaml);
  }
  /**
   * ★ 产物/上传目录必须显式传（实测 2026-10-18）：
   *   不传时写到 <comfy>/output，而桌面版正常启动写 Shared 目录，
   *   两批文件分家，资产库会漏。
   */
  if (existsSync(p.outputDir)) {
    args.push("--output-directory", p.outputDir);
  }
  if (existsSync(p.inputDir)) {
    args.push("--input-directory", p.inputDir);
  }

  log.info?.(`[comfy-launcher] 启动 ComfyUI（无头无窗口，port=${port}）`);
  log.info?.(`[comfy-launcher]   python: ${p.pyExe}`);
  log.info?.(`[comfy-launcher]   output: ${p.outputDir}`);

  try {
    launchHidden(p.pyExe, args, path.dirname(p.mainPy));
  } catch (err) {
    const reason = `启动失败：${err?.message ?? err}`;
    log.warn?.(`[comfy-launcher] ${reason}`);
    lastFailAt = Date.now();
    return { ok: false, started: false, reason };
  }

  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    await new Promise((r) => setTimeout(r, 2000));
    if (await probe(base, 2000)) {
      const secs = Math.round((Date.now() - t0) / 1000);
      log.info?.(`[comfy-launcher] ComfyUI 就绪，用时 ${secs}s`);
      return { ok: true, started: true, reason: `已启动（${secs}s）` };
    }
  }

  const reason = `启动后 ${Math.round(waitMs / 1000)} 秒仍未就绪`;
  log.warn?.(`[comfy-launcher] ${reason}`);
  lastFailAt = Date.now();
  return { ok: false, started: true, reason };
}

/** 用端口反查 PID —— 只杀占用该端口的进程，绝不误杀别的 python。 */
async function findPidByPort(port) {
  try {
    const { stdout } = await execFileAsync(
      "netstat", ["-ano"],
      { timeout: 5000, windowsHide: true, maxBuffer: 1024 * 512 }
    );
    for (const line of String(stdout).split(/\r?\n/)) {
      if (!line.includes(`:${port}`) || !line.includes("LISTENING")) continue;
      const parts = line.trim().split(/\s+/);
      const pid = Number(parts[parts.length - 1]);
      if (Number.isFinite(pid) && pid > 0) return pid;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * 关掉 ComfyUI。
 * 只杀 8188 的占用者；先试 /free 释放显存再 taskkill。
 * @returns {Promise<{ok:boolean, stopped:boolean, reason:string}>}
 */
export async function stopComfy(opts) {
  const { base, log = console } = opts;
  const port = opts.port ?? Number(new URL(base).port || 8188);

  // 先礼貌地让它释放显存（不是必须，但能让显存立刻回来）
  try {
    await fetch(`${base.replace(/\/+$/, "")}/free`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      signal: AbortSignal.timeout(3000),
    });
  } catch { /* 可能已经挂了 */ }

  const pid = await findPidByPort(port);
  if (!pid) {
    return { ok: true, stopped: false, reason: "本来就没在运行" };
  }

  try {
    await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      timeout: 8000, windowsHide: true,
    });
    log.info?.(`[comfy-launcher] 已关闭 ComfyUI（PID ${pid}）`);
    // 等端口真的释放
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (!(await findPidByPort(port))) break;
    }
    return { ok: true, stopped: true, reason: `已关闭（PID ${pid}）` };
  } catch (err) {
    const reason = `关闭失败：${err?.message ?? err}`;
    log.warn?.(`[comfy-launcher] ${reason}`);
    return { ok: false, stopped: false, reason };
  }
}

/** 供状态查询。 */
export function launcherState() {
  const coolLeft = lastFailAt
    ? Math.max(0, Math.round((FAIL_COOLDOWN_MS - (Date.now() - lastFailAt)) / 1000))
    : 0;
  return {
    starting: inflight != null,
    lastFailAgoSec: lastFailAt ? Math.round((Date.now() - lastFailAt) / 1000) : null,
    cooldownLeftSec: coolLeft,
  };
}
