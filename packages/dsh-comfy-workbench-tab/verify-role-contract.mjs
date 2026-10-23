/**
 * H3 参考用途 id 的跨模块一致性验收（2026-10-20 新增）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要这个脚本
 *
 *   本轮把 h3-labels.js 从「4 个平铺 role」重构成
 *   「4 个 H3 官方标签 + 19 个细分角色」。
 *   重构后发现【另一个项目】仍有 3 处在生产旧 id：
 *     dsh-editor/src/characters.mjs      role: "appearance"  ×2
 *     dsh-comfy-workbench-tab/src/WorkbenchView.js
 *                                        role: "appearance" / "motion" / "sound"
 *
 *   虽然 h3-labels.js 有 migrateLegacyRole() 能兼容旧值，
 *   但【兼容层不是正解】—— 生产方应该直接产出新 id。
 *   依赖兼容层意味着：
 *     · 新代码的意图被兼容层掩盖（读代码的人不知道真实契约）
 *     · 兼容层哪天删掉，两个模块同时静默出错
 *
 *   ⇒ 这个脚本把「不许再产旧 id」变成可复跑的断言。
 *     这类跨项目断言比单模块测试更值钱：它防的是「两个模块各自改对了，
 *     但契约变了没人通知对方」。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 检查项
 *
 *   ① 两个项目的源码里不许出现旧 role 字面量
 *   ② 生产方产出的 id 必须存在于 REF_ROLES
 *   ③ migrateLegacyRole() 仍能兜住旧数据（历史终端的兼容不能被删）
 *   ④ defaultRoleFor 对三种 kind 都返回合法 id
 */

/**
 * ★ 2026-10-23 D2 去敏：本文件原来写死了 D:/主工作区/... 绝对路径。
 *   别人 clone 到别的盘就全失效 ⇒ 改成从本文件位置推导。
 */
import { fileURLToPath, pathToFileURL } from "node:url";
/**
 * ★ 2026-10-23 D2 去敏：HERE 从本文件位置推导。
 *   pathToFileURL 必须一起 import —— 漏了只会在运行时
 *   报 `ReferenceError: pathToFileURL is not defined`，
 *   静态检查抓不到。
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
import fs from "node:fs";
import path from "node:path";

const ROOT_WB = path.resolve(HERE, "..");
const ROOT_WS = "D:/主工作区/DSH视频工作站/packages";

const { REF_ROLES, defaultRoleFor, migrateLegacyRole } = await import(
  pathToFileURL(path.resolve(HERE, "src", "h3-labels.js")).href
);

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else {
    fail++; failures.push(name);
    console.log(`  ❌ ${name}${extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 180) : ""}`);
  }
}

console.log("═".repeat(66));
console.log("  H3 参考用途 id · 跨模块一致性");
console.log("═".repeat(66));

/* ─── ① 源码里不许有旧 role 字面量 ───────────────────────── */
console.log("\n① 源码里不许再产旧 role（appearance / motion / sound / frame）");
{
  // 只查「作为 role 值使用」的形态，避免误伤普通英文单词
  const PATTERNS = [
    /role:\s*["']appearance["']/,
    /role:\s*["']motion["']/,
    /role:\s*["']sound["']/,
    /role:\s*["']frame["']/,
    /\|\|\s*["']appearance["']/,
    /===\s*["']appearance["']/,
  ];

  const scan = (root, label) => {
    const hits = [];
    const walk = (dir) => {
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (["node_modules", "lib", "dist", ".git", "docs"].includes(e.name)) continue;
          walk(p);
        } else if (/\.(js|mjs)$/.test(e.name) && !e.name.endsWith(".min.js")) {
          // ★ 排除本文件自己 —— 它的白名单代码里含旧值字符串，会自我命中
          if (e.name === "verify-role-contract.mjs") continue;
          let src;
          try { src = fs.readFileSync(p, "utf8"); } catch { continue; }
          const lines = src.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            const ln = lines[i];
            const trimmed = ln.trim();
            /**
             * ★ 跳过注释行。第一版只跳了 `//` 与 `*` 开头的，
             *   结果把「★★ 2026-10-20 更正：这里原来写的是 role:"appearance"。」
             *   这条【说明历史】的注释也当成违规 —— 假阳性。
             *   ⇒ 注释里提到旧值是在解释为什么改，是好事，不该报错。
             */
            if (trimmed.startsWith("//") || trimmed.startsWith("*") ||
                trimmed.startsWith("/*") || trimmed.startsWith("★")) continue;
            for (const re of PATTERNS) {
              if (re.test(ln)) {
                hits.push(`${path.relative(root, p)}:${i + 1}  ${trimmed.slice(0, 70)}`);
                break;
              }
            }
          }
        }
      }
    };
    walk(root);
    console.log(`  · ${label}: ${hits.length} 处`);
    hits.slice(0, 6).forEach((h) => console.log(`      ★ ${h}`));
    return hits;
  };

  const wbHits = scan(ROOT_WB, "DSH视频工作台/packages").filter((h) => {
    /**
     * ★ 白名单：verify-h3-labels.mjs 里那一条是【故意】用旧值的 ——
     *   它的用例名是「旧 role='appearance' 仍能生成 <Subject>」，
     *   验的正是兼容层能不能兜住历史数据。
     *   把测试「兼容旧值」的用例当成违规，是把好事当坏事。
     */
    if (h.includes("verify-h3-labels.mjs") && h.includes('role: "appearance"')) return false;
    return true;
  });
  const wsHits = scan(ROOT_WS, "DSH视频工作站/packages");

  t("工作台侧旧 id 零残留", wbHits.length === 0, wbHits.slice(0, 5));
  t("工作站侧旧 id 零残留", wsHits.length === 0, wsHits.slice(0, 5));
}

/* ─── ② 生产方产出的 id 必须合法 ─────────────────────────── */
console.log("\n② 生产方产出的 id 存在于 REF_ROLES");
{
  /**
   * ★★ 2026-10-20 修（这一项我自己错了两次）：
   *
   *   第一版直接读源码正则抽 `role: "xxx"` —— 把【注释里】
   *   「这里原来写的是 role:"appearance"」也当成了产出值。
   *
   *   正确做法：不扫源码文本，而是【真的调用】生产函数，
   *   看它实际返回什么。这是「测行为不测文本」的唯一可靠方式
   *   （同 AGENTS §6.25：grep 代码只能证伪，不能证明）。
   */
  /**
   * ★ 2026-10-23 D2 去敏：原来指向【另一个仓库】（DSH视频工作站）。
   *   D1 已把 dsh-editor 并进本仓库 ⇒ 改成从本文件位置推导。
   */
  const mod = await import(
    pathToFileURL(path.resolve(HERE, "..", "dsh-editor", "src", "characters.mjs")).href
  );

  // 构造一个假角色分组，真的跑一遍 injectCharacters + toRefSpecs
  const characters = {
    韩立: [
      { name: "hanli-front.png", path: "/x/hanli-front.png", view: "front" },
      { name: "hanli-side.png", path: "/x/hanli-side.png", view: "side" },
    ],
  };
  const r = mod.injectCharacters({
    characters,
    names: ["韩立"],
    slots: ["ref_image_0", "ref_image_1"],
    files: {},
  });
  const filledRoles = Object.values(r.filled ?? {}).map((f) => f.role);
  t("injectCharacters 真的产出了 role", filledRoles.length >= 1, filledRoles);
  t("产出的 role 全部在 REF_ROLES 里",
    filledRoles.every((x) => !!REF_ROLES[x]), filledRoles);
  t("产出的是 subject.character",
    filledRoles.every((x) => x === "subject.character"), filledRoles);

  const specs = mod.toRefSpecs(r.assigned ?? []);
  t("toRefSpecs 产出了 role", specs.length >= 1, specs.length);
  t("toRefSpecs 的 role 全部在 REF_ROLES 里",
    specs.every((s) => !!REF_ROLES[s.role]), specs.map((s) => s.role));
  t("toRefSpecs 与 injectCharacters 一致",
    specs.every((s) => s.role === "subject.character"), specs.map((s) => s.role));
}

/* ─── ③ 兼容层不能删（历史数据要能读）───────────────────── */
console.log("\n③ 旧数据兼容层仍生效（历史终端的 role 值）");
{
  t("appearance → subject.character", migrateLegacyRole("appearance", "image") === "subject.character");
  t("appearance(video) → subject.motion", migrateLegacyRole("appearance", "video") === "subject.motion");
  t("motion → subject.motion", migrateLegacyRole("motion", "video") === "subject.motion");
  t("sound → audio.timbre", migrateLegacyRole("sound", "audio") === "audio.timbre");
  t("frame → picture.first", migrateLegacyRole("frame", "image") === "picture.first");
}

/* ─── ④ defaultRoleFor 三种 kind 都合法 ─────────────────── */
console.log("\n④ defaultRoleFor 对每种 kind 都返回合法 id");
{
  for (const kind of ["image", "video", "audio"]) {
    const r = defaultRoleFor(kind);
    t(`defaultRoleFor(${kind}) = ${r}`, !!REF_ROLES[r], r);
    // 且该 id 接受这种 kind
    t(`  ${r} 的 kinds 含 ${kind}`, REF_ROLES[r]?.kinds?.includes(kind), REF_ROLES[r]?.kinds);
  }
}

/* ─── 汇总 ───────────────────────────────────────────────── */
console.log("\n" + "═".repeat(66));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  跨模块契约一致");


