// 用 /object_info 的默认值补全 API prompt 里缺失的必填字段
import fs from "node:fs";

const API_FILE = process.argv[2];
const prompt = JSON.parse(fs.readFileSync(API_FILE, "utf8"));

const info = await (await fetch("http://127.0.0.1:8188/object_info", { signal: AbortSignal.timeout(30000) })).json();

const WIDGET_TYPES = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"]);
const isWidget = (s) => Array.isArray(s) && (Array.isArray(s[0]) || WIDGET_TYPES.has(s[0]));

const filled = [];
const stillMissing = [];
const typeFixes = [];

for (const [id, node] of Object.entries(prompt)) {
  const spec = info[node.class_type];
  if (!spec) { stillMissing.push(`${id}: 未知节点类型 ${node.class_type}`); continue; }

  const req = spec.input?.required ?? {};
  const opt = spec.input?.optional ?? {};

  for (const [name, s] of Object.entries(req)) {
    // 只处理 widget 类型（连线类型必须由上游提供，不能补默认值）
    if (!isWidget(s)) continue;
    const has = Object.prototype.hasOwnProperty.call(node.inputs, name);
    if (has) {
      // 类型修复：INT/FLOAT 却是空串
      const v = node.inputs[name];
      if ((s[0] === "INT" || s[0] === "FLOAT") && v === "") {
        const def = s[1]?.default ?? 0;
        node.inputs[name] = def;
        typeFixes.push(`${id}.${node.class_type}.${name}: "" → ${def}`);
      }
      continue;
    }
    // 缺失的必填 widget → 用官方默认值
    const def = s[1]?.default;
    if (def !== undefined) {
      node.inputs[name] = def;
      filled.push(`${id}.${node.class_type}.${name} = ${JSON.stringify(def)}`);
    } else if (Array.isArray(s[0]) && s[0].length) {
      node.inputs[name] = s[0][0];
      filled.push(`${id}.${node.class_type}.${name} = ${JSON.stringify(s[0][0])}（取第一个选项）`);
    } else {
      stillMissing.push(`${id}.${node.class_type}.${name}（无默认值）`);
    }
  }
}

console.log("=== 补上的必填值 ===", filled.length);
filled.forEach((f) => console.log("  +", f));
console.log("");
console.log("=== 类型修复 ===", typeFixes.length);
typeFixes.forEach((f) => console.log("  ~", f));
console.log("");
if (stillMissing.length) {
  console.log("=== 仍缺（需人工确认）===", stillMissing.length);
  stillMissing.forEach((f) => console.log("  !", f));
} else {
  console.log("=== 没有仍缺的必填项 ===");
}

fs.writeFileSync(API_FILE, JSON.stringify(prompt, null, 2), "utf8");
console.log("");
console.log("已写回:", API_FILE);
