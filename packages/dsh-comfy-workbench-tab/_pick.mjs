const r = await fetch("http://127.0.0.1:8188/history?max_items=10", { signal: AbortSignal.timeout(8000) });
const h = await r.json();
let pick=null, size=null;
for (const [,e] of Object.entries(h)) {
  if (e.status?.status_str !== "success") continue;
  for (const [nodeId,out] of Object.entries(e.outputs??{})) for (const it of out.images??[]) { pick={nodeId,...it}; break; }
  if (pick) break;
}
console.log("pick:", JSON.stringify(pick));
