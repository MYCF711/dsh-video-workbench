/**
 * @ 引用的纯逻辑（2026-10-20 抽成独立模块）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么单独一个文件
 *
 *   这两个函数原本内联在 AssetLibrary.js 的 onChange / onKeyDown 里。
 *   AssetLibrary.js 顶部 `import React from "react"`，node 侧跑不了
 *   ⇒ 里面的逻辑只能靠【人肉在浏览器里点】验证。
 *
 *   主人 2026-10-20 的两条要求正是这类逻辑：
 *     「输入 @ 应该弹出当前可应用的资源」
 *     「也可以通过 tab 直接引用」
 *   这两条我上一轮标了「已改」但【没有验收】——
 *   因为测不了。抽出来之后就能断言了。
 *
 *   ★ 判据：一段逻辑如果「只能靠人肉点才能验证」，那它迟早会悄悄坏掉。
 *     能抽就抽出来。
 * ══════════════════════════════════════════════════════════════════════
 */

/**
 * @ 触发判定：光标之前的文本里，末尾是不是一个 `@查询词`。
 *
 * 演进（两版，每一版都是被实测逼出来的）：
 *
 *   旧：/(^|\s)@([^\s@]*)$/
 *     · @ 前必须是【行首或空白】
 *     ⇒ 中文标点后打 @ 不触发。实测「a red apple，@」完全不弹窗
 *
 *   新：允许中文标点 / 括号 / 引号 / 半角标点作分隔符
 *     · 仍然不允许查询词含空格 ——
 *       含空格说明用户不想要这个引用了，
 *       否则「@A 然后继续写正文」会被误判成还在选。
 *
 * @param {string} before 光标之前的文本
 * @returns {{start:number, query:string}|null}
 *          start = `@` 在整串里的位置；query = @ 之后的查询词
 */
export function parseAtTrigger(before) {
  const s = String(before ?? "");
  const m = /(^|[\s，。、；：！？（）【】「」《》,.;:!?()[\]"'])@([^\s@]*)$/.exec(s);
  if (!m) return null;
  return { start: s.length - m[2].length - 1, query: m[2] };
}

/**
 * @ 面板打开时，某个按键该做什么。
 *
 * @param {string} key  KeyboardEvent.key
 * @param {{count:number, cursor:number}} nav  可选项数量 与 当前光标位置
 * @param {{composing?:boolean, compatOk?:boolean}} [opts]
 *        composing = 输入法组字中（不抢键）
 *        compatOk  = 当前光标项是否通过兼容过滤（false 则不确认）
 * @returns {"up"|"down"|"accept"|"close"|"none"}
 */
export function atKeyAction(key, nav, opts = {}) {
  if (opts.composing) return "none";
  const n = Number(nav?.count ?? 0);
  const cur = Number(nav?.cursor ?? 0);

  if (key === "ArrowDown") return n > 0 ? "down" : "none";
  if (key === "ArrowUp") return n > 0 ? "up" : "none";
  if (key === "Escape") return "close";

  /**
   * Enter 与 Tab 都确认选中 ——
   * 主人原话：「也可以通过 tab 直接引用」。
   */
  if (key === "Enter" || key === "Tab") {
    if (n === 0) return "none";
    if (!Number.isFinite(cur) || cur < 0 || cur >= n) return "none";
    if (opts.compatOk === false) return "none";
    return "accept";
  }
  return "none";
}

/**
 * 在 prompt 里把 `@查询词` 换成 `@显示名`。
 *
 * ★ 抽出来的理由同上：这是纯字符串变换，可测。
 *   而且它有两条容易错的规则：
 *     ① 前后要留空格分隔（否则下一次 @ 触发会因前面不是空白而失效）
 *     ② 只替换【末尾那一段】，不能动正文里别处的 @
 *
 * @param {string} prompt   当前全文
 * @param {number} start    `@` 的位置
 * @param {number} queryLen 查询词长度
 * @param {string} marker   要插入的标记（含 @）
 * @returns {{next:string, pos:number}}
 */
export function replaceAtMarker(prompt, start, queryLen, marker) {
  const cur = String(prompt ?? "");
  const s = Math.max(0, Number(start) || 0);
  const ql = Math.max(0, Number(queryLen) || 0);
  const before = cur.slice(0, s);
  const after = cur.slice(s + 1 + ql);
  const next = `${before}${marker} ${after.replace(/^\s+/, "")}`;
  return { next, pos: before.length + String(marker).length + 1 };
}
