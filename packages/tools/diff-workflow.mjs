import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
import path from "node:path";
// 对比 v1（yz-ultimate-full）与 v2（新转换）的差异
import fs from "node:fs";

const v1 = JSON.parse(fs.readFileSync(path.join(HERE, "..", "dsh-comfy-bridge", "workflows", "yz-ultimate-full.json"), "utf8"));
const v2 = JSON.parse(fs.readFileSync(process.argv[2] ?? process.env.TEMP + "/yz-v2-api.json", "utf8"));

function models(p) {
  const out = new Map();
  for (const [id, n] of Object.entries(p)) {
    for (const [k, v] of Object.entries(n.inputs ?? {})) {
      if (typeof v === "string" && /\.(safetensors|ckpt|pt|gguf)$/i.test(v)) {
        out.set(v, (out.get(v) ?? []).concat(`${n.class_type}.${k}`));
      }
    }
  }
  return out;
}

const m1 = models(v1);
const m2 = models(v2);

console.log("=== v1 独有（新工作流不再用）===");
for (const [k, v] of m1) if (!m2.has(k)) console.log("  -", k, "  ←", v.join(", "));

console.log("");
console.log("=== v2 独有（新增依赖）===");
for (const [k, v] of m2) if (!m1.has(k)) console.log("  +", k, "  ←", v.join(", "));

console.log("");
console.log("=== 共有 ===");
let same = 0;
for (const [k] of m1) if (m2.has(k)) same++;
console.log("  ", same, "个");

console.log("");
console.log("=== 节点类型差异 ===");
const c1 = {}, c2 = {};
for (const n of Object.values(v1)) c1[n.class_type] = (c1[n.class_type] ?? 0) + 1;
for (const n of Object.values(v2)) c2[n.class_type] = (c2[n.class_type] ?? 0) + 1;
const allTypes = new Set([...Object.keys(c1), ...Object.keys(c2)]);
for (const t of [...allTypes].sort()) {
  const a = c1[t] ?? 0, b = c2[t] ?? 0;
  if (a !== b) console.log(`  ${t}: v1=${a} → v2=${b}`);
}
