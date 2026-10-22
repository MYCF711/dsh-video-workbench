/**
 * dsh-device-monitor · client 侧
 *
 * 挂在抬头栏右上角 [conversation.session.header.utilities] 里的一行设备监控。
 *
 * ★ 失效隔离（主人 2026-10-18）：
 *   「如果这个模块失效，也不会妨碍插件的其他功能」
 *   ① 整个 apply 包 try/catch，注册失败只 console.warn
 *   ② 组件内部三态：无数据 → 不渲染（返回 null），不占位不报错
 *   ③ 轮询失败静默重试，不抛
 *   ④ 用 ErrorBoundary 包住，渲染崩了也只是这一块消失
 */

import React from "react";

const { useState, useEffect, useRef } = React;
const h = React.createElement;

const PREFIX = "/device-monitor";
const POLL_MS = 3000;

/** 一条细进度条。 */
function Bar({ pct, color, width = 34 }) {
  const v = Math.max(0, Math.min(100, Number(pct) || 0));
  return h("span", {
    style: {
      display: "inline-block", width, height: 4, borderRadius: 2,
      background: "var(--dsw-alias-border-l2, #0000001a)",
      position: "relative", overflow: "hidden", flex: "none",
      verticalAlign: "middle",
    },
  },
    h("span", {
      style: {
        position: "absolute", left: 0, top: 0, bottom: 0,
        width: `${v}%`, background: color,
        borderRadius: 2, transition: "width 400ms ease",
      },
    })
  );
}

/** 一项指标：图标/标签 + 数值 + 进度条。 */
function Metric({ label, text, pct, color, title }) {
  return h("span", {
    title,
    style: {
      display: "inline-flex", alignItems: "center", gap: 4,
      fontSize: 11, lineHeight: "18px", whiteSpace: "nowrap",
      color: "var(--dsw-alias-label-tertiary, #81858c)",
    },
  },
    h("span", { style: { opacity: 0.75 } }, label),
    h("span", { style: { fontVariantNumeric: "tabular-nums" } }, text),
    pct != null ? h(Bar, { pct, color }) : null
  );
}

/** 温度取色：冷→绿，温→琥珀，热→红。 */
function tempColor(c) {
  if (c == null) return "var(--dsw-alias-label-tertiary, #81858c)";
  if (c >= 80) return "rgb(248,81,73)";
  if (c >= 70) return "rgb(210,153,34)";
  return "rgb(63,185,80)";
}

function DeviceMonitor() {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    let alive = true;

    const tick = async () => {
      try {
        const res = await fetch(`${PREFIX}/snapshot`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        if (!alive) return;
        setData(j);
        setFailed(false);
      } catch {
        if (!alive) return;
        // 静默失败：不报错、不占位
        setFailed(true);
      }
    };

    tick();
    timer.current = setInterval(tick, POLL_MS);

    return () => {
      alive = false;
      if (timer.current) clearInterval(timer.current);
    };
  }, []);

  // ★ 拿不到任何数据 → 整条不渲染
  const gpu = data?.gpu ?? null;
  const cpu = data?.cpu ?? null;
  const mem = data?.mem ?? null;
  if (!gpu && !cpu && !mem) return null;

  const items = [];

  if (gpu) {
    if (gpu.temperatureC != null) {
      items.push(h(Metric, {
        key: "gtemp",
        label: "GPU",
        text: `${gpu.temperatureC}°`,
        pct: null,
        color: tempColor(gpu.temperatureC),
        title: `${gpu.name}\n温度 ${gpu.temperatureC}°C`,
      }));
    }
    if (gpu.utilPct != null) {
      items.push(h(Metric, {
        key: "gutil",
        label: "",
        text: `${gpu.utilPct}%`,
        pct: gpu.utilPct,
        color: "rgb(65,118,230)",
        title: `GPU 占用 ${gpu.utilPct}%`,
      }));
    }
    if (gpu.vramUsedMiB != null && gpu.vramTotalMiB) {
      const usedGb = (gpu.vramUsedMiB / 1024).toFixed(1);
      const totalGb = (gpu.vramTotalMiB / 1024).toFixed(0);
      items.push(h(Metric, {
        key: "vram",
        label: "显存",
        text: `${usedGb}/${totalGb}G`,
        pct: gpu.vramPct,
        color: gpu.vramPct >= 90 ? "rgb(248,81,73)" : "rgb(63,185,80)",
        title: `显存 ${gpu.vramUsedMiB} / ${gpu.vramTotalMiB} MiB（${gpu.vramPct}%）`,
      }));
    }
  }

  if (cpu?.loadPct != null) {
    items.push(h(Metric, {
      key: "cpu",
      label: "CPU",
      text: `${cpu.loadPct}%`,
      pct: cpu.loadPct,
      color: cpu.loadPct >= 90 ? "rgb(248,81,73)" : "rgb(65,118,230)",
      title: `${cpu.name ?? "CPU"}\n负载 ${cpu.loadPct}%（本机不暴露 CPU 温度）`,
    }));
  }

  if (mem?.usedMiB != null && mem.totalMiB) {
    const usedGb = (mem.usedMiB / 1024).toFixed(1);
    const totalGb = (mem.totalMiB / 1024).toFixed(0);
    items.push(h(Metric, {
      key: "mem",
      label: "内存",
      text: `${usedGb}/${totalGb}G`,
      pct: mem.pct,
      color: mem.pct >= 90 ? "rgb(248,81,73)" : "rgb(163,106,3)",
      title: `内存 ${mem.usedMiB} / ${mem.totalMiB} MiB（${mem.pct}%）`,
    }));
  }

  if (!items.length) return null;

  return h("div", {
    style: {
      display: "inline-flex", alignItems: "center", gap: 10,
      height: 22, padding: "0 2px",
      flex: "none",
    },
  }, ...items);
}

/** 渲染崩了也只是这一块消失，不冒泡。 */
class Boundary extends React.Component {
  constructor(p) { super(p); this.state = { dead: false }; }
  static getDerivedStateFromError() { return { dead: true }; }
  componentDidCatch(e) { console.warn("[device-monitor] 渲染失败，已隐藏：", e?.message ?? e); }
  render() {
    return this.state.dead ? null : this.props.children;
  }
}

export function apply(ctx) {
  try {
    ctx.slots.inject("conversation.session.header.utilities", () =>
      ctx.slots.register(
        {
          name: "conversation.session.header.utilities",
          id: "device-monitor",
          order: 10,
          children: {},
          inject: () => ({}),
        },
        () => h(Boundary, null, h(DeviceMonitor))
      )
    );
    console.log("[device-monitor] 已挂到 header.utilities");
  } catch (err) {
    // ★ 注册失败不影响任何其它插件
    console.warn("[device-monitor] 挂载失败（监控将不可用）：", err?.message ?? err);
  }
}
