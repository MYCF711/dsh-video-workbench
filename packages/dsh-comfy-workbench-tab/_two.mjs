const cands = ["Krea2-USD-20261018_00005_.png", "Krea2-SVR-20261018_00004_.png"];
for (const f of cands) {
  const q = new URLSearchParams({ filename: f, subfolder: "", type: "output" });
  const t0 = Date.now();
  try {
    const r = await fetch("http://127.0.0.1:19499/comfy-assets/view?" + q, { signal: AbortSignal.timeout(60000) });
    const b = Buffer.from(await r.arrayBuffer());
    console.log(f, "OK", r.status, b.length, "bytes", Date.now()-t0, "ms");
  } catch (e) {
    console.log(f, "ERR", Date.now()-t0, "ms:", e.message, "| cause:", e.cause?.code, "read:", e.cause?.socket?.bytesRead);
  }
}
