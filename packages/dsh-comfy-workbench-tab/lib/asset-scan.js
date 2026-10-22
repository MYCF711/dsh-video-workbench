/**
 * 全局资产库 —— host 侧聚合层。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 主人原话（需求本身）：「资产库怎么没弄？我需要那种全局资产库，
 *                        在提示词框中 @ 就能直接调用」
 *
 * 「全局」= 一处能看到【所有】素材，而不是三个地方各看一半：
 *   ① 工作台产物   ComfyUI 的 output/   （Krea2-2ST / -USD / -SVR / YZ_H3）
 *   ② 用户上传     ComfyUI 的 input/    （uploadImage 落点）
 *   ③ dsh-editor   /timeline/assets     （已有的 11 条素材库索引）
 *
 * ── 为什么是「聚合 + 别名」，而不是把三处搬进一个库 ──────────────────
 *   实测（2026-10-18）：output/ 有 488 个文件、input/ 有 105 个。
 *   把它们全部物理搬进一个新目录会让：
 *     · ComfyUI 的 /api/view 立刻读不到旧产物（它按 output/ 寻址）
 *     · dsh-editor 的时间轴引用断链
 *   ⇒ 只读扫描 + 旁挂一份状态（收藏 / 别名 / 隐藏），一个字节都不搬。
 *     删除用「移到 trash/」而不是 unlink —— 可复原（见 deleteItem）。
 *
 * ── 为什么不直接改 dsh-editor 的素材库来当全局库 ──────────────────
 *   dsh-editor 的 assets.mjs 只能登记「已显式 add 过的路径」，
 *   它不扫 ComfyUI 的 output/（那是另一个包的落点，它不知道）。
 *   而硬约束是「不改 bridge / 不动别人的包」，所以：
 *     读它（GET /timeline/assets 当第三个数据源）→ 不写它。
 *   收藏/重命名/删除的写入全部落在【本包自己的状态文件】里。
 * ══════════════════════════════════════════════════════════════════════
 */

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { readTextTagsSync } from "./png-tags.mjs";

/* ── 类型判定（与 dsh-editor/assets.mjs 的 kindOf 同表，跨包不引）──── */
const EXT_KIND = new Map([
  ...[".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"].map((e) => [e, "image"]),
  ...[".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v"].map((e) => [e, "video"]),
  ...[".m4a", ".mp3", ".wav", ".aac", ".flac", ".ogg", ".opus"].map((e) => [e, "audio"]),
  ...[".txt", ".md", ".json", ".srt", ".csv", ".yaml", ".yml"].map((e) => [e, "text"]),
]);

export function kindOf(filename) {
  return EXT_KIND.get(path.extname(String(filename ?? "")).toLowerCase()) ?? "other";
}

/** 媒体类才可能进 ComfyUI 的素材槽；text/other 只能当纯文本引用。 */
export const MEDIA_KINDS = new Set(["image", "video", "audio"]);

/**
 * ★★ 2026-10-23 去敏：不再硬编码本机路径
 *
 *   原来 DEFAULT_ROOTS 写死：
 *     output: "D:/Comfy-Desktop/ComfyUI-Shared/output"
 *     input:  "D:/Comfy-Desktop/ComfyUI-Shared/input"
 *   ⇒ 换一台机器扫描不到任何东西，资产库直接空。
 *
 * ── 现在的解析顺序
 *   ① 环境变量 COMFY_OUTPUT_DIR / COMFY_INPUT_DIR
 *   ② 用户配置（设置页填的 config.json —— 与 comfy-launcher 同源）
 *   ③ 都取不到 ⇒ null，调用方跳过该来源
 *
 *   ★ 为什么第 ③ 步是 null 而不是猜一个路径：
 *     扫不存在的目录得到 0 条，与「真的没有资产」无法区分 ——
 *     用户会以为资产丢了。null 让我们能说清「未配置」。
 */
let _userCfg = null;
function userConfig() {
  if (_userCfg !== null) return _userCfg;
  try {
    /**
     * ★ 本文件是 ESM（package.json type: module），不能用 require。
     *   上面已有 fsSync / path 的 import，直接复用；
     *   os 用 process.env 里已有的 TMP/TEMP 推算，避免再引一个模块。
     */
    const tmp = process.env.TEMP || process.env.TMP || "/tmp";
    const dir = process.env.COMFY_BRIDGE_CONFIG_DIR
      || (process.env.DSH_PROFILE_DIR ? path.join(process.env.DSH_PROFILE_DIR, ".comfy-bridge") : null)
      || path.join(tmp, "dsh-comfy-bridge");
    const f = path.join(dir, "config.json");
    _userCfg = fsSync.existsSync(f) ? JSON.parse(fsSync.readFileSync(f, "utf8")) : {};
  } catch { _userCfg = {}; }
  return _userCfg;
}

export function comfyRoots() {
  const cfg = userConfig();
  return {
    output: process.env.COMFY_OUTPUT_DIR || cfg.outputDir || null,
    input: process.env.COMFY_INPUT_DIR || cfg.inputDir || null,
  };
}

/* ── 角色卡桥（2026-10-20）───────────────────────────────────────── */

/**
 * ★★ 为什么需要这个桥
 *
 *   实测（2026-10-20）：两个项目各有一套资产库，但【扫的是同一个目录】：
 *     工作台  .state/asset-library.json   697 项 output（rel = 文件名）
 *     工作站  outputs/assets.json          529 项 output（path = 完整路径）
 *   同名交集 517 项（529 的 98%）⇒ 能靠文件名对齐。
 *
 *   角色卡的标签（role:character / char:<名字> / view:<视角>）
 *   只存在工作站那一份里。工作台的 @ 搜索看不到，
 *   所以「@韩立」搜不到 —— 不是功能没有，是【数据没接过来】。
 *
 * ★ 为什么在 host 侧读而不是让前端读：
 *   前端没有文件系统访问权。而且这是「读另一个插件写的文件」，
 *   放在 host 的扫描流程里最自然（一次读、缓存、随 library 一起返回）。
 *
 * ★ 为什么只按【文件名】对齐：
 *   工作台的 rel 是相对 output 根的文件名（如 Krea2-USD-xxx.png），
 *   工作站的 path 是完整路径但含日期子目录（如 2026-10-15\...png）。
 *   两边都用 basename 就能对上。
 *   ⚠ 代价：不同日期子目录里同名文件会冲突 —— 实测 697 项里没有重名，
 *     但代码要能识别这种情况（见下面的 dup 计数）。
 */
const DEFAULT_WS_ASSETS = "D:/主工作区/outputs/assets.json";

export const CHAR_TAG = "role:character";
export const CHAR_PREFIX = "char:";
export const VIEW_PREFIX = "view:";

/**
 * 读工作站的角色卡数据，返回 { byBasename, stats }。
 *
 * @param {string} [file] assets.json 路径（可用 COMFY_WS_ASSETS 环境变量覆盖）
 * @returns {{byBasename: Record<string, {character:string, view:string|null}>, stats: object}}
 */
export function loadCharacterTags(file) {
  const f = file || process.env.COMFY_WS_ASSETS || DEFAULT_WS_ASSETS;
  const byBasename = {};
  const stats = { file: f, ok: false, total: 0, chars: 0, dup: 0, characters: [] };

  try {
    if (!fsSync.existsSync(f)) {
      return { byBasename, stats: { ...stats, reason: "工作站 assets.json 不存在（编辑器没跑过？）" } };
    }
    const j = JSON.parse(fsSync.readFileSync(f, "utf8"));
    const assets = Array.isArray(j?.assets) ? j.assets : [];
    stats.total = assets.length;

    const names = new Set();
    const charSet = new Set();
    for (const a of assets) {
      const tags = Array.isArray(a?.tags) ? a.tags : [];
      if (!tags.includes(CHAR_TAG)) continue;

      const charTag = tags.find((t) => typeof t === "string" && t.startsWith(CHAR_PREFIX));
      if (!charTag) continue;                       // 有 role:character 但没写角色名 → 跳过
      const character = charTag.slice(CHAR_PREFIX.length).trim();
      if (!character) continue;

      const viewTag = tags.find((t) => typeof t === "string" && t.startsWith(VIEW_PREFIX));
      const view = viewTag ? viewTag.slice(VIEW_PREFIX.length).trim() : null;

      const base = path.basename(String(a?.path ?? a?.name ?? ""));
      if (!base) continue;

      if (names.has(base)) stats.dup += 1;          // 同名冲突：保留第一条，计数上报
      else {
        names.add(base);
        byBasename[base] = { character, view };
        stats.chars += 1;
        charSet.add(character);
      }
    }
    stats.ok = true;
    stats.characters = [...charSet].sort();
    return { byBasename, stats };
  } catch (err) {
    return { byBasename, stats: { ...stats, reason: `读取失败：${err.message}` } };
  }
}

/* ── 状态文件：收藏 / 别名 / 隐藏 ─────────────────────────────────── */
const DEFAULT_STATE = "D:/主工作区/DSH视频工作台/.state/asset-library.json";

/**
 * ★★ 2026-10-20 新增：把角色标签写回工作站的 assets.json。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么是「跨项目写」
 *
 *   角色卡的标签（role:character / char:<名字> / view:<视角>）
 *   按设计存在工作站那一份（outputs/assets.json），因为：
 *     · characters.mjs 就在那个项目里，它读那里
 *     · 不新增数据结构（AGENTS 里记着这是刻意的设计决定）
 *
 *   但用户在【工作台】的资产库面板上看图、@ 引用。
 *   让他为了打个角色标签去手改 json，等于功能不可用。
 *   ⇒ 所以在工作台侧提供入口，写工作站的 tags。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 安全约束（写别人的文件，必须更小心）
 *
 *   ① 只改目标那一条资产的 tags，其它字段原样保留
 *   ② 写之前备份成 .bak-<时间戳>（可复原）
 *   ③ 先写 .tmp 再 rename（原子，避免写一半断电留坏文件）
 *   ④ 找不到那条资产 → 明确报错，不新建
 *   ⑤ 按 path 的 basename 匹配（与读取侧一致）
 *   ⑥ 只动 role:character / char: / view: 三种前缀的标签，
 *      用户自己加的其它标签一律保留
 *
 * @returns {{ok:boolean, reason?:string, backup?:string, tags?:string[], matched?:number}}
 */
export function setCharacterTag({ basename, character, view, on = true, file, createIfMissing = false, createPath, createKind } = {}) {
  const f = file || process.env.COMFY_WS_ASSETS || DEFAULT_WS_ASSETS;
  const name = String(basename ?? "").trim();
  if (!name) return { ok: false, reason: "缺 basename" };

  try {
    if (!fsSync.existsSync(f)) {
      return { ok: false, reason: `工作站 assets.json 不存在：${f}` };
    }
    const raw = fsSync.readFileSync(f, "utf8");
    const j = JSON.parse(raw);
    const assets = Array.isArray(j?.assets) ? j.assets : [];

    // ① 按 basename 找目标（可能有多个同名，全部更新并上报数量）
    let targets = assets.filter(
      (a) => path.basename(String(a?.path ?? a?.name ?? "")) === name
    );
    /**
     * ★★ 2026-10-20 新增：目标不存在时补登记。
     *
     *   实测踩到：工作台「＋上传」的文件落进 ComfyUI 的 input/，
     *   而工作站 assets.json 只收录它自己扫过的文件 ⇒ 刚上传的图不在里面。
     *   于是「入库时填角色名」必然失败：
     *     assets.json 里没有这个文件：wb_TestCharacter_00001__lx3s1x.png
     *
     *   ⇒ 允许补登记一条最小记录（id/path/name/kind/tags）。
     *     这是「写别人的文件」里最保守的补法：
     *       · 只补 id/path/name/kind/tags/createdAt 这几个必需字段
     *       · 不伪造 hash / sizeBytes / mtimeMs（那些要真算，不能编）
     *       · 补完之后工作站自己扫描时能识别并补全
     */
    if (!targets.length && createIfMissing && createPath) {
      const rec = {
        id: `wb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        path: String(createPath),
        name,
        kind: String(createKind ?? "image"),
        group: "素材",
        tags: [],
        source: "workbench",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      assets.push(rec);
      targets = [rec];
    }

    if (!targets.length) {
      return { ok: false, reason: `assets.json 里没有这个文件：${name}` };
    }

    // ② 逐条改 tags
    let lastTags = null;
    for (const a of targets) {
      const base = (Array.isArray(a.tags) ? a.tags : [])
        .filter((t) => typeof t === "string")
        // ★ 只剥这三种前缀，其它标签（如 fav、用户自己加的）原样保留
        .filter((t) => t !== CHAR_TAG && !t.startsWith(CHAR_PREFIX) && !t.startsWith(VIEW_PREFIX));
      const next = [...base];
      if (on) {
        next.push(CHAR_TAG);
        if (character && String(character).trim()) {
          next.push(CHAR_PREFIX + String(character).trim());
        }
        if (view && String(view).trim()) {
          next.push(VIEW_PREFIX + String(view).trim());
        }
      }
      a.tags = next;
      a.updatedAt = Date.now();
      lastTags = next;
    }

    // ③ 备份（可复原）
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = `${f}.bak-${stamp}`;
    fsSync.writeFileSync(backup, raw, "utf8");

    // ④ 原子写
    j.savedAt = Date.now();
    const tmp = `${f}.tmp`;
    fsSync.writeFileSync(tmp, JSON.stringify(j, null, 2), "utf8");
    fsSync.renameSync(tmp, f);

    return { ok: true, backup, tags: lastTags, matched: targets.length };
  } catch (err) {
    return { ok: false, reason: `写回失败：${err.message}` };
  }
}

export function createStateStore(file) {
  const stateFile = file || process.env.COMFY_ASSET_STATE || DEFAULT_STATE;
  let db = { version: 1, fav: {}, alias: {}, hidden: {}, trash: {}, role: {}, folder: {} };

  function load() {
    try {
      if (!fsSync.existsSync(stateFile)) return { ok: false, reason: "无状态文件（首次）" };
      const j = JSON.parse(fsSync.readFileSync(stateFile, "utf8"));
      if (!j || typeof j !== "object") return { ok: false, reason: "状态格式不对" };
      db = {
        version: 1,
        fav: j.fav && typeof j.fav === "object" ? j.fav : {},
        alias: j.alias && typeof j.alias === "object" ? j.alias : {},
        hidden: j.hidden && typeof j.hidden === "object" ? j.hidden : {},
        // ★ trash 记录「谁被移到了哪儿」—— 没有它，删除就不是可复原的，
        //   只是「移到一个用户找不回来的地方」。
        trash: j.trash && typeof j.trash === "object" ? j.trash : {},
        /**
         * ★★ 2026-10-20 新增：H3 参考用途标签（role）与项目文件夹（folder）。
         *
         * 主人原话：「默认保存到图片本体，毕竟只是改一个 tag，不动内容，
         *   如果这个 tag 是在 json 里面，那就把添加了 tag 的保存到资产库」
         *
         * ⇒ 这里的 role 就是那个「json 里的 tag」：
         *     按资产 id 存，不碰磁盘上的图片本体。
         *   role 的取值见 src/h3-labels.js 的 REF_ROLES（如 subject.character）。
         *
         * ⇒ folder 是「项目文件夹」：
         *     主人要求「资产库要分好项目文件夹，两个不相关的项目不要混在一起，
         *     不过支持 @ 的时候能搜到」。
         *   存的是文件夹名（字符串），空/缺失 = 未归类。
         */
        role: j.role && typeof j.role === "object" ? j.role : {},
        folder: j.folder && typeof j.folder === "object" ? j.folder : {},
      };
      return {
        ok: true,
        fav: Object.keys(db.fav).length,
        alias: Object.keys(db.alias).length,
        trash: Object.keys(db.trash).length,
        role: Object.keys(db.role).length,
        folder: Object.keys(db.folder).length,
      };
    } catch (err) {
      return { ok: false, reason: `状态文件读取失败：${err.message}` };
    }
  }

  function save() {
    try {
      const dir = path.dirname(stateFile);
      fsSync.mkdirSync(dir, { recursive: true });
      const tmp = stateFile + ".tmp";
      fsSync.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf8");
      fsSync.renameSync(tmp, stateFile);
      return true;
    } catch {
      return false;
    }
  }

  return {
    stateFile,
    load,
    get raw() { return db; },
    setFav(id, on) {
      if (on) db.fav[id] = true; else delete db.fav[id];
      return save();
    },
    setAlias(id, name) {
      const v = String(name ?? "").trim();
      if (v) db.alias[id] = v.slice(0, 200); else delete db.alias[id];
      return save();
    },
    /**
     * ★ 2026-10-21 补：getAlias 一直不存在，而 getRole / getFolder 都有。
     *
     *   为什么现在必须要它：
     *     写图片本体时要带上「当前的名字 + 用途」，否则每改一次 role
     *     就会把本体里的 alias 抹掉（因为 writeTextTags 是覆盖式写入）。
     *   ⇒ 三个 getter 必须齐全，读写对称。
     */
    getAlias(id) { return db.alias[id] ?? null; },
    setHidden(id, on) {
      if (on) db.hidden[id] = true; else delete db.hidden[id];
      return save();
    },
    /**
     * ★★ 2026-10-20 新增：H3 参考用途标签。
     *
     * 主人：「默认保存到图片本体，毕竟只是改一个 tag，不动内容，
     *   如果这个 tag 是在 json 里面，那就把添加了 tag 的保存到资产库」
     *
     * ⇒ 存进本状态文件（asset-library.json），不动磁盘上的图片。
     *   roleId 为空 = 清掉标签，回到「按 kind 猜默认」。
     *
     * ⚠ 不做白名单校验：合法值由 src/h3-labels.js 的 REF_ROLES 决定，
     *   而那份表在前端包（client.js）里。host 侧复制一份会在两处漂移。
     *   ⇒ 这里只做长度与字符校验，语义正确性由前端保证（前端有验收脚本）。
     */
    setRole(id, roleId) {
      const v = String(roleId ?? "").trim();
      if (!v) { delete db.role[id]; return save(); }
      if (v.length > 64 || !/^[a-z]+(\.[a-z]+)?$/i.test(v)) {
        return { ok: false, reason: `role 格式不合法：${v.slice(0, 40)}` };
      }
      db.role[id] = v;
      return save();
    },
    getRole(id) { return db.role[id] ?? null; },
    /**
     * ★★ 2026-10-20 新增：项目文件夹。
     * 主人：「资产库要分好项目文件夹，两个不相关的项目不要混在一起，
     *   不过支持 @ 的时候能搜到」
     * ⇒ 空字符串 = 移出文件夹（回到「未归类」）。
     */
    setFolder(id, folder) {
      const v = String(folder ?? "").trim();
      if (!v) { delete db.folder[id]; return save(); }
      if (v.length > 80) return { ok: false, reason: "文件夹名太长（上限 80）" };
      db.folder[id] = v;
      return save();
    },
    getFolder(id) { return db.folder[id] ?? null; },
      /**
       * 列出所有出现过的文件夹名（按名字排序，去重）。
       *
       * ★ 2026-10-21 修：db.folder 会留下【已删资产】的条目，
       *   实测 8 条里 7 条指向不存在的文件 ⇒ 候选列表里全是幽灵文件夹。
       *   ⇒ 过滤空值；另加 pruneFolderOrphans 供启动时清理。
       */
      listFolders() {
        return [...new Set(Object.values(db.folder).filter(Boolean))].sort();
      },

      /** 清掉指向已不存在资产的 folder 条目。返回清了几条。 */
      pruneFolderOrphans(aliveIds) {
        const alive = new Set(aliveIds ?? []);
        let n = 0;
        for (const id of Object.keys(db.folder)) {
          if (!alive.has(id)) { delete db.folder[id]; n++; }
        }
        if (n) save();
        return n;
      },
    /** 记下一条「移到哪儿了」，供撤销用。 */
    setTrash(id, entry) {
      if (entry) db.trash[id] = entry; else delete db.trash[id];
      return save();
    },
    getTrash(id) { return db.trash[id] ?? null; },
    listTrash() {
      return Object.entries(db.trash).map(([id, v]) => ({ id, ...v }));
    },
    /** 撤销：把文件搬回原处，并清掉 hidden / trash 两条记录。 */
    undoTrash(id) {
      const t = db.trash[id];
      if (!t) return { ok: false, reason: "没有这条回收记录" };
      try {
        fsSync.mkdirSync(path.dirname(t.from), { recursive: true });
        fsSync.renameSync(t.to, t.from);
      } catch (err) {
        return { ok: false, reason: `搬回失败：${err.message}` };
      }
      delete db.trash[id];
      delete db.hidden[id];
      save();
      return { ok: true, restored: t.from };
    },
  };
}

/* ── 扫一个 ComfyUI 根目录（output / input）────────────────────────── */
/**
 * ★ 深度只到 2：实测 output/ 下面有 `2026-10-15` `video` `h3station`
 *   `▶单图简单转换_ImageToolkit` 这一层，再深就没有了。
 *   不做无限递归 —— 万一有人把大目录挂进去，一次 GET 会把宿主卡住。
 */
export async function scanMediaRoot(root, src, { maxDepth = 2, maxFiles = 4000 } = {}) {
  const out = [];
  let truncated = false;

  async function walk(dir, rel, depth) {
    if (out.length >= maxFiles) { truncated = true; return; }
    let ents;
    try {
      ents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // 目录不存在 / 无权限 —— 这一层空着，不抛
    }
    for (const ent of ents) {
      if (out.length >= maxFiles) { truncated = true; return; }
      const name = ent.name;
      if (name.startsWith(".")) continue;
      const full = path.join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      if (ent.isDirectory()) {
        if (depth < maxDepth) await walk(full, relPath, depth + 1);
        continue;
      }
      if (!ent.isFile()) continue;
      const kind = kindOf(name);
      if (!MEDIA_KINDS.has(kind)) continue; // 素材槽只吃媒体；txt/md 不进库
      let st;
      try { st = await fs.stat(full); } catch { continue; }
      out.push({
        id: `${src}:${relPath}`,
        src,
        rel: relPath,
        // ComfyUI 的 /api/view 要 filename + subfolder 两个字段分开给
        dir: rel ? rel : "",
        name,
        absPath: full,
        kind,
        sizeBytes: st.size,
        mtime: st.mtimeMs,
      });
    }
  }

  await walk(root, "", 0);
  return { items: out, truncated, root };
}

/* ── 合并三源 + 应用状态 + 排序 ────────────────────────────────────── */
/**
 * 排序规则（主人要「收藏的排前面，方便 @ 引用」）：
 *   ① 收藏优先
 *   ② 再按修改时间倒序（新产物在最上面）
 *   ③ editor 素材没有可靠 mtime（索引里不存）→ 用 0，自然沉到后面，
 *      但它一旦被收藏就会顶上来。
 */
export function mergeLibrary({ products, uploads, editor, state, charTags }) {
  const all = [];
  // ★ 2026-10-20：角色卡桥的数据（loadCharacterTags 的返回值）
  const charByBase = charTags?.byBasename ?? {};
  const push = (it) => {
    const id = it.id;
    if (state.raw.hidden[id]) return;
    /**
     * ★★ 2026-10-21：json 里没有时，从图片本体读回。
     *
     *   主人原话：「tag 跟着资产走」。
     *   写了本体却不读，等于没做到 —— 把 PNG 拷到另一台机器、
     *   或换一个 profile，json 里没有记录，tag 就丢了。
     *
     *   优先级：json > 本体
     *     json 是界面写入的权威（用户刚改的立刻生效），
     *     本体是备份（换机器 / 新 profile / 从别处拷来时才有值）。
     *
     *   性能：只在【缺字段】时才读文件，且只扫 header
     *        （元数据一定在 IDAT 之前，实测 6.83MB 的 PNG 约 1ms）。
     */
    const fromImage = (() => {
      const needAlias = !state.raw.alias[id];
      const needRole = !state.raw.role?.[id];
      const needFolder = !state.raw.folder?.[id];
      if (!needAlias && !needRole && !needFolder) return null;
      const roots = comfyRoots();
      const abs = it.absPath || (roots[it.src] ? path.join(roots[it.src], it.rel ?? "") : "");
      if (!abs || !/\.png$/i.test(abs)) return null;
      try {
        if (!fsSync.existsSync(abs)) return null;
        const tags = readTextTagsSync(abs);
        if (!tags) return null;
        return {
          alias: tags.workbench_alias || null,
          role: tags.workbench_role || null,
          folder: tags.workbench_folder || null,
        };
      } catch { return null; }
    })();
    const alias = state.raw.alias[id] || fromImage?.alias || undefined;
    /**
     * ★ 角色卡桥：按 basename 找对应的工作站角色标签。
     *   命中时给 character / charView，前端就能「@韩立」搜到这张图。
     */
    const base = (() => {
      const n = String(it.name ?? "");
      return n;
    })();
    const ch = charByBase[base] ?? null;
    all.push({
      ...it,
      displayName: alias || it.name,
      fav: state.raw.fav[id] === true,
      renamed: !!alias,
      /**
       * ★★ 2026-10-20：H3 参考用途标签与项目文件夹。
       *
       * 没设时给 null（不是 undefined）——
       * 理由同 §6.38 那条：JSON.stringify({role: undefined}) 会让字段整个消失，
       * 前端读到的是「字段不存在」而不是「没设」，兜底分支会写错。
       */
      role: state.raw.role?.[id] ?? fromImage?.role ?? null,
      folder: state.raw.folder?.[id] ?? fromImage?.folder ?? null,
      /**
       * ★★ 2026-10-20：来自工作站的角色卡标签（跨项目桥）。
       *   null = 这张图没被标成角色定妆图。
       *   ⚠ 与 role 是两回事：
       *     role      H3 参考用途（我这一轮做的，存本项目的 state）
       *     character 角色归属（工作站已有，按文件名桥过来）
       */
      character: ch ? ch.character : null,
      charView: ch ? ch.view : null,
      // editor 的绝对路径给前端做 /timeline/file 用；output/input 不给
      // 绝对路径（前端不需要，也不该知道宿主盘符）
      absPath: it.src === "editor" ? it.absPath : undefined,
    });
  };

  for (const it of products ?? []) push(it);
  for (const it of uploads ?? []) push(it);

  for (const a of editor ?? []) {
    const abs = String(a?.path ?? "");
    if (!abs) continue;
    const kind = a.kind && a.kind !== "other" ? a.kind : kindOf(abs);
    if (!MEDIA_KINDS.has(kind)) continue;
    push({
      id: `editor:${abs}`,
      src: "editor",
      rel: abs,
      dir: "",
      name: a.name || path.basename(abs),
      absPath: abs,
      kind,
      sizeBytes: Math.round(Number(a.sizeMB ?? 0) * 1024 * 1024),
      mtime: 0,
    });
  }

  all.sort((a, b) => {
    if (a.fav !== b.fav) return a.fav ? -1 : 1;
    return (b.mtime ?? 0) - (a.mtime ?? 0);
  });
  return all;
}

export function statsOf(items) {
  const byKind = {};
  let fav = 0;
  for (const it of items) {
    byKind[it.kind] = (byKind[it.kind] ?? 0) + 1;
    if (it.fav) fav++;
  }
  const bySrc = {};
  for (const it of items) bySrc[it.src] = (bySrc[it.src] ?? 0) + 1;
  return { total: items.length, byKind, bySrc, fav };
}

/**
 * 过滤。
 * ★ kind/q 都在 host 侧做 —— 前端只把结果拉一次拉走，
 *   不然 @ 浮层每敲一个字都要打一次网络。
 */
export function filterItems(items, { kind, q, src, favOnly } = {}) {
  let out = items;
  if (kind && kind !== "all") out = out.filter((it) => it.kind === kind);
  if (src && src !== "all") out = out.filter((it) => it.src === src);
  if (favOnly) out = out.filter((it) => it.fav);
  const s = String(q ?? "").trim().toLowerCase();
  if (s) {
    out = out.filter((it) =>
      String(it.displayName).toLowerCase().includes(s) ||
      String(it.name).toLowerCase().includes(s) ||
      String(it.rel).toLowerCase().includes(s) ||
      /**
       * ★★ 2026-10-20：角色名也参与搜索。
       *   主人要的是「@韩立 引用这个角色」——
       *   角色卡的标签在工作站那边（role:character / char:韩立），
       *   这里桥过来的 character 字段就是那个名字。
       *   不参与搜索的话，「@韩立」只能搜到文件名里带「韩立」的图。
       */
      String(it.character ?? "").toLowerCase().includes(s)
    );
  }
  return out;
}

/* ── 可复原删除：移到 trash/，不 unlink ───────────────────────────── */
export async function moveToTrash(stateFile, absPath) {
  const base = path.dirname(stateFile || DEFAULT_STATE);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const trashDir = path.join(base, "trash", stamp);
  await fs.mkdir(trashDir, { recursive: true });
  const dest = path.join(trashDir, path.basename(absPath));
  await fs.rename(absPath, dest);
  return dest;
}
