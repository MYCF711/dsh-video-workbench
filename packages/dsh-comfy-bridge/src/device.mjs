/**
 * 采样本机设备状态 —— 工作台插件的 host 侧模块。
 *
 * 不属于任何其它插件；失效只影响设备监控这一块 UI。
 *
 * ★ 三处踩过的坑（2026-10-18 实测）：
 *   ① PowerShell 里的 `$cpu` / `$os` 必须用 String.raw，
 *      否则被 JS 模板插值吃掉变成空字符串，命令语法直接非法
 *   ② 整条命令必须写成【一行】，不能用数组 join("; ")
 *      —— `[pscustomobject]@{` 后面被塞进 `;` 会变成 `@{;`，hashtable 非法
 *   ③ CPU 温度取不到：Get-CimInstance MSAcpi_ThermalZoneTemperature 在本机返回
 *      「不支持」（主板不暴露 WMI 热区）⇒ 只给负载，不编造温度
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 跑命令，失败/超时都返回 null（绝不抛）。 */
async function tryExec(cmd, args, timeoutMs = 4000) {
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

/** GPU：nvidia-smi。 */
async function readGpu() {
  const out = await tryExec("nvidia-smi", [
    "--query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total",
    "--format=csv,noheader,nounits",
  ]);
  if (!out) return null;

  const line = out.trim().split(/\r?\n/)[0];
  if (!line) return null;

  const p = line.split(",").map((s) => s.trim());
  if (p.length < 5) return null;

  const temperature = Number(p[1]);
  const util = Number(p[2]);
  const used = Number(p[3]);
  const total = Number(p[4]);

  return {
    name: p[0],
    temperatureC: Number.isFinite(temperature) ? temperature : null,
    utilPct: Number.isFinite(util) ? util : null,
    vramUsedMiB: Number.isFinite(used) ? used : null,
    vramTotalMiB: Number.isFinite(total) ? total : null,
    vramPct: Number.isFinite(used) && total > 0 ? Math.round((used / total) * 100) : null,
  };
}

/** CPU 负载 + 内存。 */
async function readCpuMem() {
  // ★ 用 String.raw —— 双引号和普通反引号都会把 $cpu 当模板插值（见文件头坑①）
  const ps = String.raw`$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1; $os = Get-CimInstance Win32_OperatingSystem; [pscustomobject]@{ cpuLoad = $cpu.LoadPercentage; cpuName = $cpu.Name; memTotalKB = $os.TotalVisibleMemorySize; memFreeKB = $os.FreePhysicalMemory } | ConvertTo-Json -Compress`;

  const out = await tryExec("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps]);
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
    memPct: usedKB != null && totalKB > 0 ? Math.round((usedKB / totalKB) * 100) : null,
  };
}

/** 采一次完整快照。任何一路失败就那一路为 null。 */
export async function readDeviceSnapshot() {
  const [gpu, cpuMem] = await Promise.all([
    readGpu().catch(() => null),
    readCpuMem().catch(() => null),
  ]);

  return {
    at: Date.now(),
    gpu,
    cpu: cpuMem ? { loadPct: cpuMem.cpuLoadPct, name: cpuMem.cpuName } : null,
    mem: cpuMem
      ? { usedMiB: cpuMem.memUsedMiB, totalMiB: cpuMem.memTotalMiB, pct: cpuMem.memPct }
      : null,
  };
}
