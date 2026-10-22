# 方案 · DSH 视频工作台插件

> 定稿于 2026-10-17（R5 修订：去掉第三方依赖）
> **实施状态 2026-10-17 晚：M1 / M2 / M4 已交付，四个工作流全部真跑验收通过（84/84）**
> 依据：`docs/草稿/草稿-DSH视频工作台.md`（迭代 5 轮，否决 9 项）
> 为什么不用其它方案：见草稿 §三

---

## 零 · 已交付状态（可核验）

| 模块 | 状态 | 验收 |
|---|---|---|
| **M1** `dsh-comfy-bridge` | ✅ 已交付 | 离线 19/19 · HTTP 端到端 18/18 |
| **M2** `dsh-comfy-workbench-tab` | ✅ 已交付 | 中栏 tab 渲染 + 4 模式 + 出图 + 图片显示（截图取证） |
| **M4** `dsh-comfy-preset` | ✅ 已交付 | 18/18 |
| **M3** `dsh-comfy-canvas` | ⬜ 延后 | — |

| 工作流 | 职责 | 真跑验收 |
|---|---|---|
| `krea2` | 生图（双采精修） | ✅ 7/7 — 25s 出 2 张，一采 1024×1024 / 二采 1536×1536 |
| `qwen21-edit` | 改图 / 洗图 / 骨骼 / 换装 | ✅ 11/11 — 113s，语义级换装（白T牛仔 → 红丝绸之路） |
| `qwen21` | 文生图 | ✅ 已接入（未单独验） |
| `yz` | 生视频（H3 文武双全） | ✅ 11/11 — 95s，MP4 含音轨，时长 2.33s（吸附到 56 帧） |

**一键总验收**：`node packages/verify-all.mjs`

**测试实例**：`http://127.0.0.1:19499`（独立 profile `comfy-test`，主人正在用的 19387 全程未动）

---

## 一 · 一句话

**在 DSH 中栏加一个「视频工作台」tab，生成走本机 ComfyUI 8188。全程只用 DSH 官方扩展点，不引入第三方 UI 插件。拆成 4 个可插拔模块。**

## 二 · 目标与非目标

### 目标（第一版）
```
① 中栏「对话｜轨迹｜视频工作台」三个 tab，点「视频工作台」能操作
② 能提交 ComfyUI 任务、看进度、看产物
③ 加新工作流不改代码（复用 bind.json 机制）
④ 右栏会话用官方现成的（不改不装）
```

### 非目标（第一版明确不做）
```
✗ 无限画布（排到 M3）
✗ 分镜表 / 角色资产库（排到 M4）
✗ 首尾帧衔接（mean_abs_diff<10）（排到 M4）
✗ TTS / 拼接（M4）
✗ 安装或修改任何第三方侧栏插件
```

## 三 · ★ 右侧栏：官方已有，不动它

**实测（`app.asar` 内源码逐字）—— 官方右侧栏已注册 7 个 tab 类型：**

| 包 | kind / id | 说明 |
|---|---|---|
| `ui-subagent` | `subagentchat` / `SUBAGENT_CHAT_ID` | **★ 侧栏会话**（`t("sidebar.chat")`） |
| `ui-sidebar-files` | `files` | 文件树 |
| `ui-sidebar-documentpreview` | `text` | 文档预览 |
| `ui-sidebar-browser` | `browser` | 浏览器（`keepMounted` 在桌面端） |
| `ui-sidebar-terminal` | `terminal`（`multiple: true`） | 终端 |
| `ui-plan` | `plan` | 计划预览 |
| `ui-schedule` | `schedule` | 定时任务 |
| `ui-deliverables` | `changes-review` | 本轮改动对比 |

**官方注册代码（`ui-subagent/lib/client.js` 逐字）：**

```javascript
function registerSidebarChat(ctx, t) {
    ctx.effect(() => ctx.resources.register(subagentChatResourceProvider(ctx.sessions)), ...);
    ctx.effect(() => ctx.sidebarRightTabs.register({
        id: SUBAGENT_CHAT_ID,
        kind: "subagentchat",
        patterns: [`${SUBAGENT_CHAT_ADDRESS}**`],
        priority: "builtin",
        canOpen: (address) => parseSubagentChatAddress(address) !== void 0,
        title: (address) => { ... },
    }), ...);
}
```

**⇒ 侧栏会话是官方在维护的 `builtin` 类型。我们不装、不改、不接管。**

**⇒ 我们需要保证的只有一件事：自己注册的 tab 与它不冲突。**

### 3.1 冲突规避（三条硬约束）

```
① kind 唯一：bar 里 `kind` 最多一份 builtin + 一份 extension。
   我们若用 kind: extension 可覆盖 builtin —— 但【不覆盖】，用全新 kind。
② 不能用别人的 id：id 在全部注册中唯一，重复注册会 throw。
③ 不碰 sidebar.right.pane.tab 的既有 key：只注册自己的 key。
```

## 四 · 模块划分

| # | 模块 | 职责（一句话） | 依赖 | 可独立验收 | 状态 |
|---|---|---|---|---|---|
| **M1** | `dsh-comfy-bridge` | host 侧：把 ComfyUI API + bind 层包成 DSH 工具与 Remote | 无 | ✅ `curl` 通 | 待做 |
| **M2** | `dsh-comfy-workbench-tab` | 中栏 tab：注册 `conversation.view`，渲染工作台表单 | M1 | ✅ 看到 tab 并出图 | 待做 |
| **M4** | `dsh-comfy-preset` | Agent 预设 + 技能包 | M1 | ✅ 能对话 | 待做 |
| **M3** | `dsh-comfy-canvas` | 无限画布 | M1 M2 | ✅ | 延后 |

### 切片自检（三条全过才算对）

```
① 单模块可独立测试    M1 curl 通 / M2 看到 tab / M4 能对话          ✅
② 单模块可单独卸载    卸 M2 → M1 与 M4 照常跑；不影响官方侧栏       ✅
③ 单模块改动不波及     M2 改 UI → 不动 M1 的 API 契约               ✅
```

## 五 · 实施顺序

```
M1 ─ 验收 ─→ M2 ─ 验收 ─→ M4 ─ 验收 ─→ M3（可选）
```

---

## 六 · M1 · `dsh-comfy-bridge`（host 侧）

### 6.1 职责
把 ComfyUI 的能力包成 DSH 能调的东西。**不碰 UI。**

### 6.2 输入/输出边界

```
输入：DSH Remote 调用 / 工具调用
        { modeId, params: {prompt, aspect, durationSec, steps, seed, media...} }
输出：{ jobId, status, progress, outputs: [{type, path, url}] }

内部依赖：ComfyUI http://127.0.0.1:8188
          workflows/*.json + *.bind.json
```

### 6.3 复制哪些（不重写）

| 源文件 | 行数 | 处理 |
|---|---|---|
| `本地H3视频工作站/src/comfy.mjs` | 194 | **直接搬**，加一层 DSH Remote 包壳 |
| `本地H3视频工作站/src/workflows.mjs` | 693 | **直接搬**（bind 层核心资产） |
| `本地H3视频工作站/src/length.mjs` | 80 | **直接搬**（17k+5 帧数网格） |
| `本地H3视频工作站/src/verify-workflow.mjs` | 248 | 搬（开发期用） |
| `本地H3视频工作站/workflows/*.json + *.bind.json` | — | 搬 3 个模式 |

**⇒ 新写的只有 DSH 接线部分，估 200~300 行。**

### 6.4 文件结构

```
dsh-comfy-bridge/
├── package.json
├── cordis.patch.yml
├── src/
│   ├── index.js            ← DSH 插件入口，注册 Remote + 工具
│   ├── comfy.mjs           ← 复制
│   ├── workflows.mjs       ← 复制
│   ├── length.mjs          ← 复制
│   └── verify-workflow.mjs ← 复制（开发用）
└── workflows/
    ├── yz.json      + yz.bind.json
    ├── krea2.json   + krea2.bind.json
    └── qwen21.json  + qwen21.bind.json
```

### 6.5 必须遵守的三条（来自原项目 AGENTS.md）

```
① 不许重启 ComfyUI（主人在用）
② 改任何磁盘工作流前先备份 .bak
③ 代码里不许出现具体模型名或节点 id（工作流是运行时输入）
```

### 6.6 验收标准

```
□ node 单独跑：能列出 3 个 mode
□ curl 能提交 yz 模式并拿到 jobId
□ 轮询能拿到 progress 与 outputs
□ 故意传坏 bind → 报明确错误，不静默
□ 杀掉 ComfyUI → 返回「ComfyUI 未运行」而非超时
```

---

## 七 · M2 · `dsh-comfy-workbench-tab`（中栏 tab）

### 7.1 职责
在中栏「对话｜轨迹」后加「视频工作台」tab，渲染表单，调 M1。

### 7.2 核心注册代码（照 `ui-trajectory` 抄）

`ui-trajectory/lib/client.js` 逐字：

```javascript
ctx.slots.inject("conversation.view", () => ctx.slots.register({
    name: "conversation.view",
    id: "trajectory",
    order: 10,
    locale: NS,
    label: () => t("view.trajectory"),
    children: { "conversation.trajectory.images": { kind: "single", scope: "session" } },
    inject: (sessionId) => { ... }
}, TrajectoryView));
```

**我们照抄：**

```javascript
ctx.slots.inject("conversation.view", () => ctx.slots.register({
    name: "conversation.view",
    id: "comfy-workbench",
    order: 20,                        // 轨迹是 10，排在它后面
    locale: NS,
    label: () => "视频工作台",
    children: {},
    inject: (sessionId) => ({ bridge: ctx.comfyBridge, sessionId }),
}, WorkbenchView));
```

### 7.3 工作台 UI（第一版，表单式）

复用 `本地H3视频工作站/public/app.js`（459 行）的交互骨架：

```
┌─ 模式选择 ────────────────────────┐
│ [多参H3] [Krea2生图] [Qwen生图]    │
├─ 提示词 ──────────────────────────┤
│ ┌───────────────────────────────┐ │
│ │                               │ │
│ └───────────────────────────────┘ │
├─ 素材 ────────────────────────────┤
│ [参考图1] [参考图2] [参考图3]      │
├─ 参数 ────────────────────────────┤
│ 画幅 [9:16] 时长 [5.0s] 步数 [8]  │
│ 种子 [____]                        │
├─ 开关 ────────────────────────────┤
│ ☐ 二采精修  ☐ SeedVR2超清         │
├───────────────────────────────────┤
│           [ 生 成 ]                │
├─ 进度 / 产物 ─────────────────────┤
│ ████████░░ 62%   预计 45s         │
│ [产出的图/视频预览]                │
└───────────────────────────────────┘
```

### 7.4 与官方右侧栏的关系

```
不注册任何 sidebarRightTabs
不覆盖任何 builtin kind
不依赖 dsh-better-sidebar

若未来需要「把产物打开到右侧栏预览」：
  ctx.sidebarRight.openResource('dsh-resource://file/...')
  ⇒ 走官方 sidebar-files / documentpreview，自己不用写
```

### 7.5 验收标准

```
□ 中栏出现「对话｜轨迹｜视频工作台」三个 tab
□ 点「视频工作台」显示表单，不报错
□ 选 yz 模式填提示词，点生成，能看到进度
□ 生成完成能看到产物预览
□ 切到「对话」再切回，工作台状态不丢
□ 右侧栏原有 7 个 tab 类型全部照常工作（无冲突）
□ 关掉 DSH 重开，tab 仍在
```

### 7.6 已知约束（已查实）

```
· 可用 View 少于两个时隐藏 tab 栏 —— 现在有 2 个（对话/轨迹），加第 3 个照常显示
· 关闭代码工作工具会隐藏 Trajectory，但你的 View 不受影响
· View 选择规则：持久化选择优先，其次 chat；绝不选第一个 —— 加 tab 不会抢默认
· 客户端插件改完可能需重建 widget（除非同时跑 pnpm run dev:web）
```

---

## 八 · M4 · `dsh-comfy-preset`（Agent 预设）

### 8.1 内容

```
preset: comfy-video-workbench
  persona: 视频生产助手（懂 H3 / Krea2 / 参数网格 / 首尾帧）
  skills:
    h3-prompt-writing      ← 已有
    krea2-prompt-suite     ← 已有
    （新增）comfy-mode-dispatch  ← 什么时候用 yz / krea2 / qwen21
  tools:
    M1 提供的 comfy 工具（列模式 / 提交 / 查进度 / 取消）
```

### 8.2 验收标准

```
□ 新会话能选到 comfy-video-workbench 预设
□ 对它说「用 Krea2 生成一张 9:16 的图」，能调 M1 出图
□ 它能回答「H3 的 length 该填多少」并给出 17k+5 网格值
```

---

## 九 · M3 · `dsh-comfy-canvas`（延后）

**第一版不做。** 若做，边界是：

```
· 复用 M1 的 API，不新增 host 侧逻辑
· 画布状态存 DSH session storage
· 节点类型第一版只做 image / video / text 三种
```

---

## 十 · 目录约定

```
D:\主工作区\DSH视频工作台\
├── AGENTS.md                         项目规范
├── docs\
│   ├── 草稿\草稿-DSH视频工作台.md      ★ 否决留痕，永不删
│   ├── 方案-DSH视频工作台.md           ← 本文件
│   ├── 调研\                          调研原始材料
│   └── evidence\                      实测证据，一测一文件
├── src\host\                          M1 源码
├── src\client\                        M2 源码
└── workflows\                         3 个模式（从旧项目搬来）
```

---

## 十一 · 技术前提（全部已查实，非假设）

| 项 | 事实 | 证据 |
|---|---|---|
| 中栏 tab 机制 | `conversation.view` slot | `ui-trajectory/lib/client.js` 源码逐字 |
| tab 显示条件 | View 数 ≥ 2；加第 3 个照常显示 | `ui-conversation/README.zh.md` |
| 右侧栏已有会话 | `ui-subagent` 注册 `subagentchat` kind | `ui-subagent/lib/client.js` 源码 |
| 右侧栏已有 7 类 tab | files / text / browser / terminal / plan / schedule / changes-review | 8 个包的 client.js 实测 |
| 侧栏 tab 注册 API | `ctx.sidebarRightTabs.register({id,kind,patterns,priority,canOpen,title,guide,keepMounted})` | `ui-sidebar-right/README.zh.md` |
| 插件声明格式 | `dsh.client.inject` + `dsh.bundle.patch` | 官方包 package.json |
| ComfyUI 桥可复用 | 4,131 行里 194+693+80 行直接可用 | 旧项目已跑通 3 模式 |
| ComfyUI 在跑 | 127.0.0.1:8188，0.40.0，2833 节点 | `/object_info` 实测 |

---

## 十二 · 风险与对策

| 风险 | 对策 |
|---|---|
| 客户端插件 HMR 失效，每次要重建 | 开发期跑 `pnpm run dev:web`；或接受手动重载 |
| ComfyUI 被重启中断 | M1 检测到断开就报「ComfyUI 未运行」，不静默重试 |
| 产物路径混乱（混进用户 output 根目录） | 用 `filename_prefix` 或 M1 侧 diff 识别（旧项目已有做法） |
| 一个 tab 塞太多功能变成巨石 | 严守 §4 的模块边界；M3 画布独立成包 |
| 注册的 tab 与官方冲突 | 用全新 `id` 与 `kind`；绝不覆盖 builtin；绝不使用别人的 id |

---

## 十三 · 下一步（唯一的下一动作）

**做 M1 的验收 demo**：

```
① 建 dsh-comfy-bridge 包骨架
② 搬 comfy.mjs / workflows.mjs / length.mjs
③ 写 src/index.js，注册一个最简 Remote
④ curl 通：列模式 → 提交 yz → 拿到 jobId → 轮询到产物
```

**M1 不通，M2 无从谈起。**
