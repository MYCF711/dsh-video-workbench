const f = "zzz-renamed-220_00005_.png";
const q = new URLSearchParams({ filename: f, subfolder: "", type: "output" });
const t0 = Date.now();
try {
  const r = await fetch("http://127.0.0.1:19499/comfy-assets/view?" + q, { signal: AbortSignal.timeout(30000) });
  const b = Buffer.from(await r.arrayBuffer());
  console.log("OK status=", r.status, "bytes=", b.length, "ms=", Date.now()-t0);
} catch (e) {
  console.log("ERR after", Date.now()-t0, "ms:", e.message, e.cause?.code);
}
