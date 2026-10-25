/**
 * 工作流加载与绑定解析 —— 可插拔工作流层。
 *
 * 设计前提（用户 2026-10-15 原话：「先空着，等你实现之后接入就行了」）：
 *   · 本文件里【不许出现任何具体模型名或节点 id】
 *   · workflows/ 为空是合法状态，必须给出可操作的提示而不是报错
 *
 * 契约见 workflows/README.md
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** 变量名 → 允许的取值类型。写了不在这张表里的变量名，加载时报错。 */
const KNOWN_VARS = new Set([
  "prompt", "negative", "width", "height", "aspect",
  "length", "durationSec", "seed", "steps", "filename_prefix",
  // ── 2026-10-18 增量（主人需求：生图要能选张数；二采步数要能单独调） ──
  // batch  → 一次抽几张（EmptyLatentImage.batch_size）
  // steps2 → 第二采样的步数（krea2 的 221 节点）。一采/二采是两个独立 KSampler，
  //          各自有 steps 字段，只靠 steps 一个变量名只能改其中一个。
  // 两个都只是新增名字，既有 10 个变量的语义与行为完全不变。
  "batch", "steps2",
  // seedvrModel → UNETLoader.unet_name（SeedVR2 的模型文件名）
  //   ｜ 7B: seedvr2_7b_int8_convrot.safetensors（工作流原值）
  //   ｜ 3B: seedvr2_3b_nvfp4.safetensors
  "seedvrModel",
  // megapixels → ResolutionSelector.megapixels（FLOAT，接受任意值）
  //   ｜ 尺寸档位：1K=1.0 / 2K=4.0 / 4K=16.0（按 1024/2048/4096 的平方折算成兆像素）
  //   ｜ 实测（2026-10-18）：不用加节点，直接写这个输入即可。
  "megapixels",
]);

/** 开关声明的类型。目前只支持布尔。 */
const KNOWN_TOGGLE_TYPES = new Set(["bool"]);

export class WorkflowError extends Error {
  constructor(mode, message) {
    super(message);
    this.name = "WorkflowError";
    this.mode = mode;
  }
}

/**
 * 加载 workflows/ 下的全部模式。
 * 返回 { modes: [...], warnings: [...] }。单个模式坏掉不影响其它模式。
 */
export async function loadModes(dir) {
  const warnings = [];
  const modes = [];

  let entries;
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (err.code === "ENOENT") {
      return { modes, warnings: [`工作流目录不存在：${dir}`] };
    }
    throw err;
  }

  const binds = entries.filter((f) => f.endsWith(".bind.json"));
  const workflows = new Set(entries.filter((f) => f.endsWith(".json") && !f.endsWith(".bind.json")));

  // 没有配套 bind 的工作流：点名警告，不静默跳过
  const declaredWorkflows = new Set();
  for (const b of binds) {
    try {
      const raw = await readFile(join(dir, b), "utf8");
      const parsed = JSON.parse(raw);
      if (parsed.workflow) declaredWorkflows.add(parsed.workflow);
    } catch { /* 下面统一报 */ }
  }
  for (const w of workflows) {
    if (!declaredWorkflows.has(w)) {
      warnings.push(`${w} 没有配套的 .bind.json，已忽略（怎么接见 workflows/README.md）`);
    }
  }

  for (const file of binds) {
    const modeId = file.replace(/\.bind\.json$/, "");
    let bind; // ★ 必须在 try 外声明：catch 里要用它取 label
    try {
      bind = JSON.parse(await readFile(join(dir, file), "utf8"));
      modes.push(await resolveMode(dir, modeId, bind));
    } catch (err) {
      // 坏模式不拖垮其它模式，但要出现在列表里并带原因。
      // ⚠ 这里绝不能抛：自测抓到过「bind 未声明」把整个加载器带崩。
      let label = modeId;
      try { label = bind?.label ?? modeId; } catch { /* 保持 modeId */ }
      modes.push({ id: modeId, label, state: "invalid", error: String(err?.message ?? err) });
      warnings.push(`模式 ${modeId} 加载失败：${err?.message ?? err}`);
    }
  }

  // 排序：先按 bind 里声明的 order（数字小的在前），再按 id 字典序兜底。
  //
  // 为什么需要显式 order（2026-10-16 主人定下「多参 H3 是以后的主力」）：
  //   纯字典序会把主力模式排到中间，而前端默认选第一个 —— 用户每次进来
  //   都得再点一下。order 让「主力」这个判断写在 bind 里，而不是硬编码在代码里。
  modes.sort((a, b) => {
    const ao = a.order ?? Number.MAX_SAFE_INTEGER;
    const bo = b.order ?? Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    return a.id.localeCompare(b.id);
  });
  return { modes, warnings };
}

async function resolveMode(dir, modeId, bind) {
  if (!bind.id) throw new WorkflowError(modeId, "bind.json 缺 id");
  if (!bind.label) throw new WorkflowError(modeId, "bind.json 缺 label");
  if (!bind.workflow) throw new WorkflowError(modeId, "bind.json 缺 workflow");

  const wfPath = join(dir, bind.workflow);
  let workflow;
  try {
    workflow = JSON.parse(await readFile(wfPath, "utf8"));
  } catch (err) {
    throw new WorkflowError(modeId, `读不到工作流 ${bind.workflow}：${err.message}`);
  }

  const nodeIds = new Set(Object.keys(workflow));
  if (nodeIds.size === 0) throw new WorkflowError(modeId, `工作流 ${bind.workflow} 里没有节点`);

  // ★ 顶层不允许非节点键。实测教训（2026-10-16）：
  //   ComfyUI 会遍历顶层【每一个】键当节点，遇到字符串就抛
  //     AttributeError: 'str' object has no attribute 'get'
  //   在 execution.py:1152 `node_data.get('_meta', {}).get('title')` —— 返回裸 HTTP 500，
  //   没有任何 JSON body，极难定位。所以在【加载期】就拦下，并点名是哪个键。
  //   （注释请写在 bind.json 或文件名里，不要写进工作流 JSON。）
  const strayKeys = Object.entries(workflow)
    .filter(([, v]) => !v || typeof v !== "object" || typeof v.class_type !== "string")
    .map(([k]) => k);
  if (strayKeys.length) {
    throw new WorkflowError(
      modeId,
      `工作流 ${bind.workflow} 顶层有非节点键：${strayKeys.join(", ")}。` +
        `ComfyUI 会因此报裸 HTTP 500（它遍历所有顶层键当节点）。` +
        `请把注释移到 bind.json 里，工作流 JSON 只留节点。`
    );
  }

  // 校验 vars 指向的 node 真实存在 —— 提交前就报，不要等 ComfyUI 报
  const vars = bind.vars ?? {};
  for (const [name, spec] of Object.entries(vars)) {
    if (!KNOWN_VARS.has(name)) {
      throw new WorkflowError(modeId, `vars.${name} 不是可识别变量（可用：${[...KNOWN_VARS].join(", ")}）`);
    }
    if (!spec?.node) throw new WorkflowError(modeId, `vars.${name} 缺 node`);
    if (!nodeIds.has(String(spec.node))) {
      throw new WorkflowError(modeId, `vars.${name} 指向 node=${spec.node}，但工作流里没有这个节点`);
    }
    if (!spec?.input) throw new WorkflowError(modeId, `vars.${name} 缺 input`);

    // ★ 字段名必须真实存在 —— 否则是【静默失败】。
    //
    // 实测踩到（2026-10-16，接 YZ 工作流）：bind 里写 `"input": "value"`，
    // 但那个节点的真实字段叫 `text`。ComfyUI 收到未知字段【不报错、直接忽略】，
    // 于是提示词从没生效，画面一直用作者的原 prompt —— 而 applied 里还记着
    // 「写了 1 条」，看起来像成功了。极难发现。
    //
    // 判据：该节点的 inputs 里必须已经有这个键（我们从 ComfyUI 导出的 API 格式
    // 里带着全部字段），或它至少是个像字段名的东西。
    const targetNode = workflow[String(spec.node)];
    const known = Object.keys(targetNode?.inputs ?? {});
    if (known.length && !known.includes(spec.input)) {
      throw new WorkflowError(
        modeId,
        `vars.${name} 指向 node=${spec.node}.${spec.input}，但该节点没有这个字段。` +
          `它有的是：${known.join(", ")}。` +
          `（ComfyUI 会静默忽略未知字段 —— 写错字段名不会报错，只会让这个变量永远不生效。）`
      );
    }
  }

  const media = bind.media ?? {};
  for (const [slot, spec] of Object.entries(media)) {
    if (!spec?.node) throw new WorkflowError(modeId, `media.${slot} 缺 node`);
    if (!nodeIds.has(String(spec.node))) {
      throw new WorkflowError(modeId, `media.${slot} 指向 node=${spec.node}，但工作流里没有这个节点`);
    }
    if (!spec?.input) throw new WorkflowError(modeId, `media.${slot} 缺 input`);
  }

  // ★ always：无论开关如何，一律剪掉的节点。
  //
  // 用途（2026-10-16，Krea2）：某个组在本模式里【没有可用输入源】，整体不该提交。
  //   例：SeedVR2 放大组是一条独立支路 —— 从 LoadImage 拿外部图去放大，
  //   而那个 LoadImage 的值是作者浏览器里粘贴的图，本机没有。
  //   与其给它做一个「开了必报错」的开关，不如明确声明它不参与。
  // ★★★ 2026-10-18 修：原来这里只有【校验】没有【删除】★★★
  //   实测证据：krea2.bind.json 的 always.delete 里写了 175，
  //   但提交图里 175(BatchImageSaverCN) 依然存在，每次出图多一个 image_xxx.jpg。
  //   对照 toggle 的实现（第 415 行）：`delete wf[String(id)]` —— 那才是真删。
  //   ⇒ 这里补上删除动作。顺序放在 toggle 之前，这样 toggle 的 on.nodes
  //     不会把它「复活」（on.nodes 的语义是「保留这些节点」，对已删除的 id 无副作用）。
  const always = bind.always ?? {};
  for (const id of always.delete ?? []) {
    if (!nodeIds.has(String(id))) {
      throw new WorkflowError(modeId, `always.delete 提到 node=${id}，但工作流里没有它`);
    }
  }
  // ★ always.set：无论用户怎么调，一律强制写成某个值。
  //
  // 用途（2026-10-17，Qwen 改图）：某个开关节点的默认分支是【硬编码字符串】，
  //   用户写在 prompt 变量里的指令根本不进模型。
  //   例：官方 Qwen Image 2.1 Edit 的 ComfySwitchNode(459:484) 默认 switch=false
  //       → 走 on_false（硬编码 "Replace costumes for the character"），
  //       → TextGenerate 的增强结果（on_true）被丢弃。
  //   实测过：指令写「change to red Chinese silk dress」，输出只是把长裤换成短裤。
  //   与其在 UI 上要用户记得勾一个开关，不如在 bind 里强制声明。
  //
  // 形状：{ "<nodeId>": { "<input>": <value>, ... }, ... }
  for (const [id, patches] of Object.entries(always.set ?? {})) {
    if (!nodeIds.has(String(id))) {
      throw new WorkflowError(modeId, `always.set 提到 node=${id}，但工作流里没有它`);
    }
    if (!patches || typeof patches !== "object" || Array.isArray(patches)) {
      throw new WorkflowError(modeId, `always.set.${id} 必须是一个对象 {输入名: 值}`);
    }
  }

  // ★ 开关（toggles）—— 实现「兼容武打开关」这类需求。
  //
  // 它做的事与 ComfyUI 的 BYPASS 完全一样，但由【服务端】执行，
  // 所以前端能任意控制，不受 ComfyUI App Mode「只能选原生 widget」的限制。
  //
  // 绕过依据（实测 2026-10-16，用 ComfyUI 自己的 graphToPrompt 对照两次输出）：
  //   武打关：5 个节点不在 output 里，且下游 node 331 的 model 直接指向 400
  //   武打开：5 个节点都在 output 里，且 node 331 的 model 指向 343
  //   ⇒ BYPASS 不是「透传」，是【重新接线】：上游直连下游。
  //   所以开关 = 「删掉这 5 个节点」+「把下游的连线改指到链首的上游」。
  //
  // bind 里这样声明：
  //   "toggles": {
  //     "wudA": {
  //       "label": "武打模式",
  //       "type": "bool",
  //       "default": false,
  //       "on":  { "nodes": ["342","344","345","343","366"], "rewire": { "331": { "model": ["343", 0] } } },
  //       "off": { "delete": ["342","344","345","343","366"], "rewire": { "331": { "model": ["400", 0] } } }
  //     }
  //   }
  const toggles = bind.toggles ?? {};
  /**
   * ★★ 2026-10-20 加：工作流的能力声明（主人定的架构原则）。
   *
   *   「工作流是作为一个可替换的模块接入我们的插件的，你的所有东西
   *     都应该让工作流对号入座，而不是为工作流服务。」
   *
   *   bind.json 里可以写：
   *     "capabilities": { "h3Labels": true }
   *
   *   前端只问 caps.h3Labels，不问「你叫什么 id」。
   *   以后接新工作流，只要它在 bind 里声明能力，前端自动对号入座。
   */
  const capabilities = bind.capabilities ?? {};
  for (const [name, spec] of Object.entries(toggles)) {
    if (!KNOWN_TOGGLE_TYPES.has(spec?.type)) {
      throw new WorkflowError(modeId, `toggles.${name}.type 不支持：${spec?.type}（可用：${[...KNOWN_TOGGLE_TYPES].join(", ")}）`);
    }
    if (!spec?.on || !spec?.off) {
      throw new WorkflowError(modeId, `toggles.${name} 必须同时声明 on 与 off`);
    }
    for (const branch of ["on", "off"]) {
      const b = spec[branch];
      for (const id of [...(b.nodes ?? []), ...(b.delete ?? [])]) {
        if (!nodeIds.has(String(id))) {
          throw new WorkflowError(modeId, `toggles.${name}.${branch} 提到 node=${id}，但工作流里没有它`);
        }
      }
      for (const [tid, patches] of Object.entries(b.rewire ?? {})) {
        if (!nodeIds.has(String(tid))) {
          throw new WorkflowError(modeId, `toggles.${name}.${branch}.rewire 指向 node=${tid}，但工作流里没有它`);
        }
        for (const [field, ref] of Object.entries(patches)) {
          if (!Array.isArray(ref) || ref.length < 2) {
            throw new WorkflowError(modeId, `toggles.${name}.${branch}.rewire.${tid}.${field} 必须是 [nodeId, slot]`);
          }
        }
      }
    }
  }

  return {
    id: bind.id,
    label: bind.label,
    tabSub: bind.tabSub ?? "",
    description: bind.description ?? "",
    // order 决定标签顺序（小的在前）；primary 是给主力模式打的徽标
    order: typeof bind.order === "number" ? bind.order : undefined,
    primary: bind.primary === true,
    state: "ok",
    workflowFile: bind.workflow,
    defaults: bind.defaults ?? {},
    vars,
    media,
    outputs: bind.outputs ?? {},
    // 前端给的画幅值 → 目标节点自己的字面取值。
    // 例：{"16:9": "16:9 (Widescreen)"}（ResolutionSelector 要这种带后缀的）
    aspectMap: bind.aspectMap ?? {},
    // 开关：前端按这里渲染控件，服务端按它的 on/off 改写工作流
    toggles: Object.fromEntries(
      Object.entries(toggles).map(([k, v]) => [
        k,
        // hint 是给用户看的说明小字，前端会渲染（README §五 也承诺了它，
        // 先前漏在这里没传下去 —— 文档与实现不一致，已补）
        { label: v.label ?? k, type: v.type, default: v.default === true, hint: v.hint ?? "" },
      ])
    ),
    // 前端要知道该渲染几个槽、每个叫什么
    //
    // ★ kind 是可选的分类标签（image / video / audio），前端据此【分栏显示】——
    //   实测需求（2026-10-16 主人原话）：「参考图和参考音频还有参考视频分成三个栏位，
    //   不要混在一起」。没写 kind 时按 accept 的前缀推断，再兜底为 image。
    mediaSlots: Object.entries(media).map(([key, spec]) => ({
      key,
      label: spec.label ?? key,
      accept: spec.accept ?? "image/*",
      kind: spec.kind ?? (spec.accept ?? "image/*").split("/")[0],
      // required 未声明时视为【可选】：H3 的 first_frame/last_frame 都是 optional，
      // 而「可选」正是要触发剪枝的语义。要必填就在 bind 里显式写 "required": true。
      required: spec.required === true,
    })),
    _workflow: workflow,
    // 原始开关定义（含 on/off 分支细节）—— 只因前端只该看到 label/type/default，
    // 执行细节留在这里给 buildPrompt 用。
    _togglesRaw: toggles,
    // ★ 2026-10-18 增量：能力声明，供前端决定「该渲染哪些参数控件」。
    //
    // 为什么不靠 bind 再写一遍：这些值全都能从 vars 直接推出来，
    // 手写一份就等于有第二个真相源 —— 以后改 bind 忘了同步，UI 会说谎。
    // 前端据此规则（WorkbenchView）：
    //   caps.duration → 有「时长」下拉（视频）
    //   caps.batch    → 有「张数」下拉（生图）
    //   caps.steps2   → 有「二采步数」下拉
    //   caps.secondPassToggle → 该模式的二采开关名（没有就是 null，UI 就不显示）
    caps: {
      duration: Boolean(vars.durationSec || vars.length),
      batch: Boolean(vars.batch),
      steps: Boolean(vars.steps),
      steps2: Boolean(vars.steps2),
      // 画幅：有 vars.aspect 才算（qwen21-edit 用 width/height，没有 aspect）
      aspect: Boolean(vars.aspect),
      // 尺寸档位：有 vars.megapixels 才有 1K/2K/4K 下拉
      // （qwen21-edit 用 width/height，没有 megapixels → 不显示）
      megapixels: Boolean(vars.megapixels),
      // SeedVR2 模型是否可切换
      seedvrModel: Boolean(vars.seedvrModel),
      secondPassToggle: Object.prototype.hasOwnProperty.call(toggles, "secondPass")
        ? "secondPass"
        : null,
      /**
       * ★★ 2026-10-20 加（主人定的架构原则，逐字）：
       *
       *   「工作流是作为一个可替换的模块接入我们的插件的，你的所有东西
       *     都应该让工作流对号入座，而不是为工作流服务。后续接入新的工作流
       *     直接找插件的接口自动对号入座即可」
       *
       *   ⇒ 前端原来写的是 `if (modeId === "yz")` —— 那是「为工作流服务」：
       *     每接一个新工作流都要回来改前端。这条是错的。
       *
       *   ⇒ 改成能力位：工作流在自己的 bind.json 里声明
       *       "capabilities": { "h3Labels": true }
       *     前端只问 `caps.h3Labels`，不问「你叫什么 id」。
       *
       *   ★ 为什么不用「有 video 槽」推断：
       *     「能接视频参考」和「需要 H3 那套 <Subject N> 标签语法」
       *     是两个独立概念。前者是媒体能力，后者是提示词契约。
       *     用前者推后者，接一个「有视频槽但不是 H3」的工作流就会误判。
       *     ⇒ 必须显式声明，不做推断。
       */
      h3Labels: capabilities?.h3Labels === true,
    },
    // 无论开关如何都剪掉的节点（含原因，供文档/界面解释）
    alwaysDelete: always.delete ?? [],
    alwaysReason: always.reason ?? "",
    // 强制写入的固定值（无论用户怎么调）
    alwaysSet: always.set ?? null,
  };
}

/**
 * 把前端参数套进工作流，产出 ComfyUI /prompt 能吃的 API 格式。
 *
 * @param mode      resolveMode 的返回值
 * @param params    { prompt, negative, width, height, aspect, length, durationSec, seed, steps, files }
 * @param resolvers { snapLength, secondsToLength, aspectToSize }
 */
export function buildPrompt(mode, params, resolvers) {
  const wf = structuredClone(mode._workflow);

  // ★ 在任何改动之前，记下每个节点【最初】的连线输入。
  //   级联剪枝需要它 —— 用改动后的状态判断会永远匹配不上（第一版错在这）。
  const originInputs = new Map();
  for (const [id, node] of Object.entries(wf)) {
    const links = Object.entries(node.inputs ?? {})
      .filter(([, v]) => Array.isArray(v) && v.length === 2 && typeof v[0] === "string");
    if (links.length) originInputs.set(id, links);
  }

  const { snapLength, secondsToLength, aspectToSize } = resolvers;
  const applied = [];
  /** 被开关/素材剪枝删掉的节点 id —— setInput 用它区分「bind 写错」与「被剪掉」 */
  const prunedNodes = new Set();

  /**
   * 写一个输入。
   *
   * ★ 两种「找不到节点」必须区分：
   *   ① bind 写错了（节点从来就不存在）→ 报错。装载期已校验过，走到这里说明
   *      是原生 buildPrompt 调用，仍要报，不能静默。
   *   ② 节点被 toggle 剪掉了 → 安全跳过。实测：krea2 关 secondPass 会 delete
   *      节点 221，而 vars.steps2 正指向 221，硬报错会让「关二采」这个正常
   *      操作 500（"工作流里找不到 node=221"）。
   *   判据：剪枝时记进 prunedNodes，写输入时查它。
   */
  const skipped = [];
  const setInput = (nodeId, input, value) => {
    const node = wf[String(nodeId)];
    if (!node) {
      if (prunedNodes.has(String(nodeId))) {
        skipped.push({ node: String(nodeId), input, reason: "节点已被开关剪枝" });
        return false;
      }
      throw new WorkflowError(mode.id, `工作流里找不到 node=${nodeId}`);
    }
    node.inputs ??= {};
    node.inputs[input] = value;
    applied.push({ node: String(nodeId), input, value });
    return true;
  };

  // ---- 开关（在改任何输入之前先应用，因为它会增删节点）----
  //
  // 顺序要紧：开关会删节点 / 改连线，若先写输入、后删节点，那些输入就白写了。
  // 所以放在最前面。
  const toggleState = {};
  for (const [name, spec] of Object.entries(mode.toggles ?? {})) {
    const want = params.toggles?.[name];
    const on = want === undefined ? spec.default === true : want === true;
    toggleState[name] = on;

    // 原始 bind 定义在 mode._togglesRaw 里（装载时从 bind 带过来）
    const raw = mode._togglesRaw?.[name];
    if (!raw) continue;
    const branch = on ? raw.on : raw.off;

    for (const id of branch.nodes ?? []) {
      if (!wf[String(id)]) throw new WorkflowError(mode.id, `开关 ${name} 要启用 node=${id}，但它不在工作流里`);
      applied.push({ node: String(id), input: "(启用)", value: `开关 ${name}=开` });
    }
    for (const id of branch.delete ?? []) {
      delete wf[String(id)];
      // ★ 必须登记 —— 否则 vars 指向这个节点时（krea2 的 steps2→221），
      //   setInput 会误判成「bind 写错了」而抛错，让「关二采」这个正常操作 500。
      prunedNodes.add(String(id));
      applied.push({ node: String(id), input: "(删除)", value: `开关 ${name}=关` });
    }
    for (const [tid, patches] of Object.entries(branch.rewire ?? {})) {
      const t = wf[String(tid)];
      // ★ 目标可能已被【别的开关】删掉 —— 这不是错误，跳过即可。
      //
      // 实测（2026-10-16，Krea2 模式）：loraChain 想把 UltimateSDUpscale(199)
      // 的 model 指回 UNETLoader，但 199 属于「高清重绘」组，那组默认关闭、
      // 已把它删了。原先这里抛错 ⇒ 开关的组合效果取决于声明顺序，很脆。
      // 正确语义：目标不在了，就没有线要改。
      if (!t) {
        applied.push({
          node: String(tid), input: "(跳过)", value: null,
          rewire: `开关 ${name}：目标已被其它开关删除，无需改线`,
        });
        continue;
      }
      t.inputs ??= {};
      for (const [field, ref] of Object.entries(patches)) {
        t.inputs[field] = ref;
        applied.push({ node: String(tid), input: field, value: ref, rewire: `开关 ${name}=${on ? "开" : "关"}` });
      }
    }
  }

  // ---- 文本 ----
  if (params.prompt !== undefined && mode.vars.prompt) {
    setInput(mode.vars.prompt.node, mode.vars.prompt.input, String(params.prompt));
  }
  if (params.negative !== undefined && mode.vars.negative) {
    setInput(mode.vars.negative.node, mode.vars.negative.input, String(params.negative));
  }

  // ---- 尺寸：显式宽高优先，否则由 aspect 算 ----
  //
  // ★ aspect 有两种去处（接主人真实工作流时发现）：
  //   ① vars.aspect 指向一个 COMBO（如 ResolutionSelector.aspect_ratio）
  //      ⇒ 那个节点要的是它自己的字面取值，如 "16:9 (Widescreen)"。
  //        前端给的是 "16:9"，直接写进去会被 ComfyUI 拒（不在可选列表里）。
  //        bind 里用 aspectMap 声明映射，或只写 "16:9"，后端按【目标节点的真实可选值】模糊匹配。
  //   ② vars.width/vars.height 指向 INT
  //      ⇒ 由 aspect 算出像素宽高（对齐 32 的倍数）。
  const wantW = params.width ?? undefined;
  const wantH = params.height ?? undefined;

  if (params.aspect && mode.vars.aspect) {
    const mapped = mode.aspectMap?.[params.aspect] ?? params.aspect;
    setInput(mode.vars.aspect.node, mode.vars.aspect.input, mapped);
  }
  if (wantW != null && mode.vars.width) setInput(mode.vars.width.node, mode.vars.width.input, Number(wantW));
  if (wantH != null && mode.vars.height) setInput(mode.vars.height.node, mode.vars.height.input, Number(wantH));
  if ((wantW == null || wantH == null) && params.aspect && (mode.vars.width || mode.vars.height)) {
    const size = aspectToSize(params.aspect);
    if (size) {
      if (wantW == null && mode.vars.width) setInput(mode.vars.width.node, mode.vars.width.input, size.width);
      if (wantH == null && mode.vars.height) setInput(mode.vars.height.node, mode.vars.height.input, size.height);
    }
  }

  // ---- 帧数 / 秒数 ----
  //
  // ★ 两个目标位是【分开】的（接主人真实工作流时发现，2026-10-16）：
  //   他的工作流里帧数不是直接填的，而是
  //     PrimitiveFloat「Float (Duration)」.value  ← 秒数
  //       → ComfyMathExpression.expression 里做吸附：
  //          max(5, round(a*24)) + (5 - (max(5, round(a*24)) % 17)) % 17
  //       → MiniMaxH3ReferenceToVideo.length
  //   ⇒ 那种工作流要的是【秒数】，吸附由工作流自己算。
  //     而另一些工作流直接吃帧数。
  //   所以 bind 可以分别声明：
  //     vars.length      → 收到吸附后的【帧数】
  //     vars.durationSec → 收到【秒数】（原样，不吸附）
  //   两者都声明时都写；只声明一个就只写那个。
  let frames;
  if (params.length != null) frames = snapLength(params.length);
  else if (params.durationSec != null) frames = secondsToLength(params.durationSec);

  const wantSeconds =
    params.durationSec != null ? Number(params.durationSec) : frames != null ? lengthToSeconds(frames) : null;

  if (frames != null && mode.vars.length) {
    setInput(mode.vars.length.node, mode.vars.length.input, frames);
  }
  // ⚠ 未声明 length 变量【不记 skipped】—— 那是正常设计，不是问题。
  //   接主人工作流时发现：他的帧数由工作流自带的 ComfyMathExpression 从秒数算出，
  //   所以 bind 只声明 durationSec。初版在这里塞了一条 "skipped" 记录，
  //   读起来像是「帧数没生效」，纯噪音。（帧数仍会算出来放在返回值的 length 里供调用方参考。）
  if (wantSeconds != null && mode.vars.durationSec) {
    setInput(mode.vars.durationSec.node, mode.vars.durationSec.input, wantSeconds);
  }

  // ---- 采样 ----
  /**
   * ★★★ 2026-10-25 修：用户没给种子时，【由我们定一个并回报】。
   *
   *   【实测问题】原来写的是「params.seed != null 才 setInput」——
   *   用户留空（默认行为）时，种子节点保留工作流里的原始固定值。
   *   后果：
   *     · 前端不知道这次用了哪个种子 ⇒ 出到好图想「同一张微调」做不到
   *     · 用户以为「留空 = 随机」，而实际每次都跑同一个固定种子，
   *       连续生成出几乎一样的图，还以为模型不听话
   *
   *   ⇒ 留空时生成一个随机种子，写进节点，并在返回值里带出去（usedSeed）。
   *     判据：**凡是「用户留空」的参数，系统替他选的值必须可见**，
   *          否则他既不能复现也不能微调。
   *   ★ 上限用 2147483647 而不是 Number.MAX_SAFE_INTEGER ——
   *     ComfyUI 的 seed 是 INT32，超范围会被 schema 校验直接拒。
   */
  let usedSeed = null;
  if (mode.vars.seed) {
    const want = params.seed != null ? Number(params.seed) : NaN;
    usedSeed = Number.isFinite(want) ? Math.trunc(want) : Math.floor(Math.random() * 2147483647);
    setInput(mode.vars.seed.node, mode.vars.seed.input, usedSeed);
  }
  if (params.steps != null && mode.vars.steps) {
    setInput(mode.vars.steps.node, mode.vars.steps.input, Number(params.steps));
  }
  // ---- 2026-10-18 增量 ----
  // 张数：一次抽几张。只在该 bind 声明了 vars.batch 的生图工作流里生效；
  // 视频工作流不声明就完全不碰（不清零、不写死 1），行为与改动前一致。
  if (params.batch != null && mode.vars.batch) {
    setInput(mode.vars.batch.node, mode.vars.batch.input, Number(params.batch));
  }
  // 二采步数：krea2 的第二采样（221）独立于第一采样（203）。
  // 同样只在 bind 声明了 vars.steps2 时生效；二采关闭时该节点已被开关剪掉，
  // 这里就算写了也是写进本地克隆，不会影响提交内容。
  if (params.steps2 != null && mode.vars.steps2) {
    setInput(mode.vars.steps2.node, mode.vars.steps2.input, Number(params.steps2));
  }
  // 尺寸档位：写 ResolutionSelector.megapixels（FLOAT，任意值）。
  // 1K=1.0 / 2K=4.0 / 4K=16.0 —— 按 1024/2048/4096 的平方折算成兆像素。
  // 只在 bind 声明了 vars.megapixels 时生效（qwen21-edit 用 width/height，不走这条）。
  if (params.megapixels != null && mode.vars.megapixels) {
    setInput(mode.vars.megapixels.node, mode.vars.megapixels.input, Number(params.megapixels));
  }
  // SeedVR2 模型选择（只在 bind 声明了 vars.seedvrModel 且该节点未被开关剪掉时生效）
  if (params.seedvrModel && mode.vars.seedvrModel) {
    setInput(mode.vars.seedvrModel.node, mode.vars.seedvrModel.input, String(params.seedvrModel));
  }

  // ---- 素材 ----
  //
  // ★ 可选槽未提供时必须【连节点一起剪掉】（自测/端到端抓到，2026-10-16）：
  //   工作流里首帧/尾帧各挂一个 LoadImage，值是占位文件名（如 "placeholder.png"）。
  //   只传首帧、不传尾帧时，尾帧那个 LoadImage 仍带着不存在的占位文件
  //   ⇒ ComfyUI 报 `node 19: image - Invalid image file: placeholder.png`
  //   ⇒ 整个任务 502。
  //   剪掉「节点本身 + 指向它的连线」才符合意图：没提供的槽 = 这条输入不存在。
  //   （H3 的 first_frame / last_frame 都是 optional，少了照样能跑。）
  const files = params.files ?? {};
  const pruned = [];

  // ---- ★ 一律剪掉的节点（bind 的 always.delete）----
  //
  // 放在这里（pruned 声明之后、素材与开关之前）：这些节点与开关无关，
  // 先摘干净，后面的级联剪枝才能正确识别由它们引起的断链。
  //
  // ⚠ 位置有讲究：`pruned` 是 const，在它之前 push 会 TDZ 报错。
  //   （实测踩过 —— `node --check` 只查语法，查不出这个，是自测抓到的。）
  if (mode.alwaysDelete?.length) {
    for (const id of mode.alwaysDelete) {
      if (!wf[String(id)]) continue; // 可能已被开关删掉
      delete wf[String(id)];
      pruned.push({ slot: `(固定剪枝) node ${id}`, node: String(id) });
      applied.push({
        node: String(id), input: "(删除)", value: null,
        pruned: mode.alwaysReason || "bind 里声明了 always.delete",
      });
    }
  }

  // ---- ★ 强制写死的输入（bind 的 always.set）----
  //
  // 放在「固定剪枝之后、素材与开关之前」的理由：
  //   · 在剪枝之后 → 被剪掉的节点不用管
  //   · 在素材/开关之前 → 开关会删节点/改连线，固定值先落地，
  //     开关若把该节点删了，末尾还会再补一次（见函数结尾）。
  //
  // ⚠ 末尾还要再 apply 一次：toggles 的 rewire 可能覆盖同名输入。
  const applyAlwaysSet = (tag) => {
    for (const [id, patches] of Object.entries(mode.alwaysSet ?? {})) {
      const node = wf[String(id)];
      if (!node) continue; // 被剪了，不是错
      node.inputs ??= {};
      for (const [input, value] of Object.entries(patches)) {
        const prev = node.inputs[input];
        node.inputs[input] = value;
        applied.push({
          node: String(id), input, value,
          reason: `always.set 强制${tag ? "（" + tag + "）" : ""}`,
          prev: prev === undefined ? null : prev,
        });
      }
    }
  };
  applyAlwaysSet("");

  for (const [slot, spec] of Object.entries(mode.media)) {
    const v = files[slot];
    const supplied = v != null && v !== "" && !(Array.isArray(v) && v.length === 0);

    if (!supplied) {
      if (spec.required) {
        throw new WorkflowError(mode.id, `槽 ${slot}（${spec.label ?? slot}）是必填，但没提供文件`);
      }
      prunedNodes.add(String(spec.node));
      pruned.push({ slot, node: String(spec.node) });
      continue;
    }

    const node = wf[String(spec.node)];
    if (!node) throw new WorkflowError(mode.id, `工作流里找不到 node=${spec.node}（media.${slot}）`);
    node.inputs ??= {};
    // 只接受字符串或字符串数组。初见写进来的 undefined/null 必须挡掉 ——
    // ComfyUI 收到 null 会当成真值去校验，报的错跟真实原因差很远。
    const val = Array.isArray(v) ? v.map(String) : String(v);
    if (val == null || val === "" || (Array.isArray(val) && !val.length)) {
      throw new WorkflowError(mode.id, `槽 ${slot} 的文件引用为空（node=${spec.node}.${spec.input}）`);
    }
    node.inputs[spec.input] = val;
    applied.push({ node: String(spec.node), input: spec.input, value: val });
  }

  // 剪枝：删掉未提供的槽节点，以及任何指向它们的输入
  if (prunedNodes.size) {
    for (const id of prunedNodes) delete wf[id];
    for (const [id, node] of Object.entries(wf)) {
      for (const [k, val] of Object.entries(node.inputs ?? {})) {
        if (Array.isArray(val) && prunedNodes.has(String(val[0]))) {
          delete node.inputs[k];
          applied.push({ node: id, input: k, value: null, pruned: `上游 node ${val[0]} 未提供素材` });
        }
      }
    }
  }

  // ---- ★ 自动剪掉「画布里本来就没填」的素材槽 ----
  //
  // 实测根因（2026-10-16，接 YZ 工作流时踩到）：
  //   作者在画布里留了 9 个图槽 + 3 个音槽，没填的那些值就是【字符串 "None"】。
  //   ComfyUI 会认真去加载一个叫 None 的文件，报：
  //     node 51: LoadImage → image - Invalid image file: None
  //     node 14: LoadAudio → audio - Invalid audio file: None
  //   然后把这些节点标为不可执行，连带整条下游（含输出节点）都不跑 ——
  //   表现极其误导：任务 55 毫秒就「成功」，outputs 为空。
  //   （本文件上面那段 media 剪枝没覆盖它，因为那些槽根本没在 bind 里声明。）
  //
  // 判据：值是 "None" / "" / null 的素材加载节点，一律视为「这条输入不存在」。
  //   这是作者本人在画布上的意图 —— 没填就是没用。
  const EMPTY_MEDIA_VALUES = new Set(["None", "none", "null", ""]);
  const MEDIA_LOADERS = {
    LoadImage: "image",
    LoadAudio: "audio",
    VHS_LoadVideo: "video",
    LoadImageMask: "image",
  };
  const autoEmpty = [];
  for (const [id, node] of Object.entries(wf)) {
    const field = MEDIA_LOADERS[node.class_type];
    if (!field) continue;
    const v = node.inputs?.[field];
    // 已由 media 槽提供过文件的，不动
    if (files[Object.keys(mode.media).find((s) => String(mode.media[s].node) === id)] !== undefined) continue;
    if (v === undefined || v === null) continue;
    const asStr = Array.isArray(v) ? v.join(",") : String(v);
    if (EMPTY_MEDIA_VALUES.has(asStr.trim())) {
      autoEmpty.push({ id, class_type: node.class_type, field, value: asStr });
    }
  }
  if (autoEmpty.length) {
    const emptyIds = new Set(autoEmpty.map((e) => e.id));
    for (const e of autoEmpty) {
      delete wf[e.id];
      pruned.push({ slot: `(画布未填) node ${e.id}`, node: e.id });
      applied.push({ node: e.id, input: "(删除)", value: null, pruned: `${e.class_type}.${e.field} 的值是 ${JSON.stringify(e.value)} —— 画布上没填这个槽` });
    }
    // 摘掉所有指向这些空槽的连线（与上面同样的做法）
    for (const [id, node] of Object.entries(wf)) {
      for (const [k, val] of Object.entries(node.inputs ?? {})) {
        if (Array.isArray(val) && emptyIds.has(String(val[0]))) {
          delete node.inputs[k];
          applied.push({ node: id, input: k, value: null, pruned: `上游 node ${val[0]} 是空素材槽` });
        }
      }
    }
  }

  // ---- ★ 剪掉「纯前端」节点 ----
  //
  // 实测（2026-10-16，接 Krea2 时踩到）：
  //   `Image Comparer (rgthree)` 是**只在浏览器里用的对比工具**，它的输入
  //   存的是前端运行时数据（粘贴图的 /api/view?filename=rgthree.compare._temp_*.png
  //   与 url 对象），提交给 ComfyUI 毫无意义，还会引用已被剪掉的节点：
  //     node 176: '172'      ← 报这种莫名其妙的校验错
  //   ⇒ 这类节点一律不提交。
  //
  // 判据：class_type 里带这些标记的，是已知的前端专属节点。
  //
  // ⚠ 别把「名字带 rgthree」当成纯前端件一刀切 —— 实测踩过（2026-10-16）：
  //   `Seed (rgthree)` 我一开始也列进来剪掉了，结果 `203.seed` 直接断链
  //   （ComfyUI 报 `node 203: seed`）。它虽然由 rgthree 提供，但**是真正的
  //   值提供者**，不是纯前端件。
  //   ⇒ 白名单只放「确认过不提供运行时值」的那几类。
  const FRONTEND_ONLY_TYPES = [
    /^Image Comparer \(rgthree\)$/,      // 只存浏览器里的对比快照，无输出
    /^Label \(rgthree\)$/,               // 纯注释
    /^Fast Groups Bypasser \(rgthree\)$/, // 纯 UI 开关
    /^Note$/,
    /^MarkdownNote$/,
    /^Reroute$/,
  ];
  const frontOnly = [];
  for (const [id, node] of Object.entries(wf)) {
    if (FRONTEND_ONLY_TYPES.some((re) => re.test(node.class_type))) frontOnly.push({ id, ct: node.class_type });
  }
  if (frontOnly.length) {
    const ids = new Set(frontOnly.map((f) => f.id));
    for (const f of frontOnly) {
      delete wf[f.id];
      pruned.push({ slot: `(前端专用) node ${f.id}`, node: f.id });
      applied.push({ node: f.id, input: "(删除)", value: null, pruned: `${f.ct} 是浏览器端节点，不提交给 ComfyUI` });
    }
    for (const [id, node] of Object.entries(wf)) {
      for (const [k, val] of Object.entries(node.inputs ?? {})) {
        if (Array.isArray(val) && ids.has(String(val[0]))) {
          delete node.inputs[k];
          applied.push({ node: id, input: k, value: null, pruned: `上游 node ${val[0]} 是前端专用节点` });
        }
      }
    }
  }

  // ---- ★ 剪掉「指向画布残留文件」的素材节点 ----
  //
  // 实测（2026-10-16）：作者的 LoadImage 里留着 `pasted/image (10).png` ——
  // 那是他在浏览器里粘贴过的图，本机 input/ 目录里没有。
  // 开了那个组就会报 `image - Invalid image file: pasted/image (10).png`。
  //
  // 判据：值形如 `<任意>/<名字>` 但该文件不在本机的 → 视为残留。
  //   这里只按【形态】判（pasted/ 前缀、或含 URL 特征），
  //   因为服务端不查 ComfyUI 的 input 目录（那是另一个进程的磁盘状态，
  //   每次 buildPrompt 都去列目录会很慢，且对纯本地文件也会误判）。
  //   命中后由调用方在 verify 阶段确认。
  const RESIDUAL_MEDIA_RE = /^(pasted\/|blob:|data:)/i;
  const residual = [];
  for (const [id, node] of Object.entries(wf)) {
    const field = MEDIA_LOADERS[node.class_type];
    if (!field) continue;
    const v = node.inputs?.[field];
    if (typeof v !== "string") continue;
    if (RESIDUAL_MEDIA_RE.test(v.trim())) residual.push({ id, ct: node.class_type, field, value: v });
  }
  if (residual.length) {
    const ids = new Set(residual.map((r) => r.id));
    for (const r of residual) {
      delete wf[r.id];
      pruned.push({ slot: `(画布残留) node ${r.id}`, node: r.id });
      applied.push({ node: r.id, input: "(删除)", value: null, pruned: `${r.ct}.${r.field} = ${JSON.stringify(r.value)} —— 浏览器粘贴残留，本机没有这个文件` });
    }
    for (const [id, node] of Object.entries(wf)) {
      for (const [k, val] of Object.entries(node.inputs ?? {})) {
        if (Array.isArray(val) && ids.has(String(val[0]))) {
          delete node.inputs[k];
          applied.push({ node: id, input: k, value: null, pruned: `上游 node ${val[0]} 是画布残留素材` });
        }
      }
    }
  }

  // ---- ★ 级联剪枝：上游被剪后，下游若因此缺输入，也一并剪掉 ----
  //
  // 实测（2026-10-16，Krea2）：`195 JoinImageWithAlpha` 的 image/alpha
  // 两个输入都来自 `187`（那个值是 `pasted/image (10).png` 的画布残留）。
  // 剪掉 187 后 195 就没输入了，ComfyUI 报 `node 195: alpha|image`。
  //
  // ★ 判据必须用【摘线之前】记下的原始输入 —— 否则等上面那几段把连线删完，
  //   节点就变成「本来就没有连线输入」，永远匹配不上。（第一版就是这么错的：
  //   写成 `linkIns.length > 0 && alive.length === 0`，而摘线后 linkIns 已经空了。）
  const OUTPUT_TYPES = new Set([
    "SaveImage", "PreviewImage", "VHS_VideoCombine", "SaveVideo", "SaveAudio",
    "BatchImageSaverCN", "PreviewAudio", "SaveAnimatedWEBP", "SaveAnimatedPNG",
  ]);
  // 迭代到不动点：一轮剪完可能让更下游又断链。
  // 实测（2026-10-16，Krea2）：剪 187 → 195 断；再剪 195 → 183 又断。
  // 一轮不够，所以循环到没有新节点可剪为止。
  let round = 0;
  for (;;) {
    round++;
    if (round > 20) break; // 防御：正常不会这么多层
    const cascade = [];
    for (const [id, node] of Object.entries(wf)) {
      if (OUTPUT_TYPES.has(node.class_type)) continue;
      const origin = originInputs.get(id) ?? [];
      if (!origin.length) continue; // 本来就没有连线输入，与剪枝无关
      const aliveNow = origin.filter(([k]) => {
        const cur = node.inputs?.[k];
        return Array.isArray(cur) && wf[String(cur[0])];
      });
      if (aliveNow.length === 0) {
        cascade.push({ id, ct: node.class_type, lost: origin.map(([k, v]) => `${k}←${v[0]}`) });
      }
    }
    if (!cascade.length) break;

    const cids = new Set(cascade.map((c) => c.id));
    for (const c of cascade) {
      delete wf[c.id];
      pruned.push({ slot: `(级联剪枝 r${round}) node ${c.id}`, node: c.id });
      applied.push({
        node: c.id, input: "(删除)", value: null,
        pruned: `${c.ct} 的输入全部来自已剪节点（${c.lost.join(", ")}），无法执行`,
      });
    }
    // 摘掉指向这些节点的连线
    for (const [id, node] of Object.entries(wf)) {
      for (const [k, val] of Object.entries(node.inputs ?? {})) {
        if (Array.isArray(val) && cids.has(String(val[0]))) {
          delete node.inputs[k];
        }
      }
    }
  }

  // ★ 末尾再强制一次 always.set —— toggles 的 rewire 可能覆盖同名输入。
  applyAlwaysSet("最终");

  // ---- ★★ LoRA 多选链（2026-10-19，主人要求）----
  //
  // 主人原话：「krea2 里面的 lora 是不是应该弄一个下拉栏，里面放所有可用 lora，
  //           可以多选开启」
  //
  // 设计：
  //   前端传 params.loras = ["文件名1.safetensors", "文件名2.safetensors"]
  //   这里在【模型链末端】动态插 LoraLoaderModelOnly 节点，把 model 串起来。
  //
  // 为什么不用工作流里现成的 217/218：
  //   那两个是作者画布上写死的（Turbo + 亚洲人像），且 217 的文件本机没有。
  //   动态织入能支持任意多个、任意顺序，也不依赖作者留了几个节点。
  //
  // ★ 判据：if (!params.loras?.length) 直接跳过 —— 不传就是不带，行为与改动前完全一致。
  // ★ 强度：默认 1.0；用户可传 [{name, strength}]，也接受纯字符串数组。
  const loras = Array.isArray(params?.loras) ? params.loras : [];
  if (loras.length) {
    // 找模型链的末端：谁在消费 UNETLoader 的 MODEL？
    //   优先看 loraChain 开关 on 时的布局（218.model ← 214），
    //   也就是「所有 LoraLoaderModelOnly 之后、KSampler/UltimateSDUpscale 之前」。
    //
    // 做法：找当前所有引用 model 的边，把源头是 214(UNETLoader) 或
    //      已有 LoraLoader 的，重新接到新链尾部。
    const LORA_CLASS = "LoraLoaderModelOnly";
    let lastModelRef = ["214", 0];   // 默认从 UNETLoader 起

    // 若工作流里已经有 LoraLoader 且没被删（loraChain 开），从最末端那个续接
    const existLoras = Object.entries(wf)
      .filter(([, n]) => n.class_type === LORA_CLASS)
      .map(([id]) => id);

    // ★★ 2026-10-19 修（verify-lora-chain.mjs 第 ⑦ 组抓到的真缺陷）：
    //   原来找链尾的判据是「没有下游的 lora」，但 loraChain 开着时
    //   218 被 199/203/221 消费（那正是它该有的样子），于是 used=true，
    //   循环永远找不到链尾 ⇒ lastModelRef 保持默认的 214
    //   ⇒ 用户的 LoRA 从 214 分支出第二条链，把作者的 218 绕过去了（并联而非串联）。
    //
    //   实测（修复前）：214 → 218 → KSampler
    //                   214 → 9000(用户的)   ← 分叉，白挂
    //
    //   ✅ 正确判据：链尾 = 「它的 model 输入指向另一个 lora」这条链上最深的那一个。
    //      也就是从任意 lora 出发，沿 model 向后走，走不动了就是链尾。
    if (existLoras.length) {
      const isLora = (id) => existLoras.includes(String(id));
      // 从每个 lora 沿 model 向「下游」走（谁能连到我），取路径最长的末端
      let tail = null;
      for (const id of existLoras) {
        // 谁把 model 指向我？如果指向我的是另一个 lora，说明我在它下游
        const parent = Object.entries(wf).find(([pid, n]) =>
          isLora(pid) && String(n.inputs?.model?.[0]) === id
        );
        // 没有 lora 父节点 ⇒ 我是链头；反过来找链尾：
        // 找「被 lora 作为 model 来源」的那个，即最深的一环
      }
      // 直接算：每个 lora 到链头的距离，最远的就是链尾
      let best = null, bestDist = -1;
      for (const id of existLoras) {
        let dist = 0, cur = id, guard = 0;
        while (guard++ < 20) {
          const n = wf[cur];
          const src = String(n?.inputs?.model?.[0] ?? "");
          if (!isLora(src)) break;      // 走到非 lora（UNETLoader）就停
          dist++;
          cur = src;
        }
        if (dist > bestDist) { bestDist = dist; best = id; }
      }
      if (best) lastModelRef = [best, 0];
    }

    // 谁在消费当前链尾的 MODEL？把它们改接到新链尾
    const consumers = [];
    for (const [id, node] of Object.entries(wf)) {
      for (const [k, val] of Object.entries(node.inputs ?? {})) {
        if (Array.isArray(val) && String(val[0]) === lastModelRef[0]) {
          // 只收 model 输入（不碰 clip/vae 之类）
          if (k === "model") consumers.push({ id, input: k });
        }
      }
    }

    // 织入：从 9000 起编号，避开工作流已有的 id
    let nextId = 9000;
    const newIds = [];
    for (const raw of loras) {
      const name = typeof raw === "string" ? raw : raw?.name;
      const strength = typeof raw === "string" ? 1 : Number(raw?.strength ?? 1);
      if (!name) continue;
      while (wf[String(nextId)]) nextId++;
      const id = String(nextId++);
      wf[id] = {
        class_type: LORA_CLASS,
        inputs: {
          lora_name: name,
          strength_model: Number.isFinite(strength) ? strength : 1,
          model: lastModelRef,
        },
      };
      newIds.push(id);
      lastModelRef = [id, 0];
      applied.push({ node: id, input: "lora_name", value: name });
    }

    // 把原来的消费者接到链尾
    if (newIds.length && consumers.length) {
      for (const { id, input } of consumers) {
        wf[id].inputs[input] = lastModelRef;
      }
    }
  }

  /**
   * ★ 2026-10-25：把【实际用的种子】传出去。
   *   前端要把它回填进输入框，用户才能「同一张换个细节再试」。
   *   null 表示这个工作流没有种子变量（不声明 vars.seed 的就不该有）。
   */
  return { prompt: wf, applied, length: frames ?? null, pruned, toggles: toggleState, skipped, seed: usedSeed };
}

/**
 * 给 ComfyUI 的产物打 source（语义 key）。
 *
 * ★ 为什么需要它（2026-10-18，架构师 E5 实测）：
 *   comfy.mjs 的 history() 只返回 { nodeId, kind, filename, subfolder, type, url }，
 *   bind.outputs 的 { image→202, imageTwoPass→220, imageUsd→186, imageSeedvr→174 }
 *   从来没传到前端。前端只能靠文件名正则猜（-2ST- / -USD- / -SVR-），
 *   而那些前缀是【工作流数据不是契约】—— ComfyUI 里改个 filename_prefix，
 *   四个角标就同时错位。
 *
 * ★ 为什么放这里而不是 comfy.mjs：
 *   comfy.mjs 只是「ComfyUI 的原样客户端」，拿不到 bind（它只收 base）。
 *   映射是业务层的事；将来 M3 转存也要用同一张表，从这一个纯函数取，不重复写。
 *
 * ★ 为什么 source 必须是 null 不能是 undefined：
 *   JSON.stringify({source: undefined}) → "{}"               字段直接消失
 *   JSON.stringify({source: null})      → '{"source":null}'  前端能判
 *   写成 undefined 会让前端拿到「字段不存在」而不是「字段为 null」，
 *   兜底分支会写错。
 *
 * @param {Record<string,string>} outMap  bind.outputs，形如 { image: "202", imageUsd: "186" }
 * @param {Array<object>} outputs         comfy.history() 返回的产物数组
 * @returns {Array<object>}               新数组，每项加了 source；入参不被修改
 */
export function mapOutputSources(outMap, outputs) {
  const byNode = new Map();
  for (const [key, nodeId] of Object.entries(outMap ?? {})) {
    byNode.set(String(nodeId), key);
  }
  return (outputs ?? []).map((o) => ({
    ...o,
    // 表外节点（如附带 JPG 的 175）→ null，由前端兜底
    source: byNode.get(String(o.nodeId)) ?? null,
  }));
}
