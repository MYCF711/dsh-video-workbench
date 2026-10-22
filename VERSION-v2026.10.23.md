# v2026.10.23 · DSH 视频工作台

> 打包时间：2026-10-23 00:56（本机时间）
> 归档：`D:\主工作区\_branch-archive\DSH视频工作台-v2026.10.23-b-20261023-010836.zip`（82.8MB）
> 源码备份：`D:\主工作区\_branch-archive\merge-backup-20261023-010836`
> ★ 初版归档（-005620）已作废，保留只为追溯：它缺剪辑台的纯 CSS 宽度跟随
> 上一版：`VERSION-v2026.10.22.md`

---

## 一 · 这一版做完了什么

| # | 事项 | 状态 | 关键证据 |
|---|---|---|---|
| 一 | **宽度实时跟随 DSH**（纯 CSS 变量，无轮询） | ✅ | 工作台 + 剪辑台都引用 `--dsh-composer-card-max-width` |
| 二 | 视频工作台改成**右侧栏**布局 | ✅ | 左画布 1168 + 右栏 320 |
| 三 | 删除重复参数行（「本镜配方」） | ✅ | `hasRepeat: false` |
| 四 | **删除假控件**（提示词高度把手） | ✅ | `separatorCount: 0` |
| 五 | 滚轮缩放：从源头删掉 ArtCraft 的 ctrl 分支 | ✅ | 三位置实测全对 |
| 六 | 深色模式 5 个 token 误用 | ✅ | 见 §四 |
| 七 | 复制粘贴 C/V/X | ✅ | verify-clipboard 22/22 |
| 八 | 实时进度（WebSocket 总线） | ✅ | verify-progress 33/33 |

---

## 二 · 宽度的正确做法（走了三次弯路）

主人三次反馈，每次都对：

> ① 「宽度还是没修，没有跟随DSH原生的中栏宽度调节」
> ② 「能做成实时动效吗？DSH对话框就是实时拉动的」
> ③ （指截图）「红框框出来的位置错了，逻辑也错了」

### 三次错误做法

| 版本 | 做法 | 为什么错 |
|---|---|---|
| 第一版 | 写死 `padding: 0 56px` 避开手柄线 | 常数，不跟随 |
| 第二版 | 500ms 轮询 `localStorage` | **根本不生效**（实测改 localStorage 后 DSH 卡片宽度完全不变） |
| 第三版 | 复刻 clamp 公式 `clamp(pref, 640, viewArea-176) + 32` | 算得对，但仍是轮询，慢半拍 |

### 正确做法

DSH 的样式表里只有一行：
```css
.RlGAzG_card { width: 100%; max-width: var(--dsh-composer-card-max-width); }
```

实测该变量形如 `calc(1454px + 32px)`。**拖动时 DSH 只改这个变量，浏览器原生重绘，没有 React 重渲染** —— 这就是它「实时」的原因。

⇒ 我们也直接引用同一个变量：
```js
width: "min(100%, var(--ac-follow-w, 100%))"
// --ac-follow-w 的值 = var(--dsh-composer-card-max-width, 100%)
```

**纯 CSS 层叠，零 JS、零轮询、零监听。变量一变同帧跟随。**

实测：`our x=349 w=1488 right=1837` 与 `DSH x=349 w=1488 right=1837` 完全一致。

★ 判据：**要「实时」，就必须跟随驱动重绘的那个东西，而不是跟随它的数据源。**
  localStorage 是数据源（落盘用），CSS 变量才是渲染驱动。

---

## 三 · 侧边栏布局（从三段式改成左右两栏）

```
.comfy-wb  flexDirection: row
├── 左栏  flex: 1 1 auto   画布（1168px @ 1488 内容宽）
└── 右栏  flex: 0 0 320px  生成面板
    ├── 提示词区  flex: 1 1 auto（撑满，h=581）
    └── 参数区    marginTop: auto（贴底，y=665）
```

对应的删除与修正：

| 项 | 处置 | 理由 |
|---|---|---|
| 底部横条（952px 语义） | 改成右侧栏 320px | 主人要侧边栏 |
| 横条时代的「为省 5px 挤一排」优化 | 全部失效，改竖向 | 320px 里 wrap 会碎成一片 |
| 拖拽把手（`role="separator"` 12px） | **删除** | 提示词改 flex 撑满后，拖它无任何效果 —— 假控件 |
| 「本镜配方」摘要行 | **删除** | 参数行已显示同样的值，重复 |

★ 判据（假控件）：**一个控件如果拖了没有任何可见变化，它就是装饰。**
  要么做成真装饰（不暗示可交互），要么删掉。

---

## 四 · 深色模式暴露的 5 个 token 误用

主人：「换成深色后有点原形毕露了」。

| token | 浅色 | 深色 |
|---|---|---|
| `bg-base` | `#ffffff` | `#151517` |
| `bg-layer-1` | `#ffffff`（**与 base 同色**） | `#232324` |
| `bg-layer-2` | `#f7f8f9` | `#2c2c2e` |
| `interactive-bg-hover` | 淡灰 | `#ffffff14` |

| 错误 | 深色下的后果 | 修法 |
|---|---|---|
| 侧边栏用 `bg-layer-2` | 比画布亮两档，像贴补丁 | 同底 + 分隔线 |
| 预览底用 `rgba(0,0,0,.035)` | 更黑，空态消失 | `interactive-bg-hover`（会翻转成淡白） |
| 工具栏/根用 `bg-layer-1` | 深灰带把界面切两截 | `bg-base` |
| `border: 0.5px` | dpr=1 时被取整成 1px | 用 `boxShadow: 0 0 0 0.5px` |

★ 判据：**浅色下看不出差别的 token 用法，深色下会全部暴露。**

---

## 五 · 滚轮缩放：从源头删掉

主人：「纵轴的按住ctrl+滚轮还是没修好，横轴依旧在任意位置都能ctrl+滚轮调节，那批要求你是不是直接遗忘了？」

之前我的做法是**和 ArtCraft 抢事件**（`stopImmediatePropagation`）。正确做法是**删掉它那个分支**。

ArtCraft 的 `index.tsx:297-357` 一个 capture 监听里有两个分支：

| 分支 | 处置 |
|---|---|
| `ctrl/meta` → 缩放 | **删除** |
| 普通滚轮 → 滚动 | 保留（基础交互） |

实测结果：

| 位置 | 行为 |
|---|---|
| 纵向条 + ctrl | 纵向缩放 ✅ |
| 内容区 + ctrl | 不缩放 ✅（之前会缩横向） |
| 横向条 + ctrl | 横向缩放 ✅ |

★ 判据：**功能归属冲突时，改源头，不要在下游抢。**

---

## 六 · 实时进度（WebSocket）

ComfyUI 的进度只在 WS 上推。协议实证：
`ComfyUI/main.py:450-464`
```python
progress = {"value": value, "max": total, "prompt_id": prompt_id, "node": node_id}
```

- 用 **Node v24 内建 WebSocket**，bridge 包保持零依赖
- 懒连接（没人看就不连）、退避重连（1s→2s→…上限 10s）
- 按 jobId 幂等订阅，完成/取消时释放
- 除零保护（`max=0` → `pct: null`）、10 秒过期判定

前端显示 `15/30 步 · 50%` —— 带步数而不只是百分比（不同节点总步数不同）。

⚠ **实时进度未做真机验证** —— ComfyUI 8188 全程离线，只验证了消息解析与协议契约。

---

## 七 · 验收

```
verify-all.mjs --static   56 步：54 通过 / 2 失败（都是 ComfyUI 未运行）

剪辑台四区块实装      116/116
实时进度（WS 总线）     33/33
剪贴板 C/V/X           22/22
CSS 模板检查            6/6
```

---

## 八 · 已知限制

| 项 | 状态 |
|---|---|
| M1 HTTP 端到端 10/14 | **失败** —— ComfyUI 8188 未运行，与本次改动无关 |
| M1 异常输入 21/23 | 同上 |
| 实时进度真机数据 | **未验证** —— ComfyUI 离线，只验了消息解析 |
| `dsh-editor` 是外部包 | 来自 `D:\主工作区\DSH视频工作站`，新 PC 上没有 → **可移植性未做** |
| `verify-m4.mjs` 硬编码 | `C:/Users/Administrator/dsh-tok.txt` |
| `.models/` 3.9GB | whisper 模型，未纳入归档 |
| `dsh-artcraft-tab` 目录 | 已退役但保留（`build-payload.mjs` 仍在用） |

---

## 九 · 本轮的严重事故（必须记）

**我用 PowerShell 按行号切片改源码，把 `WorkbenchView.js` 从 3085 行切到 1819 行，丢了 5 项改动。**

事故链条：
1. `$s = -1`（没找到锚点）没检查就 `$l[0..($s-1)]`
2. `$l[0..-2]` 在 PowerShell 里是合法表达式（返回前 0 到倒数第 2 个元素），不报错
3. 结果从文件头开始替换，中间大段被吃掉
4. 表层的「能构建」掩盖了问题，直到主人指截图才发现

恢复方式：从 20:02 的 zip 里取出 `WorkbenchView.js`，然后逐项手工补回丢失的改动。

**铁律：改 JS 源码不要用行号切片。**
- 用 `edit` 工具做文本替换
- 必须批量时，先 `if ($s -lt 0) { throw }` 检查锚点
- 改完立刻 `node build.mjs`，构建通过 ≠ 逻辑正确，还要比行数

---

## 十 · 怎么跑

```powershell
# 起测试实例（不动主人的 19387）
pwsh -NoProfile -File C:\Users\Administrator\restart-test.ps1

# 改代码后构建
cd D:\主工作区\DSH视频工作台\packages\dsh-comfy-workbench-tab
node build.mjs

# 改了 ArtCraft 上游才需要（两步）
cd D:\主工作区\_upstream\artcraft-demo && node build-dsh-proof.mjs
cd D:\主工作区\DSH视频工作台\packages\dsh-artcraft-tab && node build-payload.mjs

# 验收
cd D:\主工作区\DSH视频工作台\packages
node verify-all.mjs --static
```

