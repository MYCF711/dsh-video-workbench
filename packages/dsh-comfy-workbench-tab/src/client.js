/**
 * dsh-comfy-workbench-tab —— client 侧入口
 *
 * 在对话视图环（conversation.view）里注册一个「视频工作台」标签页，
 * 与官方的 Chat（对话）和 Trajectory（轨迹）平级。
 *
 * 注册方式照抄官方 @deepseek-ai/dsh-client-ui-trajectory/lib/client.js：
 *   ui-trajectory/lib/client.js 逐字：
 *     ctx.slots.inject("conversation.view", () => ctx.slots.register({
 *         name: "conversation.view",
 *         id: "trajectory",
 *         order: 10,
 *         locale: NS,
 *         label: () => t("view.trajectory"),
 *         children: { ... },
 *         inject: (sessionId) => ({ ... }),
 *     }, TrajectoryView));
 *
 * 三条硬约束（见 docs/方案-DSH视频工作台.md §3.1 与 §7.6）：
 *   ① 用全新 id 与 kind，绝不覆盖官方 builtin
 *   ② 不用别人的 slot key
 *   ③ 不注册 sidebarRightTabs —— 侧栏会话是官方 ui-subagent 的，不碰
 */

import { WorkbenchView as RawView } from "./WorkbenchView.js";
import React from "react";
import { DeviceMonitor, DeviceMonitorBoundary } from "./DeviceMonitor.mjs";
class ViewBoundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(e) { return { err: e }; }
  componentDidCatch(e) { console.error("[comfy-wb]", e); }
  render() {
    if (this.state.err) {
      return React.createElement("pre", {
        style: { margin: 16, padding: 12, color: "#f85149", background: "rgba(248,81,73,.08)",
                 fontSize: 11, whiteSpace: "pre-wrap", borderRadius: 8, overflow: "auto" },
      }, "[comfy-wb] 渲染出错：\n" + (this.state.err.stack || this.state.err.message));
    }
    return this.props.children;
  }
}
function WorkbenchView(props) {
  /**
   * ★★ 2026-10-22：把 hostRequire 传给视图，让它能用 DSH 原生图标
   *
   *   主人（指着资产库/骰子按钮）：「这两个的图标不够DSH，很突兀，
   *                                 然后文字显示不全」
   *
   *   原来源码里用的是 emoji（🗂 / 🎲）——
   *   emoji 是彩色位图，和 DSH 全站的单色线性图标体系完全不搭。
   *   而 DSH 的图标（IconXxxOutlineMedium）必须通过 require 取到
   *   @deepseek-ai/dsh-client-ui-primitives，这个 require 只有 factory
   *   参数里有（见 lib/client.js 的 __requireShim）。
   *
   *   ⇒ 在 apply 里把 __DSH_PLUGIN_REQUIRE__ 记下来，沿着 props 传进视图。
   *     剪辑台（editor/dsh-primitives.js）早就是这么做的，工作台此前一直没接。
   */
  const withHost = { ...props, hostRequire: props?.hostRequire ?? resolveHostRequireLoose() };
  return React.createElement(ViewBoundary, null, React.createElement(RawView, withHost));
}

/**
 * 拿到宿主的 require。
 *
 * ★ 三级回退（与 editor/dsh-primitives.js 的 resolveHostRequire 同思路）：
 *   ① globalThis.__DSH_PLUGIN_REQUIRE__ —— build.mjs 在 factory 里挂的真 require
 *   ② 裸 require —— 在某些打包形态下它可能是真的
 *   ③ null —— 拿不到就让 DshIcon 回退成文字
 *
 * ★ 绝不抛错：图标拿不到只是不好看，不该让工作台白屏。
 */
function resolveHostRequireLoose() {
  try {
    if (typeof globalThis !== "undefined" && typeof globalThis.__DSH_PLUGIN_REQUIRE__ === "function") {
      return globalThis.__DSH_PLUGIN_REQUIRE__;
    }
  } catch { /* ignore */ }
  try {
    // eslint-disable-next-line no-undef
    if (typeof require === "function") return require;
  } catch { /* ignore */ }
  return null;
}
import { zh, en } from "./locale.js";
import { createHttpBridge } from "./bridge.js";
/**
 * ★ 2026-10-22：屏蔽 DSH 中栏列宽手柄 + 恢复默认宽度
 *   （主人报「视频工作台可以调节 dsh 原生的对话框宽度」）
 *   细节见 dshHandleGuard.js 文件头。
 */
import { installHandleGuard, resetDshWidths } from "./dshHandleGuard.js";
/**
 * ★ 2026-10-22 合包：剪辑台模块（原 dsh-artcraft-tab 整包）
 *   细节见 src/editor/index.js 与 editorHost.js 的文件头。
 */
import { mountEditorModule } from "./editor/index.js";

const NS = "comfy-workbench-tab";
const VIEW_ID = "comfy-workbench";

/** 客户端插件声明。 */
export const name = "dsh-comfy-workbench-tab";

/** 依赖的客户端能力。写【服务名】，不是包名。 */
export const inject = ["slots", "locale"];

/**
 * 装配。cordis 调用。
 * @param ctx 客户端 cordis 上下文
 */
/**
 * 解析 M1 的桥。
 * 优先用宿主注入的 ctx.comfyBridge；没有就建一个走 /comfy-bridge 的 HTTP 桥。
 * ★ 必须永不抛错、永不返回 null —— 组件里 await bridge.health() 会在 null 上崩。
 */
function resolveBridge(ctx) {
  try {
    if (ctx && ctx.comfyBridge && typeof ctx.comfyBridge.health === "function") {
      return ctx.comfyBridge;
    }
  } catch { /* ctx 不可读时忽略 */ }
  return createHttpBridge();
}


/**
 * DSH 底部 dock 里的 ComfyUI 开关。
 *
 * ★ 主人 2026-10-18：
 *   「那就加一个手动开关，不要自动拉起了…开关放在状态栏的 comfyui 那里应该不错」
 *   「而且没有关闭能力，应该做成开关」
 *   ⇒ 关 → 点 → 无头启动；开 → 点 → 关掉。
 *
 * ★ 字号（主人：「字体会不会太大了？不和谐」）
 *   dock 里原生 token 统计是 11px，这里跟它一致，不再用 11px+padding:8。
 */
function ComfyDockStatus({ bridge, t }) {
  const [state, setState] = React.useState({ s: "probing", vram: null, version: null });
  const [busy, setBusy] = React.useState(false);
  const [hint, setHint] = React.useState("");

  const check = React.useCallback(async () => {
    try {
      const r = await bridge.health();
      setState({
        s: r.ok ? "ok" : "down",
        vram: r.devices?.[0]?.vramFreeMiB ?? null,
        version: r.comfyuiVersion ?? null,
      });
      return r.ok;
    } catch {
      setState({ s: "down", vram: null, version: null });
      return false;
    }
  }, [bridge]);

  React.useEffect(() => {
    let alive = true;
    check();
    const timer = setInterval(() => { if (alive) check(); }, 30_000);
    return () => { alive = false; clearInterval(timer); };
  }, [check]);

  /** 开关：关→启动，开→关闭。 */
  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    setHint(state.s === "ok" ? "关闭中…" : "启动中…");

    try {
      const url = state.s === "ok" ? "/comfy-bridge/stop" : "/comfy-bridge/ensure";
      const res = await fetch(url, { method: "POST" });
      const j = await res.json();
      if (!j.ok) setHint(j.reason ?? "失败");
      else setHint("");
      await check();
    } catch (e) {
      setHint(e?.message ?? "失败");
    } finally {
      setBusy(false);
      // 提示 3 秒后清掉
      setTimeout(() => setHint(""), 3000);
    }
  };

  const dot = state.s === "ok" ? "#3fb950"
    : busy ? "#d29922"
    : "#f85149";

  // ★ 文字跟 dock 里其它项一样短（主人嫌大）
  const label = state.s === "ok"
    ? `ComfyUI${state.version ? " v" + state.version : ""}`
    : busy ? (hint || "处理中…")
    : "ComfyUI 关闭";

  const title = state.s === "ok"
    ? `ComfyUI v${state.version ?? "?"} · 空闲 ${state.vram ?? "?"} MiB\n点击关闭`
    : busy ? hint
    : hint ? `上次操作：${hint}`
    : "点击以无头模式启动（不弹窗口）";

  return React.createElement("button", {
    type: "button",
    title,
    onClick,
    disabled: busy,
    style: {
      // ★ 完全跟随 DSH 原生 token pill（实测 2026-10-18）：
      //   高 22px / 字号 12px / 行高 20px / 字重 400
      //   padding "1px 8px" / gap 6px / 圆角 999px / 色 rgb(129,133,140)
      //   主人两次指出「字体会不会太大了」「字体还是太小了，应该跟随 dsh 的系统」
      //   ⇒ 不再自定字号，一律对齐原生。
      display: "inline-flex", alignItems: "center", gap: 6,
      height: 22, padding: "1px 8px",
      boxSizing: "border-box",
      fontSize: 12, lineHeight: "20px", whiteSpace: "nowrap",
      color: "var(--dsw-alias-label-tertiary, #81858c)",
      background: "transparent", border: 0,
      // ★ 不要写 font: "inherit" —— 它是简写，会把 fontSize 重置成 body 的 16px。
      fontFamily: "inherit",
      fontWeight: 400,
      cursor: busy ? "default" : "pointer",
      borderRadius: 999,
      opacity: busy ? 0.7 : 1,
    },
  },
    React.createElement("span", {
      style: { width: 5, height: 5, borderRadius: "50%", background: dot, flex: "none" },
    }),
    label
  );
}
export function apply(ctx) {
  const t = ctx.locale.bind(NS);

  ctx.effect(
    () => ctx.locale.register(NS, { zh, en }),
    "comfy-workbench-tab: dictionaries"
  );

  /**
   * ★★ 2026-10-22 撤销屏蔽（主人改口了，我照做）
   *
   *   上一轮我装了一层覆盖层挡掉 DSH 的 10px 列宽手柄，
   *   理由是「工作台里不该能拖 DSH 对话框宽度」。
   *
   *   主人现在的原话：
   *     「dsh的对话栏确实可以调节，不过是整个tab一起调节的，
   *       你可以让我们的tab里面的对话框自适应最宽就行了」
   *
   *   ⇒ 那条手柄【是该用的】，不该挡。正确做法不是禁止调节，
   *     而是让我们的内容跟着 DSH 列宽自适应 —— 见下面 WorkbenchView
   *     的宽度改造。
   *
   *   ★ 这段代码保留为注释而不是直接删：万一以后又要屏蔽，
   *     知道它原本长什么样、为什么装上过。
   */
  // ctx.effect(() => {
  //   let dispose = null;
  //   try {
  //     dispose = installHandleGuard(".comfy-wb");
  //   } catch (e) {
  //     console.warn("[comfy-wb] 列宽手柄屏蔽安装失败（不影响其它功能）：", e?.message ?? e);
  //   }
  //   return () => { try { dispose?.(); } catch { /* ignore */ } };
  // }, "comfy-workbench-tab: dsh width handle guard");

  /**
   * ★★ 2026-10-22 同时撤销「每次激活都恢复默认宽度」
   *
   *   原因同上：主人要的是【能调节 + 内容自适应】，
   *   不是「每次都重置回默认」。
   *   每次激活都清掉用户拖过的宽度，等于把用户的调节作废。
   *
   *   ★ 但如果用户拖歪到不可用的程度，还得有个复位办法 ——
   *     这个留到 UI 上（面板里放一个「重置宽度」），
   *     而不是在每次激活时静默清除。
   */
  // try {
  //   const r = resetDshWidths();
  //   if (r.cleared) {
  //     console.info(`[comfy-wb] DSH 内容宽度已恢复默认（原值 ${r.previous ?? "(未知)"}）`);
  //   }
  // } catch (e) {
  //   console.warn("[comfy-wb] 恢复默认宽度失败：", e?.message ?? e);
  // }

  // ★ 设备监控：工作台 UI 的一个子模块。
  //   主人 2026-10-18 两条要求：
  //     ① 「他作为模块，接在 ui 部分，这部分模块失效只是丢失这部分的 ui」
  //     ② 「你先找的位置把 dsh 本身的 ui 造成了位移」
  //   ⇒ 不用 header.utilities slot（那是 flex:0，撑宽会挤走「文件资源管理器」按钮），
  //     改成自己往 body 挂一个 fixed 定位的容器，DSH 布局完全不受影响。
  //   实现：由 WorkbenchView 自己在挂载时渲染 <DeviceMonitor />，
  //   后者用 createPortal 挂到 body（fixed 定位，不参与任何布局，零位移）。
  //   这里不需要额外注册 slot —— 它本来就是工作台 UI 的一部分。

  // ★ 底部状态条：挂进 DSH 输入框下方那条 dock 的【左端空位】
  //   实测（2026-10-18）：.RlGAzG_dock 里 [data-slot="conversation.composer.dock"]
  //   是一个空 slot（x=0 w=0），右边才是 token 统计。
  //   主人要求：「放在最底部，和 token 用量那些数据监控放一起，最好放左边」
  //   ⇒ 用这个 slot，不另开地盘。
  try {
    ctx.slots.inject("conversation.composer.dock", () =>
      ctx.slots.register(
        {
          name: "conversation.composer.dock",
          id: "comfy-dock-status",
          order: -10,              // 负数排在 token 统计左边
          locale: NS,
          label: () => t("health.ok"),
          children: {},
          inject: (sessionId) => ({ sessionId, bridge: resolveBridge(ctx), t }),
        },
        ComfyDockStatus
      )
    );
  } catch (e) {
    console.warn("[comfy-wb] composer.dock 注册失败（可能该 slot 不存在）:", e.message);
  }

  // ★ 关键：注册到 conversation.view，order 20 排在 trajectory(10) 之后
  ctx.slots.inject("conversation.view", () =>
    ctx.slots.register(
      {
        name: "conversation.view",
        id: VIEW_ID,
        order: 20,
        locale: NS,
        label: () => t("view.label"),

        // 本 tab 自己的子 slot（第一版为空）
        children: {},

        /**
         * 给 View 组件注入 props。
         *
         * 注意：本包不持有 ComfyUI 连接 —— 它通过 M1 的 Remote 拿数据。
         * M1 把 `ctx.comfyBridge` provide 出来；客户端拿到的形态由宿主
         * 的 Remote 通道决定。第一版直接走 HTTP 到 M1 暴露的端点，
         * 若宿主未提供端点则退化为直连 ComfyUI（下方 resolveBridge 处理）。
         */
        inject: (sessionId) => {
          try {
            const b = resolveBridge(ctx);
            return { sessionId, bridge: b, t };
          } catch (e) {
            console.error("[comfy-wb] inject error:", e);
            return { sessionId, bridge: null, t: (k) => k };
          }
        },
      },
      WorkbenchView
    )
  );

  /**
   * ══════════════════════════════════════════════════════════════════════
   * ★★ 2026-10-22 合包：剪辑台作为【本包内的一个大模块】接入
   *
   *   主人原话：
   *     「为什么不做到同一个包？？剪辑是视频工作台的一部分」
   *     「之前说过的，最小交付房间理论，剪辑可以作为一个独立的大模块接入插件」
   *
   *   之前我做成了两个独立插件包（dsh-comfy-workbench-tab + dsh-artcraft-tab），
   *   那是把「模块边界」误解成了「包边界」。
   *
   *   ⇒ 现在整个剪辑台在 src/editor/ 下，由 mountEditorModule 统一注册：
   *       · conversation.view（id: artcraft, order 30）—— 排在视频工作台之后
   *       · settings.section（id: artcraft-shortcuts, order 60）—— 快捷键设置
   *       · DSH 列宽手柄屏蔽 + 恢复默认宽度
   *
   *   ★ 为什么用 try/catch 单独包起来：
   *     剪辑台挂了不该影响视频工作台。这是「模块失效只丢那一块」的落地 ——
   *     两个 tab 在同一个包里，但注册动作彼此隔离。
   */
  try {
    mountEditorModule(ctx, { t });
  } catch (e) {
    console.error("[comfy-wb] 剪辑台模块注册失败（视频工作台不受影响）：", e);
  }
}
