/**
 * dsh-primitives.js · 取 DSH 官方 UI 基元（2026-10-22）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 主人 2026-10-22 原话：
 *   「你可以直接复用DSH自身的素材，这个插件最后是要在Deepseek harness桌面端
 *     上面运行的，可以直接复用，这也是最原生DSH风格DSH设计语言」
 *
 * ── 为什么这条推翻了「自己写 UI」的上一版方案
 *
 *   上一版（docs/架构决策-自建UI与Agent反馈-20261021.md）的结论是
 *   「抛弃上游 UI，自建一套」。那个结论对 **ArtCraft 上游** 是对的，
 *   但我当时把它错误地推广成了「连 DSH 的 UI 也要自己写」。
 *
 *   实测到手：DSH 的 @deepseek-ai/dsh-client-ui-primitives 有 500+ 导出，
 *   包含 Menu / MenuSurface / MenuItemButton / MenuGroup / Modal /
 *   SegmentedTabs / SegmentedControl / Pill / Tag / Switch / Tooltip /
 *   Toast / StateDot / ShortcutKeys / SettingsForm + 整套 Icon*。
 *   而且【官方插件自己就是这么用的】——
 *     dsh-client-ui-settings-shell.client.js：
 *       require("@deepseek-ai/dsh-client-ui-primitives")
 *     dsh-client-shortcuts.client.js：同一行
 *   ⇒ 这不是「逆向出来的私有接口」，是官方公开的客户端依赖。
 *
 *   ⇒ 结论修正：**外壳用 DSH 原生组件拼，只有 DSH 没有的东西才自己画**
 *      DSH 有（复用）：菜单、弹窗、分段 tab、胶囊、开关、提示、图标、快捷键标注
 *      DSH 没有（自画）：时间轴轨道、预览画布、波形、缩放尺
 *
 * ── 严格性
 *
 *   拿不到 primitives 时【不静默降级成自制组件】——
 *   那会造出「看着差不多但不一样」的第二套皮肤，正是主人讨厌的城中城。
 *   这里抛错，让 ArtCraftBoundary 显性画出来。
 *   代价：如果 DSH 哪天改了包名，剪辑台会白屏报错而不是凑合能用。
 *   取舍：报错能立刻发现并修；凑合能用会长期存在且没人察觉。
 */

/**
 * 取宿主的 require。
 *
 * ★★ 2026-10-22 实测踩到的坑（这个函数就是为它存在的）
 *
 *   源码里写 `typeof require === "function" ? require : null` 是【不可靠的】：
 *   esbuild 打包 CJS 时把裸 `require` 解析成它自己的 `__require` 桩
 *   （一个抛「Dynamic require of X is not supported」的函数），
 *   而 `typeof require` 这个字面量原样保留 ⇒ 判定通过、拿到桩、调用必炸。
 *
 *   症状：剪辑台 tab 出现，但整块渲染成
 *     「[artcraft] 渲染失败：加载 @deepseek-ai/dsh-client-ui-primitives 失败」，
 *   而控制台没有更多线索。
 *
 *   ⇒ 优先取 build.mjs 的包装层挂到全局的那个（真 require），
 *     退到工厂参数（IIFE 正常路径）。
 */
export function resolveHostRequire(candidate) {
  try {
    if (typeof globalThis.__DSH_PLUGIN_REQUIRE__ === "function") {
      return globalThis.__DSH_PLUGIN_REQUIRE__;
    }
  } catch { /* ignore */ }
  if (typeof candidate === "function") return candidate;
  if (typeof require === "function") return require;
  return null;
}

const PKG = "@deepseek-ai/dsh-client-ui-primitives";

let _cache = null;

/**
 * 从宿主 require 取原生基元。
 *
 * @param {(name:string)=>any} hostRequire  IIFE factory 的 require
 * @returns {object} primitives 模块导出
 */
export function getPrimitives(hostRequire) {
  if (_cache) return _cache;
  const req = resolveHostRequire(hostRequire);
  if (typeof req !== "function") {
    throw new Error(
      "拿不到宿主 require —— 无法加载 " + PKG + "。\n" +
      "这通常意味着 client.js 的 factory 没有把 require 透传进来。"
    );
  }
  let mod;
  try {
    mod = req(PKG);
  } catch (e) {
    throw new Error(
      "加载 " + PKG + " 失败：" + (e?.message ?? e) + "\n" +
      "本插件的 UI 外壳完全依赖 DSH 原生基元（菜单/弹窗/tab/胶囊/图标）。\n" +
      "不降级成自制组件 —— 那会造出第二套皮肤。请确认该包在宿主里可用。"
    );
  }
  /**
   * ★★ 2026-10-22 实测：判据不能写 typeof === "function"
   *
   *   MenuSurface 是 forwardRef 的产物 —— 它的 typeof 是 **"object"**
   *   （React.forwardRef 返回 { $$typeof: Symbol(react.forward_ref), render }）。
   *   我第一版写 `typeof mod.MenuSurface !== "function"` ⇒ 误判为「包结构变了」，
   *   整块剪辑台渲染成一个错误框，而这个错误还是我自己造的。
   *
   *   ⇒ 正确的判据：React 组件要么是函数，要么是带 $$typeof 的对象。
   *     统一用 isComponentLike()。
   */
  if (!mod || typeof mod !== "object" || !isComponentLike(mod.MenuSurface)) {
    throw new Error(
      PKG + " 已加载，但 MenuSurface 不是可渲染组件 —— 包结构可能变了。\n" +
      "menuSurface typeof = " + typeof mod?.MenuSurface
    );
  }
  _cache = mod;
  return mod;
}

/** React 组件判定：函数 / forwardRef 对象 / memo 对象。 */
function isComponentLike(v) {
  return typeof v === "function" || (typeof v === "object" && v !== null && "$$typeof" in v);
}

/**
 * 一组语义化取值器：把「我要的那个原生组件」集中在这里。
 *
 * ★ 为什么集中：原件名很长（IconEllipsisOutlineMedium），
 *   分散在各个组件里 grep 不到、改名时漏改。
 */
export function ui(hostRequire) {
  const P = getPrimitives(hostRequire);
  const need = (name) => {
    if (P[name] === undefined) {
      throw new Error(
        "DSH 原生基元缺导出：" + name + "\n" +
        "本插件依赖它，不做降级。若 DSH 升级改了名字，改 dsh-primitives.js 一处即可。"
      );
    }
    return P[name];
  };

  return {
    /* ── 菜单 / 浮层 ── */
    Menu: need("Menu"),
    MenuSurface: need("MenuSurface"),
    MenuItemButton: need("MenuItemButton"),
    MenuGroup: need("MenuGroup"),
    Modal: need("Modal"),
    Tooltip: need("Tooltip"),

    /* ── 控件 ── */
    SegmentedTabs: need("SegmentedTabs"),
    SegmentedControl: need("SegmentedControl"),
    Pill: need("Pill"),
    Tag: need("Tag"),
    Switch: need("Switch"),
    ShortcutKeys: need("ShortcutKeys"),
    StateDot: need("StateDot"),
    Toast: need("Toast"),

    /* ── 设置面板 ── */
    SettingsForm: P.SettingsForm,

    /* ── 图标（只取要用的，缺哪个立刻报）── */
    Icon: {
      play: need("IconPlayOutlineMedium"),
      pause: need("IconPauseOutlineMedium"),
      plus: need("IconPlusOutlineMedium"),
      trash: need("IconTrashOutlineMedium"),
      copy: need("IconCopyOutlineMedium"),
      ellipsis: need("IconEllipsisOutlineMedium"),
      panelLeft: need("IconPanelLeftOutlineMedium"),
      search: need("IconSearchOutlineMedium"),
      close: need("IconCloseOutlineMedium"),
      check: need("IconCheckOutlineMedium"),
      chevronDown: need("IconChevronDownOutlineMedium"),
      chevronLeft: need("IconChevronLeftOutlineMedium"),
      chevronRight: need("IconChevronRightOutlineMedium"),
      chevronUp: need("IconChevronUpOutlineMedium"),
      download: need("IconDownloadOutlineMedium"),
      edit: need("IconEditOutlineMedium"),
      refresh: need("IconRefreshOutlineMedium"),
      fullscreen: need("IconFullscreenOutlineMedium"),
      mic: need("IconMicrophoneOutlineMedium"),
      paperclip: need("IconPaperclipOutlineMedium"),
      info: need("IconInfoOutlineMedium"),
      warning: need("IconWarningOutlineMedium"),
      folderOpen: need("IconFolderOpenOutlineMedium"),
      sliders: need("IconSlidersTwoOutlineMedium"),
      sparkle: need("IconSparkleMedium"),
      // 分割 / 复制片段 在 DSH 里没有现成图标 —— 用 CompareSplit / Copy 语义最接近
      split: need("IconCompareSplitOutlineMedium"),
      flatList: need("IconFlatListOutlineMedium"),
      compact: need("IconCompactOutlineMedium"),
    },

    /** 原始模块，给需要别的东西时用 */
    raw: P,
  };
}
