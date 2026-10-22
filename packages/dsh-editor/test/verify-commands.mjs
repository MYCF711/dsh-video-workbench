/**
 * 前端命令路由验收 —— 确认「用户点按钮」与「Agent 调工具」落在同一个 store。
 */
import { registerCommands } from "../src/commands.mjs";
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

function fakeWebServer() {
  const routes = [];
  return {
    routes,
    register(r) { routes.push(r); return () => { const i = routes.indexOf(r); if (i >= 0) routes.splice(i, 1); }; },
  };
}

function fakeReq(body) {
  const listeners = {};
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
  return {
    method: "POST",
    on(ev, fn) {
      listeners[ev] = listeners[ev] || [];
      listeners[ev].push(fn);
      if (ev === "end") setTimeout(() => { chunks.forEach((c) => (listeners.data || []).forEach((f) => f(c))); fn(); }, 0);
      if (ev === "error") { /* noop */ }
      return this;
    },
    destroy() {},
  };
}

function fakeRes() {
  return {
    statusCode: null, headers: null, body: "",
    writeHead(c, h) { this.statusCode = c; this.headers = h; },
    end(b) { this.body = b ?? ""; },
    json() { try { return JSON.parse(this.body); } catch { return null; } },
  };
}

const store = createTimelineStore({ log: { info() {}, warn() {} } });
const fakeBridge = {
  calls: { generate: [] },
  async generate(modeId, params) { this.calls.generate.push({ modeId, params }); return { jobId: "job_x", promptId: "p_x" }; },
  async cancel() { return { ok: true }; },
};

console.log("═══ ① 路由注册 ═══");
let ws, dispose;
// ★ 2026-10-18 改成「≥N 且核心命令齐全」，不硬编码总数。
//   这是第三次踩同一个坑（AGENTS §3.8）：写死 11 条，加了
//   /handoff 与 /handoff-unlock 后变 13 ⇒ 断言变红，但功能是好的。
await t("registerCommands 注册 >= 11 条命令，且核心命令齐全", () => {
  ws = fakeWebServer();
  dispose = registerCommands({ webServer: ws }, store, {
    log: { info() {}, warn() {} },
    bridge: fakeBridge,
    onExport: async () => ({ ok: true, path: "x.mp4" }),
  });
  const must = [
    "/timeline/cmd/add-shots", "/timeline/cmd/update-shot", "/timeline/cmd/add-track",
    "/timeline/cmd/edit-clip", "/timeline/cmd/replace-clip", "/timeline/cmd/generate",
    "/timeline/cmd/stop", "/timeline/cmd/edit-audio", "/timeline/cmd/export",
    "/timeline/cmd/add-audio", "/timeline/cmd/split-audio",
  ];
  const got = ws.routes.map((r) => r.path);
  const missing = must.filter((p) => !got.includes(p));
  if (got.length < 11) return `${got.length} 条（少于 11）：${got.join(",")}`;
  if (missing.length) return `缺核心命令：${missing.join(",")}（共 ${got.length} 条）`;
  return true;
});

await t("路径都在 /timeline/cmd/ 下", () => {
  const bad = ws.routes.filter((r) => !r.path.startsWith("/timeline/cmd/"));
  return bad.length === 0 ? true : bad.map((r) => r.path).join(",");
});

async function call(path, body) {
  const route = ws.routes.find((r) => r.path === "/timeline/cmd" + path);
  if (!route) throw new Error(`路由不存在：${path}`);
  const res = fakeRes();
  await route.handler(fakeReq(body), res);
  return { code: res.statusCode, body: res.json() };
}

console.log("\n═══ ② 用户操作走 HTTP，落在同一个 store ═══");

await t("POST /add-shots 加 2 段", async () => {
  const r = await call("/add-shots", { shots: [
    { prompt: "用户加的第1段", modeId: "yz", durationSec: 10 },
    { prompt: "用户加的第2段", modeId: "yz", durationSec: 10 },
  ] });
  if (r.code !== 200) return `HTTP ${r.code}：${JSON.stringify(r.body)}`;
  return store.summary().total === 2 ? true : store.summary().total;
});

await t("★ 用户在 history 里记成 who=user", () => {
  const h = store.history().filter((e) => e.action === "addShot");
  return h.length >= 2 && h.every((e) => e.who === "user") ? true : JSON.stringify(h.map((e) => e.who));
});

await t("POST /update-shot 改提示词", async () => {
  const s = store.snapshot();
  const cid = s.tracks[0].clips[0].id;
  const r = await call("/update-shot", { clipId: cid, patch: { prompt: "用户改的" } });
  if (r.code !== 200) return `HTTP ${r.code}`;
  const after = store.snapshot().tracks[0].clips[0].shot.prompt;
  return after === "用户改的" ? true : after;
});

await t("POST /edit-clip op=speed", async () => {
  const s = store.snapshot();
  const cid = s.tracks[0].clips[0].id;
  const r = await call("/edit-clip", { clipId: cid, op: "speed", speed: 2 });
  if (r.code !== 200) return `HTTP ${r.code}`;
  return store.snapshot().tracks[0].clips[0].speed === 2 ? true : "没设上";
});

await t("POST /edit-clip 非法 op 返回 400", async () => {
  const s = store.snapshot();
  const cid = s.tracks[0].clips[0].id;
  const r = await call("/edit-clip", { clipId: cid, op: "bogus" });
  return r.code === 400 && r.body.error ? true : JSON.stringify(r);
});

console.log("\n═══ ③ 生成与停止 ═══");

await t("POST /generate 提交并记 who=user", async () => {
  const s = store.snapshot();
  const cid = s.tracks[0].clips[1].id;
  const r = await call("/generate", { clipIds: [cid] });
  if (r.code !== 200) return `HTTP ${r.code}：${JSON.stringify(r.body)}`;
  const results = r.body.results;
  if (!results?.[0]?.ok) return results?.[0]?.reason;
  const h = store.history().filter((e) => e.action === "jobStarted");
  return h.length >= 1 && h[h.length - 1].who === "user" ? true : JSON.stringify(h.map((e) => e.who));
});

await t("提交后 summary.running=1", () => {
  return store.summary().running === 1 ? true : store.summary().running;
});

await t("POST /stop 停单段", async () => {
  const s = store.snapshot();
  const cid = s.tracks[0].clips[1].id;
  const r = await call("/stop", { clipId: cid });
  if (r.code !== 200) return `HTTP ${r.code}`;
  return store.summary().running === 0 ? true : store.summary().running;
});

await t("POST /stop 不传 clipId 停全部", async () => {
  const r = await call("/stop", {});
  return r.code === 200 && typeof r.body.stopped === "number" ? true : JSON.stringify(r);
});

console.log("\n═══ ④ 导出 ═══");

await t("POST /export 调 onExport", async () => {
  const r = await call("/export", {});
  return r.code === 200 && r.body.ok === true ? true : JSON.stringify(r);
});

await t("没配 onExport 时报明确错误", async () => {
  const ws2 = fakeWebServer();
  const d2 = registerCommands({ webServer: ws2 }, store, { log: { info() {}, warn() {} }, bridge: fakeBridge });
  const route = ws2.routes.find((r) => r.path === "/timeline/cmd/export");
  const res = fakeRes();
  await route.handler(fakeReq({}), res);
  d2();
  return res.statusCode === 400 && /onExport/.test(res.json()?.error ?? "") ? true : `${res.statusCode} ${res.json()?.error}`;
});

console.log("\n═══ ⑤ 非 POST 被拒 ═══");

await t("GET 请求返回 405", async () => {
  const route = ws.routes.find((r) => r.path === "/timeline/cmd/add-shots");
  const res = fakeRes();
  await route.handler({ method: "GET", on() {} }, res);
  return res.statusCode === 405 ? true : res.statusCode;
});

console.log("\n" + "═".repeat(58));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  前端命令路由验收全过");