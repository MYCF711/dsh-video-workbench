/**
 * 设备监控 —— 工作台插件内部的一个 UI 模块。
 *
 * ★ 挂载位置（2026-10-18 三次修正后的结论）：
 *   不用 header.utilities slot（flex:0 会挤走 DSH 自己的按钮）。
 *   改成 createPortal + position:fixed，right 值【动态测量】DSH 右侧按钮容器的
 *   左边缘，贴到它左边。绝不写死 right —— 写死会把文件夹按钮盖住。
 *
 * ★ 进度样式：照抄 DSH 自己的圆环进度（_2WTFBq_track / _2WTFBq_fill）
 *   svg 14×14 / r=5.5 / stroke-width 2 / rotate(-90 7 7)
 *   track rgba(0,0,0,.12)，fill 按负载取色。
 *   实测来源：DSH 底部 29% 那个环。
 *
 * ★ 失效隔离：拿不到数据 → null；量不到位置 → null；渲染崩 → Boundary 吞。
 */

import React from "react";
import { createPortal } from "react-dom";

const { useState, useEffect, useRef } = React;
const h = React.createElement;

const PREFIX = "/comfy-bridge";
const POLL_MS = 3000;

/** DSH 风格的圆环进度。 */
function Ring({ pct, color, size = 14 }) {
  const v = Math.max(0, Math.min(100, Number(pct) || 0));
  const r = 5.5;
  const circumference = 2 * Math.PI * r;         // 34.5575…
  const dash = (v / 100) * circumference;
  const c = size / 2;

  return h("svg", {
    viewBox: `0 0 ${size} ${size}`, width: size, height: size,
    "aria-hidden": "true", style: { flex: "none", display: "block" },
  },
    h("circle", {
      cx: c, cy: c, r,
      fill: "none", stroke: "rgba(0,0,0,.12)", strokeWidth: 2,
    }),
    h("circle", {
      cx: c, cy: c, r,
      fill: "none", stroke: color, strokeWidth: 2, strokeLinecap: "round",
      strokeDasharray: `${dash} ${circumference}`,
      transform: `rotate(-90 ${c} ${c})`,
      style: { transition: "stroke-dasharray 400ms ease, stroke 200ms ease" },
    })
  );
}

/** 一项指标：环 + 标签 + 百分比。 */
function Metric({ label, pct, hint }) {
  const v = Math.round(Number(pct) || 0);
  const color = v >= 90 ? "rgb(248,81,73)"
    : v >= 70 ? "rgb(210,153,34)"
    : "rgb(129,133,140)";
  /**
   * 顺序（主人 2026-10-18）：「GPU 这种文字应该在圆形进度条左边」
   *   ⇒ 标签 → 圆环 → 百分比
   *
   * ★★ 2026-10-20 去掉温度（主人：「一个 0% 一个 36 度？不需要温度」）
   *
   *   来龙去脉：
   *     2026-10-18 想把 GPU 温度塞进环内小字（fontSize 7），
   *     2026-10-20 实测「字挤进圆环里、也变小了」⇒ 挪到环右侧。
   *     结果主人看到的是「18% 36°」两个数并排 —— 更糊涂了。
   *
   *   ⇒ 温度这个数据本身就不要。一个指标只显示一个数。
   *     CPU 温度本来也取不到（WMI 热区不支持），
   *     只给 GPU 显示温度反而不对称。
   */
  return h("span", {
    title: hint || undefined,
    style: {
      display: "inline-flex", alignItems: "center", gap: 5,
      // ★ 跟随 DSH 原生 dock 字号（12px）
      fontSize: 12, lineHeight: "20px", whiteSpace: "nowrap",
      color: "var(--dsw-alias-label-tertiary, #81817c)",
      // ★ 2026-10-19：允许被压缩，空间不够时缩而不是溢出
      flex: "0 1 auto", minWidth: 0,
    },
  },
    h("span", { style: { opacity: 0.72 } }, label),
    h(Ring, { pct: v, color }),
    h("span", {
      style: { fontVariantNumeric: "tabular-nums", minWidth: 26, textAlign: "right" },
    }, `${v}%`)
  );
}

export function DeviceMonitor() {
  const [data, setData] = useState(null);
  const timer = useRef(null);

  // ★ 不自动拉起（主人 2026-10-18：
  //   「那就加一个手动开关，不要自动拉起了，自动拉起很麻烦，
  //     用的时候把 comfyui 打开就行了」）
  //   开关在底部状态栏的 ComfyUI 那一项上，见 client.js 的 ComfyDockStatus。

  // 采样
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch(`${PREFIX}/device`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        if (alive) setData(j);
      } catch {
        if (alive) setData(null);
      }
    };
    tick();
    timer.current = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      if (timer.current) clearInterval(timer.current);
    };
  }, []);


  if (!data) return null;

  const gpu = data.gpu ?? null;
  const cpu = data.cpu ?? null;
  const mem = data.mem ?? null;
  if (!gpu && !cpu && !mem) return null;

  // ★ 顺序（主人 2026-10-18）：「cpu，圆进度条，百分比，然后是 gpu，
  //   然后是显存，然后是内存」⇒ CPU 排第一，其余按 GPU/显存/内存。
  const items = [];
  if (cpu?.loadPct != null) items.push(h(Metric, { key: "cpu", label: "CPU", pct: cpu.loadPct }));
  /**
   * ★★ 2026-10-20：温度不再显示（主人：「不需要温度」）。
   *
   *   历史：2026-10-18 想把 GPU 温度塞进环内小字 → 2026-10-20 实测
   *   「字挤进圆环里、也变小了」，挪到环右边后又变成「18% 36°」两个数并排。
   *   ⇒ 干脆不要。一个指标只显示一个数。
   *
   *   CPU 温度本来也取不到（WMI 热区不支持），只给 GPU 显示反而不对称。
   *   temperatureC 仍在 /comfy-bridge/device 的返回里（后端不改），
   *   只是 UI 不再展示 —— 以后想加回来，数据还在。
   */
  if (gpu?.utilPct != null) {
    items.push(h(Metric, {
      key: "gpu", label: "GPU", pct: gpu.utilPct,
      hint: gpu.name ? `${gpu.name}\n利用率 ${gpu.utilPct}%` : undefined,
    }));
  }
  if (gpu?.vramPct != null) items.push(h(Metric, { key: "vram", label: "显存", pct: gpu.vramPct }));
  if (mem?.pct != null) items.push(h(Metric, { key: "mem", label: "内存", pct: mem.pct }));

  if (!items.length) return null;

  const title = [
    gpu
      ? `${gpu.name}` +
        `\nGPU ${gpu.utilPct}%` +
        `  显存 ${gpu.vramUsedMiB}/${gpu.vramTotalMiB} MiB`
      : null,
    cpu ? `${cpu.name}\nCPU ${cpu.loadPct}%` : null,
    mem ? `内存 ${mem.usedMiB}/${mem.totalMiB} MiB` : null,
  ].filter(Boolean).join("\n");

  // ★ 放到 DSH 底部状态条里（主人 2026-10-18：
  //   「放在最底部也不错？最底部本来就是用来监控状态的，而且宽度应该刚好够」）
  //   实测：dock 宽 546px，现有内容只用到 x=820~1366，右边还有 546px，够用。
  //   这样它天然和 token 统计同一行，不用 fixed 定位，也不会盖任何东西。
  const dock = document.querySelector(".RlGAzG_dock");
  if (!dock) return null;

  return createPortal(
    h("div", {
      title,
      style: {
        display: "inline-flex", alignItems: "center",
        // ★ 2026-10-19 修（实测溢出）：原来 gap:10 / flex:"none"
        //   四格总宽 328px，塞进剩余空间不够的 dock ⇒ 「内存」那格
        //   超出 dock 右边缘 6px，而 dock 是 overflow:visible，
        //   于是直接画到外面被切掉。截图确认右侧确实缺了一块。
        //   实测数据：dock x=72 w=521 right=593
        //             监控父容器 x=273 w=328 right=601（超 8px）
        //             内存格 x=525 w=74 right=599（超 6px）
        //
        //   修法：
        //     ① gap 10 → 6（省 12px）
        //     ② 允许收缩（flex:"0 1 auto" + minWidth:0），
        //        空间不够时四格等比让位，而不是溢出去
        //     ③ 容器加 maxWidth:100%，让它永远不越过父容器
        gap: 6,
        height: 22, padding: "0 2px",
        flex: "0 1 auto", minWidth: 0, maxWidth: "100%",
        overflow: "hidden",
        whiteSpace: "nowrap",
        pointerEvents: "auto",
      },
    }, ...items),
    dock
  );
}

/** 渲染崩了只让这一块消失。 */
export class DeviceMonitorBoundary extends React.Component {
  constructor(p) { super(p); this.state = { dead: false }; }
  static getDerivedStateFromError() { return { dead: true }; }
  componentDidCatch(e) {
    console.warn("[device-monitor] 渲染失败，已隐藏（不影响工作台）：", e?.message ?? e);
  }
  render() { return this.state.dead ? null : this.props.children; }
}