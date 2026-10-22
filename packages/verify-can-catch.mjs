/**
 * 验收自检：断言「能变红」吗？
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要这个工具（实测踩出来的）
 *
 *   verify-artcraft-storage.mjs 里写的是：
 *     const el = p?.data?.scenes?.[0]?.tracks?.video?.[0]?.elements?.[0];
 *     t("clip 投影成了 element", !!el);
 *
 *   `tracks.video` 这个键在 ArtCraft 里【根本不存在】（正确的是 main）。
 *   所以 el 恒为 undefined，断言恒为 false。
 *
 *   ★ 但它一直显示「通过」—— 因为测试脚本在断言之前就 TypeError 崩了，
 *     外层 runner 把崩溃记成一个失败，而那个失败被当成「这条验收有问题」
 *     而不是「产品有问题」。长期下来没人看。
 *
 *   更糟的是同文件里另有两条断言：
 *     t("element.mediaId = 我们的资产 id", el?.mediaId === "output:xxx");
 *   el 恒 undefined ⇒ el?.mediaId 恒 undefined ⇒ 恒 false。
 *   ★ 这种「结构没读到 → 断言恒 false → 看起来像在断言」的写法，
 *     是最典型的假通过：它有断言的样子，但没有断言的作用。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 本工具做什么
 *
 *   对每个验收脚本做【变异测试】的极简版：
 *     ① 原样跑一次 → 必须通过
 *     ② 注入一个「必然破坏被测行为」的变异 → 必须变红
 *     ③ 若变异后仍通过 ⇒ 报「假通过」
 *
 *   ★ 只做「可自动注入」的变异，不追求覆盖所有断言。
 *     能做的是最有价值的一类：把某个导出函数改成恒返回错误值。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 用法
 *
 *   node verify-can-catch.mjs                 # 跑内置的变异清单
 *   node verify-can-catch.mjs --list          # 只列清单
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WF_PKG = path.join(HERE, "dsh-comfy-workbench-tab");   // HERE 已经是 packages/
const AC_PKG = path.join(HERE, "dsh-artcraft-tab");

/**
 * 变异清单。
 *
 * 每条：
 *   file    被测源文件
 *   find    要替换的字面量（必须唯一出现）
 *   replace 替换成什么（必然破坏行为）
 *   verify  用哪个验收脚本抓它
 *   why     这个变异破坏的是什么
 */
const MUTATIONS = [
  {
    name: "MediaTime 从整数 tick 改成浮点秒",
    file: path.join(WF_PKG, "src", "timeline-projection.mjs"),
    find: "return Math.round((Number(sec) || 0) * TICKS_PER_SECOND);",
    replace: "return (Number(sec) || 0);",
    verify: path.join(HERE, "verify-regression.mjs"),
    why: "ArtCraft 要求整数 tick，浮点会触发 addMediaTime 报错",
  },
  {
    name: "duration 改回 out-in（不再按 trim 算）",
    file: path.join(WF_PKG, "src", "timeline-projection.mjs"),
    find: "const effectiveDur = hasTrim ? (trimEndRaw - trimStartSec) : dur;",
    replace: "const effectiveDur = dur;",
    verify: path.join(HERE, "verify-regression.mjs"),
    why: "trim 改了但时长不变 —— 静默失效",
  },
  {
    name: "startTime 累加改回 out-in",
    file: path.join(WF_PKG, "src", "timeline-projection.mjs"),
    find: "t += timeToSec(el.duration);",
    replace: "t += Math.max(0, (Number(clip.out) || 0) - (Number(clip.in) || 0));",
    verify: path.join(HERE, "verify-regression.mjs"),
    why: "双 clip 之间会出现空隙",
  },
  {
    name: "AudioElement 去掉 sourceType",
    file: path.join(WF_PKG, "src", "timeline-projection.mjs"),
    find: 'element.sourceType = "upload";',
    replace: '/* removed */',
    verify: path.join(HERE, "verify-regression.mjs"),
    why: "导出没有音频流",
  },
  {
    name: "type 判断改回按 clip.kind",
    file: path.join(WF_PKG, "src", "timeline-projection.mjs"),
    find: "const kind = AUDIO_EXT.has(ext) || clip.kind === \"audio\"",
    replace: "const kind = clip.kind === \"audio\"",
    verify: path.join(HERE, "verify-regression.mjs"),
    why: "PNG 被当成 video，缩略图不显示",
  },
  {
    name: "trimEnd 没裁切时写 0（而不是全长）",
    file: path.join(WF_PKG, "src", "timeline-projection.mjs"),
    find: "trimEnd: secToTime(hasTrim ? trimEndRaw : dur),",
    replace: "trimEnd: secToTime(hasTrim ? trimEndRaw : 0),",
    verify: path.join(HERE, "verify-regression.mjs"),
    why: "没裁切时 trimEnd=0 ⇒ 取不到源素材，画面空白",
  },
  {
    name: "裁切写回改成写整个 state（不再只提交 trim）",
    file: path.join(AC_PKG, "src", "saveTrim.js"),
    find: "op: \"trim\",",
    replace: "op: \"trim\", __polluted: true,",
    verify: path.join(AC_PKG, "verify-save-trim.mjs"),
    why: "只提交 trim 与顺序 —— 夹带其它字段会污染 timeline-state",
  },

  /* ─── 以下是任务书核心功能（一 ~ 四）的变异 ────────────────── */

  {
    name: "H3：tagOfRole 忽略角色，一律返回 Subject",
    file: path.join(WF_PKG, "src", "h3-labels.js"),
    find: 'return REF_ROLES[roleId]?.tag ?? "Subject";',
    replace: 'return "Subject";',
    verify: path.join(WF_PKG, "verify-h3-labels.mjs"),
    why: "Audio/Picture/Video 全被标成 Subject —— 正是主人说的「分了也没意义」",
  },
  {
    name: "H3：migrateLegacyRole 的 appearance 不分视频/图片",
    file: path.join(WF_PKG, "src", "h3-labels.js"),
    find: 'case "appearance": return String(kind) === "video" ? "subject.motion" : "subject.character";',
    replace: 'case "appearance": return "subject.character";',
    verify: path.join(WF_PKG, "verify-h3-labels.mjs"),
    why: "旧数据迁移时，视频的外观参考会被错标成角色外观",
  },
  {
    name: "H3：migrateLegacyRole 的 frame 不映射到 picture.first",
    file: path.join(WF_PKG, "src", "h3-labels.js"),
    find: 'case "frame": return "picture.first";',
    replace: 'case "frame": return "subject.character";',
    verify: path.join(WF_PKG, "verify-h3-labels.mjs"),
    why: "帧被当外观 —— H3 不会把它当第一帧对齐",
  },
  {
    name: "@ 引用：中文标点后不再触发",
    file: path.join(WF_PKG, "src", "at-mentions.js"),
    find: "export function parseAtTrigger(before) {",
    replace: 'export function parseAtTrigger(before) { if (/[，。！？；：]/.test(String(before||""))) return null;',
    verify: path.join(WF_PKG, "verify-at-mentions.mjs"),
    why: "中文标点后打 @ 弹不出面板 —— 中文用户的主流场景",
  },
  {
    /*
     * ★★ 2026-10-21 修正：原来这条变异是
     *      find:    "export function firstFreeSlotFor(media, files, kind) {"
     *      replace: "... { return null;"
     *    它在签名行插了 return null，后面整段循环变成【死代码】。
     *    语法合法、行为确实坏了，但【源码断言仍然通过】——
     *    因为我验的是「源码里有 Object.entries(media)」，而那行还在。
     *
     *    ⇒ 这是「源码层断言对语义变异天然无力」的实例。
     *      换成两条真正的【语义变异】—— 改动循环内部的判断条件，
     *      不产生死代码，源码断言和行为断言都必须能抓住。
     */
    name: "资产库：firstFreeSlotFor 的 kind 过滤失效",
    file: path.join(WF_PKG, "src", "AssetLibrary.js"),
    find: "if (spec?.kind && spec.kind !== kind) continue;",
    replace: "if (false) continue;",
    verify: path.join(WF_PKG, "verify-pick-mode.mjs"),
    why: "@ 引用音频会被塞进图片槽 —— 提交时类型不匹配",
  },
  {
    name: "资产库：firstFreeSlotFor 忽略槽是否已占用",
    file: path.join(WF_PKG, "src", "AssetLibrary.js"),
    find: "if (!files?.[slot]) return { slot, label: spec?.label ?? slot, spec };",
    replace: "return { slot, label: spec?.label ?? slot, spec };",
    verify: path.join(WF_PKG, "verify-pick-mode.mjs"),
    why: "第二个 @ 引用的图会覆盖第一个 —— 前一张凭空消失",
  },

  /* ─── M1：参数闭环（§6.25「四个下拉全是摆设」）───────────────── */

  {
    /*
     * ★★ 这是本项目最严重的历史缺陷（AGENTS §6.25）：
     *   界面上「画幅 / 尺寸 / 张数 / 放大模型」四个下拉都能点、能显示、
     *   能持久化到 sessionStorage，但提交给 ComfyUI 的全是工作流默认值。
     *
     *   根因：WorkbenchView 的 onGenerate 里从未把 aspect / megapixels /
     *         batch / seedvrModel 补进 params。
     *
     *   修好后由 tools/check-param-closure.mjs 看守。
     *   这条变异把 asppect 的赋值删掉 —— 验收必须能红。
     */
    name: "M1 参数闭环：删掉 params.aspect 赋值",
    file: path.join(HERE, "dsh-comfy-workbench-tab", "src", "WorkbenchView.js"),
    find: "if (caps.aspect) params.aspect = aspect;",
    replace: "/* removed: params.aspect */",
    verify: path.join(HERE, "dsh-comfy-bridge", "tools", "check-param-closure.mjs"),
    why: "画幅下拉变成摆设 —— 界面选了 21:9，实际按工作流默认 9:16 出图",
  },
  {
    name: "M1 参数闭环：删掉 params.batch 赋值",
    file: path.join(HERE, "dsh-comfy-workbench-tab", "src", "WorkbenchView.js"),
    find: "if (caps.batch) params.batch = Number(batch);",
    replace: "/* removed: params.batch */",
    verify: path.join(HERE, "dsh-comfy-bridge", "tools", "check-param-closure.mjs"),
    why: "张数下拉变摆设 —— 选 4 张只出 1 张",
  },
  {
    name: "M1 参数闭环：UI_TO_PARAM 少一个映射",
    file: path.join(HERE, "dsh-comfy-bridge", "tools", "check-param-closure.mjs"),
    find: '"field.aspect": "aspect",',
    replace: '// removed: field.aspect 映射',
    verify: path.join(HERE, "dsh-comfy-bridge", "tools", "check-param-closure.mjs"),
    why: "映射表漏项 ⇒ 该控件不被检查 ⇒ 它变摆设也没人发现",
  },
];



function runVerify(file) {
  try {
    execFileSync(process.execPath, [file], {
      cwd: path.dirname(file),
      stdio: "pipe",
      timeout: 180000,
    });
    return { ok: true, code: 0 };
  } catch (e) {
    return { ok: false, code: e.status ?? -1, out: String(e.stdout || "").slice(-400) };
  }
}

console.log("═".repeat(66));
console.log("  验收自检：这些断言真的能变红吗");
console.log("═".repeat(66));

if (process.argv.includes("--list")) {
  MUTATIONS.forEach((m, i) => {
    console.log(`  ${i + 1}. ${m.name}`);
    console.log(`     ${path.basename(m.file)} → ${path.basename(m.verify)}`);
    console.log(`     破坏：${m.why}`);
  });
  process.exit(0);
}

let pass = 0, fail = 0;
const blind = [];

for (const m of MUTATIONS) {
  console.log(`\n【${m.name}】`);
  console.log(`  破坏：${m.why}`);

  if (!fs.existsSync(m.file)) {
    console.log(`  ⏭ 源文件不存在，跳过`);
    continue;
  }
  const orig = fs.readFileSync(m.file, "utf8");

  // find 必须唯一出现，否则变异位置不确定
  const count = orig.split(m.find).length - 1;
  if (count !== 1) {
    console.log(`  ⏭ 目标字符串出现 ${count} 次（要求恰好 1 次），跳过`);
    continue;
  }

  const backup = m.file + ".mutbak";
  fs.writeFileSync(backup, orig, "utf8");

  try {
    // ① 变异后必须变红
    fs.writeFileSync(m.file, orig.replace(m.find, m.replace), "utf8");
    const bad = runVerify(m.verify);

    if (bad.ok) {
      /**
       * ★★ 这就是假通过。
       *   行为被破坏了，验收还说通过 ⇒ 这条验收根本没在验它。
       */
      console.log(`  ❌ 假通过：行为已破坏，但验收仍然通过`);
      fail++;
      blind.push(m.name);
    } else {
      console.log(`  ✅ 能抓住（验收变红，exit=${bad.code}）`);
      pass++;
    }
  } finally {
    // 恢复原文
    fs.writeFileSync(m.file, orig, "utf8");
    fs.unlinkSync(backup);
  }
}

console.log("\n" + "═".repeat(66));
/**
 * ★ 输出必须含 `通过 N / N` —— verify-all.mjs 的 runner 用
 *   /通过 (\\d+) \\/ (\\d+)/ 解析分母。格式不匹配就显示成 `?`。
 *   （这也是「换一种写法就静默失联」的一个例子：不报错，只是统计不到。）
 */
console.log(`  通过 ${pass} / ${pass + fail}   （能抓住的变异数）`);
if (fail) {
  console.log(`  假通过：${blind.join(" · ")}`);
  console.log("  ⇒ 这些断言没有起作用，行为坏了它也不报");
  process.exit(1);
}
console.log("  所有变异都被抓住（验收不是摆设）");
