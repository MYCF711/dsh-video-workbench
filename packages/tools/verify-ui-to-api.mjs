/**
 * ui-to-api 转换器的验收
 *
 * ★ 为什么专门给它写验收
 *   这是本项目里唯一一个「错了五次才定稿」的模块。
 *   每次错的都是同一类：**widgets_values 的对位规则**。
 *   而它错了之后的表现极其安静 —— 参数值不报错，只是悄悄错了位
 *   （ref_image_size 拿到 1344、start_percent 拿到 0.2），
 *   提交给 ComfyUI 才在很远处报 value_not_in_list。
 *
 *   ⇒ 必须有回归测试锁住这五条判据。
 *
 * ── 五条判据（都是实测踩出来的）
 *   ① widget 型字段都占 widgets_values 的位 —— 【不管有没有连线】
 *   ② 连线型字段（MODEL/VAE/IMAGE/LATENT…）不占位
 *   ③ COMBO 家族（含 COMFY_DYNAMICCOMBO_V3）算 widget
 *   ④ widgets_values 是对象时按键写入（VHS_LoadVideo）
 *   ⑤ control_after_generate 占一个位但不算真参数
 */
import { uiToApi, summarize } from "./ui-to-api.mjs";

let pass = 0, fail = 0;
const ok = (n, d = "") => { pass++; console.log(`  ✓ ${n}${d ? "  " + d : ""}`); };
const bad = (n, d = "") => { fail++; console.log(`  ✗ ${n}${d ? "  " + d : ""}`); };
const chk = (n, cond, d = "") => (cond ? ok(n, d) : bad(n, d));

/** 造 objectInfo 条目：{ input: { required, optional } } —— 与真实 /object_info 同构 */
const spec = (required, optional) => ({ input: { required, optional: optional ?? {} } });

const info = {
  /** 有 optional 的 MODEL 连线字段（不占位）+ seed 带 control */
  SelfLiftH3Sampler: spec({
    model: ["MODEL"],
    vae: ["VAE"],
    latent_image: ["LATENT"],
    sampler: ["SAMPLER"],
    sigmas: ["SIGMAS"],
    seed: ["INT", { default: 0, control_after_generate: true }],
    cfg: ["FLOAT", { default: 5 }],
    upscaler_model: [["none", "a.safetensors", "b.safetensors"], { default: "none" }],
    highres_tiling: ["BOOLEAN", { default: false }],
    upscaler_unload: ["BOOLEAN", { default: true }],
  }, {
    model_hires: ["MODEL"],
  }),

  /** selection 是动态下拉（COMFY_DYNAMICCOMBO_V3） */
  BlockSparseAttention: spec({
    model: ["MODEL"],
    selection: ["COMFY_DYNAMICCOMBO_V3", { default: "sol-attn" }],
    start_percent: ["FLOAT", { default: 0.2 }],
    end_percent: ["FLOAT", { default: 1 }],
    dense_blocks: ["STRING", { default: "" }],
    min_tokens: ["INT", { default: 12288 }],
    extra_tokens: ["INT", { default: 256 }],
    sink_conditioning: [["a", "b"], { default: "a" }],
    verbose: ["BOOLEAN", { default: false }],
  }),

  ResolutionSelector: spec({
    aspect_ratio: [["16:9 (Widescreen)", "1:1 (Square)", "x"]],
    megapixels: ["FLOAT", { default: 1.0 }],
    multiple: ["INT", { default: 32 }],
  }),

  VHS_LoadVideo: spec({
    video: [["x.mp4"]],
    force_rate: ["FLOAT"],
    custom_width: ["INT"],
    custom_height: ["INT"],
    frame_load_cap: ["INT"],
    skip_first_frames: ["INT"],
    select_every_nth: ["INT"],
  }, { format: [["None", "AnimateDiff"]] }),

  VAELoader: spec({ vae_name: [["v.safetensors"]] }),
  PreviewImage: spec({}),
  UNETLoader: spec({ unet_name: [["m.safetensors"]], weight_dtype: [["default", "fp8"]] }),
};

const ui = (nodes, links = []) => ({ nodes, links });

const caseSelfLift = () => ui([
  {
    id: 1, type: "SelfLiftH3Sampler",
    inputs: [
      { name: "model", link: 10 },
      { name: "vae", link: 11 },
      { name: "latent_image", link: 12 },
      { name: "sampler", link: 13 },
      { name: "sigmas", link: 14 },
      { name: "model_hires", link: null },
      { name: "seed", link: null },
      { name: "cfg", link: null },
      { name: "upscaler_model", link: null },
      { name: "highres_tiling", link: null },
      { name: "upscaler_unload", link: null },
    ],
    widgets_values: [12345, "randomize", 1, "b.safetensors", false, true],
  },
], [
  [10, 99, 0, 1, 0, "MODEL"],
  [11, 99, 0, 1, 1, "VAE"],
  [12, 99, 0, 1, 2, "LATENT"],
  [13, 99, 0, 1, 3, "SAMPLER"],
  [14, 99, 0, 1, 4, "SIGMAS"],
]);

const caseBlockSparse = () => ui([
  {
    id: 2, type: "BlockSparseAttention",
    inputs: [
      { name: "model", link: 20 },
      { name: "selection", link: null },
      { name: "selection.tau", link: null },
      { name: "start_percent", link: null },
      { name: "end_percent", link: null },
      { name: "dense_blocks", link: null },
      { name: "min_tokens", link: null },
      { name: "extra_tokens", link: null },
      { name: "sink_conditioning", link: null },
      { name: "verbose", link: null },
    ],
    widgets_values: ["sol-attn", 1.3, 0.2, 1, "", 12288, 256, "exact_kv_and_rows", true],
  },
], [[20, 99, 0, 2, 0, "MODEL"]]);

const caseLinkedWidget = () => ui([
  /* ★ 必须有一个真实存在的源节点 —— 第一版写了不存在的 99，
     导致连线被丢，megapixels 保留了 widgets 值 1.5，看着像对位对了其实是漏了连线 */
  { id: 5, type: "VAELoader", inputs: [{ name: "vae_name", link: null }], widgets_values: ["v.safetensors"] },
  {
    id: 3, type: "ResolutionSelector",
    inputs: [
      { name: "aspect_ratio", link: null },
      { name: "megapixels", link: 30 },
      { name: "multiple", link: null },
    ],
    widgets_values: ["16:9 (Widescreen)", 1.5, 32],
  },
], [[30, 5, 0, 3, 1, "FLOAT"]]);

const caseVhsObject = () => ui([
  {
    id: 4, type: "VHS_LoadVideo",
    inputs: [{ name: "video", link: null }],
    widgets_values: {
      video: "x.mp4", force_rate: 0, custom_width: 0, custom_height: 0,
      frame_load_cap: 0, skip_first_frames: 0, select_every_nth: 1,
      format: "AnimateDiff",
      videopreview: { some: "ui junk" },
    },
  },
]);

const caseVirtual = () => ui([
  { id: 10, type: "VAELoader", inputs: [{ name: "vae_name", link: null }], widgets_values: ["v.safetensors"] },
  { id: 11, type: "Reroute", inputs: [{ name: "", link: 50 }] },
  { id: 12, type: "SetNode", inputs: [{ name: "", link: 51 }], widgets_values: ["V"] },
  { id: 13, type: "GetNode", inputs: [], widgets_values: ["V"] },
  {
    id: 14, type: "ResolutionSelector",
    inputs: [
      { name: "aspect_ratio", link: null },
      { name: "megapixels", link: null },
      { name: "multiple", link: null },
      { name: "vae", link: 52 },
      { name: "vae2", link: 53 },
    ],
    widgets_values: ["x", 1, 32],
  },
], [
  [50, 10, 0, 11, 0, "VAE"],
  [51, 10, 0, 12, 0, "VAE"],
  [52, 11, 0, 14, 3, "VAE"],
  [53, 13, 0, 14, 4, "VAE"],
]);

console.log("");
console.log("═".repeat(60));
console.log("  ui-to-api 转换器验收");
console.log("═".repeat(60));

console.log("");
console.log("[1] SelfLiftH3Sampler —— model_hires 不占位 + seed 的 control 位");
{
  const { prompt } = uiToApi(caseSelfLift(), { objectInfo: info });
  const n = prompt["1"] ?? { inputs: {} };
  chk("seed 拿到 12345（不是 randomize）", n.inputs.seed === 12345, `实际 ${JSON.stringify(n.inputs.seed)}`);
  chk("cfg 拿到 1", n.inputs.cfg === 1, `实际 ${JSON.stringify(n.inputs.cfg)}`);
  chk("upscaler_model 拿到 b.safetensors", n.inputs.upscaler_model === "b.safetensors", `实际 ${JSON.stringify(n.inputs.upscaler_model)}`);
  chk("highres_tiling 拿到 false", n.inputs.highres_tiling === false);
  chk("upscaler_unload 拿到 true", n.inputs.upscaler_unload === true);
  chk("control_after_generate 没进 inputs", !("control_after_generate" in n.inputs));
  chk("model_hires 没被当成 widget", !("model_hires" in n.inputs));
}

console.log("");
console.log("[2] BlockSparseAttention —— COMFY_DYNAMICCOMBO_V3 占位");
{
  const { prompt } = uiToApi(caseBlockSparse(), { objectInfo: info });
  const n = prompt["2"] ?? { inputs: {} };
  chk("selection = sol-attn", n.inputs.selection === "sol-attn", `实际 ${JSON.stringify(n.inputs.selection)}`);
  chk("selection.tau = 1.3", n.inputs["selection.tau"] === 1.3, `实际 ${JSON.stringify(n.inputs["selection.tau"])}`);
  chk("start_percent = 0.2（不是 1.3）", n.inputs.start_percent === 0.2, `实际 ${JSON.stringify(n.inputs.start_percent)}`);
  chk("end_percent = 1", n.inputs.end_percent === 1, `实际 ${JSON.stringify(n.inputs.end_percent)}`);
  chk("min_tokens = 12288", n.inputs.min_tokens === 12288, `实际 ${JSON.stringify(n.inputs.min_tokens)}`);
  chk("sink_conditioning = exact_kv_and_rows", n.inputs.sink_conditioning === "exact_kv_and_rows");
}

console.log("");
console.log("[3] 已连线的 widget 型字段仍占位（265 的核心教训）");
{
  const { prompt } = uiToApi(caseLinkedWidget(), { objectInfo: info });
  const n = prompt["3"] ?? { inputs: {} };
  chk("aspect_ratio 对位正确", String(n.inputs.aspect_ratio ?? "").startsWith("16:9"), `实际 ${JSON.stringify(n.inputs.aspect_ratio)}`);
  chk("multiple = 32（megapixels 占位没被跳过）", n.inputs.multiple === 32, `实际 ${JSON.stringify(n.inputs.multiple)}`);
  chk("megapixels 走连线而不是 widgets 值", Array.isArray(n.inputs.megapixels), `实际 ${JSON.stringify(n.inputs.megapixels)}`);
}

console.log("");
console.log("[4] widgets_values 是对象（VHS_LoadVideo）");
{
  const { prompt } = uiToApi(caseVhsObject(), { objectInfo: info });
  const n = prompt["4"] ?? { inputs: {} };
  chk("对象形式的 widgets 被读到 video", n.inputs.video === "x.mp4", `实际 ${JSON.stringify(n.inputs.video)}`);
  chk("select_every_nth = 1", n.inputs.select_every_nth === 1);
  chk("videopreview 被跳过", !("videopreview" in n.inputs));
}

console.log("");
console.log("[5] 虚拟节点消除（Reroute / GetNode / SetNode）");
{
  const { prompt } = uiToApi(caseVirtual(), { objectInfo: info });
  chk("Reroute / SetNode / GetNode 都被消掉", !prompt["11"] && !prompt["12"] && !prompt["13"]);
  chk("经 Reroute 的连线指向 VAELoader", JSON.stringify(prompt["14"]?.inputs?.vae) === '["10",0]', `实际 ${JSON.stringify(prompt["14"]?.inputs?.vae)}`);
  chk("经 Set/Get 的连线指向 VAELoader", JSON.stringify(prompt["14"]?.inputs?.vae2) === '["10",0]', `实际 ${JSON.stringify(prompt["14"]?.inputs?.vae2)}`);
  const s = summarize(prompt);
  chk("没有悬空连线", s.dangling.length === 0, s.dangling.join(", "));
}

console.log("");
console.log("═".repeat(60));
console.log(`  结果：${pass} 通过 / ${fail} 失败`);
console.log("═".repeat(60));
process.exit(fail ? 1 : 0);

