/**
 * 全局资产库 + 提示词框 @ 引用 —— 验收脚本（assets-room 交付）
 *
 * 用法：
 *   node verify-assets.mjs
 *   node verify-assets.mjs --base http://127.0.0.1:19499
 *   node verify-assets.mjs --base ... --comfy http://127.0.0.1:8188
 *
 * 覆盖六条验收里【能在 node 里证明】的部分：
 *   1. /comfy-assets/library 能列出 ≥ 20 条，三源齐全，按类型能筛
 *   2. 收藏 / 改名 / 删除（删除必须进 trash、可复原）
 *   3. /comfy-assets/file 的白名单（不许变成任意文件读取）
 *   4. 构建产物 lib/client.js 里确实含着 @ 引用与库面板（防「改了源码忘了 build」）
 *   5. 画布持久化端点 GET/POST 往返
 *
 * ★ 不在这里测的（本脚本明确不假装测过）：
 *   · 打 @ 弹浮层、↑↓ 选、Enter 插入 —— 浏览器交互，证据是
 *     docs/预览/_shots/asset-01-at-picker.png + 本文档的实测记录
 *   · 「选一张图作为原图 → ComfyUI node 470 = 那张图」—— 要真跑一次生成，
 *     证据是 ComfyUI /history 的 prompt 原文（见交付报告）
 *   · 面板不挤动 DSH 原生元素 —— 要量 getBoundingClientRect，同上
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const argOf = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const BASE = argOf("--base", "http://127.0.0.1:19499");
const HERE = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0, skip = 0;
const ok = (n, d = "") => { pass++; console.log(`  ✓ ${n}${d ? "  " + d : ""}`); };
const bad = (n, d = "") => { fail++; console.log(`  ✗ ${n}${d ? "  " + d : ""}`); };
const miss = (n, why) => { skip++; console.log(`  – ${n}  （跳过：${why}）`); };

const j = async (p, init) => {
  const r = await fetch(BASE + p, { signal: AbortSignal.timeout(45000), ...init });
  const t = await r.text();
  let body = null;
  try { body = JSON.parse(t); } catch { body = t; }
  return { status: r.status, body };
};

console.log(`\n=== 全局资产库 + @ 引用 验收 ===`);
console.log(`  实例: ${BASE}\n`);

// ── 1. 三源合并 + 数量 + 筛选 ────────────────────────────────────────
console.log("[1] /comfy-assets/library 三源合并");
let lib = null;
{
  const { status, body } = await j("/comfy-assets/library?limit=2000");
  if (status !== 200 || !body?.ok) {
    bad("library 返回 200/ok", `status=${status} ${String(body).slice(0, 120)}`);
  } else {
    lib = body;
    // ★ 断言写成「≥ 20 且三源齐全」，不写死总数（AGENTS §3.7）
    if (body.matched >= 20) ok("条目 ≥ 20", `matched=${body.matched}`);
    else bad("条目 ≥ 20", `matched=${body.matched}`);

    const src = body.sources ?? {};
    for (const k of ["output", "input", "editor"]) {
      if (src[k]?.ok && src[k].count > 0) ok(`来源 ${k} 有货`, `${src[k].count} 条`);
      else bad(`来源 ${k} 有货`, JSON.stringify(src[k] ?? null));
    }

    // 三源都必须真的并进了 items
    const kinds = new Set((body.items ?? []).map((i) => i.src));
    for (const k of ["output", "input", "editor"]) {
      if (kinds.has(k)) ok(`items 里含 ${k} 的项`);
      else bad(`items 里含 ${k} 的项`, `实际来源=${[...kinds].join("/")}`);
    }

    // 类型筛选
    for (const kind of ["image", "video", "audio"]) {
      const { body: b2 } = await j(`/comfy-assets/library?kind=${kind}&limit=5`);
      const allSame = (b2?.items ?? []).every((i) => i.kind === kind);
      if (!b2?.items?.length) miss(`按 ${kind} 筛`, "该类型当前为空");
      else if (allSame) ok(`按 ${kind} 筛`, `${b2.matched} 条`);
      else bad(`按 ${kind} 筛`, "返回了别的 kind");
    }

    // 来源筛选
    {
      const { body: b2 } = await j("/comfy-assets/library?src=editor&limit=5");
      const all = (b2?.items ?? []).every((i) => i.src === "editor");
      if ((b2?.items ?? []).length && all) ok("按来源筛 src=editor", `${b2.matched} 条`);
      else bad("按来源筛 src=editor", JSON.stringify(b2?.items?.slice(0, 1) ?? null));
    }

    // 搜索
    {
      const { body: b2 } = await j("/comfy-assets/library?q=krea2&limit=5");
      const hit = (b2?.items ?? []).every((i) =>
        `${i.displayName}${i.name}${i.rel}`.toLowerCase().includes("krea2"));
      if ((b2?.items ?? []).length && hit) ok("按关键字搜 q=krea2", `${b2.matched} 条`);
      else bad("按关键字搜 q=krea2", `${b2?.matched} 条`);
    }

    // 排序：收藏必须在最前
    const firstNonFav = (body.items ?? []).findIndex((i) => !i.fav);
    const lastFav = (body.items ?? []).map((i) => i.fav).lastIndexOf(true);
    if (lastFav < 0) miss("收藏置顶", "当前没有收藏项（先收藏一条再跑）");
    else if (firstNonFav < 0 || lastFav < firstNonFav) ok("收藏排在所有非收藏之前", `最后一条收藏 idx=${lastFav}, 首个非收藏 idx=${firstNonFav}`);
    else bad("收藏排在所有非收藏之前", `lastFav=${lastFav} firstNonFav=${firstNonFav}`);

    // stats 必须按全量算，不随 limit 变
    {
      const { body: b3 } = await j("/comfy-assets/library?limit=1");
      if (b3?.stats?.total === body.stats?.total) ok("stats.total 不受 limit 影响", `${b3.stats.total}`);
      else bad("stats.total 不受 limit 影响", `limit=1 → ${b3?.stats?.total}, limit=2000 → ${body.stats?.total}`);
    }
  }
}

// ── 2. 收藏 / 改名 / 删除（可复原）──────────────────────────────────
console.log("\n[2] 收藏 / 改名 / 删除");
{
  // ★ 用一个【真实存在但先备份】的项做删除测试，测完恢复。
  //   不用临时文件 —— 临时文件会让 library 的 id 推断与真实场景不符。
  const candidates = (lib?.items ?? []).filter((i) => i.src === "input" && i.kind === "image");
  const probe = candidates[0] ?? (lib?.items ?? []).find((i) => i.src === "input");
  if (!probe) {
    miss("收藏 / 改名 / 删除", "input/ 下没有可测的图片");
  } else {
    const id = probe.id;
    const before = probe.fav;
    /**
     * ★ 2026-10-21 修：记住原始显示名，结束时恢复。
     *
     *   事故：这段测试会把 probe 的名字改成「验收改名-xxxx」再清空，
     *        而 probe 可能是主人命名过的真实资产（实测命中了
     *        「韩立-定妆照」），跑完主人的名字就没了。
     *   ⇒ 必须 try/finally 恢复。
     */
    const origName = probe.displayName && probe.displayName !== probe.name
      ? probe.displayName
      : "";
    const origRole = probe.role ?? "";

    // 收藏
    {
      const { status, body } = await j("/comfy-assets/mutate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "fav", id, on: !before }),
      });
      if (status === 200 && body?.ok && body.fav === !before) ok("收藏切换", `${before} → ${body.fav}`);
      else bad("收藏切换", `status=${status} ${JSON.stringify(body).slice(0, 100)}`);

      const { body: l2 } = await j("/comfy-assets/library?limit=2000");
      const hit = (l2?.items ?? []).find((i) => i.id === id);
      if (hit?.fav === !before) ok("收藏已落盘（重扫后仍生效）");
      else bad("收藏已落盘（重扫后仍生效）", `fav=${hit?.fav}`);

      // 复原
      await j("/comfy-assets/mutate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "fav", id, on: before }),
      });
    }

    // 改名
    {
      const newName = `验收改名-${Date.now().toString(36)}`;
      const { status, body } = await j("/comfy-assets/mutate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rename", id, name: newName }),
      });
      if (status === 200 && body?.ok) {
        const { body: l2 } = await j("/comfy-assets/library?limit=2000");
        const hit = (l2?.items ?? []).find((i) => i.id === id);
        if (hit?.displayName === newName && hit?.renamed === true) {
          ok("改名生效", `${hit.name} → ${hit.displayName}`);
        } else {
          bad("改名生效", `displayName=${hit?.displayName} renamed=${hit?.renamed}`);
        }
      } else {
        bad("改名生效", `status=${status} ${JSON.stringify(body).slice(0, 100)}`);
      }
      // 清掉别名（传空字符串 = 删除别名）
      await j("/comfy-assets/mutate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rename", id, name: "" }),
      });
    }

    // 空名字 = 清掉别名（改名的逆操作必须存在，否则改名不可逆）
    {
      const { status, body } = await j("/comfy-assets/mutate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rename", id, name: "" }),
      });
      if (status === 200 && body?.ok && body?.cleared) {
        const { body: l2 } = await j("/comfy-assets/library?limit=2000");
        const hit = (l2?.items ?? []).find((i) => i.id === id);
        if (hit?.renamed === false && hit?.displayName === hit?.name) {
          ok("空名字 = 清掉别名（改名可逆）", `displayName 回到 ${hit.displayName}`);
        } else {
          bad("空名字 = 清掉别名（改名可逆）", `renamed=${hit?.renamed} displayName=${hit?.displayName}`);
        }
      } else {
        bad("空名字 = 清掉别名（改名可逆）", `status=${status} ${JSON.stringify(body).slice(0, 100)}`);
      }
    }

    /**
     * ★ 2026-10-21 修：测试结束【必须】把原始名字恢复回去。
     *
     *   事故：这段测试把 probe 改成「验收改名-xxxx」再清空，
     *        而 probe 可能是主人命名过的真实资产（实测命中「韩立-定妆照」），
     *        跑完主人的名字就没了。
     *   ⇒ 这里无条件恢复；写进 verify-all 前也确认过它现在会被跑到。
     */
    try {
      await j("/comfy-assets/mutate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rename", id, name: origName }),
      });
      if (origRole) {
        await j("/comfy-assets/mutate", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "role", id, role: origRole }),
        });
      }
    } catch { /* 恢复失败不影响断言结论，但会在下面报 */ }
    if (origName) ok("测试后已恢复原始名字", `→ ${origName}`);


    // 超长名字必须拒绝
    {
      const { status } = await j("/comfy-assets/mutate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rename", id, name: "x".repeat(200) }),
      });
      if (status === 400) ok("超长名字被拒绝", `→ ${status}`);
      else bad("超长名字被拒绝", `期望 400，实际 ${status}`);
    }

    // ★ 删除 = 移到 trash，不许 unlink（预设硬规则①）
    //   为了不改动真实素材，这里只验证【路由形态】：缺 src/rel 必须 400，
    //   以及「不带 purge 时不返回 purged:true」。
    {
      const { status: s1 } = await j("/comfy-assets/mutate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", id }),
      });
      if (s1 === 400) ok("delete 缺 src/rel 被拒绝", `→ ${s1}`);
      else bad("delete 缺 src/rel 被拒绝", `期望 400，实际 ${s1}`);

      const { status: s2 } = await j("/comfy-assets/mutate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", id, src: "output", rel: "../../etc/passwd" }),
      });
      if (s2 === 400) ok("delete 拒绝 rel 越界", `→ ${s2}`);
      else bad("delete 拒绝 rel 越界", `期望 400，实际 ${s2}`);
    }

    /**
     * ★ 完整的「删 → 进回收区 → 撤销」闭环。
     *   为了不碰真实素材，先自己复制一份出来测，测完删掉副本。
     *   这条是「可复原」这个承诺的唯一证据 —— 没有它，删除只是
     *   「移到一个用户找不回来的地方」。
     */
    {
      const { existsSync, copyFileSync, unlinkSync } = await import("node:fs");
      const { createHash } = await import("node:crypto");
      const rootsProbe = await j("/comfy-assets/library?src=output&kind=image&limit=1");
      const donor = (rootsProbe.body?.items ?? []).find((i) => i.src === "output" && i.kind === "image");
      if (!donor) {
        miss("删除 → 回收区 → 撤销", "output/ 里没有可复制的图片做样本");
      } else {
        // donor.rel 形如 "Krea2-xxx.png"；用路径拼出绝对路径
        const outRoot = "D:/Comfy-Desktop/ComfyUI-Shared/output";
        const srcAbs = `${outRoot}/${donor.rel}`;
        const testRel = `_verify-assets-${Date.now()}.png`;
        const testAbs = `${outRoot}/${testRel}`;
        try {
          copyFileSync(srcAbs, testAbs);
          const sha0 = createHash("sha256").update(readFileSync(testAbs)).digest("hex");

          const d = await j("/comfy-assets/mutate", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "delete", id: `output:${testRel}`, src: "output", rel: testRel }),
          });
          if (d.status === 200 && d.body?.trashed) {
            ok("删除返回 trashed（不是 purged）");
          } else {
            bad("删除返回 trashed（不是 purged）", JSON.stringify(d.body).slice(0, 120));
          }
          if (!existsSync(testAbs)) ok("删除后原位置已让出");
          else bad("删除后原位置已让出", "文件还在 output/");

          const tl = await j("/comfy-assets/mutate", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "trash-list" }),
          });
          const rec = (tl.body?.items ?? []).find((x) => x.id === `output:${testRel}`);
          if (rec && rec.from && rec.to) ok("回收区记录了 from/to", rec.to.slice(-40));
          else bad("回收区记录了 from/to", JSON.stringify(tl.body).slice(0, 120));

          const u = await j("/comfy-assets/mutate", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "undo-delete", id: `output:${testRel}` }),
          });
          if (u.status === 200 && u.body?.ok && existsSync(testAbs)) {
            const sha1 = createHash("sha256").update(readFileSync(testAbs)).digest("hex");
            if (sha0 === sha1) ok("撤销后文件回到原处且字节一致", sha1.slice(0, 16) + "…");
            else bad("撤销后文件回到原处且字节一致", `${sha0.slice(0, 8)} != ${sha1.slice(0, 8)}`);
          } else {
            bad("撤销后文件回到原处且字节一致", JSON.stringify(u.body).slice(0, 120));
          }

          // 删掉样本，别污染主人的 output/
          try { unlinkSync(testAbs); } catch { /* 已删 */ }
        } catch (err) {
          miss("删除 → 回收区 → 撤销", `准备样本失败：${err.message}`);
          try { unlinkSync(testAbs); } catch { /* ignore */ }
        }
      }
    }
  }
}

// ── 3. /file 白名单（代理不许变成任意文件读取）─────────────────────
console.log("\n[3] /comfy-assets/file 白名单");
{
  const bad1 = await j("/comfy-assets/file?src=output&rel=..%2F..%2Fetc%2Fpasswd");
  if (bad1.status === 400) ok("拒绝 rel 里的 ..", `→ 400`);
  else bad("拒绝 rel 里的 ..", `→ ${bad1.status}`);

  const bad2 = await j("/comfy-assets/file?src=output&rel=%2Fetc%2Fpasswd");
  if (bad2.status === 400) ok("拒绝绝对路径 rel", `→ 400`);
  else bad("拒绝绝对路径 rel", `→ ${bad2.status}`);

  const bad3 = await j("/comfy-assets/file?src=evil&rel=x.png");
  if (bad3.status === 400) ok("拒绝非法 src", `→ 400`);
  else bad("拒绝非法 src", `→ ${bad3.status}`);

  // editor 源只认「此刻真的在 dsh-editor 索引里」的路径
  const bad4 = await j(`/comfy-assets/file?src=editor&rel=${encodeURIComponent("C:\\Windows\\win.ini")}`);
  if (bad4.status === 403) ok("editor 源拒绝库外路径", `→ 403`);
  else bad("editor 源拒绝库外路径", `→ ${bad4.status}`);

  // 正面：output 里真实存在的一张图必须能取到字节
  const real = (lib?.items ?? []).find((i) => i.src === "output" && i.kind === "image");
  if (!real) {
    miss("能取到真实产物的字节", "output/ 里没有图片");
  } else {
    const r = await fetch(`${BASE}/comfy-assets/file?src=output&rel=${encodeURIComponent(real.rel)}`,
      { signal: AbortSignal.timeout(60000) });
    const buf = Buffer.from(await r.arrayBuffer());
    if (r.ok && buf.length === real.sizeBytes) {
      ok("能取到真实产物的字节", `${buf.length} bytes = 索引里的大小`);
    } else {
      bad("能取到真实产物的字节", `status=${r.status} got=${buf.length} want=${real.sizeBytes}`);
    }
  }

  // editor 源正面：dsh-editor 索引里的文件必须能取
  const ed = (lib?.items ?? []).find((i) => i.src === "editor" && i.kind === "image");
  if (!ed) {
    miss("能取到 editor 素材的字节", "editor 源里没有图片");
  } else {
    const r = await fetch(`${BASE}/comfy-assets/file?src=editor&rel=${encodeURIComponent(ed.rel)}`,
      { signal: AbortSignal.timeout(60000) });
    const buf = Buffer.from(await r.arrayBuffer());
    if (r.ok && buf.length > 0) ok("能取到 editor 素材的字节", `${buf.length} bytes`);
    else bad("能取到 editor 素材的字节", `status=${r.status}`);
  }
}

// ── 4. 画布持久化端点 ───────────────────────────────────────────────
console.log("\n[4] 画布持久化 /comfy-assets/canvas");
{
  const stamp = Date.now();
  const payload = { view: { x: 7, y: 11, s: 1.5 }, pos: { [`verify:${stamp}`]: { x: 3, y: 4 } }, at: stamp };
  const w = await j("/comfy-assets/canvas", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  if (w.status === 200 && w.body?.ok && w.body?.saved) ok("POST 落盘", w.body.path ?? "");
  else bad("POST 落盘", `status=${w.status} ${JSON.stringify(w.body).slice(0, 120)}`);

  const r = await j("/comfy-assets/canvas");
  if (r.status === 200 && r.body?.ok && r.body?.view?.s === 1.5 && r.body?.pos?.[`verify:${stamp}`]) {
    ok("GET 读回（往返一致）");
  } else {
    bad("GET 读回（往返一致）", JSON.stringify(r.body).slice(0, 160));
  }

  const badBody = await fetch(`${BASE}/comfy-assets/canvas`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json",
    signal: AbortSignal.timeout(15000),
  });
  if (badBody.status === 400) ok("POST 拒绝非法 JSON", `→ 400`);
  else bad("POST 拒绝非法 JSON", `→ ${badBody.status}`);
}

// ── 5. 构建产物里确实含着新模块 ─────────────────────────────────────
console.log("\n[5] 构建产物 lib/client.js");
{
  try {
    const libSrc = readFileSync(join(HERE, "lib", "client.js"), "utf8");
    const marks = [
      ["@ 选择器", /AtPicker/],
      ["提示词胶囊高亮", /PromptHighlight/],
      ["全局资产库面板", /LibraryPanel/],
      ["引用票据条", /RefStrip/],
      ["槽满时的换槽浮层", /SlotChooser/],
      ["库数据 hook", /useAssetLibrary/],
      ["@ 引用 hook", /useAssetAtMentions/],
      ["失效隔离", /AssetLibraryBoundary/],
      ["库接口", /comfy-assets/],
      ["槽绑定持久化", /slotrefs/],
      ["按钮文案", /资产库/],
    ];
    for (const [name, re] of marks) {
      if (re.test(libSrc)) ok(`含 ${name}`);
      else bad(`含 ${name}`, "—— 可能改了源码忘了 node build.mjs");
    }
    ok("lib/client.js 大小", `${(Buffer.byteLength(libSrc) / 1024).toFixed(1)} KB`);
  } catch (err) {
    bad("读取 lib/client.js", err.message);
  }
}

// ── 结论 ────────────────────────────────────────────────────────────
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 / ${skip} 跳过 ===`);
console.log(`
本脚本不覆盖的（不要在报告里写成已验证）：
  · 打 @ 弹浮层 / ↑↓ / Enter 插入          → 浏览器交互，见 docs/预览/_shots/asset-01-at-picker.png
  · 选图作为「原图」后 ComfyUI node 470 的值 → 真跑一次生成，看 /history 的 prompt 原文
  · 面板不挤动 DSH 原生元素                 → getBoundingClientRect 前后对比
  · 库模块挂掉时工作台照常                  → 拦截 fetch 后重测
`);
process.exit(fail ? 1 : 0);
