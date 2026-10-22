/**
 * host 入口验收 —— 用一个假的 cordis ctx 验证插件装配。
 *
 * 判据：
 *   ① apply 不抛错，返回 dispose 函数
 *   ② 注册了 SSE 路由（2 条）
 *   ③ 注册了工具（8 个）
 *   ④ 轮询器存在且 unref（不阻止进程退出）
 *   ⑤ dispose 能清理干净
 */
import os from "node:os";
import pathMod from "node:path";
import { apply, inject } from "../src/index-host.mjs";
import { createTimelineStore } from "../src/host-store.mjs";

let pass = 0, fail = 0;
const failures = [];
async function t(desc, fn) {
  try {
    const r = await fn();
    if (r === true || r === undefined) { console.log(`  ✅ ${desc}`); pass++; }
    else { console.log(`  ❌ ${desc}\n     ${r}`); fail++; failures.push(desc); }
  } catch (err) {
    console.log(`  ❌ ${desc}\n     ${String(err.message).slice(0, 300)}`);
    fail++; failures.push(desc);
  }
}

/** 假 cordis ctx。 */
function fakeCtx({ withTools = true } = {}) {
  const webRoutes = [];
  const tools = [];
  const provided = {};
  const ctx = {
    __webRoutes: webRoutes,
    __tools: tools,
    __provided: provided,
    logger: { info() {}, warn() {}, error() {} },
    webServer: {
      register(route) {
        webRoutes.push(route);
        return () => {
          const i = webRoutes.indexOf(route);
          if (i >= 0) webRoutes.splice(i, 1);
        };
      },
    },
    // ★ cordis 的 provide —— 直接赋值 ctx.xxx 会报
    //   "cannot set property ... without provide"（实测踩过）
    provide(name, value) {
      provided[name] = value;
      return () => { delete provided[name]; };
    },
  };
  if (withTools) {
    ctx.tools = {
      // 与 DSH 官方 defineTool 同形状
      defineTool: (def) => {
        if (!def.name || !def.description || !def.parameters || typeof def.execute !== "function") {
          throw new Error(`工具定义不完整：${def.name ?? "(no name)"}`);
        }
        return def;
      },
      register(def) {
        tools.push(def);
        return () => {
          const i = tools.indexOf(def);
          if (i >= 0) tools.splice(i, 1);
        };
      },
    };
  }
  return ctx;
}

console.log("═══ ① inject 声明 ═══");

await t("inject 是服务名（不是包名）", () => {
  if (!Array.isArray(inject)) return `不是数组：${typeof inject}`;
  const bad = inject.filter((x) => String(x).startsWith("@"));
  return bad.length === 0 ? true : `含包名 ${bad.join(",")}`;
});

await t("inject 含 webServer 与 tools", () => {
  return inject.includes("webServer") && inject.includes("tools") ? true : JSON.stringify(inject);
});

console.log("\n═══ ② apply 装配 ═══");

let ctx, dispose;
/** ★ 每个用例用独立的临时 stateFile —— 否则会读到真实存档
 *  （实测踩到：真实存档里有 4 段，导致「初始为空」断言失败）。 */
function tmpState(tag) {
  return pathMod.join(os.tmpdir(), `dsh-host-entry-${tag}-${Date.now()}-${Math.random().toString(36).slice(2,8)}.json`);
}

await t("apply 不抛错并返回 dispose 函数", async () => {
  ctx = fakeCtx();
  dispose = await apply(ctx, { pollMs: 999999, stateFile: tmpState("main"), assetIndex: tmpState("assets") });
  return typeof dispose === "function" ? true : typeof dispose;
});

// ★ 2026-10-18 改成「≥N 且核心路由齐全」，不硬编码总数。
//   理由（AGENTS §3.8 同一个坑）：写死 18 条，加了 /characters 与
//   /character-tag 后变 20 ⇒ 断言变红，但功能是好的。
await t("注册了 >= 18 条路由，且核心路由齐全", () => {
  const paths = ctx.__webRoutes.map((r) => r.path);
  const must = [
    "/timeline/snapshot", "/timeline/preview", "/timeline/assets",
    "/timeline/cmd/export", "/timeline/cmd/generate", "/timeline/cmd/characters",
  ];
  const missing = must.filter((p) => !paths.includes(p));
  if (paths.length < 18) return `${paths.length} 条（少于 18）：${paths.join(",")}`;
  if (missing.length) return `缺核心路由：${missing.join(",")}（共 ${paths.length} 条）`;
  return true;
});

// ★ 2026-10-18：改成「必含清单」而不是「完全相等」。
//   原来把 18 条路由逐字列出做全等比较，加任何一条就红 ——
//   这不是在守「路由正确」，是在守「路由不许变」，与 §3.8 同一个坑。
await t("路由集合包含全部必需项", () => {
  const got = ctx.__webRoutes.map((r) => r.path);
  const must = [
    "/timeline/align", "/timeline/assets", "/timeline/file", "/timeline/preview", "/timeline/snapshot",
    "/timeline/cmd/add-shots", "/timeline/cmd/add-track", "/timeline/cmd/assets-scan",
    "/timeline/cmd/edit-audio", "/timeline/cmd/edit-clip", "/timeline/cmd/export",
    "/timeline/cmd/generate", "/timeline/cmd/replace-clip", "/timeline/cmd/stop",
    "/timeline/cmd/update-shot", "/timeline/cmd/add-audio", "/timeline/cmd/split-audio",
    "/timeline/events",
  ];
  const missing = must.filter((p) => !got.includes(p));
  return missing.length === 0 ? true : `缺：${missing.join(",")}（实际 ${got.length} 条）`;
});

// ★ 2026-10-18 改成「≥N 且核心工具齐全」，不硬编码总数。
//   理由（AGENTS.md §3.7 记过同一个坑）：原来写死 === 16，
//   加了 timeline_chain_frames 后变 17 ⇒ 断言变红，但功能是好的。
//   「加工具不该让断言变红」—— 断言该守的是「核心能力还在」。
await t("注册了 >= 16 个 LLM 工具，且核心工具齐全", () => {
  const names = ctx.__tools.map((x) => x.name);
  const must = [
    "timeline_summary", "timeline_add_shots", "timeline_generate",
    "timeline_edit_clip", "timeline_replace_clip", "timeline_chain_frames",
  ];
  const missing = must.filter((n) => !names.includes(n));
  if (names.length < 16) return `${names.length} 个（少于 16）：${names.join(",")}`;
  if (missing.length) return `缺核心工具：${missing.join(",")}（共 ${names.length} 个）`;
  return true;
});

await t("工具名以 timeline_ 或 assets_ 开头", () => {
  const bad = ctx.__tools.filter((x) => !x.name.startsWith("timeline_") && !x.name.startsWith("assets_"));
  return bad.length === 0 ? true : bad.map((x) => x.name).join(",");
});

await t("暴露了 ctx.timelineStore", () => {
  return ctx.__provided.timelineStore && typeof ctx.__provided.timelineStore.summary === "function" ? true : "没 provide";
});

await t("store 初始为空（summary.total=0）", () => {
  return ctx.__provided.timelineStore.summary().total === 0 ? true : ctx.__provided.timelineStore.summary().total;
});

console.log("\n═══ ③ 没有 tools 服务时降级 ═══");

await t("ctx.tools 缺失时仍能启动（SSE + 命令照常注册）", async () => {
  const c2 = fakeCtx({ withTools: false });
  const d = await apply(c2, { pollMs: 999999, stateFile: tmpState("degraded"), assetIndex: tmpState("degraded-assets") });
  const ok = typeof d === "function" && c2.__webRoutes.length >= 18;
  d();
  return ok ? true : `路由 ${c2.__webRoutes.length} 条（应为 18）`;
});

console.log("\n═══ ④ 端到端：Agent 建分镜 → 状态可见 ═══");

await t("通过工具建 3 段分镜", async () => {
  const addTool = ctx.__tools.find((x) => x.name === "timeline_add_shots");
  await addTool.execute({
    shots: [
      { prompt: "镜头1", modeId: "yz", durationSec: 12 },
      { prompt: "镜头2", modeId: "yz", durationSec: 12 },
      { prompt: "镜头3", modeId: "yz", durationSec: 10 },
    ],
  });
  return ctx.__provided.timelineStore.summary().total === 3 ? true : ctx.__provided.timelineStore.summary().total;
});

await t("SSE 能推给订阅者", async () => {
  // 直接用 store.subscribe 验证（SSE 层已在 verify-sse.mjs 单测过）
  const events = [];
  const off = ctx.__provided.timelineStore.subscribe((e) => events.push(e));
  const addTool = ctx.__tools.find((x) => x.name === "timeline_add_shots");
  await addTool.execute({ shots: [{ prompt: "推送测试", modeId: "yz" }] });
  off();
  return events.length >= 1 && events[0].who === "agent" ? true : `${events.length} 条`;
});

console.log("\n═══ ⑤ dispose 清理 ═══");

await t("dispose 后路由与工具都清掉", () => {
  dispose();
  return ctx.__webRoutes.length === 0 && ctx.__tools.length === 0
    ? true : `路由 ${ctx.__webRoutes.length} / 工具 ${ctx.__tools.length}`;
});

console.log("\n" + "═".repeat(58));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  host 入口验收全过");