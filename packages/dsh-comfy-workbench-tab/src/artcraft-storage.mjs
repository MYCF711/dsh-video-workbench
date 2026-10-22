/**
 * ArtCraft 的 projectStorage 后端（2026-10-20）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 这个模块解决什么
 *
 *   ArtCraft 要一个 ProjectStorageAdapter：
 *     loadProject(id)        → EditorProject | null
 *     saveProject(project)   → void
 *     deleteProject(id)      → void
 *     listProjects()         → ProjectMeta[]
 *     createProject(name)    → EditorProject
 *
 *   它的 EditorProject 是 { id, name, updatedAt, data: unknown }，
 *   `data` 里装它自己的 TProject。
 *
 *   ★★ 但我们的真相是 timeline-state.json，里面还有 shot / handoff ——
 *      那是 ArtCraft 模型里【不存在】的东西（见 timeline-projection.mjs
 *      顶部那段说明）。所以 saveProject 绝不能直接覆盖存档，
 *      必须走 fromArtCraft() 合并：只取 trim 与顺序，其余字段原样保留。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么是「单工程」
 *
 *   我们的模型没有「多个工程」的概念 —— 只有一份 timeline-state.json。
 *   ⇒ listProjects 永远返回 1 条；createProject 是「重置这份存档」；
 *     deleteProject 是「清空 clips」而不是删文件（删文件不可复原）。
 *
 *   ★ 这不是偷懒，是契约诚实：
 *     假装支持多工程（比如拿 clips 的某个字段当工程 id）会让用户以为
 *     切换工程能保住另一份数据 —— 实际上会互相覆盖。
 *     宁可只报 1 个工程，让 ArtCraft 的工程列表就显示一个。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 接线方式（前端 UI 之后照这个做）
 *
 *   const storage = createProjectStorage({ store, persister, log });
 *   // 传给 ArtCraft：<VideoEditor adapters={{ ...defaults, projectStorage: storage }} />
 */

import { toArtCraft, fromArtCraft } from "./timeline-projection.mjs";

/** 我们只有一个工程，固定 id。 */
export const SINGLE_PROJECT_ID = "wb_timeline";

/**
 * @param {object} deps
 * @param {object} deps.store       host-store（要有 snapshot()）
 * @param {object} deps.persister   createPersister 的返回值（要有 load/flush）
 * @param {object} [deps.log]
 * @param {(state:object)=>void} [deps.replaceState]
 *        把合并后的 state 写回 store 的函数。没提供时退化为「只改内存里的
 *        snapshot 副本」→ saveProject 会返回 not-supported 警告。
 */
export function createProjectStorage({ store, persister, log = console, replaceState } = {}) {
  if (!store || typeof store.snapshot !== "function") {
    throw new Error("createProjectStorage 需要 store.snapshot()");
  }

  /** 取当前真相（内存态）。 */
  function currentState() {
    return store.snapshot();
  }

  /**
   * 转换成 ArtCraft 的 EditorProject。
   * `data` 放投影后的 TProject；我们自己的字段不进 data（ArtCraft 不需要）。
   */
  function stateToEditorProject(state) {
    const tproj = toArtCraft(state, { projectId: SINGLE_PROJECT_ID });
    return {
      id: SINGLE_PROJECT_ID,
      name: String(state?.name ?? "未命名"),
      updatedAt: Number(state?.savedAt) || Date.now(),
      data: tproj,
    };
  }

  return {
    /** ArtCraft 打开工程时调。 */
    async loadProject(id) {
      if (id != null && id !== SINGLE_PROJECT_ID) return null;

      /**
       * ★ 用 persister.load() 还是 store.snapshot()？
       *   load() 会【再从磁盘读一遍并覆盖内存】—— 那是启动流程做的事。
       *   ArtCraft 只是来取工程，不该触发重载（会把用户刚改的东西冲掉）。
       *   ⇒ 用内存里的 snapshot()，它才是当前真相。
       */
      const state = currentState();
      return stateToEditorProject(state);
    },

    /**
     * ArtCraft 保存工程时调。
     *
     * ★★ 这是全模块最危险的一处：
     *   它拿到的是【ArtCraft 改完的 TProject】。如果直接把它当新真相写盘，
     *   我们的 shot / handoff / rendered / regenError 会全部消失，
     *   而且不会报错 —— 下次打开时间轴，每一镜的「生成配方」和
     *   「谁锁了 prompt」都没了。
     *
     *   ⇒ 必须走 fromArtCraft()：只取 trim 与顺序，其余字段原样返回。
     */
    async saveProject(project) {
      if (!project || project.id !== SINGLE_PROJECT_ID) {
        log.warn?.("[artcraft-storage] 忽略非本工程的保存：" + String(project?.id));
        return;
      }
      const data = project.data;
      if (!data || !Array.isArray(data.scenes)) {
        log.warn?.("[artcraft-storage] project.data 不是合法的 TProject，跳过保存");
        return;
      }

      const state = currentState();
      const { next, changed } = fromArtCraft(state, data);

      if (!changed.length) {
        // 没有实质改动 ⇒ 不写盘，避免无谓的 IO 与 mtime 变化
        return;
      }

      if (typeof replaceState !== "function") {
        /**
         * ★ 没有 replaceState 时的诚实行为：
         *   不要偷偷只改内存里的副本（那会让 UI 看起来保存成功、
         *   实际重启就丢）。明确 warn，让接线方知道少了这一环。
         */
        log.warn?.(
          "[artcraft-storage] saveProject 需要 replaceState 才能把改动写回 store；" +
          "本次改动未生效。changed=" + changed.join(",")
        );
        return;
      }

      replaceState(next);
      // 立刻落盘，不等 debounce —— ArtCraft 的「保存」是显式动作，用户期望即时
      try { persister?.flush?.(); } catch (e) {
        log.warn?.("[artcraft-storage] flush 失败：", e?.message ?? e);
      }
      log.info?.("[artcraft-storage] 已保存：" + changed.join(", "));
    },

    /**
     * ArtCraft 删除工程。
     *
     * ★ 不删文件。我们的存档是不可复原的资产（含每一镜的生成配方），
     *   删掉就没了。⇒ 只清空 clips，轨道结构保留。
     *   这符合两条底线第一条：「不可复原的操作先转成可复原形式」。
     */
    async deleteProject(id) {
      if (id !== SINGLE_PROJECT_ID) return;
      if (typeof replaceState !== "function") {
        log.warn?.("[artcraft-storage] deleteProject 需要 replaceState");
        return;
      }
      const state = currentState();
      const next = JSON.parse(JSON.stringify(state));
      for (const tr of next.tracks ?? []) tr.clips = [];
      next.savedAt = Date.now();
      replaceState(next);
      try { persister?.flush?.(); } catch { /* ignore */ }
      log.info?.("[artcraft-storage] 已清空 clips（存档文件保留，可手动恢复）");
    },

    /** 只报一个工程 —— 见文件头「为什么是单工程」。 */
    async listProjects() {
      const state = currentState();
      const clips = (state?.tracks ?? []).reduce((n, tr) => n + (tr.clips?.length ?? 0), 0);
      return [{
        id: SINGLE_PROJECT_ID,
        name: String(state?.name ?? "未命名"),
        updatedAt: Number(state?.savedAt) || Date.now(),
        // 没有缩略图 —— 我们的存档里没有这个概念
        thumbnailUrl: undefined,
        clipCount: clips,
      }];
    },

    /**
     * ArtCraft 新建工程。
     *
     * ★ 语义是「重置当前这份存档」，不是「再开一份」。
     *   返回的对象要带一个空 TProject，ArtCraft 才能直接进去编辑。
     */
    async createProject(name) {
      const blank = {
        version: 1,
        savedAt: Date.now(),
        fps: Number(currentState()?.fps) || 24,
        name: String(name ?? "未命名"),
        nextShotIndex: 1,
        tracks: [
          { id: "t_video_1", kind: "video", name: "视频 1", clips: [] },
          { id: "t_audio_1", kind: "audio", name: "音频 1", clips: [] },
        ],
      };
      if (typeof replaceState === "function") {
        replaceState(blank);
        try { persister?.flush?.(); } catch { /* ignore */ }
      } else {
        log.warn?.("[artcraft-storage] createProject 需要 replaceState，仅返回空工程未落盘");
      }
      return stateToEditorProject(blank);
    },
  };
}
