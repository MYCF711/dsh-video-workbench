/**
 * dsh-device-monitor · host 侧
 *
 * 采样本机设备状态，通过 HTTP 暴露给前端。
 *
 * ★ 独立模块原则（主人 2026-10-18）：
 *   「如果这个模块失效，也不会妨碍插件的其他功能」
 *   ⇒ 每个数据源单独 try/catch，任何一个挂了只影响那一项；
 *   ⇒ 整个 apply 包在 try 里，失败只 warning 不抛；
 *   ⇒ 前端拿不到数据就整条不渲染，不占位、不报错。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const name = "dsh-device-monitor";
export const inject = ["webServer"];

const PREFIX = "/device-monitor";

/** 跑一个命令，超时/失败都返回 null（绝不抛）。 */
async function tryExec(cmd, args, timeoutMs = 3000) {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 256,
    });
    return String(stdout);
  } catch {
    return null;
  }
}

/**
 * GPU：nvidia-smi
 * 输出形如：NVIDIA GeForce RTX 5070 Ti, 37, 0 %, 8830 MiB, 16303 MiB
 */
async function readGpu() {
  const out = await tryExec("nvidia-smi", [
    "--query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total",
    "--format=csv,noheader,nounits",
  ]);
  if (!out) return null;

  const line = out.trim().split(/\r?\n/)[0];
  if (!line) return null;

  const parts = line.split(",").map((s) => s.trim());
  if (parts.length < 5) return null;

  const temperature = Number(parts[1]);
  const util = Number(parts[2]);
  const usedMiB = Number(parts[3]);
  const totalMiB = Number(parts[4]);

  return {
    name: parts[0],
    temperatureC: Number.isFinite(temperature) ? temperature : null,
    utilPct: Number.isFinite(util) ? util : null,
    vramUsedMiB: Number.isFinite(usedMiB) ? usedMiB : null,
    vramTotalMiB: Number.isFinite(totalMiB) ? totalMiB : null,
    vramPct: Number.isFinite(usedMiB) && totalMiB > 0
      ? Math.round((usedMiB / totalMiB) * 100)
      : null,
  };
}

/**
 * CPU 负载 + 内存。用 PowerShell 的 CIM，一次取齐。
 *
 * ★ CPU 温度取不到 —— 实测（2026-10-18）：
 *   Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature
 *   → 「不支持」。这块主板不暴露 WMI 热区。
 *   所以 CPU 只给负载，不给温度（不编造）。
 */
async function readCpuMem() {
  // ★ 必须用【单引号】—— 实测（2026-10-18）踩到：
  //   写成双引号时 `$cpu.LoadPercentage` 会被 JS 当模板插值，
  //   而 JS 里没有 $cpu 这个变量 → 拼出来变成空字符串
  //   → PowerShell 收到的是 "cpuLoad = .LoadPercentage" → 解析失败 → 返回 null。
  //   单引号才是字面量。
  // ★ 必须写成【一整条不换行】的 PowerShell 语句 —— 实测（2026-10-18）：
  //   用数组 join("; ") 拼时，`[pscustomobject]@{` 后面会被塞进 `;`，
  //   变成 `@{;`，hashtable 语法直接非法 → 整条命令失败。
  //   另外两个 $ 变量绝对不能用 JS 双引号（会被当模板插值吃掉）。
  // ★ 用 String.raw 保证 $ 不被任何插值吃掉（双引号和普通反引号都会吃）
  const ps = String.raw`$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1; $os = Get-CimInstance Win32_OperatingSystem; [pscustomobject]@{ cpuLoad = $cpu.LoadPercentage; cpuName = $cpu.Name; memTotalKB = $os.TotalVisibleMemorySize; memFreeKB = $os.FreePhysicalMemory } | ConvertTo-Json -Compress`;

  const out = await tryExec("powershell", [
    "-NoProfile", "-NonInteractive", "-Command", ps,
  ]);
  if (!out) return null;

  let j;
  try {
    j = JSON.parse(out.trim());
  } catch {
    return null;
  }

  const totalKB = Number(j.memTotalKB);
  const freeKB = Number(j.memFreeKB);
  const usedKB = Number.isFinite(totalKB) && Number.isFinite(freeKB) ? totalKB - freeKB : null;

  return {
    cpuLoadPct: Number.isFinite(Number(j.cpuLoad)) ? Number(j.cpuLoad) : null,
    cpuName: String(j.cpuName ?? "").trim() || null,
    memUsedMiB: usedKB != null ? Math.round(usedKB / 1024) : null,
    memTotalMiB: Number.isFinite(totalKB) ? Math.round(totalKB / 1024) : null,
    memPct: usedKB != null && totalKB > 0
      ? Math.round((usedKB / totalKB) * 100)
      : null,
  };
}

export function apply(ctx) {
  const log = ctx?.logger ?? console;

  try {
    // ★ 实测（2026-10-18）：ctx.webServer.register 接收【一个对象】
    //   { kind, path, handler }，不是 (path, handler) 两个参数。
    //   写成两参数时静默失败（路由不注册、也不报错），表现为 404。
    //   正确形态照抄 dsh-editor/src/sse.mjs:42。
    if (typeof ctx?.webServer?.register !== "function") {
      log.warn?.("[device-monitor] ctx.webServer 不可用，监控未注册");
      return;
    }
    // ★ 官方 README.zh.md 逐字：「两者返回的 disposer 都会移除注册。
    //   同一张表内的重复路径会抛错 —— route 模式是组合层约定，冲突即配置错误」
    //   ⇒ 必须保存 disposer，否则插件重载会重复注册并抛错。
    const dispose = ctx.webServer.register({
      kind: "exact",
      path: `${PREFIX}/snapshot`,
      handler: async (req, res) => {
      // 三路并行，各自失败各自返回 null
      const [gpu, cpuMem] = await Promise.all([
        readGpu().catch(() => null),
        readCpuMem().catch(() => null),
      ]);

      const body = JSON.stringify({
        at: Date.now(),
        gpu,
        cpu: cpuMem
          ? { loadPct: cpuMem.cpuLoadPct, name: cpuMem.cpuName }
          : null,
        mem: cpuMem
          ? { usedMiB: cpuMem.memUsedMiB, totalMiB: cpuMem.memTotalMiB, pct: cpuMem.memPct }
          : null,
      });

        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(body);
      },
    });

    // 交给 cordis 管理生命周期：插件卸载/重载时自动移除路由
    if (typeof ctx.effect === "function") {
      ctx.effect(() => dispose, "device-monitor: route");
    }

    log.info?.(`[device-monitor] 已注册 ${PREFIX}/snapshot`);
  } catch (err) {
    // 注册失败不影响任何其它插件
    log.warn?.(`[device-monitor] 注册路由失败（监控将不可用）：${err?.message ?? err}`);
  }
}
