
/**
 * 工作台状态持久化 —— 质检 P1-4 修复。
 *
 * ★ 问题：切到「轨迹」tab 再切回来，组件被【卸载后重建】——
 *   实测 document.querySelector(".comfy-wb") 返回 null，说明整个子树销毁了。
 *   于是提示词、所选工作流、参数全丢，而 ComfyUI 里的任务还在跑，
 *   用户会以为没提交过，再点一次就变成两个任务。
 *
 * ★ 为什么用 sessionStorage 而不是 localStorage：
 *   这是「同一次浏览会话里的 tab 切换」，关掉页面就该清掉。
 *   localStorage 会让下次打开还留着上次的提示词，反而更乱。
 *
 * ★ 只存「用户填的东西」，不存瞬时状态（job / 轮询 / error）。
 *   存 job 反而危险：重建后拿旧 jobId 去查，可能已经 lost。
 */
const PERSIST_KEY = "dsh-comfy-workbench:v1";

/**
 * ★★ 2026-10-21 加防线：读出时剥掉「用户不该看到的内容」
 *
 *   实测事故：
 *     提示词框里出现 "subject_definitions:\n<Subject 1> is the character in <Picture 1>."
 *     而且 sessionStorage.clear() 之后【立刻刷新】，值又回来了。
 *
 *   根因链：
 *     ① 某次测试把 H3 内部格式写进了 prompt 字段
 *     ② sessionStorage 被清空
 *     ③ 刷新前组件的 useEffect 跑 savePersisted(prompt: 脏数据)
 *     ④ 脏数据回到 sessionStorage  ⇒ 自我复制，清一次不够
 *
 *   ⇒ 在读入口过滤：认出内部 section 就剥掉，只留用户正文。
 *
 *   ★ 判据：sessionStorage 该存【用户输入】，不是【给模型的格式】。
 *     两者混在一起时，用户看到不认识的内容，而且删不掉（会自我复制）。
 */
const INTERNAL_MARKERS = /^(subject_definitions|overall_soundscape|non_diegetic_music)\s*[:：]/m;

export function stripInternalFormat(text) {
  const s = String(text ?? "");
  if (!INTERNAL_MARKERS.test(s)) return s;
  const arr = s.split(/\r?\n/);
  let i = 0;
  while (i < arr.length) {
    const line = arr[i].trim();
    if (INTERNAL_MARKERS.test(line)) { i++; continue; }
    if (/^<(Subject|Picture|Video|Audio)\s*\d+>/i.test(line)) { i++; continue; }
    if (line === "") { i++; continue; }
    break;
  }
  return arr.slice(i).join("\n").trim();
}

function loadPersisted() {
  try {
    const raw2 = sessionStorage.getItem(PERSIST_KEY);
    if (!raw2) return null;
    const j = JSON.parse(raw2);
    // ★ 读出时清理 prompt 里的内部格式（见 stripInternalFormat）
    if (j && typeof j.prompt === "string") {
      const cleaned = stripInternalFormat(j.prompt);
      if (cleaned !== j.prompt) {
        j.prompt = cleaned;
        try { sessionStorage.setItem(PERSIST_KEY, JSON.stringify(j)); } catch { /* ignore */ }
      }
    }
    return j;
  } catch { return null; }
}

function savePersisted(patch) {
  try {
    const cur = loadPersisted() ?? {};
    sessionStorage.setItem(PERSIST_KEY, JSON.stringify({ ...cur, ...patch }));
  } catch { /* 隐私模式 / 配额满 —— 静默降级，不持久化而已 */ }
}

/**
 * 素材槽上传器 —— 质检 P1-6 修复。
 *
 * ★ 为什么必须有它：
 *   qwen21-edit（改图）的工作流里有 LoadImage 节点，值是作者浏览器里
 *   粘贴的示例图。没有上传入口时，点「生成」会拿那张示例图跑，
 *   用户以为自己改的是自己的图，实际改的是作者的样例 ——
 *   核心用途完全不可用，界面还毫无提示。
 *
 * ★ 契约（后端早就支持，只是没人调）：
 *   前端传 params.files = { [slot]: { base64, filename } }
 *   后端 uploadImage → 拿到 ComfyUI 的文件名 → 填进该槽对应的节点。
 *   槽定义来自 /modes 的 media 字段：
 *     { ref_image_0: { node, input, label, accept, kind } }
 *
 * ★ 缺必填槽的后果（workflows.mjs:604-620 逐字）：
 *   没提供 + spec.required ⇒ 抛「槽 X 是必填，但没提供文件」
 *   没提供 + 非必填   ⇒ 剪掉该节点
 *   ⇒ 所以这里要在点生成前提示缺哪个，而不是让后端抛错。
 */
/**
 * 素材槽 —— 支持「用途」（照 YUH Studio 的参考图分用途）。
 *
 * ★ 为什么要有「用途」：
 *   H3 的提示词用四种标签区分素材角色（官方 references/ref-en.txt）：
 *     <Subject N> 角色/主体外观    <Picture N> 具体帧/分镜锚点
 *     <Video N>   动作/运镜       <Audio N>   声音
 *   而工作流侧只是 ref_images.ref_image_0..5 六个按位置编号的槽 ——
 *   光看槽位分不出「这张是给某一镜当首帧」还是「只用来定角色长相」。
 *
 *   官方逐字：「If an image is used only to define a character, scene, costume,
 *   or style, do not create a standalone picture entry.」
 *   ⇒ 用错了会让 H3 把一张只该定外观的图当成某一帧，画面被强行凑上去。
 *
 * ★ 分工：
 *   槽位用途 → 只影响【提示词标签怎么生成】，不影响【图片填哪个节点】。
 *   图片永远按 slot 填节点（后端 media 映射），用途纯属提示词工程。
 *   这样即使标签生成出错，生成结果也只是提示词不够准，不会跑错图。
 */
function MediaSlots({ media, files, roles, onPick, onRole, hideEmpty, t }) {
  let slots = Object.entries(media ?? {});
  // ★★ 2026-10-20：hideEmpty —— 只渲染【已绑定】的槽。
  //
  //   主人在 2026-10-20 决定：「+参考图1~6 / +参考视频1 / +参考音频1~3」那排
  //   按钮全去掉，统一走资产库的 @ 引用。
  //   ⇒ 空槽不再显示成「+ 参考图1」按钮。
  //   ⇒ 但已绑定的槽仍显示（否则用户看不出绑了什么、也不知道类型对不对）。
  if (hideEmpty) {
    slots = slots.filter(([slot]) => {
      const f = files?.[slot];
      return f && (f.assetId || f.base64 || f.filename);
    });
  }
  if (!slots.length) return null;

  const pick = (slot, accept) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept || "*/*";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      // 20MB 上限 —— base64 会膨胀 33%，再大 HTTP body 容易被宿主截断
      if (file.size > 20 * 1024 * 1024) {
        alert(`文件太大：${(file.size / 1024 / 1024).toFixed(1)}MB，上限 20MB`);
        return;
      }
      const buf = await file.arrayBuffer();
      let bin = "";
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      const base64 = btoa(bin);
      const kind = file.type.startsWith("video") ? "video"
        : file.type.startsWith("audio") ? "audio" : "image";
      onPick(slot, {
        base64,
        filename: file.name,
        kind,
        preview: URL.createObjectURL(file),
        /**
         * 默认用途（2026-10-20 改用 H3 新 id）：
         *   图片 → 角色外观（最保守 —— 不会强行当帧，符合官方第 68 行）
         *   视频 → 动作/表情（官方第 88 行：视频取动作仍属 Subject，不是 Video）
         *   音频 → 音色
         * ★ 旧值是平铺的 appearance/motion/sound，那是 4 分类时代的写法。
         *   虽然 h3-labels.js 的 migrateLegacyRole() 能兼容，
         *   但新代码直接用新 id，不依赖兼容层。
         */
        role: defaultRoleFor(kind),
      });
    };
    input.click();
  };

  return h("div", {
    style: {
      display: "flex", alignItems: "center", gap: 6,
      flexWrap: "wrap", padding: "2px 0",
    },
  },
    ...slots.map(([slot, spec]) => {
      const f = files?.[slot];
      const label = spec.label ?? slot;
      const kinds = rolesForKind(f?.kind ?? spec.kind ?? "image");
      const cur = kinds.find((k) => k.id === (f?.role ?? roles?.[slot])) ?? kinds[0];

      return h("span", {
        key: slot,
        style: { display: "inline-flex", alignItems: "center", gap: 3 },
      },
        // ① 选文件
        h("button", {
          type: "button",
          title: f
            ? `${label}：${f.displayName || f.filename}（点击替换）`
            : `点击选择${label}（${spec.accept ?? "*/*"}）`,
          onClick: () => pick(slot, spec.accept),
          style: {
            display: "inline-flex", alignItems: "center", gap: 5,
            height: 28, padding: f ? "0 6px 0 3px" : "0 8px",
            border: 0, borderRadius: 8, cursor: "pointer",
            fontFamily: "inherit", fontSize: 12, fontWeight: 400,
            maxWidth: 170, overflow: "hidden",
            background: f
              ? "var(--dsw-alias-interactive-bg-active, #f1f3f5)"
              : "transparent",
            color: f
              ? "var(--dsw-alias-label-primary, #0f1115)"
              : "var(--dsw-alias-label-tertiary, #81858c)",
          },
        },
          f
            ? h("img", {
                src: f.preview, alt: "",
                style: { width: 22, height: 22, borderRadius: 5, objectFit: "cover", flex: "none" },
              })
            : h("span", {
                style: {
                  width: 16, height: 16, borderRadius: 4, flex: "none",
                  border: "1px dashed currentColor", opacity: 0.6,
                  display: "inline-flex", alignItems: "center",
                  justifyContent: "center", fontSize: 11, lineHeight: 1,
                },
              }, "+"),
          h("span", {
            style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
          }, f ? (f.displayName || f.filename) : label)
        ),

        // ② 用途（只有选了文件才出现；只有一个可选用途时不显示）
        //
        // ★★ 2026-10-20 改（主人：「要能在编辑框中临时修改，修改后就默认保存」）：
        //   这里改的是【这个槽的当前用途】。改完通过 onRole 一路传到
        //   WorkbenchView 的 onRole 处理器，那里会：
        //     ① 更新 files[slot].role（本次生成用它）
        //     ② 若这个槽来自资产库（有 assetId），同时写回资产库的 role 字段
        //   ⇒ 「临时修改 + 默认保存」两件事一次做完。
        //
        // ★ 文案用 zh（h3-labels 新字段），不是 label（旧字段已不存在）。
        //   并按 H3 标签分组，让人看清「这个用途会变成哪种标签」。
        f && kinds.length > 1
          ? h("select", {
              title: cur
                ? `${cur.zh} → <${cur.tag}>\n${cur.hint}\n（改完会保存到资产库，下次 @ 它自动带上）`
                : "",
              value: cur?.id ?? "",
              onChange: (e) => onRole(slot, e.target.value),
              style: {
                height: 24, maxWidth: 130,
                border: 0, borderRadius: 6,
                background: "var(--dsw-alias-interactive-bg-hover, #f5f6f7)",
                color: "var(--dsw-alias-label-secondary, #5c6068)",
                fontFamily: "inherit", fontSize: 11,
                padding: "0 4px", cursor: "pointer",
              },
            },
            ...["Subject", "Picture", "Video", "Audio"].map((tagName) => {
              const grp = kinds.filter((k) => k.tag === tagName);
              if (!grp.length) return null;
              return h("optgroup", { key: tagName, label: `<${tagName}>` },
                ...grp.map((k) => h("option", { key: k.id, value: k.id }, k.zh))
              );
            })
          )
          : null
      );
    })
  );
}


/**
 * WorkbenchView —— 中栏「视频工作台」标签页。
 *
 * 2026-10-18 改版：参数区从「胶囊按钮多行」改为「一行下拉框」。
 *
 * 布局（自上而下）：
 *   状态行 → 参数条（一行：工作流/画幅/动态槽/步数[/二采步数]/种子/生成）
 *          → 开关行（若有） → 提示词（可拖高，最少 5 行） → 成果区（占满剩余）
 *
 * 动态槽（第 3 位）按模式能力切换：
 *   有 durationSec → 「时长」（视频流，如 yz）
 *   无 durationSec → 「张数」（生图流，如 krea2/qwen21/qwen21-edit）
 * 二采步数只在该模式 vars 里有 steps2 时出现（目前只有 krea2）。
 * 能力一律读后端给的 mode.caps，不在前端猜。
 *
 * 样式取值来源：19499 实例实机测量（docs/预览/测量记录.md）
 *   控件高 28px / 边框 0px / 圆角 8px(--dsw-radius-sm) / 字体 13px
 *   hover 为 --dsw-alias-interactive-bg-hover
 *   焦点环是 box-shadow 2px（不是 outline），用 --dsw-alias-state-business-primary
 *
 * Props：{ sessionId, bridge, t }
 */
import React from "react";
import { DeviceMonitor, DeviceMonitorBoundary } from "./DeviceMonitor.mjs";
/**
 * ★ 画布式资产库（主人 2026-10-18）
 *   「现在的视频工作台部分是不是空白太多？弄成画布怎么样？」
 *   「图片不能打开，不能保存，不知道对应的是哪个的产物」
 *   —— 独立模块，自带 Boundary；它崩了只丢画布，参数区照常可用。
 */
import { SafeCanvas } from "./AssetCanvas.js";
import { rolesForKind, tagReferences, defaultRoleFor } from "./h3-labels.js";
/**
 * ★ 全局资产库 + @ 引用（主人 2026-10-18）
 *   「我需要那种全局资产库，在提示词框中@就能直接调用」
 *   独立模块，自带 Boundary；它崩了只丢库，提示词与生成照常。
 */
import {
  useAssetAtMentions, AssetLibraryBoundary, useAssetPicker,
} from "./AssetLibrary.js";

// ★ 2026-10-18：补 useMemo —— 原来解构里没有它，
//   我加了 refWarnings 的 useMemo 后整个工作台白屏（ReferenceError: useMemo is not defined）。
const { useState, useEffect, useRef, useCallback, useMemo } = React;
const h = React.createElement;

/**
 * DSH 原生图标（2026-10-22）
 *
 * 主人：「这两个的图标不够DSH，很突兀」—— 原来是 emoji 🗂 / 🎲，
 * 彩色位图与 DSH 的单色线性图标体系完全不搭。
 *
 * ★ 三级回退，绝不白屏：
 *   ① 有 hostRequire → 取 DSH 图标
 *   ② 取到但导出名不对 → 占位 span（尺寸保持，布局不塌）
 *   ③ 没有 hostRequire → 同上
 */
const ICON_NAMES = {
  folderOpen: "IconFolderOpenOutlineMedium",
  refresh: "IconRefreshOutlineMedium",
  plus: "IconPlusOutlineMedium",
  trash: "IconTrashOutlineMedium",
  close: "IconCloseOutlineMedium",
  info: "IconInfoOutlineMedium",
  sparkle: "IconSparkleOutlineMedium",
  sliders: "IconSlidersOutlineMedium",
  download: "IconDownloadOutlineMedium",
  search: "IconSearchOutlineMedium",
  ellipsis: "IconEllipsisOutlineMedium",
};

function DshIcon({ hostRequire, name, size = 14 }) {
  const Comp = useMemo(() => {
    try {
      if (typeof hostRequire !== "function") return null;
      const pkg = hostRequire("@deepseek-ai/dsh-client-ui-primitives");
      const exportName = ICON_NAMES[name] || name;
      const C = pkg?.[exportName];
      /* ★ forwardRef 的 typeof 是 "object" 不是 "function"（AGENTS §7.6-②） */
      return (typeof C === "function" || (C && typeof C === "object" && "$$typeof" in C)) ? C : null;
    } catch { return null; }
  }, [hostRequire, name]);

  if (!Comp) {
    return h("span", { style: { display: "inline-block", width: size, height: size }, "aria-hidden": "true" });
  }
  return h(Comp, { size, "aria-hidden": "true" });
}

const ASPECTS = ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"];
const DURATIONS = [5, 10, 15];
// 尺寸档位 → ResolutionSelector.megapixels（1024/2048/4096 的平方折算成兆像素）
// 实测：yz 现在 1.5、krea2 现在 1、qwen21 现在 2
// 画幅的显示顺序：横屏在左、竖屏在右成对排，1:1 单独占一行。
// ★ 主人 2026-10-18：「把横屏和竖屏的分辨率左右对齐放在一行？1:1 单独放一行，
//   16:9 和 9:16 对齐一行，这样直观一点」
// ★ 排版（主人 2026-10-18）：「1:1 和 21:9 放一行，这样刚好整洁，没有浪费空间」
//   第一行：1:1 + 21:9（两个「没有配对」的）
//   之后每行都是横屏左 / 竖屏右
const ASPECT_FIRST_ROW = ["1:1", "21:9"];
const ASPECT_PAIRS = [
  ["16:9", "9:16"],   // 宽屏
  ["4:3", "3:4"],     // 标准
  ["3:2", "2:3"],     // 相片
];
const ASPECT_SOLO = [];   // 已全部并入首行

// SeedVR2 放大模型（本机两个都有，实测于 2026-10-18）
const SEEDVR_MODELS = [
  { v: "seedvr2_7b_int8_convrot.safetensors", t: "7B" },
  { v: "seedvr2_3b_nvfp4.safetensors", t: "3B" },
];

const MEGAPIXELS = [
  { v: 1.0, t: "1K" },
  { v: 4.0, t: "2K" },
  { v: 16.0, t: "4K" },
];
const STEPS = [4, 6, 8, 10, 15, 20];
const STEPS2 = [3, 5, 8, 10, 15];
const BATCHES = [1, 2, 4, 8];

/* ══════════════════════════════════════════════════════════════════════
   样式常量 —— 与 docs/预览/工作台参数区.html 一一对应。
   改这里必须同步改预览，两份数值必须一致。
   ══════════════════════════════════════════════════════════════════════ */

const BAR_HEIGHT = 32;        // 参数条总高（方案书 §3.1 上限）

/** 下拉框 / 输入框共用（照抄官方 trigger 实测值） */
const ctrl = {
  appearance: "none",
  WebkitAppearance: "none",
  display: "block",
  width: "100%",
  height: 28,
  minWidth: 0,                          // ★ 必须，否则 grid 项不收缩
  // ★ 主人 2026-10-18 明确要求：三角在文字【左边】（方案书 §3.4 的右侧做法已作废）
  padding: "0 8px 0 18px",
  border: 0,                            // 实测官方 0px
  borderRadius: "var(--dsw-radius-sm, 8px)",
  background: "transparent",            // 实测官方透明
  color: "var(--dsw-alias-label-secondary, #61666b)",
  font: "var(--dsw-font-xs-13, 13px/20px inherit)",
  textAlign: "left",
  cursor: "pointer",
  outline: "none",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

/** 自绘箭头 ▾ */
const arrow = {
  position: "absolute",
  left: 5,                                  // ★ 三角在文字左边
  top: "50%",
  transform: "translateY(-50%)",
  pointerEvents: "none",
  fontSize: 9,
  lineHeight: 1,
  color: "var(--dsw-alias-label-tertiary, #81858c)",
};

const field = { position: "relative", minWidth: 0, width: "100%" };

const btn = {
  flex: "none",
  height: 28,
  minWidth: 72,
  padding: "0 14px",
  border: 0,
  borderRadius: "var(--dsw-radius-sm, 8px)",
  background: "var(--dsw-alias-button-primary-fill, #0f1115)",
  // ★ 文字色必须跟底色翻转 —— 暗色下底近白，硬编码 #fff 会变白字白底（实测 1.00:1）
  // ★ DSH 没有 button-primary-fg 这个 token（实测 403 个 token 里没有），
  //   必须用 label-primary-foreground —— 它在浅色下是白、暗色下是黑，
  //   正好跟 button-primary-fill 的翻转配对。
  color: "var(--dsw-alias-label-primary-foreground, #fff)",
  font: "var(--dsw-font-xs-13, 13px/20px inherit)",
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const btnOff = {
  ...btn,
  background: "var(--dsw-alias-interactive-bg-active, #2631481a)",
  color: "var(--dsw-alias-label-tertiary, #81858c)",
  cursor: "not-allowed",
};

/**
 * 下拉框 —— 自绘面板，不用原生 <select>。
 *
 * ★ 为什么不用原生 select（2026-10-18 主人反馈）：
 *   ① 点开后有浏览器原生蓝色焦点环，CSS 的 outline:none 挡不住（UA 样式）
 *   ② 弹出的选项列表是系统灰底样式，跟 DSH 完全不搭
 *   两者都改不动 —— 只能自己画。
 *
 * 交互：点击展开 / 再点收起 / 点外面关 / Esc 关 / 方向键可选。
 * hover 底色只包「三角 + 文字」，控件占位由外层 grid 列决定 → 切选项不位移。
 */
function Select({ label, value, options, onChange, disabled, title, minWidth = 0, formatValue, pairGroups }) {
  const [open, setOpen] = useState(false);
  const [hot, setHot] = useState(false);
  const [active, setActive] = useState(-1);
  const boxRef = useRef(null);

  // ★ 当前值不在 preset 列表里时（实测：qwen21 默认 40 步、qwen21-edit 默认 25 步，
  //   都不在 STEPS=[4,6,8,10,15,20] 里），把当前值插进去当额外选项 ——
  //   否则 find 返回 undefined → 回退 options[0] → 界面显示「4 步」但实际提交 40 步。
  // ★ formatValue 对所有项生效，不只是兜底项 ——
  //   实测（2026-10-18）：一开始只给兜底项套 formatValue，
  //   结果值在 options 里时（如 10 步）显示成光秃秃的「10」，没有单位。
  const withText = (o) => ({ value: o.value, text: formatValue ? formatValue(o.value) : o.text });
  const opts = options.some((o) => String(o.value) === String(value))
    ? options.map(withText)
    : [withText({ value, text: String(value) }), ...options.map(withText)];
  const curIdx = Math.max(0, opts.findIndex((o) => String(o.value) === String(value)));
  const text = opts[curIdx] ? opts[curIdx].text : "";

  // 点外面 / Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => { if (!open) setActive(-1); }, [open]);

  const pick = (i) => {
    const o = opts[i];
    if (!o) return;
    onChange(String(o.value));
    setOpen(false);
  };

  const onKeyDown = (e) => {
    if (disabled) return;
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault(); setOpen(true); setActive(curIdx);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault(); setActive((i) => Math.min(opts.length - 1, (i < 0 ? curIdx : i) + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault(); setActive((i) => Math.max(0, (i < 0 ? curIdx : i) - 1));
    } else if (e.key === "Enter") {
      e.preventDefault(); pick(active < 0 ? curIdx : active);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  return h("div", {
      ref: boxRef,
      // ★ 槽必须定宽 —— 否则「切选项不位移」会失效。
      //   实测（2026-10-18）：flex 下前槽宽度随后槽文字变化，
      //   切工作流时画幅槽动 12px、时长槽动 24px、步数槽动 36px。
      style: { ...field, position: "relative", flex: "0 0 auto", width: minWidth || undefined },
      onMouseEnter: () => !disabled && setHot(true),
      onMouseLeave: () => setHot(false),
    },
    // 触发器：一个 button，不是 select —— 所以没有原生焦点环
    h("button", {
      type: "button",
      role: "combobox",
      "aria-label": label,
      "aria-expanded": open,
      "aria-haspopup": "listbox",
      disabled: !!disabled,
      title: title || label,
      onClick: () => !disabled && setOpen((v) => !v),
      onKeyDown,
      style: {
        ...ctrl,
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        // ★ 2026-10-19 修（复核员 2e3543a0 打穿，我复跑确认）：
        //   原来这里写 width: "100%"，hover 背景就铺满整个定宽槽（实测 96px），
        //   而文字只有 62~86px —— 主人 2026-10-18 明确要求「hover 底色只覆盖
        //   文字宽度」。AGENTS §3.9 描述的 .wb-hl 高亮层在当前实现里并不存在
        //   （grep 源码与 lib/client.js 均 0 命中）。
        //   ⇒ 用 justify-content: flex-start + 内层包裹承载背景，
        //     包裹宽度 = 三角 + 文字，随文字变，槽宽仍由外层固定（不位移）。
        justifyContent: "flex-start",
        width: "100%",                 // 占满定宽的槽 → 触发器尺寸不随文字变
        maxWidth: "100%",
        padding: 0,                    // ★ 内边距移到内层，否则背景仍会带出空白
        overflow: "hidden",
        border: 0,
        borderRadius: "var(--dsw-radius-sm, 8px)",
        background: "transparent",     // ★ 背景不再挂在满宽按钮上
        color: hot && !disabled
          ? "var(--dsw-alias-label-primary, #0f1115)"
          : "var(--dsw-alias-label-secondary, #61666b)",
        font: "var(--dsw-font-xs-13, 13px/20px inherit)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.45 : 1,
      },
    },
      // ★ 内层包裹：只包「三角 + 文字」，背景挂在这里 → 只覆盖文字宽度
      //
      // ★★ 2026-10-19 压缩（主人：「还是两排，精简一下缩短一下」）：
      //   原 padding "0 6px 0 4px" + gap 4 = 每个下拉多占 14px。
      //   9 个下拉 × 14 = 126px 的纯装饰开销。
      //   ⇒ gap 4→2、padding "0 6px 0 4px" → "0 4px 0 3px"，每个省 5px。
      //   省下的 45px 用来把右侧「资产库/种子/生成」拉回第一排。
      h("span", {
        style: {
          display: "inline-flex",
          alignItems: "center",
          gap: 2,
          maxWidth: "100%",
          minWidth: 0,
          padding: "0 4px 0 3px",
          borderRadius: "var(--dsw-radius-sm, 8px)",
          background: hot && !disabled
            ? "var(--dsw-alias-interactive-bg-hover, #2631480f)"
            : "transparent",
        },
      },
        h("span", { style: { ...arrow, position: "static", transform: "none", opacity: disabled ? 0.3 : 0.9 } }, "▾"),
        h("span", {
          style: {
            fontSize: 13, whiteSpace: "nowrap",
            overflow: "hidden", textOverflow: "ellipsis",
            minWidth: 0,               // ★ flex 子项默认不收缩，没它 ellipsis 不触发
            flex: "1 1 auto",
          },
        }, text)
      )
    ),

    // 自绘面板
    open
      ? h("div", {
          role: "listbox",
          "aria-label": label,
          style: {
            position: "absolute",
            // ★ 向上展开 —— 参数条在卡片底部，往下会盖住 DSH 自己的输入框，
            //   往上更自然（主人 2026-10-18 反馈）。
            bottom: "calc(100% + 4px)",
            left: 0,
            zIndex: 30,
            minWidth: "100%",
            maxHeight: 260,
            overflowY: "auto",
            padding: 4,
            // ★ 有 pairGroups（画幅）时按「横屏左 / 竖屏右」显式排；
            //   否则选项多时用均分双列。
            display: pairGroups ? "block" : (opts.length > 6 ? "grid" : "block"),
            gridTemplateColumns: (!pairGroups && opts.length > 6) ? "1fr 1fr" : undefined,
            gap: (!pairGroups && opts.length > 6) ? 2 : undefined,
            borderRadius: 16,                      // ★ 官方 16px
            border: 0,
            // ★ 不能用 bg-overlay —— 实测它是 #e9ecf2（浅灰），比页面白底更深，
            //   面板看起来是凹陷的灰块而不是浮起来的白卡。
            //   bg-layer-1 才是浮层白（#fff），配 elevation-panel 阴影才像弹出。
            background: "var(--dsw-alias-bg-layer-1, #fff)",
            // ★ 官方面板是毛玻璃：半透明 + blur(40px) saturate(1.5)
            backdropFilter: "blur(40px) saturate(1.5)",
            boxShadow: "var(--dsw-elevation-panel, 0 3px 8px rgba(0,0,0,.04), 0 0 20px rgba(0,0,0,.05))",
          },
        },
          (() => {
            // 单项渲染（选中项加粗 + ✓）
            const renderItem = (o, i) => h("div", {
              key: String(o.value) + "@" + i,
              role: "option",
              "aria-selected": i === curIdx,
              onMouseEnter: () => setActive(i),
              onMouseDown: (e) => { e.preventDefault(); pick(i); },
              style: {
                padding: "5px 10px",
                borderRadius: "var(--dsw-radius-sm, 8px)",
                fontSize: 13,
                lineHeight: "20px",
                whiteSpace: "nowrap",
                cursor: "pointer",
                color: i === curIdx
                  ? "var(--dsw-alias-label-primary, #0f1115)"
                  : "var(--dsw-alias-label-secondary, #61666b)",
                fontWeight: i === curIdx ? 600 : 400,
                background: i === active
                  ? "var(--dsw-alias-interactive-bg-hover, #2631480f)"
                  : "transparent",
              },
            },
              // ★ 不加 ✓ —— 主人 2026-10-18：勾会把右边的格子挤开，加粗就够了
              o.text
            );

            // 没有 pairGroups → 普通列表 / 均分双列
            if (!pairGroups) return opts.map((o, i) => renderItem(o, i));

            // ★ 有 pairGroups（画幅）→ 横屏左 / 竖屏右成对，1:1 单独一行
            const find = (v) => opts.findIndex((o) => String(o.value) === v);
            const row = (nodes, key) =>
              h("div", { key, style: { marginBottom: 2 } }, nodes);

            const out = [];

            // ★ 首行：1:1 + 21:9（这两个没配对的放一排，刚好填满不留空）
            {
              const firstRow = ASPECT_FIRST_ROW
                .map((v) => ({ v, i: find(v) }))
                .filter(({ i }) => i >= 0);
              if (firstRow.length === 2) {
                out.push(h("div", {
                  key: "first-row",
                  style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 2, marginBottom: 2 },
                },
                  h("div", null, renderItem(opts[firstRow[0].i], firstRow[0].i)),
                  h("div", null, renderItem(opts[firstRow[1].i], firstRow[1].i))
                ));
              } else {
                for (const { v, i } of firstRow) out.push(row(renderItem(opts[i], i), "first-" + v));
              }
            }
            // 其余 solo（如果以后再加）
            for (const v of ASPECT_SOLO) {
              const i = find(v);
              if (i >= 0) out.push(row(renderItem(opts[i], i), "solo-" + v));
            }

            // 横竖成对
            for (const pair of ASPECT_PAIRS) {
              const a = find(pair[0]);
              const b = find(pair[1]);
              if (a >= 0 && b >= 0) {
                out.push(h("div", {
                  key: "pair-" + pair.join("-"),
                  style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 2, marginBottom: 2 },
                },
                  h("div", null, renderItem(opts[a], a)),
                  h("div", null, renderItem(opts[b], b))
                ));
              } else if (a >= 0 || b >= 0) {
                const i = a >= 0 ? a : b;
                out.push(row(renderItem(opts[i], i), "half-" + pair.join("-")));
              }
            }

            // 兜底：不在配对表里的原样列出
            opts.forEach((o, i) => {
              const v = String(o.value);
              const known = ASPECT_SOLO.includes(v) || ASPECT_FIRST_ROW.includes(v)
                || ASPECT_PAIRS.some((p) => p.includes(v));
              if (!known) out.push(row(renderItem(o, i), "extra-" + v));
            });

            return out;
          })()
        )
      : null
  );
}


/**
 * 数字输入框 + 上下箭头（照原生 number input 的交互，但样式可控）。
 *
 * ★ 为什么不用下拉：主人 2026-10-18 明确要求
 *   「步数不用下拉选择，改成支持文本输入以及上下箭头加减步数的那种」。
 * ★ 为什么不用原生 <input type="number"> 的箭头：实测原生箭头在 28px 高里
 *   只有 10px 宽、几乎点不到，且各浏览器长相不一，和 DSH 风格不统一。
 *
 * 支持：直接打字 / 点上下箭头 / ↑↓ 键 / 失焦时夹到 [min,max] / 回车确认。
 */
function NumberField({
  label, prefix = "", suffix = "", value, onChange,
  min = 1, max = 200, step = 1, width = 80, disabled, title,
}) {
  const [draft, setDraft] = useState(String(value ?? ""));
  const [hot, setHot] = useState(false);

  // 外部值变了（切工作流 / 开关二采）→ 同步
  useEffect(() => { setDraft(String(value ?? "")); }, [value]);

  const commit = useCallback((raw) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) { setDraft(String(value ?? "")); return; }
    const clamped = Math.max(min, Math.min(max, Math.round(n)));
    setDraft(String(clamped));
    onChange(clamped);
  }, [min, max, onChange, value]);

  const bump = useCallback((dir) => {
    if (disabled) return;
    const cur = Number(draft);
    const base = Number.isFinite(cur) ? cur : Number(value ?? min);
    commit(base + dir * step);
  }, [draft, value, step, min, commit, disabled]);

  return h("div", {
      /**
       * ★★ 2026-10-21 U5 修（参数行间距不一致的根因）
       *
       *   实测参数行的间距：
       *     工作流→画幅   4px  ✅
       *     画幅→尺寸     4px  ✅
       *     尺寸→[时长]   49px ★  ← 这里是 minWidth 造成的死空白
       *     [时长]→高级参数 11px ★
       *
       *   根因：这个盒子写的是 minWidth: width（66px），
       *   但内层实际只占 35px（输入框 22 + 秒 13），
       *   多出来的 31px 是纯空白，把后面的元素推远。
       *
       *   ⇒ minWidth 改为按内容（auto）。调用方传的 width 作为【最小可用宽】保留，
       *     但不强行撑开 —— 参数行要靠 gap 统一间距，不能靠盒内空白凑位置。
       */
      style: {
        position: "relative", flex: "none",
        // ★ 用 max(内容宽, 调用方给的下限)：内容更宽时不裁，内容更窄时不撑
        minWidth: Math.max(28, width * 0.55),
      },
      onMouseEnter: () => setHot(true),
      onMouseLeave: () => setHot(false),
    },
    h("div", {
      title,
      style: {
        display: "inline-flex", alignItems: "center", gap: 2,
        // ★ 2026-10-19 压宽：左内边距 6 → 4（四个字段共省 8px）
        height: 28, padding: "0 1px 0 4px",
        borderRadius: 8,
        background: hot && !disabled
          ? "var(--dsw-alias-interactive-bg-hover, #2631480f)"
          : "transparent",
        color: hot && !disabled
          ? "var(--dsw-alias-label-primary, #0f1115)"
          : "var(--dsw-alias-label-secondary, #61666b)",
        font: "13px/20px inherit",
        opacity: disabled ? 0.45 : 1,
      },
    },
      prefix ? h("span", { style: { opacity: 0.7 } }, prefix) : null,
      h("input", {
        type: "text",
        inputMode: "numeric",
        "aria-label": label,
        value: draft,
        disabled: !!disabled,
        onChange: (e) => setDraft(e.target.value.replace(/[^\d]/g, "")),
        onBlur: () => commit(draft),
        onKeyDown: (e) => {
          if (e.key === "Enter") { e.preventDefault(); commit(draft); e.currentTarget.blur(); }
          else if (e.key === "ArrowUp") { e.preventDefault(); bump(1); }
          else if (e.key === "ArrowDown") { e.preventDefault(); bump(-1); }
        },
        style: {
          width: 22, minWidth: 0, padding: 0, border: 0, background: "transparent",
          color: "inherit", font: "inherit", textAlign: "center", outline: "none",
          cursor: disabled ? "not-allowed" : "text",
        },
      }),
      suffix ? h("span", { style: { opacity: 0.7 } }, suffix) : null,
      // 上下箭头
      h("span", {
        style: {
          display: "inline-flex", flexDirection: "column",
          justifyContent: "center", gap: 1, marginLeft: 2, flex: "none",
        },
      },
        h("button", {
          type: "button", tabIndex: -1, disabled: !!disabled,
          "aria-label": "增加",
          onClick: () => bump(1),
          style: {
            width: 14, height: 11, padding: 0, border: 0, borderRadius: 3,
            background: "transparent", cursor: disabled ? "not-allowed" : "pointer",
            fontSize: 8, lineHeight: "11px", color: "var(--dsw-alias-label-tertiary, #81858c)",
            display: "flex", alignItems: "center", justifyContent: "center",
          },
        }, "▲"),
        h("button", {
          type: "button", tabIndex: -1, disabled: !!disabled,
          "aria-label": "减少",
          onClick: () => bump(-1),
          style: {
            width: 14, height: 11, padding: 0, border: 0, borderRadius: 3,
            background: "transparent", cursor: disabled ? "not-allowed" : "pointer",
            fontSize: 8, lineHeight: "11px", color: "var(--dsw-alias-label-tertiary, #81858c)",
            display: "flex", alignItems: "center", justifyContent: "center",
          },
        }, "▼")
      )
    )
  );
}
/**
 * 拨动开关 —— 武打模式、二采精修等所有 toggle 用同一套。
 *
 * ★ 主人 2026-10-18：「武打模式改成拨动原点开关样式」，
 *   并要求二采开关和武打模式【完全对等】（它们在后端都是「整组节点绕过」）：
 *     krea2 secondPass → off.delete [221,222,223,220]
 *     yz    wudA       → off.delete [342,344,345,343,366] + rewire
 *   实测：二采开 28 节点 / 关 24 节点，机制确实一样。
 */
function ToggleSwitch({ label, hint, checked, onChange }) {
  // ★ 改回圆点拨动样式（主人 2026-10-18）：
  //   「你可以弄成原本的圆点拨动开关，文字不可点，这样文字就恒存在，
  //     只在支持二采开关的地方在文字的右边或者左边插入开关。」
  //   ⇒ 文字是 <span>（不可点），拨动件是 <button role=switch>，两者分离。
  //
  // ★★ 2026-10-19 缩体积（主人：「找一个更小体积的开关标识方式？」
  //     +「krea2 宽度不足，导致被挤出两行」）
  //
  //   实测原占位：拨动件 24×14 + gap 3 + 11px 文字
  //     高清重绘 79px / 挂 LoRA 73px / SeedVR2 放大 108px = 260px
  //     占参数条 853px 的 30% —— 这就是被挤出两行的主因。
  //
  //   三处压缩，都不牺牲可读性：
  //     ① 拨动件 24×14 → 19×11，球 10 → 8，行程 12 → 9   （省 5px/个）
  //     ② gap 3 → 2                                      （省 1px/个）
  //     ③ 文字 11px → 11px 不变，但长名用【短形式】（见 SHORT_LABEL）
  //        SeedVR2 放大 → SeedVR2   （省 2 字 ≈ 22px）
  //        挂 LoRA       → LoRA      （省 1 字 ≈ 11px）
  //        高清重绘      不变         （已经是短名）
  //   合计 260 → 约 195px，省 65px。完整名字仍在 title 里，悬停可见。
  // 短名表 —— ★ 2026-10-19 修正：key 必须用【label 文本】而不是 toggle key。
  //   上一版我按 k(seedvr / loraChain) 建表，而实际传入的 label 是中文
  //   「SeedVR2 放大」「挂 LoRA」，永远对不上 ⇒ 短名从未生效。
  //   实测证据：SeedVR2 放大▾7B 仍占 156px、挂 LoRA 仍占 67px。
  //
  //   这又是一次「同一类判定逐个比对」的教训（§6.23③）：
  //   写了映射表却没核对键的取值范围。
  const SHORT_LABEL = {
    // ★ 2026-10-19 二次压宽：SeedVR2 文字 81px → SVR2 约 34px，省 47px
    //   产品里此前一直写作 SeedVR2，但参数条上它只是开关名，
    //   完整名「SeedVR2 放大」仍在 title（悬停可见）。
    "SeedVR2 放大": "SVR2",
    "挂 LoRA": "LoRA",
    "高清重绘": "重绘",
    "武打模式": "武打",
  };
  // 先按 label 去掉括号补充，再套短名表；两者都命中不了就用原 label
  const base = String(label).replace(/（[^）]*）/g, "").replace(/\([^)]*\)/g, "").trim();
  const shortName = SHORT_LABEL[base] ?? base;

  return h("span", {
      title: hint || label,
      style: {
        display: "inline-flex", alignItems: "center", gap: 2,
        height: 28, padding: 0,
        font: "11px/18px inherit",
        whiteSpace: "nowrap", flex: "none",
        color: checked
          ? "var(--dsw-alias-label-primary, #0f1115)"
          : "var(--dsw-alias-label-tertiary, #81858c)",
        transition: "color 140ms ease",
      },
    },
      // 拨动件（可点）—— 19×11，球 8，行程 9
      h("button", {
        type: "button",
        role: "switch",
        "aria-checked": !!checked,
        "aria-label": label,
        onClick: onChange,
        style: {
          width: 19, height: 11, padding: 0, border: 0,
          borderRadius: 999, flex: "none",
          background: checked
            ? "var(--dsw-alias-state-business-primary, #4176e6)"
            : "var(--dsw-alias-border-l2, #0000001a)",
          position: "relative", cursor: "pointer",
          transition: "background 140ms ease",
        },
      },
        h("span", {
          style: {
            position: "absolute", top: 1.5, left: checked ? 9 : 1.5,
            width: 8, height: 8, borderRadius: "50%",
            background: "#fff",
            boxShadow: "0 1px 1.5px rgba(0,0,0,.25)",
            transition: "left 140ms ease",
            pointerEvents: "none",
          },
        })
      ),
      // 文字（不可点）—— 用短形式，完整名在 title 里
      h("span", { style: { pointerEvents: "none" } }, shortName)
    );
}
/**
 * LoRA 多选下拉（2026-10-19 新增，主人要求）。
 *
 * 交互：
 *   按钮显示「LoRA」或「LoRA · N」；点开是带复选框的列表；
 *   已选的在顶部按选择顺序排列，可单独调强度、可移除。
 *
 * ★ 为什么不用原生 <select multiple>：
 *   原生多选在 Windows 上要求 Ctrl+点击，且无法给每一项配强度输入。
 *   自绘一个浮层反而更简单，也能和参数条的 28px 行高对齐。
 *
 * ★ 为什么强度默认 1.0 且可改：
 *   ComfyUI 的 LoraLoaderModelOnly.strength_model 就是这个语义；
 *   不给用户调，遇到「太浓/太淡」只能换模型，不符合工作台的定位。
 *
 * ★ 拿不到名单时（state=error/empty）：按钮禁用并显示原因，
 *   绝不假装「本机没装 LoRA」—— 那是把排障方向带偏（同 §3.13⑥ 的教训）。
 */
function LoraMultiSelect({ list, state, value, onChange }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const selected = Array.isArray(value) ? value : [];
  const names = selected.map((x) => x.name);

  // 点外面关掉
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const toggle = (name) => {
    if (names.includes(name)) {
      onChange(selected.filter((x) => x.name !== name));
    } else {
      onChange([...selected, { name, strength: 1 }]);
    }
  };
  const setStrength = (name, s) => {
    const n = Number(s);
    onChange(selected.map((x) => (x.name === name ? { ...x, strength: Number.isFinite(n) ? n : 1 } : x)));
  };

  const disabled = state === "error" || state === "empty";
  const label = disabled ? "LoRA" : selected.length ? `LoRA · ${selected.length}` : "LoRA";
  const tip = state === "error"
    ? "LoRA 列表拉取失败（ComfyUI 可能没起）。其它参数不受影响。"
    : state === "empty"
      ? "ComfyUI 没有报告任何可用 LoRA。"
      : `已选 ${selected.length} 个 · 点击选择`;

  return h("span", {
      ref: wrapRef,
      style: { position: "relative", flex: "none", display: "inline-flex", alignItems: "center" },
    },
      h("button", {
        type: "button",
        disabled,
        onClick: () => !disabled && setOpen((v) => !v),
        title: tip,
        "aria-label": "LoRA 多选",
        style: {
          display: "inline-flex", alignItems: "center", gap: 3,
          height: 28, padding: "0 8px", flex: "none",
          border: 0, borderRadius: 8,
          cursor: disabled ? "not-allowed" : "pointer",
          background: "transparent",
          color: disabled
            ? "var(--dsw-alias-label-quaternary, #a9adb3)"
            : selected.length
              ? "var(--dsw-alias-state-business-primary, #4176e6)"
              : "var(--dsw-alias-label-secondary, #61666b)",
          fontFamily: "inherit", fontSize: 12,
          fontWeight: selected.length ? 600 : 400,
          opacity: disabled ? 0.55 : 1,
        },
      },
        h("span", { style: { fontSize: 9, opacity: 0.7 } }, open ? "▴" : "▾"),
        label
      ),

      open
        ? h("div", {
            style: {
              position: "absolute", bottom: 32, left: 0, zIndex: 60,
              minWidth: 240, maxHeight: 300, overflowY: "auto",
              padding: 6, borderRadius: 10,
              background: "var(--dsw-alias-bg-overlay, #fff)",
              boxShadow: "0 8px 24px rgba(0,0,0,.18), 0 0 0 1px rgba(0,0,0,.06)",
            },
          },
            // 已选区（带强度）
            selected.length
              ? h("div", { style: { paddingBottom: 6, marginBottom: 6, borderBottom: "1px solid rgba(0,0,0,.06)" } },
                  ...selected.map((x) =>
                    h("div", {
                      key: "sel-" + x.name,
                      style: { display: "flex", alignItems: "center", gap: 4, padding: "3px 6px", fontSize: 11 },
                    },
                      h("span", {
                        style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
                        title: x.name,
                      }, x.name.split("\\").pop()),
                      h("input", {
                        type: "number", step: 0.05, min: -10, max: 10,
                        value: x.strength,
                        onChange: (e) => setStrength(x.name, e.target.value),
                        title: "强度（负值=反向）",
                        style: {
                          width: 48, height: 20, padding: "0 3px", fontSize: 11,
                          border: "1px solid rgba(0,0,0,.12)", borderRadius: 5,
                          background: "transparent", color: "inherit", fontFamily: "inherit",
                        },
                      }),
                      h("button", {
                        type: "button",
                        onClick: () => toggle(x.name),
                        title: "移除",
                        style: {
                          width: 18, height: 18, padding: 0, border: 0, borderRadius: 4,
                          background: "transparent", cursor: "pointer",
                          color: "var(--dsw-alias-label-tertiary, #81858c)", fontSize: 12, lineHeight: 1,
                        },
                      }, "×")
                    )
                  )
                )
              : null,
            // 全部可选项
            ...list.map((name) => {
              const on = names.includes(name);
              return h("button", {
                key: "opt-" + name,
                type: "button",
                onClick: () => toggle(name),
                title: name,
                style: {
                  display: "flex", alignItems: "center", gap: 6, width: "100%",
                  padding: "4px 6px", border: 0, borderRadius: 6,
                  background: on ? "rgba(65,118,230,.10)" : "transparent",
                  cursor: "pointer", textAlign: "left",
                  color: "inherit", fontFamily: "inherit", fontSize: 11,
                },
              },
                h("span", {
                  style: {
                    width: 12, height: 12, flex: "none", borderRadius: 3,
                    border: on ? "none" : "1px solid rgba(0,0,0,.25)",
                    background: on ? "var(--dsw-alias-state-business-primary, #4176e6)" : "transparent",
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                    color: "#fff", fontSize: 9, lineHeight: 1,
                  },
                }, on ? "✓" : ""),
                h("span", {
                  style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
                }, name.split("\\").pop())
              );
            })
          )
        : null
    );
}

/**
 * 极端保守的挂载器：只要子模块有任何问题（未定义、抛错、render 崩），
 * 整块返回 null，绝不让异常冒到工作台。
 */
function SafeMount({ Comp, Boundary }) {
  if (typeof Comp !== "function") return null;
  try {
    const inner = React.createElement(Comp);
    return typeof Boundary === "function"
      ? React.createElement(Boundary, null, inner)
      : inner;
  } catch (err) {
    console.warn("[comfy-wb] 设备监控挂载失败，已跳过：", err?.message ?? err);
    return null;
  }
}

export function WorkbenchView(props) {
  /* ★ 2026-10-22：hostRequire 由 client.js 注入，用于取 DSH 原生图标 */
  const { bridge, t, hostRequire } = props;

  const [health, setHealth] = useState({ state: "probing" });
  const [modes, setModes] = useState([]);
  const [modesState, setModesState] = useState("loading");
  const [modeId, setModeId] = useState(null);

  const [prompt, setPrompt] = useState("");
  const [negative, setNegative] = useState("");
  const [aspect, setAspect] = useState("16:9");
  const [durationSec, setDurationSec] = useState(5);
  const [steps, setSteps] = useState(8);
  const [steps2, setSteps2] = useState(5);
  const [batch, setBatch] = useState(1);
  const [megapixels, setMegapixels] = useState(1.0);
  const [seedvrModel, setSeedvrModel] = useState(SEEDVR_MODELS[0].v);
  const [seed, setSeed] = useState("");
  const [toggles, setToggles] = useState({});
  // ★★ 2026-10-19 新增（主人：「krea2 的 lora 下拉栏里放所有可用 lora，可以多选开启」）
  //   loraList: ComfyUI 认的合法名单（GET /comfy-bridge/loras）
  //   loras:    [{ name, strength }] 已选的多选集合
  //   拿不到名单时 loraList=[] 且 loraState="error"，下拉降级成「不可用」，
  //   绝不把整个参数区拖垮（任务书「模块失效只丢那一块」）。
  const [loraList, setLoraList] = useState([]);
  // ★★ 2026-10-20 新增：高级参数卡片开关（主人：
  //   「除了每个工作流都需要的常用调整：比例，分辨率，张数/秒数，
  //     其他的都应该放在（高级参数）里面，这个点击之后展开一个卡片」）
  //
  //   分层设计：
  //     常驻行 —— 工作流 / 画幅 / 分辨率 / 张数或秒数
  //     高级卡片 —— 按三类分组（多采 / LoRA / 模型），随工作流不同而不同
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [loraState, setLoraState] = useState("loading");
  const [loras, setLoras] = useState([]);
  // ★ 2026-10-18 补（质检 P1-6）：素材槽状态
  //   qwen21-edit 需要「原图 + 参考图」，yz 需要 6图+1视频+3音频。
  //   后端 /modes 早就返回了 media 定义（每槽有 label / accept / kind），
  //   但前端从来没渲染过 —— 结果改图工作流一直拿工作流内置的示例图去跑，
  //   核心用途完全不可用，界面上也没有任何提示。
  //   形状：{ [slot]: { base64, filename, dataUrl } }
  const [files, setFiles] = useState({});
  // ★ 2026-10-18（质检 P1-3）：独立的「提交中」互斥门。
  //   原来 busy = job && !job.completed —— 而 job 要等 await bridge.generate()
  //   返回才 set，中间几百毫秒 busy 是 falsy。实测连点 5 次真的提交了 5 个任务
  //   （fetch 拦到 5 次相同 body）。这个状态在发出请求前就同步置 true。
  const [submitting, setSubmitting] = useState(false);

  // 提示词框高度（px）—— 用顶部把手拖拽，不用原生 resize
  const [promptH, setPromptH] = useState(3 * 24 + 8);
  const dragRef = useRef(null);
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const pollRef = useRef(null);

  /**
   * ★ 画布资产（主人第 ④ 件事：「生成后直接弹到画布里面」）
   *
   * 为什么是【累积表】而不是直接用 job.outputs：
   *   ① job.outputs 每轮轮询都是【整个重建的新数组】。画布按顺序自动落位，
   *      若把数组当身份，每次轮询都会被当成「一批全新产物」而重新排布 →
   *      主人拖好的卡片会被弹回原位。
   *   ② 连出两张时，第二张不该把第一张从画布上抹掉。资产库本来就该攒。
   *
   * 合并键 = nodeId + filename（见 AssetCanvas.keyOf）。
   * 增量只把【新键】并入，已存在的原对象引用不动 ⇒ 画布不重排。
   */
  /**
   * 画布上的产物清单。
   *
   * ★ 2026-10-18 修（自查发现）：原来只是内存 state —— 刷新页面后
   *   assets 变回 []，画布空着，而 AssetCanvas 的坐标还被持久化着
   *   ⇒ 存了一堆没人用的坐标。
   *   实测：拖好卡片 → 刷新 → localStorage 里 pos 还在，但画布是空的。
   *
   * ★ 修法：按 modeId 分别存最近 40 条（每个产物只占一个文件名 + nodeId + url，
   *   几十字节一条，40 条不到 20KB）。不存 base64、不存整张图。
   *   恢复时校验 modeId 一致，避免把 krea2 的产物显示到 yz 的画布上。
   */
  const ASSETS_KEY = (mid) => `comfy-wb:assets:${mid ?? "none"}`;

  function loadAssets(mid) {
    if (!mid) return [];
    try {
      const raw = localStorage.getItem(ASSETS_KEY(mid));
      if (!raw) return [];
      const j = JSON.parse(raw);
      return Array.isArray(j?.items) ? j.items : [];
    } catch { return []; }
  }

  function saveAssets(mid, list) {
    if (!mid) return;
    try {
      // 只留最近 40 条，避免 localStorage 涨到上限
      const items = list.slice(-40);
      localStorage.setItem(ASSETS_KEY(mid), JSON.stringify({ items, at: Date.now() }));
    } catch { /* 配额满 / 隐私模式 —— 静默降级 */ }
  }

  const [assets, setAssets] = useState([]);
  const assetKeysRef = useRef(new Set());

  /**
   * ★★ 2026-10-22：宽度实时跟随 DSH（主人：「能做成实时动效吗？」）
   *
   *   实测：DSH 拖动时只改 CSS 变量 --dsh-composer-card-max-width，
   *   浏览器原生重绘，没有 React 重渲染 ⇒ 所以它能「实时」。
   *   我们引用同一个变量即可同帧跟随，不需要轮询、不需要监听。
   *
   *   ★ 这里只补一个兜底：变量在首帧可能还没被 DSH 定义。
   */
  useEffect(() => {
    const el = document.querySelector(".comfy-wb");
    if (!el) return;
    if (!el.style.getPropertyValue("--ac-follow-w")) {
      el.style.setProperty("--ac-follow-w", "var(--dsh-composer-card-max-width, 100%)");
    }
  }, []);
  // mergeAssets 是 useCallback([])，闭包里拿不到最新 modeId，用 ref 兜
  const modeIdRef = useRef(null);
  useEffect(() => { modeIdRef.current = modeId; }, [modeId]);

  /** 把一次轮询拿到的 outputs 并进资产表。返回本次新增条数。 */
  const mergeAssets = useCallback((outs) => {
    const list = Array.isArray(outs) ? outs : [];
    if (!list.length) return 0;
    let added = 0;
    setAssets((prev) => {
      const seen = assetKeysRef.current;
      const next = prev.slice();
      for (const o of list) {
        const k = `${o?.nodeId ?? "?"}:${String(o?.filename ?? "")}`;
        if (!o?.filename || seen.has(k)) continue;
        seen.add(k);
        next.push(o);
        added++;
      }
      if (added) saveAssets(modeIdRef.current, next);
      return added ? next : prev;
    });
    return added;
  }, []);


  const clearAssets = useCallback(() => {
    assetKeysRef.current = new Set();
    setAssets([]);
    // 清画布 = 用户主动丢弃，磁盘上的也别留着（否则刷新后又回来）
    if (modeIdRef.current) {
      try { localStorage.removeItem(ASSETS_KEY(modeIdRef.current)); } catch {}
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await bridge.health();
        if (alive) setHealth({ state: r.ok ? "ok" : "down", detail: r });
      } catch (err) {
        if (alive) setHealth({ state: "down", detail: { error: err.message } });
      }
    })();
    return () => { alive = false; };
  }, [bridge]);

  // ★★ 2026-10-19 新增：拉 ComfyUI 认的 LoRA 名单。
  //
  // ★ 为什么不和 modes 一起拉：
  //   LoRA 名单要问 ComfyUI（object_info），比 modes（纯本地文件扫描）慢得多，
  //   而且 ComfyUI 没起时会失败。两者分开，一个挂了不拖累另一个。
  //
  // ★ 失败不报错、不阻塞：loraState="error" + loraList=[]，
  //   下拉显示「LoRA 不可用」，其它参数照常能用。
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await bridge.loras?.();
        if (!alive) return;
        const list = Array.isArray(r?.loras) ? r.loras : [];
        setLoraList(list);
        setLoraState(list.length ? "ok" : "empty");
      } catch (err) {
        if (!alive) return;
        setLoraList([]);
        setLoraState("error");
        console.warn("[comfy-wb] LoRA 列表拉取失败（其它参数不受影响）：", err?.message ?? err);
      }
    })();
    return () => { alive = false; };
  }, [bridge]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = (await bridge.modes?.()) ?? [];
        if (!alive) return;
        setModes(list);
        setModesState(list.length ? "ok" : "empty");
        if (list.length) {
          const saved = loadPersisted();
          // ★ 恢复上次的工作流（若它还在列表里），否则退回 order 最小的
          const want = saved?.modeId && list.some((m) => m.id === saved.modeId)
            ? list.find((m) => m.id === saved.modeId)
            : list.slice().sort((a, b) => (a.order ?? 99) - (b.order ?? 99))[0];
          setModeId(want.id);
          modeIdRef.current = want.id;
          // ★ 恢复这个工作流上次的产物清单（刷新/切 tab 回来画布不再空）
          const savedAssets = loadAssets(want.id);
          if (savedAssets.length) {
            assetKeysRef.current = new Set(
              savedAssets.map((o) => `${o?.nodeId ?? "?"}:${String(o?.filename ?? "")}`)
            );
            setAssets(savedAssets);
          }
          applyDefaults(want);
          // ★ 再覆盖回用户填过的值（applyDefaults 会先写默认值）
          if (saved && saved.modeId === want.id) {
            if (typeof saved.prompt === "string") setPrompt(saved.prompt);
            if (typeof saved.negative === "string") setNegative(saved.negative);
            if (saved.aspect) setAspect(saved.aspect);
            if (saved.durationSec != null) setDurationSec(saved.durationSec);
            if (saved.steps != null) setSteps(saved.steps);
            if (saved.steps2 != null) setSteps2(saved.steps2);
            if (saved.batch != null) setBatch(saved.batch);
            if (saved.megapixels != null) setMegapixels(saved.megapixels);
            if (saved.seedvrModel) setSeedvrModel(saved.seedvrModel);
            if (typeof saved.seed === "string") setSeed(saved.seed);
            if (saved.toggles && typeof saved.toggles === "object") {
              setToggles((cur) => ({ ...cur, ...saved.toggles }));
            }
          }
        }
      } catch (err) {
        if (alive) { setModesState("error"); setError(err.message); }
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge]);

  const currentMode = modes.find((m) => m.id === modeId) ?? null;
  /* 能力：后端 resolveMode 从 vars 推导，经 /modes 的 caps 传下来。
     老后端没有 caps → 全部按「有」处理（退回改版前行为，不会崩）。 */
  // ★ 2026-10-18：素材槽在 currentMode.media（与 caps 平级），不在 caps 里。
  //   实测 /modes 返回的字段是 {..., media, toggles, caps}。
  const media = currentMode?.media ?? {};
  const caps = currentMode?.caps ?? {
    duration: true, batch: false, steps: true, steps2: false, secondPassToggle: null,
  };

  function applyDefaults(mode) {
    const d = mode?.defaults ?? {};
    setPrompt(d.prompt ?? "");
    setNegative(d.negative ?? "");
    setAspect(d.aspect ?? "16:9");
    setDurationSec(d.durationSec ?? 5);
    setSteps(d.steps ?? 8);
    setSteps2(d.steps2 ?? 5);
    setBatch(d.batch ?? 1);
    setMegapixels(d.megapixels ?? 1.0);
    setSeedvrModel(d.seedvrModel ?? SEEDVR_MODELS[0].v);
    setSeed(d.seed != null ? String(d.seed) : "");
    const tg = {};
    for (const [k, spec] of Object.entries(mode?.toggles ?? {})) tg[k] = spec.default === true;
    setToggles(tg);
  }

  const pickMode = useCallback((id) => {
    const m = modes.find((x) => x.id === id);
    setModeId(id);
    modeIdRef.current = id;
    if (m) applyDefaults(m);
    // ★ 必须先停旧轮询（AGENTS.md §3.13 ⑤）：不停的话 1s 后旧 job 的
    //   setJob + mergeAssets 会把上一个模式的结果塞回新界面 / 新画布。
    stopPoll();
    setJob(null);          // 切工作流清空成果区
    setError(null);
    // ★ 切模式 = 换一块画布。
    //   不保留上一个模式的产物（否则用户以为新产物出来了），
    //   但【也不删盘】—— 每个模式各自的历史留着，
    //   切回原模式时从 loadAssets(modeId) 恢复。
    assetKeysRef.current = new Set();
    setAssets([]);
    // 恢复目标模式上次的产物（pickMode 传进来的 id 就是新模式）
    const restored = loadAssets(id);
    if (restored.length) {
      assetKeysRef.current = new Set(
        restored.map((o) => `${o?.nodeId ?? "?"}:${String(o?.filename ?? "")}`)
      );
      setAssets(restored);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modes, clearAssets]);

  const startPoll = useCallback((jobId) => {
    stopPoll();
    pollRef.current = setInterval(async () => {
      try {
        const j = await bridge.job(jobId);
        // ★ ComfyUI 对执行失败也写 history：status_str = "error"/"failed"，completed = false。
        //   只判 completed 会让失败任务永久轮询，用户永远看不到错误。
        const st = String(j?.statusStr ?? j?.status_str ?? "").toLowerCase();
        const isTerminal = j.completed || ["error", "failed", "cancel"].some((k) => st.includes(k));
        setJob({ ...j, failed: !j.completed && isTerminal });
        // ★★ 第 ④ 件事：「生成后直接弹到画布里面」
        //   在这里并资产，而不是等 isTerminal ——
        //   ComfyUI 的 /history 条目是【完成后】才出现的，但一旦出现就带全部 outputs。
        //   每轮都调 mergeAssets 是幂等的（按键去重），所以不影响任何时序。
        //   轮询周期 1500ms ⇒ 产物出现后最迟约 1.5s 上画布。
        if (Array.isArray(j?.outputs) && j.outputs.length) mergeAssets(j.outputs);
        if (isTerminal) stopPoll();
      } catch (err) {
        setError(err.message);
        stopPoll();
      }
    }, 1000);   // ★ 1000ms：验收要求「3 秒内自动出现在画布上」，留足余量
  }, [bridge, mergeAssets]);

  function stopPoll() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }

  useEffect(() => stopPoll, []);

  // ★ 2026-10-18（质检 P1-4）：参数变化就落 sessionStorage。
  //   防抖 300ms —— 拖提示词框 / 连续上下调步数时不要每帧都写。
  //   只存「用户填的东西」，不存 job / 轮询 / error 这些瞬时状态。
  useEffect(() => {
    const t = setTimeout(() => {
      savePersisted({
        modeId, prompt, negative, aspect, durationSec,
        steps, steps2, batch, megapixels, seedvrModel, seed, toggles,
      });
    }, 300);
    return () => clearTimeout(t);
  }, [modeId, prompt, negative, aspect, durationSec,
      steps, steps2, batch, megapixels, seedvrModel, seed, toggles]);

  /**
   * 高级参数卡片的内容（2026-10-20 新增）。
   *
   * 主人要求：「里面放一些步数，lora/loras（武打模式就是几个 lora 集群，
   * 要开一起开）种子使用方法（固定，随机）…… 根据工作流不同，具体调整的
   * 东西也不同，不过可以大致分为通用类，说白了也就是多采相关、lora相关、
   * 模型相关」
   *
   * ⇒ 按三类分组，每组只在有内容时才出现（工作流不支持就整组消失）。
   *
   * ★ 为什么写成函数而不是内联 JSX：这张卡片很长，内联会让底部行的
   *   JSX 嵌套深到看不清结构（之前就因此踩过「多余的 )」那个坑）。
   */
  function renderAdvancedGroups() {
    const groups = [];

    /* ── ① 多采相关：步数 / 二采 ───────────────────────────── */
    if (caps.steps || caps.steps2) {
      const kids = [];
      if (caps.steps) {
        kids.push(h(NumberField, {
          key: "adv-steps",
          label: showSteps2 ? t("field.steps1") : t("field.steps"),
          prefix: showSteps2 ? t("unit.pass1") : "",
          suffix: t("unit.steps"),
          value: steps, min: 1, max: 200, step: 1,
          onChange: (v) => setSteps(v),
          width: showSteps2 ? 64 : 58,
          title: `${showSteps2 ? t("field.steps1") : t("field.steps")} · ${steps}`,
        }));
      }
      if (caps.steps2 && caps.secondPassToggle) {
        kids.push(h("button", {
          key: "adv-2pass-sw",
          type: "button",
          role: "switch",
          "aria-checked": secondPassOn,
          "aria-label": t("field.steps2"),
          onClick: () => setToggles((s) => ({ ...s, [caps.secondPassToggle]: !secondPassOn })),
          title: secondPassOn ? "二采已开（点击关闭；步数保留）" : `二采已关（点击开启；恢复 ${steps2} 步）`,
          style: {
            width: 24, height: 14, padding: 0, border: 0, borderRadius: 999,
            flex: "none", marginLeft: 4,
            background: secondPassOn
              ? "var(--dsw-alias-state-business-primary, #4176e6)"
              : "var(--dsw-alias-border-l2, #0000001a)",
            position: "relative", cursor: "pointer", transition: "background 140ms ease",
          },
        },
          h("span", {
            style: {
              position: "absolute", top: 2, left: secondPassOn ? 12 : 2,
              width: 10, height: 10, borderRadius: "50%", background: "#fff",
              boxShadow: "0 1px 2px rgba(0,0,0,.25)",
              transition: "left 140ms ease", pointerEvents: "none",
            },
          })
        ));
      }
      if (caps.steps2) {
        kids.push(h(NumberField, {
          key: "adv-steps2",
          label: t("field.steps2"),
          prefix: t("unit.pass2"),
          suffix: "",
          value: steps2, min: 1, max: 200, step: 1,
          onChange: (v) => setSteps2(v),
          width: 52,
          disabled: !secondPassOn,
          title: secondPassOn
            ? `${t("field.steps2")} · ${steps2}`
            : `${t("field.steps2")} · 已关闭（值保留 ${steps2}）`,
        }));
      }
      groups.push({ key: "sampling", title: "多采", kids });
    }

    /* ── ② LoRA 相关：开关 + 多选 + 武打集群 ────────────────── */
    {
      const loraToggles = Object.entries(toggles).filter(([k]) => {
        if (["null", "undefined", caps.secondPassToggle].includes(k)) return false;
        const meta = currentMode?.toggles?.[k];
        // 用 label 判断是不是 LoRA 类（武打模式 / 挂 LoRA）
        const lb = String(meta?.label ?? k);
        return /lora|LoRA|武打|loraChain/i.test(lb) || /lora/i.test(k);
      });
      if (loraToggles.length || (caps.loraChain !== undefined || currentMode?.toggles?.loraChain)) {
        const kids = [];
        for (const [k, v] of loraToggles) {
          kids.push(h(ToggleSwitch, {
            key: "adv-sw-" + k,
            label: currentMode?.toggles?.[k]?.label ?? k,
            hint: currentMode?.toggles?.[k]?.hint,
            checked: v === true,
            onChange: () => setToggles((s) => ({ ...s, [k]: !s[k] })),
          }));
        }
        if (toggles.loraChain === true) {
          kids.push(h(LoraMultiSelect, {
            key: "adv-lora-multi",
            list: loraList,
            state: loraState,
            value: loras,
            onChange: setLoras,
          }));
        }
        groups.push({ key: "lora", title: "LoRA", kids });
      }
    }

    /* ── ③ 模型相关：SeedVR2 模型 / 高清重绘 / SeedVR2 放大 ─── */
    {
      const modelToggles = Object.entries(toggles).filter(([k]) => {
        if (["null", "undefined", caps.secondPassToggle].includes(k)) return false;
        const meta = currentMode?.toggles?.[k];
        const lb = String(meta?.label ?? k);
        if (/lora|LoRA|武打/i.test(lb) || /lora/i.test(k)) return false;
        return true;
      });
      const kids = [];
      for (const [k, v] of modelToggles) {
        const sw = h(ToggleSwitch, {
          key: "adv-msw-" + k,
          label: currentMode?.toggles?.[k]?.label ?? k,
          hint: currentMode?.toggles?.[k]?.hint,
          checked: v === true,
          onChange: () => setToggles((s) => ({ ...s, [k]: !s[k] })),
        });
        if (k === "seedvr" && caps.seedvrModel) {
          kids.push(h("span", {
            key: k + "-grp",
            style: { display: "inline-flex", alignItems: "center", gap: 2 },
          },
            sw,
            v === true
              ? h(Select, {
                  label: t("field.seedvrModel"),
                  minWidth: 52,
                  value: seedvrModel,
                  options: SEEDVR_MODELS.map((x) => ({ value: x.v, text: x.t })),
                  onChange: setSeedvrModel,
                  title: `${t("field.seedvrModel")} · ${seedvrModel}`,
                })
              : null
          ));
        } else {
          kids.push(sw);
        }
      }
      if (kids.length) groups.push({ key: "model", title: "模型", kids });
    }

    if (!groups.length) {
      return h("div", {
        style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary, #81858c)" },
      }, "这个工作流没有额外可调的参数。");
    }

    return h(React.Fragment, null,
      ...groups.map((g) =>
        h("div", {
          key: g.key,
          style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", minHeight: 28 },
        },
          h("span", {
            style: {
              flex: "none", width: 44, fontSize: 11, fontWeight: 600,
              color: "var(--dsw-alias-label-tertiary, #81858c)",
              letterSpacing: 0.2,
            },
          }, g.title),
          ...g.kids
        )
      )
    );
  }

  async function onGenerate() {
    setError(null);
    if (!modeId) return;

    // ★ 2026-10-19 加（主动测异常输入发现）：
    //   空提示词能一路提交到 CLIPTextEncode（实测节点 215 的 text = "   "），
    //   然后真的跑一遍生成，出一张「因为没提示词所以随机」的图。
    //   浪费显存与时间，结果无意义。
    //
    //   实测的其它异常输入都被挡住了：
    //     steps=0/-1/99999、batch=0/-5、megapixels=0/999、aspect="100:1"
    //       → ComfyUI schema 校验拒绝（prompt_outputs_failed_validation）
    //     未知 modeId → bridge 拒绝（未知模式：xxx）
    //   只有空提示词没人管 —— 前端零校验，后端也不查。
    // ★ 2026-10-19 收紧（与后端同步）：只接受字符串，且必须有可见字符。
    //   零宽字符 \u200b-\u200d、BOM、全角空格都算空。
    const visible = typeof prompt === "string"
      ? prompt.replace(/[\s\u200b-\u200f\u2028-\u202f\u205f\u2060-\u2064\u206a-\u206f\ufeff\u3000\u180e\u3164\u115f\u1160\uffa0\u0000-\u001f\u007f\ufff9-\ufffb]/g, "")
      : "";
    if (!visible) {
      setError("提示词不能为空（只有空白或不可见字符）—— 会生成随机的图");
      return;
    }
    // ★ 2026-10-18（质检 P1-3）：同步互斥门。
    //   这里必须先于任何 await 置位 —— 否则连点 5 次会真的提交 5 个任务
    //   （实测 fetch 拦截到 5 次相同 body，/queue 里 pending 排到 2）。
    if (submitting) return;
    setSubmitting(true);
    try {
      const params = { prompt, steps: Number(steps), toggles };
    // ★ 2026-10-18（质检 P1-6）：把素材槽一起发出去。
    //   只发 base64 + filename —— 后端 uploadImage 后会把 ComfyUI 的文件名
    //   填进该槽对应的节点。preview（objectURL）不发，那是本地预览用的。
    if (media) {
      /**
       * ★★★ 2026-10-21 修：只拦【声明了 required:true】的槽
       *
       *   原实现把 Object.keys(media) 全当必填 ⇒ yz 的 10 个可选参考槽
       *   全被拦，纯文生视频根本发不出去（主人截图实证）。
       *
       *   ★ 判据（AGENTS §6.29）：每个槽都要问「没有它，功能还成立吗？」
       *     yz 纯文生视频成立 ⇒ 参考槽可选；
       *     qwen21-edit 的 ref_image_0 是「要改的图」，不成立 ⇒ 必填。
       */
      const need = Object.keys(media).filter((s) => media[s]?.required === true);
      const missing = need.filter((s) => !files?.[s]);
      if (missing.length) {
        const labels = missing.map((s) => media[s]?.label ?? s).join("、");
        setError(`请先选择素材：${labels}`);
        return;
      }
      params.files = {};
      for (const [slot, f] of Object.entries(files ?? {})) {
        if (!media[slot]) continue;   // 不属于当前模式的槽，不发
        if (!f?.base64) continue;
        params.files[slot] = { base64: f.base64, filename: f.filename };
      }

      // ★★ 2026-10-20 改（主人定的架构原则，逐字）：
      //   「工作流是作为一个可替换的模块接入我们的插件的，你的所有东西
      //     都应该让工作流对号入座，而不是为工作流服务。
      //     后续接入新的工作流直接找插件的接口自动对号入座即可」
      //
      //   原来是 `if (modeId === "yz")` —— 这是「为工作流服务」：
      //   每接一个新工作流都要回来改前端。
      //   ⇒ 改成读工作流自己声明的能力位：bind.json 的
      //     "capabilities": { "h3Labels": true }
      if (caps.h3Labels) {
        const refs = Object.entries(files ?? {})
          .filter(([slot, f]) => media[slot] && f?.base64)
          .map(([slot, f]) => ({
            slot, name: f.filename, kind: f.kind, role: f.role || defaultRoleFor(f.kind),
          }));
        if (refs.length) {
          const { lines, warnings } = tagReferences(refs);
          if (lines.length) {
            params.refLabels = lines;      // 单独字段传，不动用户写的 prompt
            // ★ 2026-10-19 删（参数闭环检查抓出来）：
            //   后端从来没人读 params.refWarnings —— 它只在【前端】渲染
            //   （WorkbenchView.js 的 refWarnings.map 那块），不需要发给后端。
            //   原来那行注释说「前端没有任何地方渲染」也不对，前端其实渲染了。
            //   发过去等于每次生成多带一段没人要的数据。
          }
        }
      }
    }
  // ★ 只在二采真的开启时才传 steps2 —— 关掉二采还传，等于告诉后端「用二采」
      if (caps.steps2 && secondPassOn) params.steps2 = Number(steps2);
      if (seed !== "") params.seed = Number(seed);

      // ★★★ 2026-10-19 修阻断级缺陷（复核员 e4c5e6cf 打穿，我复跑确认）：
      //   上面那行 params 初值只写了 { prompt, steps, toggles }。
      //   之后的 params.xxx 只补了 files / refLabels / refWarnings / steps2 / seed，
      //   【从未】补 aspect / megapixels / batch / seedvrModel。
      //   ⇒ 四个下拉框全是摆设：主人调了画幅/尺寸/张数/放大模型，
      //     界面显示改了，实际提交给 ComfyUI 的仍是工作流原值。
      //
      //   实测证据（复核员抓的，我 grep 复现）：
      //     · 页面 fetch 劫持到的 body 只有 {prompt,steps,toggles,files,steps2,modeId}
      //     · ComfyUI /history 的 prompt[2] 里 aspect:"9:16" mp:1 batch:1（工作流默认）
      //     · Node 直传 megapixels:16,batch:4,aspect:"21:9" → 立刻写进节点 211/210
      //       ⇒ 后端是好的，是前端没传
      //
      //   ★ 纪律（AGENTS §3.13 ② 已写过但代码没落地）：
      //     置灰的控件必须同时挡住【数据】，不能只挡鼠标；
      //     反过来，**启用的控件必须真的把数据传下去** —— 这条之前没人检查。
      //   每一项都先问 caps，避免给不支持该参数的工作流发多余字段。
      if (caps.aspect) params.aspect = aspect;
      if (caps.megapixels) params.megapixels = Number(megapixels);
      if (caps.batch) params.batch = Number(batch);
      if (caps.seedvrModel && toggles?.seedvr) params.seedvrModel = seedvrModel;
      // ★★ 2026-10-19：LoRA 多选 —— 后端 buildPrompt 会按这个数组动态织链。
      //   不选就不传（后端 if (!loras.length) 直接跳过，行为与改动前一致）。
      //
      //   ★ 必须问 caps（check-param-closure.mjs 当场抓到）：
      //     只有声明了 toggles.loraChain 的工作流才认 LoRA 链。
      //     无条件发送会给 yz / qwen21 也塞一个 loras 字段，
      //     后端 buildPrompt 虽会忽略，但那是「多余字段」——
      //     和 §3.13② 「置灰的控件仍在传 aspect」是同一类。
      //   ⚠ 两个约束，都是被检查工具逼出来的（实测）：
      //     ① 不能抽中间变量（capsLora）—— 它按「同一行有没有 caps.」做文本匹配
      //     ② caps 判断必须和 params.loras 在【同一行】
      if (caps.loraChain !== undefined && loras.length) params.loras = loras.map((x) => ({ name: x.name, strength: Number(x.strength ?? 1) }));
      // ★★ 2026-10-19 同一类缺陷的第二处（自查发现）：
      //   NumberField 渲染了「时长」（1570 行，label=t("field.duration")），
      //   但 params 里从来没有 params.duration —— yz 视频的时长同样是摆设。
      //   ⇒ 用「UI 控件清单 vs params 字段清单」对照才查出来的。
      // ★ 字段名必须是 durationSec，不是 duration ——
      //   workflows.mjs 第 17 行的白名单与第 497-501 行的读取都是 durationSec。
      //   我先写成 params.duration，后端不认，等于又白传一次。
      if (caps.duration) params.durationSec = Number(durationSec);
      const r = await bridge.generate(modeId, params);
      setJob({ jobId: r.jobId, promptId: r.promptId, completed: false });
      startPoll(r.jobId);
    } catch (err) { setError(err.message); }
    finally { setSubmitting(false); }
  }

  async function onCancel() {
    if (!job?.jobId) return;
    stopPoll();
    try {
      await bridge.cancel(job.jobId);
      setJob({ ...job, cancelled: true });
    } catch (err) { setError(err.message); }
  }

  const healthDot = health.state === "ok" ? "#3fb950" : health.state === "down" ? "#f85149" : "#8b949e";
  // ★ failed 也算终态 —— 否则失败后按钮永远是「生成中…」没法重试
  // submitting 也算忙 —— 它是「已点生成但还没拿到 jobId」那段窗口
  /**
   * 参考用途警告 —— 组件作用域内实时算，不是等提交。
   *
   * ★ 2026-10-18（复核员 P1）：原来 tagReferences() 算出的 warnings 只塞进
   *   params.refWarnings，前端没有任何地方渲染、后端也不读 —— 算完就丢。
   *   AGENTS §6.12 声称「当场警告」，实际一条都没显示过。
   *
   * ★ 注意必须放在【组件作用域】而不是 onGenerate 内部：
   *   我第一版误写在 onGenerate 里，渲染时 ReferenceError: refWarnings is not defined，
   *   整个工作台白屏（被 SafeMount 兜住了，页面显示「[comfy-wb] 渲染出错」）。
   */
  const refWarnings = useMemo(() => {
    // ★ 2026-10-20：改成读能力位（原来写的是 modeId !== "yz"）。
    //   见上面 onGenerate 里那段注释 —— 工作流自己声明要不要 H3 标签语法。
    if (!caps.h3Labels) return [];
    const refs = Object.entries(files ?? {})
      .filter(([slot, f]) => media[slot] && f)
      .map(([slot, f]) => ({
        slot, name: f.filename, kind: f.kind, role: f.role || defaultRoleFor(f.kind),
      }));
    if (!refs.length) return [];
    return tagReferences(refs).warnings ?? [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, media, caps.h3Labels]);

  const busy = submitting || (job && !job.completed && !job.cancelled && !job.failed && !job.lost);
  const secondPassOn = caps.secondPassToggle ? toggles[caps.secondPassToggle] !== false : true;

  /**
   * ★ 2026-10-19 新增：参数组合超出物理约束的提醒。
   *
   *   实测踩到两条（都不是代码 bug，是参数本身跑不动）：
   *     ① 4K(16MP) × 4 张 → torch.OutOfMemoryError
   *        Allocation would exceed allowed memory
   *        Currently allocated 26.46 GiB / Device limit 15.92 GiB
   *     ② yz steps=4 → SelfLiftH3Sampler
   *        ValueError: SelfLift: transition_step 6 out of range for 4 steps
   *        （yz.bind.json 里 vars.steps2 → node 397.transition_step，
   *          即「二采步数」对 yz 而言就是 transition_step，默认 5）
   *
   *   ★ 为什么只提示不拦：
   *     这是「用户自己的选择」，不是错误。拦掉会让人以为功能缺失。
   *     主人 2026-10-18 对类似问题的态度是「当场告诉我就行，不要试错」。
   *   ⇒ 琥珀色提示，不禁止。
   */
  const paramWarnings = useMemo(() => {
    const w = [];
    // ① 显存：像素数 × 张数 超过约 12 MP·张 有 OOM 风险
    //    依据：16 MP × 4 = 64 实测 OOM；1 MP × 4 = 4 实测正常
    const mp = Number(megapixels) || 1;
    const b = Number(batch) || 1;
    const load = mp * b;
    if (load >= 24) {
      w.push(`${mp}K × ${b} 张 = ${load} MP，本机 16GB 显存可能不够（实测 64 必 OOM）`);
    }
    // ② H3 的 transition_step：yz 的二采步数绑的就是它，steps 必须 ≥ 它
    if (caps.steps2 && secondPassOn && Number(steps) < Number(steps2)) {
      w.push(`步数 ${steps} 小于二采步数 ${steps2}，H3 会报 transition_step out of range`);
    }
    return w;
  }, [megapixels, batch, steps, steps2, caps.steps2, secondPassOn]);


  // ★ 已改为官方卡片布局：参数由 flex 自然排列，不再需要 grid 列模板
  // ★ 「一采 / 二采」这套措辞只在【真的有二采可关】时用。
  //   实测（2026-10-18）：原来写 caps.steps2 && secondPassOn，
  //   而 yz 的 secondPassToggle 是 null（H3 的二采拆不掉，没有整组绕过），
  //   secondPassOn 恒为 true → 没问题；但 krea2 关掉二采后 showSteps2 变 false，
  //   一采的「一采」前缀就消失了，看起来像设置丢了。
  //   正确判据：这个工作流有没有 steps2 这一格（有就一直用「一采/二采」措辞）。
  const hasTwoPass = caps.steps2;
  const showSteps2 = hasTwoPass;
  // 二采是否真的可关（只有 bind 里声明了 secondPass 这类开关才行）
  const canToggleSecondPass = !!caps.secondPassToggle;

  const seedInput = { ...ctrl, padding: "0 8px", cursor: "text" };

  /* ══════════════════════════════════════════════════════════════════
   * 全局资产库 + 提示词框 @ 引用（主人 2026-10-18）
   *   「资产库怎么没弄？我需要那种全局资产库，在提示词框中@就能直接调用」
   *
   * ★ 这一段必须放在【任何 early return 之前】——
   *   hook 顺序铁律（AGENTS.md §3.9）。本组件目前没有 early return，
   *   但约束是「别让它将来因为加了一行 if 就整棵树被卸载」。
   *
   * ★ 失效隔离：useAssetAtMentions 内部所有 fetch 都 try/catch 过，
   *   失败只让 lib.s === "error"；@ 触发仍然工作（会提示库为空）。
   *   再加一层 AssetLibraryBoundary 包住全部渲染节点。
   * ══════════════════════════════════════════════════════════════════ */
  const promptRef = useRef(null);
  const atMentions = useAssetAtMentions({
    prompt, setPrompt, media, files, setFiles, textareaRef: promptRef, t,
    /**
     * ★ modesReady：modes 拉到之前 currentMode 是 null，media 是 {}。
     *   「这个模式没有槽」与「还没加载出来」必须分开 ——
     *   否则槽绑定的恢复逻辑会在空 media 上收尾，等 modes 到了也不重试。
     */
    mediaReady: modesState === "ok" && !!currentMode,
  });

  // ══════════════════════════════════════════════════════════════════
  // 布局：完全对齐 DSH 官方输入卡片（docs/规格-DSH官方输入区.md）
  //
  //   ┌──────────────────────────────────────────────────┐
  //   │  成果区（flex:1，占满剩余）                        │
  //   ├──────────────────────────────────────────────────┤
  //   │ ╭──────────────────────────────────────────────╮ │ ← 卡片 r=28
  //   │ │ 提示词                                        │ │   scroll 36px
  //   │ ├──────────────────────────────────────────────┤ │
  //   │ │ ▾模式 ▾画幅 ▾时长 ▾步数 ○开关     状态 [生成] │ │   row 42px
  //   │ ╰──────────────────────────────────────────────╯ │
  //   └──────────────────────────────────────────────────┘
  //
  // 与旧版的差别：状态不再独占一条 39px，开关不再独占 30px，
  //               全部收进卡片的 row → 参数区从 102px 降到 50px
  // ══════════════════════════════════════════════════════════════════
  return h(React.Fragment, null,
    // ★ 设备监控：portal 到 body，fixed 定位，不影响任何布局。
    //   外面再包一层 SafeMount —— 即使 DeviceMonitor 模块本身有问题
    //   （未定义 / 抛错 / 渲染崩），也只是这块不出现，工作台照常。
    h(SafeMount, { Comp: DeviceMonitor, Boundary: DeviceMonitorBoundary }),

    h("div", {
    className: "comfy-wb",
    style: {
      /**
       * ★★ 2026-10-22 根容器：三段式 → 左右两栏 + 宽度实时跟随 DSH
       *
       *   · flexDirection: row   左画布弹性 + 右侧栏 320
       *   · width: var(--ac-follow-w)  跟随 DSH 的 CSS 变量（同帧，无轮询）
       *   · margin: 0 auto      居中，与 DSH composer 同一种定位
       *   · padding 底部 8px    与 composer 分开（原来贴死，实测都是 794）
       */
      /**
       * ★★ 2026-10-23 底部间距 8 → 16
       *
       *   主人：「剪辑台和对话框直接的间隔直接为0是否太拥挤？」
       *   实测 DSH 自己的「对话 tab」给了 16px（最后一条消息 778 → composer 794）。
       *   两个 tab 用同一个值，边界看起来才一致。
       */
      padding: "0 0 16px",
      boxSizing: "border-box",
      /**
       * ★★ 2026-10-23 修首帧满宽：直接引用 DSH 的变量，不等我们自己的 CSS
       *
       *   原来写 var(--ac-follow-w, 100%) —— 而这个变量是 JS 在
       *   useEffect 里写入的，比首帧晚 ⇒ 首帧取到 100% = 满宽 ⇒ 闪一下。
       *
       *   ⇒ 加一层回落：var(--ac-follow-w, var(--dsh-composer-card-max-width, 100%))
       *     --dsh-composer-card-max-width 由 DSH 定义在 viewArea 上，
       *     首帧就有值（实测 :root 没有、viewArea 有）。
       *     JS 写的 --ac-follow-w 仍然优先（保留覆盖能力）。
       *
       *   修前实测（每 100ms 采样，剪辑台）：
       *     t=400ms 宽 1633（满宽）→ t=500ms 1496
       *   ⚠ 修后的实测数字尚未取，验证后再补。
       */
      width: "min(100%, var(--ac-follow-w, var(--dsh-composer-card-max-width, 100%)))",
      maxWidth: "100%",
      margin: "0 auto",
      height: "100%",
      display: "flex",
      flexDirection: "row",
      minHeight: 0,
      // ★ 必须 hidden —— 实测（2026-10-18 主人反馈「整个页面都能上下滚」）：
      //   下拉面板展开时多出的高度被父级链逐层传递，
      //   最终撑大 Dc7zOa_scrollBody（overflow-y:auto）→ 整个对话框跟着滚。
      overflow: "hidden",
      background: "var(--dsw-alias-bg-base, #fff)",
      color: "var(--dsw-alias-label-primary, #0f1115)",
      font: "var(--dsw-font-xs-13, 13px/20px inherit)",
      gap: 0,
    },
  },

    // ── 成果区 = 画布式资产库（主人 2026-10-18 改版）──
    //   ★ 原来是 flex:1 的空白 div 按顺序摆图 —— 主人原话「空白太多」。
    //     现在这块恒等于画布：没有产物时画布给明确空状态，有产物时自由排布。
    //   ★ 这里不再 overflow:auto —— 平移/缩放交给画布自己（否则滚轮事件被
    //     外层滚动条抢走，画布缩放手感和整页滚动打架）。
    h("div", {
      style: {
        /**
         * ★ 2026-10-22 侧边栏改造：这块现在是【左栏】。
         *
         *   flex: 1 1 auto → 占满除侧边栏外的全部宽度
         *   minWidth: 0    → 必须！否则窄窗口时画布不肯收缩，
         *                   会把侧边栏挤出视口（flex 项目 min-width 默认 auto）
         */
        flex: "1 1 auto",
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "12px 16px 8px",
        overflow: "hidden",
      },
    },

      // ── 状态条（只在有内容可报时出现，占 18px，不再是一片空白）──
      renderResultBar({ job, assets, t, onClear: clearAssets, modesState, error }),

      // ── 画布本体 ──
      //   modeId 传下去：不同工作流的 bind.outputs 表不同，
      //   画布靠它取对应的「nodeId → 来源角色」映射。
      modesState === "ok" || modesState === "empty"
        ? h(SafeCanvas, {
        outputs: assets, bridge, t, modeId,
        /**
         * ★★ 2026-10-21 U6：空态的两个行动入口。
         *
         *   为什么由这里传：AssetCanvas 是独立模块，它不知道
         *   「资产库按钮」和「提示词框」在哪个位置、怎么打开。
         *   传回调进去，画布只管触发，不关心实现 —— 两个模块解耦。
         *
         *   onOpenLibrary：打开全局资产库（用户手上已有 871 项，
         *                  从现有素材起步比从空白写提示词更快）
         *   onGenerate：   把光标送进提示词框（不是直接触发生成 ——
         *                  提示词还空着，生成了也没用）
         */
        /**
         * ★ 2026-10-21 修：正确的入口是 openLibrary，不是 lib.open。
         *   useAssetAtMentions 的返回值里：
         *     openLibrary: () => setPanel(true)   ← 打开全局资产库面板
         *     lib:         ArtCraft 用的 picker（返回 Promise<选中项>），用途不同
         *   我一开始用了 lib.open，点了没反应。
         */
        /**
         * ★ 2026-10-21 G3：把资产总数传进画布空态。
         *   ★ 实时取（stats.total），不写死 —— 写死的数字就是谎话。
         */
        libraryCount: atMentions.lib?.stats?.total ?? null,
        onOpenLibrary: () => atMentions.openLibrary?.(),
        onGenerate: () => {
          try { promptRef.current?.focus(); } catch { /* ignore */ }
        },
      })
        : null
    ),

    // ── 输入卡片（叶子尺寸/圆角/阴影全部照抄官方实测）──
    h("div", {
      style: {
        /**
         * ★★ 2026-10-22（主人：当前还是三段式tab / 要侧边栏面板 / 深色原形毕露 / 实时跟随）
         *
         *   这一块经历了四次改：
         *     ① 从「底部横条」→「右侧栏」：flex: 0 0 320px，占满整高
         *     ② 深色修正：bg-layer-2 在深色下比画布亮两档 → 改同底 + 分隔线
         *     ③ 宽度实时跟随 DSH：width: var(--ac-follow-w)
         *     ④ 内边距 14px（原来左右是 0，文字紧贴边界）
         *
         *   ★ 宽度为什么用 CSS 变量而不是 JS 计算：
         *     DSH 拖手柄时只改 CSS 变量 --dsh-composer-card-max-width，
         *     浏览器原生重绘（无 React 重渲染）⇒ 我们也引用变量就能同帧跟随。
         *     实测：改 localStorage 后 DSH 卡片宽度完全不变，说明它不读 localStorage。
         */
        flex: "0 0 320px",
        width: 320,
        minWidth: 0,
        boxSizing: "border-box",
        padding: "8px 14px 0",
        borderRadius: 0,
        background: "var(--dsw-alias-bg-base, #ffffff)",
        borderLeft: "1px solid var(--dsw-alias-border-l2, #0000001a)",
        display: "flex",
        flexDirection: "column",
        overflowY: "auto",
        overflowX: "hidden",
      },
    },



      /**
       * ★★ 2026-10-22（主人：「提示词抬头部分不需要重复显示参数」）
       *
       *   这里原来是「本镜配方 · 多参 H3 · 16:9 · 5秒 · 1K」摘要行。
       *   它 2026-10-21 加的时候有理由（参数散在下面、要逐个读）。
       *   但现在参数行已经把这些值全部显示出来了 ⇒ 同一份数据出现两次 = 纯噪音。
       *
       *   ⇒ 整行删除。参数值的唯一展示位就是参数行本身。
       *
       *   ★ 判据：同一份数据在一屏里出现两次，第二次必须提供新信息。
       *     问「删了这行用户会少知道什么」—— 答不上来就是重复。
       */


      // 提示词
      h("div", {
        style: {
          /**
           * ★★ 2026-10-22 侧边栏：提示词区要【撑开】剩余高度
           *
           *   原来 margin: "0 8px 0 16px"（横条时代的左右留白），
           *   且在竖向布局里 flex: none ⇒ 只按 textarea 的 promptH 占位，
           *   参数置底后中间会留一大片空白，提示词反而只有 80px 高。
           *
           *   ⇒ flex: "1 1 auto" + minHeight: 0 ⇒ 占满参数区以上的全部高度。
           *     左右 margin 归零（侧边栏自己已有 14px padding）。
           */
          flex: "1 1 auto",
          minHeight: 0,
          margin: 0,
          display: "flex",
          flexDirection: "column",
          // ★ position:relative —— 高亮层要贴在它里面（absolute inset:0）
          position: "relative",
        },
      },
        /**
         * ★ @ 引用高亮层（在 textarea 之下）。
         *   为什么只画底色、不让这层显示文字：见 AssetLibrary.js 的
         *   PromptHighlight 注释 —— 字由 textarea 自己画，错位风险最低。
         *   整块包 Boundary：它挂了 textarea 还在。
         */
        h(AssetLibraryBoundary, null, atMentions.highlightNode),
        h("textarea", {
          ref: promptRef,
          value: prompt,
          /**
           * ★ @ 触发与键盘导航全在 atMentions.textareaProps 里。
           *   展开它，但【保留原来的 Ctrl+Enter 与 IME 保护】——
           *   顺序有意义：@ 浮层开着时 Enter 归浮层，否则归生成。
           */
          ...atMentions.textareaProps,
          onChange: (e) => {
            atMentions.textareaProps.onChange(e);
          },
          onKeyDown: (e) => {
            // ★ IME 保护（原注释）：中文输入法组字状态下 Enter 是上屏候选词。
            if (e.nativeEvent?.isComposing || e.keyCode === 229) return;
            // ① 浮层开着 → 优先给浮层（↑↓/Enter/Esc）
            atMentions.textareaProps.onKeyDown(e);
            if (e.defaultPrevented) return;
            // ② 否则 Ctrl+Enter 生成
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              onGenerate();
            }
          },
          placeholder: t("field.promptPlaceholder"),
          style: {
            display: "block",
            width: "100%",
            boxSizing: "border-box",
            /* ★ 2026-10-22 侧边栏：撑满提示词区（flex:1）而不是固定 promptH        由下方把手调高度时，promptH 仍然生效于 minHeight */             flex: "1 1 auto",             minHeight: promptH,
            padding: "4px 0",
            border: 0,
            // ★ 必须是 transparent —— 高亮层在下面垫底色
            background: "transparent",
            // ★ 不能让高亮层压住输入区：它是 pointerEvents:none，但
            //   textarea 必须在更高的绘制层上，否则光标看不见。
            position: "relative",
            zIndex: 1,
            color: "var(--dsw-alias-label-primary, #0f1115)",
            font: "14px/24px inherit",         // ★ 官方 scroll 是 14/24
            // ★ 不要原生 resize 手柄 —— 实测（2026-10-18 主人反馈）：
            //   textarea 在卡片底部，往下拉时卡片贴底不动、上方内容被顶上去，
            //   视觉上变成「顶部往上张、底部不动」，方向反直觉。
            //   改成用户直接拖整张卡片的上边缘（由下面 card 的 resize 负责）。
            resize: "none",
            overflowY: "auto",
            outline: "none",
          },
        })
      ),

      /**
       * ── 提示词高度拖拽把手：已删除（2026-10-22）
       *
       *   主人（指着截图红框）：「那这个东西还有必要吗？可以直接删掉了吧？」
       *
       *   ★ 为什么它变成废物了：
       *     侧边栏改造后，提示词区是 flex: "1 1 auto"（撑满参数区以上的全部高度），
       *     textarea 也是 flex: 1（实测 h=569、inline height 为空）。
       *     高度由布局决定 ⇒ 拖那个把手拖动不了任何东西。
       *     实测：它占 12px 高、有 ns-resize 光标、却改了 promptH 也不产生影响。
       *
       *   ★ 保留 promptH 状态的原因：
       *     它现在是 textarea 的 minHeight（防止被压成一条），
       *     只是不再由拖拽控制。
       *
       *   ★ 判据：一个控件如果拖了没有任何可见变化，它就是装饰。
       *     装饰要么做成真装饰（不暗示可交互），要么删掉 —— 不要留「假控件」。
       */


      // ★★ 2026-10-20 去掉 independent 的「引用票据」条（主人：
      //   「现在引用之后是单独有一个小卡片，应该把那个小卡片放在正文中@韩立这个部分」）
      //
      //   引用信息现在【只在正文里】以胶囊 chip 呈现（见 AssetLibrary.js 的
      //   PromptHighlight）。原来这里还有一条 RefStrip，与正文重复。
      //
      //   ⚠ 但保留了一件事：解绑。原来 RefStrip 上有「×」能解绑，
      //     现在解绑的办法是——在正文里删掉那个 @名字。
      //     files[slot] 会由 syncFromPrompt 自动清（见下方 useEffect）。
      //     如果那条同步没生效，就必须把 RefStrip 加回来（记在问题 md）。

      // ★★ 2026-10-20 第四轮改（主人指着截图：「现在还是有两个卡片，只留文本中的卡片」）
      //
      //   上一轮虽然去掉了「+参考图1~6」那排按钮，但【已绑定的槽】仍在
      //   提示词下方渲染成一排「缩略图 + 文件名 + 用途下拉」的小卡片。
      //   于是同一张图出现两次：正文里一个 chip、下面一个卡片。
      //
      //   ⇒ 下面这排整个去掉。信息全部收进正文 chip（用途 tag 也在 chip 上，
      //     点它能换 —— 见 AssetLibrary.js 的 PromptHighlight / buildTagSelect）。
      //
      //   ★ 只保留【警告】—— 那是「有没有 Picture / 一致性有没有约束」的提示，
      //     它不属于某一个槽，必须独立显示。
      media && Object.keys(media).length && refWarnings.length
        ? h("div", {
            style: { padding: "0 8px 4px", minWidth: 0 },
          },
            // ★ 2026-10-18 修（复核员 P1）：警告必须显示，否则「当场提示」是空话。
            //   琥珀色而不是红色 —— 这是「可以但不推荐」，不是错误。
            refWarnings.length
              ? h("div", {
                  style: {
                    display: "flex", flexDirection: "column", gap: 2,
                    padding: "3px 0 1px",
                  },
                },
                  ...refWarnings.map((w, i) =>
                    h("div", {
                      key: i,
                      style: {
                        display: "flex", alignItems: "flex-start", gap: 5,
                        fontSize: 11, lineHeight: "15px",
                        color: "rgb(163,106,3)",
                      },
                    },
                      h("span", { style: { flex: "none", opacity: 0.8 } }, "⚠"),
                      h("span", { style: { minWidth: 0 } }, w)
                    )
                  )
                )
              : null
          )
        : null,

      /**
       * ── 参数与生成（2026-10-22 改成适配 320px 侧边栏的竖向布局）
       *
       *   主人：「然后那些参数是不是应该默认置底？」
       *
       * ── 原来是横条布局，在侧边栏里全错了
       *   这段的所有优化都是为【952px 宽的底部横条】做的：
       *     · padding: "2px 2px 6px"  ← 为了省 5px 挤进一排
       *     · flexWrap: wrap + justifyContent: space-between  ← 左右分组
       *     · 各种「收窄下拉」「短名」  ← 为了横排放得下
       *   而侧边栏只有 320px ⇒ wrap 会疯狂换行，视觉上碎成一片。
       *
       * ── 现在改成「上：参数区（可长）/ 下：生成按钮」
       *   · flexDirection: column
       *   · marginTop: auto ⇒ 整块贴在侧边栏【底部】（主人要的「置底」）
       *   · 生成按钮占满整宽（侧边栏里它就该是全宽主按钮）
       *   · 去掉 space-between / wrap —— 竖排不需要
       */
      h("div", {
        style: {
          marginTop: "auto",        /* ★ 贴底：把这块推到侧边栏底部 */
          flex: "none",
          padding: "8px 0 10px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          /* ★ 相对定位：高级参数浮层用 bottom:100% 锚在这里 */
          position: "relative",
          borderTop: "0.5px solid var(--dsw-alias-border-l2, #0000001a)",
        },
      },

        // 左：参数 + 开关
        h("div", {
          style: {
            display: "flex", alignItems: "center", gap: 4,
            /* ★ 2026-10-22 侧边栏：参数在 320px 内必须能换行（否则溢出） */
            flexWrap: "wrap",
            rowGap: 4,
            minWidth: 0,
            // ★ 不抢满整行 —— 实测 flex:"1 1 auto" 会把左组撑到 936px，
            //   右侧按钮组被挤到第二排（底部行 74px 而不是 42px）。
            //   改成按内容宽，右侧就能并排。
            flex: "0 1 auto",
            // ★ 不能写 overflow:hidden —— 实测（2026-10-18 主人反馈「点了没反应」）：
            //   本层只有 28px 高，而弹出面板高 129px、从 top+4 往下展开，
            //   被这层的 overflow:hidden 整个裁掉 ⇒ 面板存在但看不见。
            //   要裁也别裁这里；参数放不下就让卡片行本身滚动。
            overflow: "visible",
          },
        },
          h(Select, {
            label: t("field.mode"),
            // ★ 2026-10-19 收窄：96 → 88 → 78
            //   「Krea2 生图」实测 62px + 三角 8 + 内边距 7 = 77px，78 刚够。
            minWidth: 78,
            value: modeId ?? "",
            options: modes
              .slice()
              .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
              .map((m) => ({ value: m.id, text: m.label + (m.primary ? " ★" : "") })),
            onChange: pickMode,
          }),
          caps.aspect
            ? h(Select, {
                label: t("field.aspect"),
                // ★ 2026-10-19 收窄：64 → 54（16:9 / 9:16 是 4~5 字符，54px 够）
                minWidth: 54,
                value: aspect,
                options: ASPECTS.map((a) => ({ value: a, text: a })),
                onChange: setAspect,
                // ★ 按「横屏左 / 竖屏右」成对排，1:1 单独一行
                pairGroups: true,
                title: `${t("field.aspect")} · ${aspect}`,
              })
            : null,
          // 尺寸档位（1K/2K/4K）—— 只有 bind 声明了 vars.megapixels 才有
          caps.megapixels
            ? h(Select, {
                label: t("field.megapixels"),
                // ★ 2026-10-19 收窄：58 → 46（1K/2K/4K 只有 2 字符）
                minWidth: 46,
                value: megapixels,
                options: MEGAPIXELS.map((x) => ({ value: x.v, text: x.t })),
                onChange: (v) => setMegapixels(Number(v)),
                formatValue: (v) => {
                  const hit = MEGAPIXELS.find((x) => x.v === Number(v));
                  return hit ? hit.t : String(v);
                },
                title: `${t("field.megapixels")} · ${megapixels}`,
              })
            : null,
          // ★ 时长也改成可输入 —— 主人 2026-10-18：
          //   「秒数也应该做成这种样式，目前只能选固定的 5/10/15」
          //
          // ★★ 2026-10-19 移走：SeedVR2 模型（7B/3B）下拉【不再放这里】。
          //   主人原话：「然后那个 seedvr2 的模型 3/7b 选择应该和开关在一起」
          //   ⇒ 已移到开关组，紧跟「SeedVR2 放大」开关右边（见下方 toggles 渲染处）。
          //   这样「开不开」与「用哪个模型」在视觉上是同一件事，且省掉一个独立槽位。
          caps.duration
            ? h(NumberField, {
                label: t("field.duration"),
                prefix: "",
                suffix: t("unit.sec"),
                value: durationSec,
                min: 1,
                max: 60,
                step: 1,
                onChange: (v) => setDurationSec(v),
                width: 66,
                title: `${t("field.duration")} · ${durationSec}`,
              })
            : caps.batch
            ? h(Select, {
                label: t("field.batch"),
                // ★ 2026-10-19 收窄：76 → 58（"1 张" / "8 张" 只有 3~4 字符）
                minWidth: 58,
                value: batch,
                options: BATCHES.map((b) => ({ value: b, text: `${b} ${t("unit.images")}` })),
                onChange: (v) => setBatch(Number(v)),
                formatValue: (v) => `${v} ${t("unit.images")}`,
                title: `${t("field.batch")} · ${batch} ${t("unit.images")}`,
              })
            : null,
          // ══════════════════════════════════════════════════════════════
          // ★★ 2026-10-20 参数分层（主人要求）
          //
          //   主人原话：「除了每个工作流都需要的常用调整：比例，分辨率，
          //     张数/秒数，其他的都应该放在（高级参数）里面，这个点击之后
          //     展开一个卡片，里面放一些步数，lora/loras（武打模式就是几个
          //     lora集群，要开一起开）种子使用方法（固定，随机）这里面的部分
          //     根据工作流不同，具体调整的东西也不同，不过可以大致分为
          //     通用类，说白了也就是多采相关、lora相关、模型相关」
          //
          //   ⇒ 常驻行只留：工作流 / 画幅 / 分辨率 / 张数或秒数
          //   ⇒ 其余全部进「高级参数」卡片，按三类分组：
          //       多采（步数、二采开关）
          //       LoRA（挂 LoRA + 多选、武打集群）
          //       模型（SeedVR2 模型、高清重绘、SeedVR2 放大）
          // ══════════════════════════════════════════════════════════════

          // 「高级参数」开关按钮 —— 常驻行最后一项
          h("button", {
            type: "button",
            onClick: () => setAdvancedOpen((v) => !v),
            "aria-expanded": advancedOpen,
            "aria-label": "高级参数",
            title: advancedOpen ? "收起高级参数" : "展开高级参数（步数 / LoRA / 模型）",
            style: {
              display: "inline-flex", alignItems: "center", gap: 3,
              height: 28, padding: "0 9px", flex: "none",
              border: 0, borderRadius: 8, cursor: "pointer",
              background: advancedOpen
                ? "var(--dsw-alias-interactive-bg-active, #e9ecef)"
                : "transparent",
              color: "var(--dsw-alias-label-secondary, #61666b)",
              fontFamily: "inherit", fontSize: 12, fontWeight: 400,
              whiteSpace: "nowrap",
            },
          },
            h("span", { style: { fontSize: 9, opacity: 0.75 } }, advancedOpen ? "▴" : "▾"),
            "高级参数"
          )
        ),

        /**
         * ★★ 2026-10-20 改成浮层（主人：「会导致提示词窗口位移」）
         *
         *   原来写的是 `flex: "1 0 100%"` —— 在文档流里独占一整行。
         *   展开时把整个参数区撑高 60~80px，提示词区被顶上去，用户正在看的
         *   那段文字突然跳走。
         *
         *   ⇒ 改成 position: absolute 浮层：
         *     · 不占布局空间 ⇒ 提示词区一动不动
         *     · 向上展开（bottom: 100%）—— 参数条在卡片底部，
         *       往下会盖住 DSH 的输入框（和原生 Select 同一处理）
         *     · 视觉规格抄 DSH 原生下拉：圆角 16 / bg-layer-1 /
         *       blur(40px) saturate(1.5) / elevation-panel 阴影
         */
        advancedOpen
          ? h("div", {
              style: {
                position: "absolute",
                /**
                 * ★★ 2026-10-20 实测修（截图里浮层压住了提示词里的字）
                 *
                 *   第一版用 bottom: "calc(100% + 6px)" —— 那是锚在
                 *   【参数行】上方 6px，但参数行上面紧贴着提示词区，
                 *   于是浮层盖住了提示词最后一行。
                 *
                 *   ⇒ 往上再抬 16px，让浮层底部落在参数行上方 22px 处，
                 *     视觉上与提示词之间留出清晰间隔。
                 */
                bottom: "calc(100% + 22px)",
                left: 0,
                zIndex: 40,
                minWidth: 320,
                maxWidth: "min(560px, 90vw)",
                display: "flex", flexDirection: "column",
                // ★ 三组之间 6px（原来是 8，显得散）
                gap: 6,
                // ★ 内边距收紧：10px 12px → 8px 10px
                padding: "8px 10px",
                borderRadius: 16,
                background: "var(--dsw-alias-bg-layer-1, #fff)",
                backdropFilter: "blur(40px) saturate(1.5)",
                boxShadow: "var(--dsw-elevation-panel, 0 3px 8px rgba(0,0,0,.04), 0 0 20px rgba(0,0,0,.05))",
                border: "0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,.06))",
              },
            },
              renderAdvancedGroups()
            )
          : null,

        // 旧常驻行的内容已全部下沉到 renderAdvancedGroups()。
        // 这里原来的 LoRA 多选也一并下沉（它属于「LoRA 相关」那组）。

        // ★ 参数组合提醒（琥珀色，不禁止）
        paramWarnings.length
          ? h("div", {
              style: {
                display: "flex", flexDirection: "column", gap: 2,
                padding: "0 8px 2px 16px",
              },
            },
              ...paramWarnings.map((msg, i) =>
                h("div", {
                  key: i,
                  style: {
                    display: "flex", alignItems: "flex-start", gap: 5,
                    fontSize: 11, lineHeight: "15px",
                    color: "rgb(163,106,3)",
                  },
                },
                  h("span", { style: { flex: "none", opacity: 0.8 } }, "⚠"),
                  h("span", { style: { minWidth: 0 } }, msg)
                )
              )
            )
          : null,

        // 右：状态 + 种子 + 生成
        h("div", {
          style: {
            display: "flex", alignItems: "center", gap: 6,
            // ★ 右组不许被压缩 —— 实测会被左组挤到「留空随」截断
            flex: "0 0 auto", minWidth: "fit-content",
            whiteSpace: "nowrap", marginLeft: "auto",
            alignSelf: "center",
          },
        },
          /**
           * ★ 资产库入口（主人 2026-10-18「我需要那种全局资产库」）
           *   放在参数行最右、种子左边：它和「选素材」是一类动作。
           *   ⚠ 自己包 Boundary —— 库模块炸了这颗按钮只变成「不可用」，
           *   不许把同一行的种子/生成按钮一起带走。
           */
          h(AssetLibraryBoundary, null,
            h("button", {
              type: "button",
              onClick: () => atMentions.openLibrary(),
              title: atMentions.lib.s === "error"
                ? `资产库加载失败：${atMentions.lib.error}\n（生成与提示词不受影响）`
                : `全局资产库（${atMentions.lib.stats?.total ?? 0} 项）\n在提示词里打 @ 也能直接调用`,
              "aria-label": "全局资产库",
              style: {
                display: "inline-flex", alignItems: "center", gap: 4,
                height: 28, padding: "0 9px", flex: "none",
                border: 0, borderRadius: 8, cursor: "pointer",
                background: atMentions.lib.s === "error"
                  ? "rgba(248,81,73,.10)"
                  : "transparent",
                color: atMentions.lib.s === "error"
                  ? "rgb(207,34,46)"
                  : "var(--dsw-alias-label-secondary, #61666b)",
                fontFamily: "inherit", fontSize: 12, fontWeight: 400,
              },
            },
              h(DshIcon, { hostRequire, name: "folderOpen" }),
              "资产库",
              atMentions.lib.stats
                ? h("span", {
                    style: {
                      fontSize: 11, opacity: .6,
                      fontVariantNumeric: "tabular-nums",
                    },
                  }, String(atMentions.lib.stats.total))
                : null
            )
          ),
          // 种子：骰子（随机）+ 输入框
          h("button", {
            type: "button",
            "aria-label": t("field.seedRandom"),
            title: t("field.seedRandom"),
            onClick: () => setSeed(String(Math.floor(Math.random() * 1e12))),
            style: {
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              width: 24, height: 28, padding: 0, flex: "none",
              border: 0, borderRadius: 8, background: "transparent",
              color: "var(--dsw-alias-label-secondary, #61666b)",
              cursor: "pointer", fontSize: 14,
            },
          }, h(DshIcon, { hostRequire, name: "refresh" })),
          h("input", {
            type: "number", step: 1, value: seed,
            placeholder: t("field.seedHint"),
            "aria-label": t("field.seed"),
            onChange: (e) => setSeed(e.target.value),
            style: {
              width: 76, height: 28, padding: "0 5px",
              border: 0, borderRadius: 8,
              background: "transparent",
              color: "var(--dsw-alias-label-secondary, #61666b)",
              font: "13px/20px inherit",
              outline: "none", textAlign: "left",
            },
          }),
          /**
           * ★★ 2026-10-23 改：生成 / 停止 合到【一个按钮】里
           *
           *   主人：「点击生成后多出来一个取消，应该学习DSH的对话发送和暂停，
           *          在一个按钮位置做切换」
           *
           * ── 原来是什么样
           *   生成中会【多出一个】「取消」按钮，生成按钮同时变成「生成中…」且被禁用。
           *   于是同一行里出现两个按钮，一个能点（取消）、一个不能点（生成中）。
           *
           * ── DSH 怎么做的（照它）
           *   composer 的发送键在 streaming 时【原地变成】停止键：
           *     · 位置不变（不新增元素）
           *     · 图标从 ↑ 变 ▪
           *     · 语义从「提交」变「中断」
           *   ⇒ 一个位置，两种状态，用户不用找第二个按钮。
           *
           * ── 这里怎么做
           *   · busy 时：同一个按钮 → 显示「停止」+ 方块图标 + onClick=onCancel，可点
           *   · 闲时：  显示「生成」+ 保留原来的 primary 蓝底胶囊
           *   · 停止态用【中性色】（不是蓝底）—— 停止不是主操作，是中断操作。
           *     用蓝底会让人以为「再点一下会继续生成」。
           */
          h("button", {
            type: "button",
            onClick: busy ? onCancel : onGenerate,
            disabled: !busy && !modeId,
            title: busy
              ? "停止生成（中断当前任务）"
              : "生成（Ctrl+Enter）",
            "aria-label": busy ? "停止" : "生成",
            style: {
              height: 34, minWidth: 34, padding: "0 14px",
              border: 0, borderRadius: 999,
              /**
               * 三态背景：
               *   busy            → 中性底（停止）
               *   无工作流        → 禁用底
               *   正常            → primary 蓝
               */
              background: busy
                ? "var(--dsw-alias-interactive-bg-active, #f1f3f5)"
                : (!modeId
                    ? "var(--dsw-alias-interactive-bg-active, #f1f3f5)"
                    : "var(--dsw-alias-state-business-primary, #4176e6)"),
              color: busy
                ? "var(--dsw-alias-label-primary, #0f1115)"
                : (!modeId
                    ? "var(--dsw-alias-label-tertiary, #81858c)"
                    : "var(--dsw-alias-label-primary-foreground, #fff)"),
              font: "13px/20px inherit", fontWeight: 600,
              cursor: (!busy && !modeId) ? "not-allowed" : "pointer",
              flex: "none",
              /* ★ 图标与文字间距 —— 停止态要有个方块图标 */
              display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5,
            },
          },
            busy
              ? h("span", {
                  /* 方块：DSH 停止键的语义符号，用 CSS 画（不依赖图标集） */
                  style: {
                    width: 8, height: 8, borderRadius: 1.5,
                    background: "currentColor", flex: "none",
                  },
                  "aria-hidden": "true",
                })
              : null,
            busy ? t("btn.stop") : t("btn.generate"))
        )
        )
      )
    ),

    /* ══════════════════════════════════════════════════════════════
     * 全局资产库的三个浮层 —— 全部 portal 到 body，零布局占用。
     * （验收第 ⑤ 条：不许挤动 DSH 原生元素。）
     * 每块单独包 Boundary：任一块挂了，其余照常。
     * ══════════════════════════════════════════════════════════════ */
    h(AssetLibraryBoundary, null, atMentions.pickerNode),
    h(AssetLibraryBoundary, null, atMentions.panelNode),
    h(AssetLibraryBoundary, null, atMentions.chooserNode),
    h(AssetLibraryBoundary, null, atMentions.hoverNode)
  );
}

/**
 * 成果区顶部状态条。
 *
 * ★ 它替代了原来的 renderOutputs()。
 *   旧实现把「完成 · 24.0s · 5 个产物」这行字和图片流挤在同一个滚动容器里，
 *   图片一多就被顶出视野；空态时整块是 flex:1 的空白 div（主人：「空白太多」）。
 *   现在状态条固定 18px 高，产物全部交给画布。
 */
function renderResultBar({ job, assets, t, onClear, modesState, error }) {
  // 工作流列表本身出问题 → 显示真实错误，不要显示成「没有工作流」
  if (modesState === "error") {
    return h("div", {
      style: {
        flex: "none", padding: "8px 10px", borderRadius: 12,
        fontSize: 12, lineHeight: "18px", whiteSpace: "pre-wrap",
        background: "rgba(248,81,73,.08)", color: "rgb(207,34,46)",
      },
    }, error ?? t("modes.error"));
  }
  if (modesState === "loading" || modesState === "empty") {
    return h("div", {
      style: {
        flex: "none", fontSize: 12, lineHeight: "18px",
        color: "var(--dsw-alias-label-tertiary, #81858c)",
      },
    }, modesState === "loading" ? t("modes.loading") : t("modes.empty"));
  }

  const n = assets.length;
  const bits = [];

  // ★ 2026-10-18 修（质检 P2-7「ComfyUI 未启动点生成时静默 14 秒」）：
  //   原来只有 modesState==="error" 时才渲染 error，而 ComfyUI 没跑的时候
  //   modes 是能加载的（工作流 JSON 在磁盘上，不依赖 ComfyUI）⇒ modesState="ok"，
  //   于是生成时的 500 {"error":"ComfyUI 未运行或不可达…"} 被传进来却从不使用。
  //   用户看到的是点了没反应。
  if (error) {
    return h("div", {
      style: {
        flex: "none", padding: "8px 10px", borderRadius: 12,
        fontSize: 12, lineHeight: "18px", whiteSpace: "pre-wrap",
        background: "rgba(248,81,73,.08)", color: "rgb(207,34,46)",
        display: "flex", alignItems: "flex-start", gap: 8,
      },
    },
      h("span", { style: { flex: "1 1 auto", minWidth: 0 } }, String(error)),
      job?.jobId
        ? h("button", {
            type: "button",
            onClick: onClear,
            title: "清除这条错误（画布上的产物会保留）",
            style: {
              flex: "none", border: 0, background: "transparent",
              color: "inherit", cursor: "pointer", opacity: 0.7,
              fontFamily: "inherit", fontSize: 14, lineHeight: "18px",
              padding: 0,
            },
          }, "×")
        : null
    );
  }

  if (job?.completed) {
    bits.push(h("span", { key: "s", style: { color: "rgb(46,160,67)", fontWeight: 600 } }, t("result.done")));
    bits.push(h("span", { key: "e" }, `${((job.elapsedMs ?? 0) / 1000).toFixed(1)}s`));
    bits.push(h("span", { key: "n" }, `${n} ${t("unit.outputs")}`));
    if (n === 0) {
      // 完成却 0 产物 —— 必须显式说，否则画布空着像「还在跑」
      bits.push(h("span", { key: "z", style: { color: "rgb(163,106,3)" } },
        "completed 但 0 产物 —— 检查 bind 的 outputs"));
    }
  } else if (job?.failed) {
    bits.push(h("span", { key: "f", style: { color: "rgb(207,34,46)", fontWeight: 600 } }, t("result.failed")));
    bits.push(h("span", { key: "i", style: { fontSize: 11 } }, String(job.jobId ?? "")));
  } else if (job?.cancelled) {
    bits.push(h("span", { key: "c" }, t("result.cancelled")));
  } else if (job) {
    bits.push(h("span", { key: "r", style: { color: "var(--dsw-alias-state-business-primary, #4176e6)" } },
      t("result.running")));

    /**
     * ★★ 2026-10-22 新增：队列位次 + 实时进度
     *
     *   主人：「是不是需要有一个任务队列，或者任务状态？实时显示进度之类的？」
     *       → 选了「只做进度 + 位次」
     *
     *   数据来源（都已由后端提供）：
     *     queue    —— job handler 一直返回，但前端从没读过（§6.38 生产方产出、消费方没接）
     *     progress —— bridge 新加的 WebSocket 进度总线
     *
     *   ★ progress 为 null 时不显示：WS 没连上 / 还没开始跑。
     *     显示 0% 比不显示更糟 —— 会让人以为卡住。
     */
    const q = job.queue;
    if (q && Number.isFinite(q.running) && Number.isFinite(q.pending)) {
      const isMine = q.runningPromptId && q.runningPromptId === job.promptId;
      if (isMine) {
        if (q.pending > 0) {
          bits.push(h("span", { key: "q", style: { fontSize: 11, opacity: .75 } },
            `后面还有 ${q.pending} 个`));
        }
      } else {
        const idx = (q.pendingPromptIds || []).indexOf(job.promptId);
        if (idx >= 0) {
          const ahead = (q.running > 0 ? 1 : 0) + idx;
          bits.push(h("span", { key: "q", style: { fontSize: 11, opacity: .75 } },
            `排队第 ${ahead + 1} 位`));
        }
      }
    }

    /**
     * ★★ 2026-10-23 改：进度从「一句话」变成「进度条」
     *
     *   主人：「视频工作台还是没用之前说的进度」——
     *   之前只在状态条里塞了 11px 的小字「15/30 步 · 50%」，
     *   混在 jobId、产物数里，根本看不出来那是进度。
     *
     *   ⇒ 改成【可见的进度条】：
     *     · 48px 宽的细条 + 百分比数字
     *     · 用 DSH 的 primary 色，和「生成中」的语义一致
     *     · 仍然只在有真实数据时出现（null 就不显示）
     *
     *   ★ 为什么不用 DSH 的 Progress 组件：
     *     状态条只有 18px 高，Progress 自带上下留白会撑高整条。
     *     这里用两个 div 画（底槽 + 填充），零依赖、尺寸完全可控。
     */
    const pg = job.progress;
    if (pg && Number.isFinite(pg.pct)) {
      const pct = Math.max(0, Math.min(100, pg.pct));
      bits.push(h("span", {
        key: "pg",
        style: {
          display: "inline-flex", alignItems: "center", gap: 6,
          fontVariantNumeric: "tabular-nums",
        },
        title: Number.isFinite(pg.value) && Number.isFinite(pg.max)
          ? `${pg.value} / ${pg.max} 步`
          : undefined,
      },
        /* 底槽 */
        h("span", {
          style: {
            position: "relative", display: "inline-block",
            width: 48, height: 4, borderRadius: 2,
            background: "var(--dsw-alias-interactive-bg-active, #f1f3f5)",
            flex: "none", overflow: "hidden",
          },
        },
          /* 填充 */
          h("span", {
            style: {
              position: "absolute", left: 0, top: 0, bottom: 0,
              width: `${pct}%`, borderRadius: 2,
              background: "var(--dsw-alias-state-business-primary, #4176e6)",
              transition: "width .2s ease",
            },
          })
        ),
        /* 数字：带步数（不同节点总步数不同，只看百分比看不出「在动」） */
        h("span", null,
          Number.isFinite(pg.value) && Number.isFinite(pg.max)
            ? `${pg.value}/${pg.max} · ${pct}%`
            : `${pct}%`)
      ));
    }

    bits.push(h("span", { key: "i", style: { fontSize: 11 } }, String(job.jobId ?? "")));
    if (n > 0) bits.push(h("span", { key: "n" }, `${n} ${t("unit.outputs")}`));
  } else {
    return null;   // 全新打开 —— 画布自己会显示空状态，这里不重复占位
  }

  // 用「·」分隔，保持和原来那行字的观感一致
  const sep = [];
  bits.forEach((b, i) => {
    if (i) sep.push(h("span", { key: "d" + i, style: { opacity: 0.55 } }, "·"));
    sep.push(b);
  });

  return h("div", {
    style: {
      flex: "none", display: "flex", alignItems: "center", gap: 6,
      minHeight: 18,
      fontSize: 12, lineHeight: "18px",
      color: "var(--dsw-alias-label-tertiary, #81858c)",
    },
  },
    sep,
    n > 0
      ? h("button", {
          type: "button",
          onClick: onClear,
          title: "清空画布（不影响已生成的文件）",
          style: {
            marginLeft: "auto", flex: "none",
            height: 20, padding: "0 8px", boxSizing: "border-box",
            border: 0, borderRadius: 999,
            background: "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05))",
            color: "var(--dsw-alias-label-tertiary, #81858c)",
            fontFamily: "inherit", fontSize: 11, lineHeight: "16px",
            cursor: "pointer",
          },
        }, "清空画布")
      : null,
  );
}

export default WorkbenchView;






