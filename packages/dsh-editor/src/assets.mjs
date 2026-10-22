
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const ASSET_KINDS = ["image", "video", "audio", "text", "other"];

/**
 * ★★ 2026-10-19 新增：资产库【根目录 + 分类子目录】。
 *
 * 主人原话：
 *   「资产库需要在一个可以指定的目录位置。这个目录做好分类，
 *     其他地方的不要弄进去」
 *
 * 设计：
 *   <root>/
 *     ├─ 图片/     → kind=image
 *     ├─ 视频/     → kind=video
 *     ├─ 音频/     → kind=audio
 *     ├─ 文本/     → kind=text
 *     └─ 其他/     → kind=other
 *
 *   scanRoot() 只扫这五个分类子目录（也接受根目录下的散落文件，
 *   按扩展名自动归类）。任何【别处】的目录都不能通过它进入 ——
 *   要收别处的文件，必须由用户显式 move/copy 进来。
 *
 * ★ 为什么分类用中文目录名而不是 image/video：
 *   主人要在文件资源管理器里直接看懂。中文名对程序无影响
 *   （都走 path.join，不参与 URL 或正则）。
 *
 * ★ 为什么同时接受「根目录散落文件」：
 *   直接扔进根目录比先建子目录再扔更符合直觉；
 *   扩展名判定是可靠的（kindOf 已经做了白名单）。
 */
export const CATEGORY_DIRS = {
  image: "图片",
  video: "视频",
  audio: "音频",
  text: "文本",
  other: "其他",
};

export function kindOf(filename) {
  const e = path.extname(String(filename ?? "")).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"].includes(e)) return "image";
  if ([".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v"].includes(e)) return "video";
  if ([".m4a", ".mp3", ".wav", ".aac", ".flac", ".ogg", ".opus"].includes(e)) return "audio";
  if ([".txt", ".md", ".json", ".srt", ".csv", ".yaml", ".yml"].includes(e)) return "text";
  return "other";
}

export function fileHash(file, maxBytes = 8 * 1024 * 1024) {
  try {
    const st = fs.statSync(file);
    const size = st.size;
    if (size <= maxBytes) {
      return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 16);
    }
    const fd = fs.openSync(file, "r");
    const head = Buffer.alloc(1024 * 1024);
    fs.readSync(fd, head, 0, head.length, 0);
    const tail = Buffer.alloc(1024 * 1024);
    fs.readSync(fd, tail, 0, tail.length, Math.max(0, size - tail.length));
    fs.closeSync(fd);
    return crypto.createHash("sha256").update(head).update(tail).update(String(size)).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

/**
 * 建一个素材库。
 * @param {object} opts
 * @param {string} opts.indexFile  索引文件路径
 * @param {object} [opts.log]
 */
export function createAssetLibrary({ indexFile, log = console }) {
/** /** @type {{version:number, assets:object[], savedAt:number}} */
  let db = { version: 1, assets: [], savedAt: null };
  let seq = 0;
  const uid = () => `a_${Date.now().toString(36)}_${(seq += 1)}`;

  function load() {
    if (!fs.existsSync(indexFile)) return { ok: false, reason: "没有索引文件" };
    try {
      const j = JSON.parse(fs.readFileSync(indexFile, "utf8"));
      if (!j || !Array.isArray(j.assets)) return { ok: false, reason: "索引格式不对" };
      db = j;
      return { ok: true, count: db.assets.length };
    } catch (err) {
      log.warn?.(`[assets] 索引损坏：${err.message}`);
      return { ok: false, reason: "索引损坏" };
    }
  }

  function save() {
    try {
      const dir = path.dirname(indexFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = indexFile + ".tmp";
      db.savedAt = Date.now();
      fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf8");
      fs.renameSync(tmp, indexFile);
      return true;
    } catch (err) {
      log.warn?.(`[assets] 写索引失败：${err.message}`);
      return false;
    }
  }

/**
 * /**
 * 登记一个素材（不复制文件，只建引用）。
 * @param {object} spec
 * @param {string} spec.path        文件路径（绝对或相对项目根）
 * @param {string} [spec.name]      显示名
 * @param {string[]} [spec.tags]    标签
 * @param {string} [spec.group]     分组（如「角色」「场景」「配音」）
 * @param {string} [spec.source]    来源（'gen' 生成 / 'upload' 上传 / 'import' 导入）
 * @param {object} [spec.meta]      额外信息（尺寸、时长、生成参数）
 */
  function add(spec) {
    const p = String(spec.path ?? "").trim();
    if (!p) throw new Error("素材必须有 path");
    if (!fs.existsSync(p)) throw new Error(`文件不存在：${p}`);

    const st = fs.statSync(p);
    if (!st.isFile()) throw new Error(`不是文件：${p}`);

    const hash = fileHash(p);
    const exist = db.assets.find((a) => a.path === p);
    if (exist) {
      Object.assign(exist, {
        name: spec.name ?? exist.name,
        tags: spec.tags ?? exist.tags,
        group: spec.group ?? exist.group,
        meta: { ...exist.meta, ...(spec.meta ?? {}) },
        sizeBytes: st.size,
        mtimeMs: st.mtimeMs,
        hash,
        updatedAt: Date.now(),
      });
      save();
      return exist;
    }

    const asset = {
      id: uid(),
      path: p,
      name: spec.name ?? path.basename(p),
      kind: kindOf(p),
      group: spec.group ?? null,
      tags: Array.isArray(spec.tags) ? [...spec.tags] : [],
      source: spec.source ?? "import",
      sizeBytes: st.size,
      mtimeMs: st.mtimeMs,
      hash,
      meta: spec.meta ?? {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    db.assets.push(asset);
    save();
    return asset;
  }

  function scanDir(dir, opts = {}) {
    if (!fs.existsSync(dir)) throw new Error(`目录不存在：${dir}`);
    const exts = opts.exts ?? null;
    const recursive = opts.recursive !== false;
    const out = [];
    const walk = (d) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, ent.name);
        if (ent.isDirectory()) {
          if (recursive && !ent.name.startsWith(".")) walk(full);
        } else if (ent.isFile()) {
          if (exts && !exts.includes(path.extname(ent.name).toLowerCase())) continue;
          try {
            out.push(add({ path: full, group: opts.group ?? null, source: opts.source ?? "import" }));
          } catch (err) {
            log.warn?.(`[assets] 跳过 ${ent.name}：${err.message}`);
          }
        }
      }
    };
    walk(dir);
    return out;
  }

  /**
   * 扫【资产库根目录】—— 唯一推荐的入库方式。
   *
   * 与 scanDir 的区别（这是主人 2026-10-19 明确要求的边界）：
   *   · scanDir(任意目录)  → 任何路径都能进库，会导致库里混进别处的文件
   *   · scanRoot()        → 只认 <root>/<分类子目录>/ 与 <root>/ 下的散落文件
   *
   * 返回 { added, byKind, skipped, root }，added 是本次新增的素材数组。
   * 已存在（path 相同）的不重复登记 —— add() 内部按 path 去重。
   */
  function scanRoot(root, opts = {}) {
    if (!root) throw new Error("scanRoot 需要根目录");
    if (!fs.existsSync(root)) {
      // ★ 不自动建目录：主人可能拼错了路径，静默建一个空目录会让人以为「扫过了」
      throw new Error(`资产库根目录不存在：${root}`);
    }
    const added = [];
    const skipped = [];
    // ★★ 2026-10-19 修（verify-asset-root.mjs 第 ⑥ 组抓到）：
    //   add() 遇到已存在的 path 会走「更新」分支并【返回已有记录】，
    //   它自己分不清「新增」与「更新」。
    //   原来的 scanRoot 把返回值全塞进 added ⇒ 第二次扫描报「新增 5 个」，
    //   而库里总数仍是 5 —— 调用方会误以为一直在新增。
    //   ⇒ 用 before/after 的库长度差来判定真实新增数。
    const countBefore = () => db.assets.length;

    const collect = (dir, forcedKind, group) => {
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); }
      catch (err) { skipped.push({ dir, reason: err.message }); return; }
      for (const ent of ents) {
        if (ent.name.startsWith(".")) continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          // 分类子目录内部允许再分层（比如 图片/角色/xxx.png）
          // 递归，但仍受 forcedKind 约束
          collect(full, forcedKind, group);
          continue;
        }
        if (!ent.isFile()) continue;
        const k = forcedKind ?? kindOf(ent.name);
        const before = countBefore();
        try {
          const a = add({ path: full, group: group ?? CATEGORY_DIRS[k] ?? null, source: "import" });
          if (countBefore() > before) added.push(a);   // 只有库变长了才算新增
        } catch (err) {
          skipped.push({ file: full, reason: err.message });
        }
      }
    };

    // ① 先扫五个分类子目录（存在才扫）
    for (const [kind, dirName] of Object.entries(CATEGORY_DIRS)) {
      const sub = path.join(root, dirName);
      if (fs.existsSync(sub) && fs.statSync(sub).isDirectory()) {
        collect(sub, kind, dirName);
      }
    }

    // ② 再扫根目录下的【散落文件】（不递归 —— 子目录已经在 ① 处理过）
    let rootEnts = [];
    try { rootEnts = fs.readdirSync(root, { withFileTypes: true }); }
    catch (err) { skipped.push({ dir: root, reason: err.message }); }
    for (const ent of rootEnts) {
      if (!ent.isFile() || ent.name.startsWith(".")) continue;
      const before = countBefore();
      try {
        const a = add({ path: path.join(root, ent.name), group: null, source: "import" });
        if (countBefore() > before) added.push(a);
      } catch (err) {
        skipped.push({ file: ent.name, reason: err.message });
      }
    }

    // byKind 只统计【本次新增】，与 added 对齐
    const byKind = { image: 0, video: 0, audio: 0, text: 0, other: 0 };
    for (const a of added) byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;
    return { added, byKind, skipped, root };
  }

  function list({ kind = null, group = null, tag = null, q = null, limit = 500 } = {}) {
    let out = db.assets;
    if (kind) out = out.filter((a) => a.kind === kind);
    if (group) out = out.filter((a) => a.group === group);
    if (tag) out = out.filter((a) => (a.tags ?? []).includes(tag));
    if (q) {
      const s = String(q).toLowerCase();
      out = out.filter((a) =>
        String(a.name).toLowerCase().includes(s) ||
        String(a.path).toLowerCase().includes(s) ||
        (a.tags ?? []).some((t) => t.toLowerCase().includes(s))
      );
    }
    return out.slice(0, limit);
  }

  function get(id) {
    return db.assets.find((a) => a.id === id) ?? null;
  }

  function update(id, patch) {
    const a = get(id);
    if (!a) throw new Error(`素材不存在：${id}`);
    const allowed = ["name", "group", "tags", "meta"];
    for (const [k, v] of Object.entries(patch)) {
      if (!allowed.includes(k)) throw new Error(`不支持改 ${k}（可用 ${allowed.join("/")}）`);
      a[k] = v;
    }
    a.updatedAt = Date.now();
    save();
    return a;
  }

/**
 * /**
 * 移除素材。
 * ★ 默认只删索引，不删文件（防误删）。
 */
  function remove(id, { deleteFile = false } = {}) {
    const i = db.assets.findIndex((a) => a.id === id);
    if (i < 0) return false;
    const a = db.assets[i];
    db.assets.splice(i, 1);
    if (deleteFile && fs.existsSync(a.path)) {
      try { fs.unlinkSync(a.path); } catch (err) { log.warn?.(`[assets] 删文件失败：${err.message}`); }
    }
    save();
    return true;
  }

  function findMissing() {
    return db.assets.filter((a) => !fs.existsSync(a.path));
  }

  function stats() {
    const byKind = {};
    let totalBytes = 0;
    for (const a of db.assets) {
      byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;
      totalBytes += a.sizeBytes ?? 0;
    }
    const groups = [...new Set(db.assets.map((a) => a.group).filter(Boolean))];
    const tags = [...new Set(db.assets.flatMap((a) => a.tags ?? []))];
    return {
      total: db.assets.length,
      byKind,
      groups,
      tags,
      totalBytes,
      totalMB: Math.round((totalBytes / 1024 / 1024) * 10) / 10,
      missing: findMissing().length,
    };
  }

/**
 * /**
 * ★ 按内容去重 —— 同一张图被登记多次时找出来。
 * 用 hash 判断（不是文件名）。
 */
  function findDuplicates() {
    const byHash = new Map();
    for (const a of db.assets) {
      if (!a.hash) continue;
      if (!byHash.has(a.hash)) byHash.set(a.hash, []);
      byHash.get(a.hash).push(a);
    }
    return [...byHash.entries()]
      .filter(([, arr]) => arr.length > 1)
      .map(([hash, arr]) => ({ hash, assets: arr.map((x) => ({ id: x.id, name: x.name, path: x.path })) }));
  }

  function clear() {
    db = { version: 1, assets: [], savedAt: null };
    save();
  }

  return {
    indexFile,
    load, save,
    add, scanDir, scanRoot, list, get, update, remove,
    findMissing, findDuplicates, stats, clear,
    get raw() { return db; },
  };
}
