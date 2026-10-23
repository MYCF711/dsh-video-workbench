// 用 live /object_info 做精确字段名，把 UI 工作流转成 API 格式
import fs from "node:fs";
import { uiToApi, summarize } from "./ui-to-api.mjs";

const SRC = process.argv[2];
const DEST = process.argv[3];
if (!SRC || !DEST) {
  console.error("用法: node convert-workflow.mjs <UI.json> <out-api.json>");
  process.exit(1);
}

const ui = JSON.parse(fs.readFileSync(SRC, "utf8"));

// 拉 /object_info（ComfyUI 在线才有精确字段名）
let objectInfo = null;
try {
  const res = await fetch("http://127.0.0.1:8188/object_info", { signal: AbortSignal.timeout(20000) });
  if (res.ok) objectInfo = await res.json();
  console.log(objectInfo ? `✓ /object_info 拿到 ${Object.keys(objectInfo).length} 个节点定义` : "✗ /object_info 无响应");
} catch (e) {
  console.log("✗ ComfyUI 离线，退回硬编码字段名表：", e.message.slice(0, 80));
}

const { prompt, warnings } = uiToApi(ui, { objectInfo });
const s = summarize(prompt);

console.log("");
console.log("=== 转换结果 ===");
console.log("节点数:", s.nodeCount);
console.log("类型分布:");
for (const [k, v] of Object.entries(s.classes).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(3)}  ${k}`);
}

if (s.dangling.length) {
  console.log("");
  console.log("❌ 悬空连线（指向不存在的节点）:", s.dangling.length);
  s.dangling.slice(0, 10).forEach((d) => console.log("   ", d));
} else {
  console.log("");
  console.log("✓ 无悬空连线");
}

if (warnings.length) {
  console.log("");
  console.log("⚠ warnings:", warnings.length);
  warnings.slice(0, 10).forEach((w) => console.log("   ", w));
}

fs.writeFileSync(DEST, JSON.stringify(prompt, null, 2), "utf8");
console.log("");
console.log("已写出:", DEST);
