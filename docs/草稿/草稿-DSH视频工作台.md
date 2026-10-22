# 草稿 · DSH 视频工作台插件

> 起于 2026-10-17 ｜ 迭代 4 轮 ｜ 状态：**已定稿（见 `docs/方案-DSH视频工作台.md`）**

---

## 一 · 目标

把「AI 漫剧/视频生产工作台」做进 DSH：中栏加一个「视频工作台」tab，右栏用于 agent 会话与资产，底层生成走本机 ComfyUI。

### 目标演进（保留痕迹）

**v1（用户最初）**：
> ~~在 ComfyUI 里实现 TapNow 体验 —— 无限画布 + 节点外观 = TapNow 式 + 一段一段维护~~

**v2（2026-10-17 用户转向前）**：
> 「yuh这个工作台是非适合作为新的基座」
> 「它自己造了一个comfyui+agent+画布+视频工作站的这么一个产品，其实comfyui是现成的，agent也是现成的，需要的只是视频工作站和ui，而这部分其实是可以接入DSH的？」
> 「只需要弄一个专门的AGENT预设+在主会话的对话/轨迹/右边加一个画布，一个视频工作台，这样就可以了，然后按照之前约定的，单最小模块，做成一个模组包，成为一个单独插件」

**v3（2026-10-17 补正，最终）**：
> 「我想把视频工作台加在**这里**（截图为中栏「对话｜轨迹」标签栏后的空位），右边的侧边用来放agent会话」
> 「感觉本质还是加一个tab标签页」

⇒ **目标从「画布」收敛为「中栏一个 tab」。** 画布是可选项，不是第一步。

---

## 二 · 设想（R1 发散 —— 不取舍，全写下来）

### 设想 A · 中栏加 conversation.view tab
- 内容：注册 `conversation.view` slot，与「对话」「轨迹」平级
- 好处：官方机制，`ui-trajectory` 是活模板；用户明确要这个位置
- ⚠ 坏处：无（已查实机制）
- **状态**：✅ **已采纳**

### 设想 B · 右栏用 dsh-better-sidebar 放 agent 会话
- 内容：装 `dsh-better-sidebar` v0.28.0，它自带 `side chat`（每会话独立）
- 好处：无需自己写侧边聊天；MIT 开源；有 `dsh-ide-git` 作为「注册成它原生 tab」的活模板
- ⚠ 坏处：引入第三方依赖；它的 API 未来可能变
- **状态**：~~已否决~~（用户 2026-10-17 裁决，见 §三 #9）

### 设想 C · 自己从零写右侧栏
- 内容：用 `ctx.sidebarRightTabs.register` 手写
- 好处：无第三方依赖，完全可控
- ⚠ 坏处：`dsh-better-sidebar` 已经做了 240+ 文件（含 side chat 后端路由 20 KB、文件树 39.5 KB、终端 21.3 KB、浏览器 11.3 KB）—— 重写等于白干
- **状态**：~~已否决~~（见 §三 #1）

### 设想 D · 完整无限画布（节点 + 连线 + 拖拽）
- 内容：照 YUH Studio 的画布做
- 好处：真正的 TapNow 体验
- ⚠ 坏处：3000~5000 行前端；用户当前只要一个 tab
- **状态**：⏸ **延后**（不是否决，是排到 M5）

### 设想 E · 直接给 YUH Studio 写插件
- 内容：继续用 YUH，往它里面加东西
- 好处：YUH 已有完整生产链路（26 镜分镜表、TTS、拼接）
- ⚠ 坏处：**闭源**，`app.asar` 130.7 MB 不可改；内置 ComfyUI 0.37.0 比桌面版 0.40.0 旧，你的工作流插件它大概率没有
- **状态**：~~已否决~~（见 §三 #2）

### 设想 F · 用 Toonflow 做外壳
- 内容：Toonflow（★17,996，MIT）做画布，自研做引擎
- 好处：开源可改，无限画布已有
- ⚠ 坏处：它是独立 Electron 应用，**不是 DSH 插件** ⇒ 与「在 DSH 里加 tab」的目标冲突
- **状态**：~~已否决~~（见 §三 #3）

### 设想 G · 把「本地H3视频工作站」整个搬成 DSH 插件
- 内容：4,131 行全搬
- 好处：已跑通 3 个模式、有静态验证器、有陷阱库
- ⚠ 坏处：它的前端（`public/` 686 行原生 HTML）在 DSH 里没用，只需搬 host 侧的 ComfyUI 桥
- **状态**：✅ **部分采纳**（只搬 host 侧，见 §五 M2）

### 设想 H · 直接调 ComfyUI 的 `/prompt`，不要 bind 层
- 内容：前端直接拼 API 工作流
- 好处：少一层
- ⚠ 坏处：`bind.json` 那一层解决的正是「工作流是运行时输入」——用户 2026-10-15 原话「先空着，等你实现之后接入就行了」。去掉它就得把模型名写死在代码里
- **状态**：~~已否决~~（见 §三 #4）

### 设想 I · 一个插件里塞全部功能
- 内容：单包 = 桥 + tab + 画布 + 资产库
- 好处：装一次就行
- ⚠ 坏处：违反「一个功能 = 一个可插拔模块」；出问题无法定位
- **状态**：~~已否决~~（见 §三 #5）

### 设想 J · 用 MCP 而不是插件
- 内容：把 ComfyUI 桥做成 MCP server，DSH 通过 MCP 调
- 好处：MCP 是通用协议
- ⚠ 坏处：MCP 走**模型调用**路径，不适合「用户在 UI 里点按钮生成」这种人类驱动的操作。MCP 是给 agent 用的
- **状态**：~~已否决（作为主路径）~~（见 §三 #6）；但可作为**辅助**——让 agent 也能提交 ComfyUI 任务

---

## 三 · ✗ 已否决（★ 只增不删）

| # | 设想 | 否决理由 | 时间 | 谁 |
|---|---|---|---|---|
| 1 | ~~自己从零写右侧栏~~ | `dsh-better-sidebar` v0.28.0 已含 side chat + 文件树 + 终端 + 浏览器 + 240+ 类型定义，MIT。重写 3000+ 行只为省一个依赖，不划算 | 2026-10-17 R2 | 我 + npm 实测 |
| 2 | ~~继续用 YUH Studio 做基座~~ | 闭源（app.asar 130.7 MB 不可改）；内置 ComfyUI **0.37.0** 旧于桌面版 **0.40.0**，用户已接的工作流（H3官流/Krea2/漫转真/田园MJ）依赖 KJNodes/rgthree/UltimateSDUpscale/SeedVR2，它大概率没有；models 目录几乎空（仅 1 个 10.51 MB 语义桥） | 2026-10-17 R2 | 我 + 实测 |
| 3 | ~~用 Toonflow 做外壳~~ | 独立 Electron 应用，不是 DSH 插件 ⇒ 与「在 DSH 中栏加 tab」目标冲突。若装它，用户得在两个窗口间切换，等于放弃 DSH 的会话/轨迹/记忆 | 2026-10-17 R2 | 我 |
| 4 | ~~去掉 bind 层，直接拼 API 工作流~~ | bind 层正是「工作流 = 运行时输入」的实现。去掉就要把模型名/节点 id 写死进代码 —— 用户 2026-10-15 明确说「先空着，等你实现之后接入就行了」 | 2026-10-17 R2 | 我 + 用户原话 |
| 5 | ~~单包塞全部功能~~ | 违反「一个功能 = 一个可插拔模块」。判据：出问题时能否立刻说出是哪个模块 —— 单包做不到 | 2026-10-17 R2 | 我 |
| 6 | ~~主路径走 MCP~~ | MCP 面向「模型决定的调用」，而「用户在 UI 点生成」是**人类驱动**的。混用会让 agent 与 UI 抢同一队列，且 MCP 无法承载轮询进度/预览缩略图这类 UI 状态 | 2026-10-17 R3 | 我 |
| 7 | ~~自己实现 conversation.view 的 slot 注册~~ | 已有官方 slot，`ui-trajectory/lib/client.js` 是活模板，注册只需十几行 | 2026-10-17 R3 | 我 + 源码实测 |
| 8 | ~~第一步就做无限画布~~ | 用户当前只要「一个 tab」。先做画布 = 3000~5000 行，且未验证 DSH 插件通路就跑大工程 | 2026-10-17 R4 | 我 + 用户截图 |
| 9 | ~~右栏用 dsh-better-sidebar（第三方）~~ | **用户 2026-10-17 裁决**：「右侧栏已经有侧栏会话可以用现成的，而且是官方dsh自己在维护，只要保证我们的插件接入正常就行了」。实测确认：官方 `ui-subagent` 已注册 `subagentchat` kind（侧栏会话），另有 files/text/browser/terminal/plan/schedule/changes-review 共 7 类。⇒ 不装第三方，只用官方；我们只负责自己注册的 tab 与官方不冲突 | 2026-10-17 R5 | 主人 + 源码实测 |

---

## 四 · 待定问题

| # | 问题 | 归属 | 状态 |
|---|---|---|---|
| 1 | 中栏 tab 组件要接收哪些 props？（`conversation.view` 的 SlotMap 类型） | 我查源码 | ⬜ 未决 |
| 2 | `dsh-better-sidebar` v0.28.0 与本机 DSH 0.2.0-rc.2 兼容吗？ | 我实测 | ⬜ 未决 |
| 3 | 客户端插件能否 HMR，还是必须重建 | 我查 | ⬜ 未决 |
| 4 | 生成任务的状态存哪？（DSH session storage / 插件自己的 storage / 文件） | 我定 | ⬜ 未决 |
| 5 | 产物（图片/视频）如何在 DSH 里预览？走 `dsh-resource://` 还是自己的 HTTP 路由 | 我查 | ⬜ 未决 |
| 6 | 是否需要 Agent 预设（用户提到「专门的 AGENT 预设」） | 主人 | ⬜ 未决 |

---

## 五 · 决定（定稿骨架）

| # | 决定 | 依据 |
|---|---|---|
| 1 | 中栏用官方 `conversation.view` slot 加 tab | 源码实测：`ui-trajectory` 十几行即可注册 |
| 2 | 右栏用 `dsh-better-sidebar` v0.28.0（**已作废**，见 §三 #9） | ~~npm 实测：MIT、含 side chat~~ ⇒ 改用官方 `ui-subagent` 的 `subagentchat` |
| 3 | 拆成 4 个可插拔模块（见下） | 用户「一个功能一个可插拔模块」 |
| 4 | 第一版只做「表单式工作台」，不做画布 | 用户当前只要 tab；先验证通路 |
| 5 | host 侧复用现有 4,131 行里的 ComfyUI 桥 | 已验证跑通 3 个模式 |
| 6 | 跳过 YUH / Toonflow 做外壳 | 见 §三 #2 #3 |

### 模块划分

| # | 模块 | 职责（一句话） | 依赖谁 | 可独立验收？ |
|---|---|---|---|---|
| M1 | `dsh-comfy-bridge` | host 侧：把 ComfyUI API 包成 DSH 的 Remote/工具 | 无 | ✅ 能单独 curl 通 |
| M2 | `dsh-comfy-workbench-tab` | 中栏 tab：注册 `conversation.view`，渲染工作台表单 | M1 | ✅ 能单独看到 tab |
| M3 | `dsh-comfy-canvas` | 无限画布（延后） | M1 M2 | ✅ | 
| M4 | `dsh-comfy-preset` | Agent 预设 + 技能包 | M1 | ✅ 能单独对话 |

**判据自检**（§5.4 三条）：
```
① 单模块可独立测试 —— M1 curl 通、M2 看到 tab、M4 能对话  ✅
② 单模块可单独卸载 —— 卸载 M2 不影响 M1 与 M4  ✅
③ 单模块改动不波及别处 —— M2 改 UI 不动 M1 的 API  ✅
```

---

## 六 · 变更日志

- **2026-10-17 R1 发散**：列 10 条设想 A–J（含「自己写侧栏」「用 YUH」「用 Toonflow」「走 MCP」等看着可行的路）
- **2026-10-17 R2 批判**：否决 5 条（§三 #1–#5），核心理由是「已有现成」与「闭源不可改」
- **2026-10-17 R3 收敛**：再否决 2 条（MCP 主路径 / 自己实现 slot），补 6 个待定问题
- **2026-10-17 R4 切分**：否决「第一步做画布」，切成 M1–M4 四个模块，定实施顺序
- **2026-10-17 定稿** → `docs/方案-DSH视频工作台.md`

---

## 七 · 调研证据（R1–R2 期间采集）

### 7.1 中栏 tab 机制（源码实测）

`dsh/node_modules/@deepseek-ai/dsh-client-ui-trajectory/lib/client.js`：

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

`dsh-client-ui-conversation/lib/client.js` 渲染侧：

```javascript
const viewTabs = () => {
    for (const entry of slots.entries("conversation.view")) {
        if (entry.options.id === void 0) continue; ...
    }
};
renderSlot("conversation.view", {...}, { only: viewId })
```

### 7.2 右侧栏扩展点（官方文档逐字）

`dsh-client-ui-sidebar-right/README.zh.md`：

> `ctx.sidebarRightTabs.register({ id, kind, patterns?, priority?, canOpen?, title, guide?, keepMounted? })`
> `ctx.slots.register({ name: 'sidebar.right.pane.tab', key: definition.id }, Body)`

### 7.3 dsh-better-sidebar（npm 实测）

```
name       dsh-better-sidebar
latest     0.28.0（共 34 个版本，从 0.10.0 起）
license    MIT
repo       https://github.com/omdsh-dev/DSH-better-sidebar
desc       "file tree, editor, changes, tasks and side chat in one column,
            separate for every conversation. Also exposes a service other
            plugins use to register sidebar tabs and file viewers."
```

同类插件模板 `dsh-ide-git` v0.18.7：
```json
"dsh": {
  "client": { "inject": [...], "platform": "web" },
  "bundle": { "patch": "./cordis.patch.yml" }
}
"peerDependencies": { "dsh-better-sidebar": "...", "@deepseek-ai/dsh": "...", "@deepseek-ai/cordis": "..." }
```

### 7.4 YUH Studio 剖析（否决依据）

```
D:\YUH Studio  2.7 GB
  内置 ComfyUI 0.37.0（custom_nodes 9 个全自研）
  models 目录几乎空（仅 MiniMaxH3_SemanticBridge_v1 10.51 MB）
  openharness 34 模块 ~1,600 KB Python（锁在 asar 内）
  ai-drama-pipeline 已产出 26 镜分镜表 + mean_abs_diff<10 判据
  闭源：YUH Studio.exe 227.9 MB + app.asar 130.7 MB
```

### 7.5 现有资产（M1/M2 可复用）

```
D:\主工作区\本地H3视频工作站\
  4,131 行，零 npm 依赖
  src/comfy.mjs          194 行   ComfyUI 桥
  src/workflows.mjs      693 行   可插拔 bind 层   ★
  src/verify-workflow.mjs 248 行  静态验证器（0 误报，有反证）★
  src/deploy-check.mjs   150 行   模型盘点
  src/length.mjs          80 行   17k+5 帧数网格
  workflows/*.json + *.bind.json  3 个模式（yz/krea2/qwen21）
```
