/**
 * 提示词 / 文本的「有没有实际内容」判定 —— 单一权威。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要这个文件（2026-10-19）
 *
 *   同一个错误在项目里出现了 6 次：
 *     if (!String(x ?? "").trim())  ...
 *   它拦不住 String({a:1}) → "[object Object]"、String(0) → "0"、零宽字符。
 *   实测后果：这些都提交成功，跑出一张「因为没提示词所以随机」的图。
 *
 * ══════════════════════════════════════════════════════════════════════
 * ★★ 2026-10-19 第二次重构：黑名单 → 白名单（独立复核打穿后）
 *
 *   第一版用【黑名单】正则删不可见字符。独立复核（角色 tester，我逐条复跑确认）
 *   打穿 4 条：
 *
 *     U+2800  盲文空白 BRAILLE PATTERN BLANK   （类别 So，视觉完全空白）
 *     U+00AD  软连字符 SOFT HYPHEN             （类别 Cf，默认可忽略）
 *     "\u2060\u2800\u00ad\ufeff" 混合串         （名单内的被删，名单外的留下 ⇒ 非空）
 *     槽名 + 空 base64                          （见 index.js，另一处）
 *
 *   实测证据（复核员给出，我复跑确认）：
 *     prompt="\u2800" → 提交成功，CLIPTextEncode.text 码点 [10240]
 *     prompt="\u00ad" → 提交成功，码点 [173]
 *
 *   ⇒ **黑名单方法本身不可靠**：Unicode 里「视觉不可见」的字符成千上万，列不完。
 *      而且每次补一批，复核员总能再找一个 —— 这是方法问题，不是清单问题。
 *
 *   ✅ 改用【白名单】：只认「确定有内容」的字符，其余全不算。
 *      判据用正则的 Unicode 属性类（\p{...}），不手写编码范围：
 *        字母 / 数字 / 标点 / emoji / 常见符号
 *      盲文点字区段（U+2800-U+28FF）整体排除 —— 它在提示词里没有语义价值。
 *
 * ══════════════════════════════════════════════════════════════════════
 */

/**
 * 「确定有内容」的字符类（白名单）。
 *
 *   \p{L}   字母（含 CJK 汉字、假名、韩文、拉丁、西里尔……）
 *   \p{N}   数字（含全角数字、罗马数字）
 *   \p{P}   标点（含中英文标点）
 *   \p{S}   符号 —— 但盲文点字（So 类里的 U+2800-U+28FF）要排除，
 *           所以在下面用 SYMBOL_BUT_BLANK 单列，这里先放常见符号区段
 *   emoji   用区段覆盖（\p{Emoji_Presentation} 在部分 Node 不支持）
 *
 * ⚠ 必须带 u 标志，否则 \p{} 无效。
 */
const VISIBLE = new RegExp(
  "[" +
    "\\p{L}" +                  // 字母：CJK / 假名 / 韩文 / 拉丁 / 西里尔 ……
    "\\p{N}" +                  // 数字
    "\\p{P}" +                  // 标点：* / @ # % & 等
    // ★★ 2026-10-19 补（独立复核第二轮发现我误拒了 14 个符号）：
    //   原来漏了 \p{S}（Symbol），导致这些全被拒、报「提示词不能为空」：
    //     $ + = < > | ~ ^ ∑ ℃ √ ∞ ≈ ≠
    //   它们明明有内容 —— 「校验设太严」和放行一样是缺陷。
    //
    //   \p{S} 含：数学符号、货币符、修饰符、箭头、杂项符号。
    //   ⚠ 它【包含】盲文区段 U+2800-U+28FF，那个在 hasVisibleText 里单独排除。
    "\\p{S}" +
    "\\u{1F000}-\\u{1FAFF}" +   // emoji 主区（🐱 😀 🎬 ……）
  "]",
  "u"
);

/**
 * 盲文点字区段（U+2800-U+28FF）整体不算内容。
 *
 *   其中 U+2800 BRAILLE PATTERN BLANK 是「盲文空白」，视觉完全空白，
 *   但 Unicode 类别是 So（符号），会被 \p{S} 或区段匹配命中。
 *   整段排除最省事 —— 盲文在视频提示词里没有任何语义价值。
 */
const BRAILLE = /[\u2800-\u28FF]/u;

/**
 * 「虽然是字母/符号类，但视觉空白」的字符 —— 白名单的例外。
 *
 * ★★ 这是白名单方法的必要补丁（2026-10-19 实测发现）：
 *    \u3164 HANGUL FILLER 的 Unicode 类别是 Lo（字母），会被 \p{L} 命中，
 *    但它渲染出来是【空白】。同类还有韩文填充符的几个编码。
 *
 *    这些字符数量很少（不像字母有几千个），可以显式列出。
 *    「字母类但空白」是特例，「字母类有形状」是常态 —— 所以白名单 + 少量例外
 *    比黑名单可靠得多。
 */
const LETTER_BUT_BLANK = /[\u115f\u1160\u3164\uffa0\u2800]/u;

/**
 * 这段文本有没有「确定有内容」的字符？
 * 非字符串一律视为「没有」。
 *
 * ★ 用 for...of 遍历（按码点而不是码元），emoji 才不会被拆成两半。
 *
 * @param {unknown} s
 * @returns {boolean}
 */
export function hasVisibleText(s) {
  if (typeof s !== "string") return false;
  for (const ch of s) {
    if (BRAILLE.test(ch)) continue;        // 盲文区段跳过
    if (LETTER_BUT_BLANK.test(ch)) continue; // 字母类但视觉空白（韩文填充符等）
    if (VISIBLE.test(ch)) return true;
  }
  return false;
}

/**
 * 去掉不可见字符后剩下的可读文本 —— 用于日志或文件名。
 * @param {unknown} s
 * @returns {string}
 */
export function stripInvisible(s) {
  if (typeof s !== "string") return "";
  let out = "";
  for (const ch of s) {
    if (BRAILLE.test(ch)) continue;
    if (LETTER_BUT_BLANK.test(ch)) continue;
    if (VISIBLE.test(ch)) out += ch;
  }
  return out;
}

/**
 * 校验并返回一句人话的错误；通过则返回 null。
 * @param {unknown} s
 * @param {string} what 用在错误文案里，如「提示词」「分镜提示词」
 * @returns {string|null}
 */
export function checkVisibleText(s, what = "提示词") {
  if (typeof s !== "string") {
    return `${what}必须是字符串（收到 ${s === null ? "null" : typeof s}）`;
  }
  if (!hasVisibleText(s)) {
    return `${what}不能为空（只有空白或不可见字符）`;
  }
  return null;
}
