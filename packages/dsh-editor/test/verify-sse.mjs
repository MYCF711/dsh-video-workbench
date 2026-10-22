/**
 * SSE 推送验收 —— 用一个假的 webServer + 假 req/res 验证协议正确性。
 *
 * 不启动真实 HTTP 服务：验的是「事件格式对不对、版本跳号能不能发现」，
 * 这些是纯逻辑，不需要网络。
 */
import { registerSse, subscribeTimeline } from "../src/sse.mjs";
import { createTimelineStore } from "../src/host-store.mjs";

let pass = 0, fail = 0;
const failures = [];
function t(desc, fn) {
  return Promise.resolve()
    .then(fn)
    .then((r) => {
      if (r === true || r === undefined) { console.log(`  ✅ ${desc}`); pass++; }
      else { console.log(`  ❌ ${desc}\n     ${r}`); fail++; failures.push(desc); }
    })
    .catch((err) => {
      console.log(`  ❌ ${desc}\n     ${String(err.message).slice(0, 300)}`);
      fail++; failures.push(desc);
    });
}

/** 假 webServer：记录路由注册。 */
function fakeWebServer() {
  const routes = [];
  return {
    routes,
    register(route) {
      routes.push(route);
      return () => {
        const i = routes.indexOf(route);
        if (i >= 0) routes.splice(i, 1);
      };
    },
  };
}

/** 假 SSE 响应：收集写入的帧。 */
function fakeSseRes() {
  const frames = [];
  return {
    frames,
    statusCode: null,
    headers: null,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
    write(chunk) { frames.push(chunk); return true; },
    end() { this.ended = true; },
    on() {},
    /** 解析出所有 event 帧。 */
    events() {
      const text = frames.join("");
      const out = [];
      for (const block of text.split("\n\n")) {
        if (!block.trim() || block.startsWith(":")) continue;
        const ev = {};
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) ev.event = line.slice(7);
          else if (line.startsWith("data: ")) ev.data = line.slice(6);
          else if (line.startsWith("retry: ")) ev.retry = line.slice(7);
        }
        if (ev.event) out.push(ev);
      }
      return out;
    },
  };
}

/** 假普通响应。 */
function fakeJsonRes() {
  const r = {
    statusCode: null, headers: null, body: "",
    writeHead(c, h) { this.statusCode = c; this.headers = h; },
    end(b) { this.body = b ?? ""; },
  };
  return r;
}

const store = createTimelineStore({ log: { info() {}, warn() {} } });

console.log("═══ ① 路由注册 ═══");

let ws, dispose;
await t("registerSse 注册五个路由（snapshot/events/align/preview/file）", () => {
  ws = fakeWebServer();
  const ctx = { webServer: ws };
  dispose = registerSse(ctx, store, { log: { info() {}, warn() {} } });
  const paths = ws.routes.map((r) => r.path).sort();
  // ★ 断言随功能增长更新：M9 加了 preview 与 file 两个路由
  const want = "/timeline/align,/timeline/events,/timeline/file,/timeline/preview,/timeline/snapshot";
  return paths.join(",") === want ? true : paths.join(",");
});

await t("两个路由都是 exact 类型", () => {
  return ws.routes.every((r) => r.kind === "exact") ? true : ws.routes.map((r) => r.kind).join(",");
});

await t("没有 webServer 时不抛错，只警告", () => {
  let warned = false;
  const d = registerSse({}, store, { log: { info() {}, warn: () => { warned = true; } } });
  d();
  return warned ? true : "没警告";
});

console.log("\n═══ ② /snapshot 返回全量 ═══");

await t("snapshot 返回 state + summary + version", async () => {
  store._reset("SSE 测试");
  store.addShot({ modeId: "yz", prompt: "镜头 1" }, "agent");
  const route = ws.routes.find((r) => r.path === "/timeline/snapshot");
  const res = fakeJsonRes();
  await route.handler({ method: "GET" }, res);
  if (res.statusCode !== 200) return `HTTP ${res.statusCode}`;
  const j = JSON.parse(res.body);
  const need = ["state", "summary", "version"];
  const miss = need.filter((k) => j[k] === undefined);
  if (miss.length) return `缺 ${miss.join(",")}`;
  return j.summary.total === 1 ? true : `total=${j.summary.total}`;
});

await t("snapshot 的 Content-Type 是 JSON", async () => {
  const route = ws.routes.find((r) => r.path === "/timeline/snapshot");
  const res = fakeJsonRes();
  await route.handler({ method: "GET" }, res);
  return /application\/json/.test(res.headers["Content-Type"] ?? "") ? true : res.headers["Content-Type"];
});

await t("snapshot 拒绝非 GET", async () => {
  const route = ws.routes.find((r) => r.path === "/timeline/snapshot");
  const res = fakeJsonRes();
  await route.handler({ method: "POST" }, res);
  return res.statusCode === 405 ? true : res.statusCode;
});

console.log("\n═══ ③ /events 是 SSE 流 ═══");

await t("events 的 Content-Type 是 text/event-stream", async () => {
  const route = ws.routes.find((r) => r.path === "/timeline/events");
  const res = fakeSseRes();
  await route.handler({ method: "GET", on() {} }, res);
  if (!/text\/event-stream/.test(res.headers["Content-Type"] ?? "")) {
    return res.headers["Content-Type"];
  }
  return true;
});

await t("events 首帧发 retry + snapshot", async () => {
  const route = ws.routes.find((r) => r.path === "/timeline/events");
  const res = fakeSseRes();
  await route.handler({ method: "GET", on() {} }, res);
  const evs = res.events();
  const hasRetry = res.frames.join("").includes("retry:");
  const hasSnapshot = evs.some((e) => e.event === "snapshot");
  return hasRetry && hasSnapshot ? true : JSON.stringify({ hasRetry, hasSnapshot, evs: evs.map((e) => e.event) });
});

await t("events 首帧 snapshot 含全量数据", async () => {
  const route = ws.routes.find((r) => r.path === "/timeline/events");
  const res = fakeSseRes();
  await route.handler({ method: "GET", on() {} }, res);
  const snap = res.events().find((e) => e.event === "snapshot");
  if (!snap) return "没有 snapshot 帧";
  const j = JSON.parse(snap.data);
  return j.state && j.summary ? true : Object.keys(j).join(",");
});

console.log("\n═══ ④ ★ 状态变化会推给已连接客户端 ═══");

let liveRes;
await t("连接后，store 变了会收到事件", async () => {
  // 上一组测试留下的连接还在 clients 里，先清空重来
  dispose();
  ws = fakeWebServer();
  dispose = registerSse({ webServer: ws }, store, { log: { info() {}, warn() {} } });

  const route = ws.routes.find((r) => r.path === "/timeline/events");
  liveRes = fakeSseRes();
  await route.handler({ method: "GET", on() {} }, liveRes);

  const before = liveRes.events().length;
  store.addShot({ modeId: "yz", prompt: "推送测试" }, "agent");
  const after = liveRes.events();
  const newOnes = after.slice(before);
  const changed = newOnes.filter((e) => e.event === "timeline");
  return changed.length >= 1 ? true : `新增 ${newOnes.length} 帧，其中 timeline 事件 ${changed.length}`;
});

await t("推送的事件带 action / who / version", async () => {
  const evs = liveRes.events().filter((e) => e.event === "timeline");
  const last = evs[evs.length - 1];
  if (!last) return "没有 timeline 事件";
  const j = JSON.parse(last.data);
  return j.action === "addShot" && j.who === "agent" && typeof j.version === "number"
    ? true : JSON.stringify({ a: j.action, w: j.who, v: j.version });
});

await t("多次变更依次推送，version 递增", async () => {
  const before = liveRes.events().filter((e) => e.event === "timeline").length;
  store.addTrack("video", null, "user");
  store.addTrack("audio", null, "user");
  const evs = liveRes.events().filter((e) => e.event === "timeline").slice(before);
  if (evs.length !== 2) return `收到 ${evs.length} 条`;
  const v1 = JSON.parse(evs[0].data).version;
  const v2 = JSON.parse(evs[1].data).version;
  return v2 > v1 ? true : `${v1} → ${v2}`;
});

console.log("\n═══ ⑤ 清理 ═══");

await t("dispose 后路由消失", () => {
  dispose();
  return ws.routes.length === 0 ? true : `还剩 ${ws.routes.length} 条`;
});

await t("dispose 后再变更不再推给旧客户端", async () => {
  const before = liveRes.frames.length;
  store.addShot({ modeId: "yz", prompt: "退订后的变更" }, "agent");
  return liveRes.frames.length === before ? true : `还写了 ${liveRes.frames.length - before} 帧`;
});

console.log("\n═══ ⑥ 前端订阅器（subscribeTimeline）═══");

await t("能创建订阅器并在 close 后不抛错", () => {
  // 前端订阅器要 EventSource 与 fetch，Node 里没有 —— 用替身
  const origES = globalThis.EventSource;
  const origFetch = globalThis.fetch;
  let created = null;
  globalThis.EventSource = class {
    constructor(url) { this.url = url; this.handlers = {}; created = this; }
    addEventListener(n, fn) { this.handlers[n] = fn; }
    close() { this.closed = true; }
  };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ version: 1, state: {}, summary: {} }) });

  try {
    const sub = subscribeTimeline({ prefix: "/timeline", onSnapshot: () => {}, onChange: () => {} });
    if (!created) return "没创建 EventSource";
    if (created.url !== "/timeline/events") return `URL = ${created.url}`;
    sub.close();
    if (!created.closed) return "close 没关掉";
    return true;
  } finally {
    globalThis.EventSource = origES;
    globalThis.fetch = origFetch;
  }
});

await t("★ 版本跳号时自动重新拉全量", async () => {
  const origES = globalThis.EventSource;
  const origFetch = globalThis.fetch;
  let created = null;
  let snapshotPulls = 0;
  globalThis.EventSource = class {
    constructor(url) { this.url = url; this.handlers = {}; created = this; }
    addEventListener(n, fn) { this.handlers[n] = fn; }
    close() {}
  };
  globalThis.fetch = async () => {
    snapshotPulls += 1;
    return { ok: true, json: async () => ({ version: 100, state: {}, summary: {} }) };
  };

  try {
    const got = [];
    const sub = subscribeTimeline({
      prefix: "/timeline",
      onSnapshot: () => {},
      onChange: (e) => got.push(e),
    });
    // 模拟首帧 snapshot（version=1）
    created.handlers.snapshot({ data: JSON.stringify({ version: 1, state: {}, summary: {} }) });
    // 正常递增
    created.handlers.timeline({ data: JSON.stringify({ version: 2, action: "a" }) });
    // 跳号（2 → 5，中间漏了 3、4）
    created.handlers.timeline({ data: JSON.stringify({ version: 5, action: "b" }) });

    const pulls = snapshotPulls;
    sub.close();
    if (got.length !== 1) return `onChange 被调了 ${got.length} 次（跳号那条不该算）`;
    if (pulls < 1) return "跳号后没有重新拉快照";
    return true;
  } finally {
    globalThis.EventSource = origES;
    globalThis.fetch = origFetch;
  }
});

console.log("\n" + "═".repeat(58));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  SSE 推送验收全过");
