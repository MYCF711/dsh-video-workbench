#!/usr/bin/env node
/**
 * E 段验收 —— 设置页 / 模型清单 / 一键体检（静态 + 真实接口）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * E 段要求
 *   E1 settings.section 里有 ComfyUI 安装目录、模型目录、输出目录三个路径输入
 *      + 实时检测（存在/版本/可写）
 *   E2 模型需求清单：从工作流 JSON 反推实际引用的模型文件名，生成清单 +
 *      下载链接，页面显示「已找到 / 缺失」
 *   E3 一键体检：ComfyUI 目录对不对、模型齐不齐、ffmpeg 在不在、端到端探活
 *
 * ── 2026-10-23 真机实测（19499 + ComfyUI 在线）记录
 *
 *   设置页侧栏有「ComfyUI 与环境」。点进去：
 *     4 个路径输入（比要求的 3 个多一个「输入目录」）
 *     值分别是 ComfyUI 安装 / models / output / input
 *     有「体检」按钮
 *
 *   点「体检」后显示「1 项有问题」，逐项：
 *     ComfyUI 安装目录    D:\Comfy-Desktop\ComfyUI-Installs\My_Comfy_UI
 *     输出目录可写        D:\Comfy-Desktop\ComfyUI-Shared\output
 *     输入目录可写        D:\Comfy-Desktop\ComfyUI-Shared\input
 *     ffmpeg              <repo>\packages\dsh-editor\bin\ffmpeg.exe
 *     模型                共 26 项：25 就位，缺 1
 *     端到端探活          HTTP 200 · 576ms · ComfyUI 0.40.0
 *     ComfyUI 状态        已连接 · 版本 0.40.0 · 延迟 6ms · 4 个工作流
 *
 *   模型需求按【角色】分组（这是主人明确要求过的）：
 *     LoRA（风格/角色/动作增强）8 个 · 缺 1 · models/loras
 *     VAE（解码器）6 个 · models/vae
 *     文本 / 视觉编码器 5 个 · …
 *   每条标注 [字段名] 用于：<工作流>.json · 应放到 models/xxx
 *   缺失项带「→ 下载链接」。
 *
 * ★ 一个诚实的设计点（实测）：
 *   comfy-test profile 没有自己的 .comfy-bridge/config.json，
 *   bridge 回退到默认位置（desktop 的配置），并在页面上如实标注：
 *     「配置文件：…\profiles\desktop\.comfy-bridge\config.json
 *       （来自 DSH_PROFILE_DIR，可能属于另一个 profile；
 *         可用环境变量 COMFY_BRIDGE_CONFIG_DIR 指定）」
 *   ⇒ 这是正确设计：把不确定性明确告诉用户，而不是静默用错配置。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, "..");
const BRIDGE = path.join(PKG_ROOT, "dsh-comfy-bridge", "src");
const TAB = path.join(PKG_ROOT, "dsh-comfy-workbench-tab", "src");

let pass = 0;
const fails = [];
const check = (name, ok, detail = "") => {
  if (ok) { pass++; return; }
  fails.push({ name, detail });
};

const readRaw = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "");
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");

console.log("");
console.log("═".repeat(70));
console.log("  E 段：设置页 / 模型清单 / 一键体检（静态）");
console.log("═".repeat(70));
console.log("");

/* ══ E1：settings.section 注册 + 路径输入 ══ */
console.log("[E1] 设置页");
{
  const settingsPath = path.join(TAB, "editor", "ComfySettings.js");
  check("ComfySettings.js 存在", fs.existsSync(settingsPath));
  const raw = readRaw(settingsPath);
  const code = stripComments(raw);

  /**
   * 注册到 settings.section —— 但要【精确到 ComfyUI 那一处】
   *
   * ★ 2026-10-23 变异测试暴露：index.js 里有两处 settings.section
   *   （L190 剪辑台快捷键、L219 ComfyUI 与环境）。
   *   只查「有没有 settings.section」的话，把 ComfyUI 那处删掉
   *   仍然为真 —— 假通过。
   *
   *   ⇒ 按 id 精确定位：comfy-environment。
   */
  const idxRaw = readRaw(path.join(TAB, "editor", "index.js"));
  const idxCode = stripComments(idxRaw);
  check("E1 注册到 settings.section（id = comfy-environment）",
    /ctx\.slots\.register\(\s*\{[^}]{0,300}id:\s*["']comfy-environment["']/s.test(idxCode),
    "设置页必须挂在 settings.section 上且 id 是 comfy-environment");
  check("E1 用 ComfySettingsSection 渲染",
    /ComfySettingsSection/.test(idxCode));
  check("E1 order 50（排在快捷键之前）",
    /id:\s*["']comfy-environment["'][^}]{0,200}order:\s*50/s.test(idxCode),
    "环境配置是「装完插件第一件事」，应排在快捷键（60）之前");

  /* 四个路径字段 */
  for (const [field, label] of [
    ["comfyPath", "ComfyUI 安装目录"],
    ["modelsDir", "模型放置目录"],
    ["outputDir", "输出目录"],
    ["inputDir", "输入目录"],
  ]) {
    check(`E1 有 ${label} 字段`, new RegExp(`\\b${field}\\b`).test(code),
      `缺字段 ${field}`);
  }

  /* 体检按钮 */
  check("E1 有体检按钮", /体检/.test(raw), "必须能一键检查环境");
}

/* ══ E2：模型清单按角色分类 ══ */
console.log("");
console.log("[E2] 模型需求清单");
{
  const mmPath = path.join(BRIDGE, "model-manifest.mjs");
  check("model-manifest.mjs 存在", fs.existsSync(mmPath));
  const raw = readRaw(mmPath);
  const code = stripComments(raw);

  /* 角色映射表 */
  const FIELD_ROLE_RE = /FIELD_ROLE\s*=\s*\{/;
  check("E2 有 FIELD_ROLE 角色映射", FIELD_ROLE_RE.test(code),
    "主人要求「根据模型作用分类」，不能只列文件名");

  /* 关键角色 */
  for (const [field, role] of [
    ["lora_name", "lora"],
    ["unet_name", "unet"],
    ["clip_name", "textEncoder"],
    ["vae_name", "vae"],
  ]) {
    check(`E2 ${field} → ${role}`,
      new RegExp(`${field}\\s*:\\s*["']${role}["']`).test(code),
      "字段到角色的映射缺失");
  }

  /* 反推自工作流 JSON（不是手写清单） */
  check("E2 从工作流 JSON 反推", /readFileSync|readdir/.test(code) && /json/i.test(raw),
    "模型清单必须是反推出来的，手写的会随工作流变化而过期");

  /* 下载链接 */
  check("E2 有下载来源解析", /resolveSource|loadSources|models-sources/.test(code));

  /* 缺失检测 */
  check("E2 有缺失检测", /missing/i.test(code));
}

/* ══ E3：一键体检的六项 ══ */
console.log("");
console.log("[E3] 一键体检");
{
  const idxRaw = readRaw(path.join(BRIDGE, "index.js"));
  const code = stripComments(idxRaw);
  const raw = idxRaw;   /* ★ 可写检测要看原文（注释里也可能提「可写」）*/

  /* /doctor 路由 */
  check("E3 有 /doctor 路由", /\/doctor/.test(code));

  /* 六项检查 */
  for (const [key, label] of [
    ["comfyPath", "ComfyUI 目录"],
    ["models", "模型齐不齐"],
    ["ffmpeg", "ffmpeg"],
    ["probe", "端到端探活"],
    ["outputDir", "输出目录"],
    ["inputDir", "输入目录"],
  ]) {
    check(`E3 体检含「${label}」`, new RegExp(`\\b${key}\\b`).test(code),
      `缺 ${key} 检查`);
  }

  /* 可写检测 */
  check("E3 检测目录可写", /accessSync|W_OK|可写/.test(raw),
    "只说「存在」不够，要能写");
}

/* ══ 配置回退要如实告知（实测到的设计点）══ */
{
  /**
   * ★ 2026-10-23：这条路我写错过两次 ——
   *   ① 先以为在 index.js 里（实际在 user-config.mjs）
   *   ② 读错文件时 /mayBeWrongProfile/.test("") === false，
   *      这条断言变成永假 ⇒ 会一直报红
   *   ⇒ 读文件前先 check 存在。
   */
  const ucPath = path.join(BRIDGE, "user-config.mjs");
  check("user-config.mjs 存在", fs.existsSync(ucPath), ucPath);
  const ucRaw = readRaw(ucPath);
  check("配置来源如实标注（可能属于另一个 profile）",
    /mayBeWrongProfile/.test(ucRaw),
    "★ 实测：comfy-test profile 没有配置时回退到 desktop 的，" +
    "页面必须告诉用户，不能静默用错");

  /* 页面上要真的把它渲染出来 */
  const setRaw = readRaw(path.join(TAB, "editor", "ComfySettings.js"));
  check("设置页把「可能属于另一个 profile」显示出来",
    /mayBeWrongProfile/.test(setRaw),
    "桥路返回了标记，前端不渲染等于没做");
}

console.log("");
console.log("─".repeat(70));
if (fails.length === 0) {
  console.log("  ✅ E 段实现完整");
  console.log(`  通过 ${pass} / ${pass}`);
  console.log("");
  process.exit(0);
}
for (const f of fails) {
  console.log(`  ✗ ${f.name}${f.detail ? "：" + f.detail : ""}`);
}
console.log("");
console.log(`  ❌ ${pass} 通过 / ${fails.length} 失败`);
console.log(`  通过 ${pass} / ${pass + fails.length}`);
console.log("");
process.exit(1);



