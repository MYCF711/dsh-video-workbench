# v2026.10.22 · DSH 视频工作台

> 打包时间：2026-10-22 20:02（本机时间）
> 归档：`<WORKSPACE>\_branch-archive\DSH视频工作台-v2026.10.22-b-20261022-200247.zip`（82.7MB）
> 验收：**53 / 55 通过**（2 项失败是 ComfyUI 未运行，与本次改动无关）
> 上一版：`VERSION-v2026.10.21.md`

---

## 一 · 这一版做完了什么

两个大块：**剪辑台重做** + **合包**。

| # | 事项 | 状态 | 关键证据 |
|---|---|---|---|
| 一 | 剪辑台重做成 DSH 原生风格（四区块） | ✅ | verify-editor-console 112/112 |
| 二 | **剪辑台合入视频工作台包** | ✅ | boot entries 68→67，`artcraftInBoot: false` |
| 三 | 复制粘贴改大众习惯 C/V/X | ✅ | 真机：`已粘贴 1 个片段到 4.00s`，新元素 `startTime = 4` |
| 四 | 滚动条滚轮缩放（横/纵按位置分） | ✅ | 10/10 位置用例全对 |
| 五 | 导入按钮不可见 / 圆环消失 / 手柄可拖 | ✅ | 真机实测 |

---

## 二 · 数得出来的量

```
src 源文件        53 个（src 顶层 29 + editor/ 24）
验收脚本          36 个（verify-* 与 check-*）
verify-all 登记   62 步
docs 文档         62 个（docs/*.md）
AGENTS.md         50.2KB / 64KB 注入预算
```

### 代码包

| 包 | 职责 | 体积 |
|---|---|---|
| `dsh-comfy-bridge` | host 侧：ComfyUI 桥 + bind 层 + HTTP 路由 | 0.5MB |
| `dsh-comfy-workbench-tab` | **视频工作台 + 剪辑台**（一个包，两个模块） | 23.8MB |
| `dsh-artcraft-tab` | **已退役**，只留 `build-payload.mjs` | 21.8MB（历史） |
| `dsh-comfy-preset` | Agent 预设 + 技能 | 0.0MB |

---

## 三 · 合包：一个插件包，两个模块

主人原话：
> 「为什么不做到同一个包？？剪辑是视频工作台的一部分」
> 「之前说过的，最小交付房间理论，剪辑可以作为一个独立的大模块接入插件」

**我之前的错误**：把「模块边界」误解成「包边界」，做成了两个独立插件。

**现在**：

```
dsh-comfy-workbench-tab/
├── src/client.js          插件入口（唯一的 apply/name/inject）
├── src/editor/            ★ 剪辑台模块，24 个文件
│   ├── index.js           mountEditorModule(ctx) 统一注册
│   ├── editorHost.js      剪辑台客户端主逻辑（原名 client.js）
│   ├── clipboard.js       C/V/X 剪贴板
│   ├── timelineZoomGestures.js  滚动条滚轮缩放
│   └── …（组件 / CSS / 快捷键 / Agent 同步）
└── verify-*.mjs           36 个验收脚本
```

### 三个必须解决的技术点

| 问题 | 解决 |
|---|---|
| `__requireShim` 只放行 react | 白名单加 `@deepseek-ai/` 前缀（官方 UI 包 50+ 个，逐个列必漏） |
| esbuild 把裸 require 换成桩 | `globalThis.__DSH_PLUGIN_REQUIRE__` 桥，`resolveHostRequire()` 优先取它 |
| 两个包都 export apply | `editorHost.js` 删掉 `apply`/`name`/`inject`，注册归 `editor/index.js` |

### 代价与收益（量过的）

gzip：workbench 本体 0.08MB + artcraft 产物 3.41MB = **3.49MB 一次下载**。
拆包时是「0.08MB 首屏 + 点剪辑台才拉 3.41MB」。
主人选了合并 —— **功能归属优先于加载优化**。

---

## 四 · 复制粘贴：从 Ctrl+D 改成 C/V/X

主人原话：
> 「复制粘贴为什么不是大众习惯的 c 和 v？」
> 「d 没必要保留吧？」

**原来**：只有 `duplicate`（Mod+D）= 原地复制一份，不经过剪贴板，
也没有「粘贴到别处」—— **那是功能缺口，不只是键位不合习惯**。

**现在**：

```
Ctrl+C  复制选中片段到模块级剪贴板
Ctrl+V  粘贴到【播放头】位置（可跨轨道）
Ctrl+X  剪切（复制 + 删除原片段）
Ctrl+D  已删除
```

设计要点：
- 剪贴板是**内存**的（不写 localStorage、不碰系统剪贴板）。代价：刷新即丢。
- 粘贴**保持相对间隔**：选三段相隔 2 秒的，粘出来也相隔 2 秒。
- `cut` **先复制成功才删除** —— 反序则失败就永久丢内容。
- 冲突交给 ArtCraft 的 `placement: auto`，不自己解（会与它的规则打架）。

---

## 五 · 滚轮缩放：按鼠标位置分横/纵

主人原话：
> 「鼠标放在纵向上的滑动条上面就缩放纵向，放在横向滑动条上面就缩放横向」
> 「目前在缩放纵向的滑动条时偶尔脱离滑动条就会失效」
> 「不管在哪都会缩放横向的滑动条」

**三个真实根因**：

1. **容错写死 8px，实际占位 10px** → 2px 死角，鼠标差一点就失效。
   ⇒ 改为现场量 `rect - clientWidth`，再向外加 6px 容错。
2. **右下角一律优先横向** → 用户以为在纵向条上，差几像素就缩放错方向。
   ⇒ 右下角交汇格**不缩放**，交回浏览器。
3. **ArtCraft 自己在 `timelineRef` 上挂了 capture 监听**，会抢走所有滚轮。
   ⇒ 监听改挂 `document`（最顶层祖先）+ `stopImmediatePropagation`。

实测 10 个位置用例全部符合预期：

| 位置 | 行为 |
|---|---|
| 纵向 最外 1px / 滑块中心 / 内侧 9px / 容错 12px | 纵向缩放 |
| 纵向 超出 20px | 不缩放 |
| 横向 滑块中心 / 内侧 9px / 容错 12px | 横向缩放 |
| 内容区中央 / 右下角 | 不缩放 |

---

## 六 · 这一版修掉的真 bug

### 6.1 导入按钮白字透明底（修了三次）

第三次才对。真根因：**CSS 注释正文里写了注释结束符**，提前结束注释块，
后面整条规则被当成非法内容**静默丢弃**。
编译不报错、运行不报错，`style.textContent` 里还有，只有 `sheet.cssRules` 里没有。

已固化 `check-css-template.mjs`（6 项，含注入变异测试）。

### 6.2 拖动预览高度把时间轴挤出页面

根因：`.ac-root { height: 100% }` 在 `display: contents` 的父级下解析成 auto
⇒ 容器被内容撑高。修：`max-height: 100% + overflow: hidden` + CSS `clamp()` 双层保险。

### 6.3 滚轮手势把整个 DSH 白屏

根因：`installWheelZoom` 在 `useEffect` 里立刻跑，那时容器还没挂出来，
`el.getBoundingClientRect()` 抛异常穿透 React 提交阶段 ⇒ 整棵应用树卸载。
服务端无报错、控制台无显式错误，只有「body 是空的」。

修法三层：模块内部判空不抛 + 轮询等容器就位 + 安装点再包 try/catch。

### 6.4 `insertElement` 不吃 `startTime`

实测：传 600000（5 秒）进去，插入后读回来是 **0**。
根因：`strategy: { type: "firstAvailable" }` 是「从轨道起点找空位」，
不是我给的时间点。
修：插入后显式 `updateElements({ startTime })` 改回目标值。

### 6.5 点时间轴后快捷键全部失效

根因：DSH 的 composer 是 `contenteditable`，点时间轴时焦点没离开它，
而 `installShortcutHandler` 的保护逻辑「焦点在 contentEditable 里就不接管」
—— 那层保护本身是对的（在输入框里按 C 应该打字）。
缺的是「用户已经明确点了时间轴」这个信号。
修：根节点捕获 `pointerdown`，落点不在输入框内就给根节点 focus。

---

## 七 · 已知限制（写清楚，别当成已修）

| 项 | 状态 |
|---|---|
| M1 HTTP 端到端 10/14 | **失败** —— ComfyUI 8188 未运行，与本次改动无关 |
| M1 异常输入 21/23 | 同上 |
| 剪贴板刷新即丢 | 设计选择（不写 localStorage、不碰系统剪贴板） |
| 跨 tab 复制 | 不支持 —— 剪贴板是模块级内存 |
| `dsh-artcraft-tab` 目录 | **未删除**，已标退役。`build-payload.mjs` 仍在用；本项目无 git，需保留回滚参照 |
| 合包后首屏多 3.41MB | 主人已确认接受 |

---

## 八 · 怎么跑起来

```powershell
# 起测试实例（不动主人的 19387）
pwsh -NoProfile -File <HOME>\restart-test.ps1

# 只跑离线检查（约 1 分钟）
cd <REPO>\packages
node verify-all.mjs --static

# 剪辑台单独验
cd dsh-comfy-workbench-tab
node verify-editor-console.mjs    # 112/112
node verify-clipboard.mjs         # 22/22
node check-css-template.mjs       # 6/6

# 改代码后构建
cd dsh-comfy-workbench-tab && node build.mjs
```

### ⚠ ArtCraft 上游变了才需要跑这个

```powershell
cd packages\dsh-artcraft-tab
node build-payload.mjs     # 重新生成 _artcraft-payload.js（10.43MB，读上游产物）
```

---

## 九 · 踩坑记录

细节全在 Hindsight（AGENTS.md 已 50.2KB，逼近 64KB 预算，只留指针）：

```
查：hindsight_search_knowledge_pages("CSS 注释正文 注释结束符 静默丢弃规则")
查：hindsight_search_knowledge_pages("useEffect 访问未就绪 DOM 白屏 三层防线")
查：hindsight_search_knowledge_pages("剪辑台合入 comfy-workbench-tab 一个插件包")
查：hindsight_search_knowledge_pages("CSS 特异性 简写vs长写 CRLF 假通过")
查：hindsight_search_knowledge_pages("insertElement 不吃 startTime firstAvailable")
```

### 这一版最值钱的三条判据

```
① 样式不生效时，不要只看 computed 值，要查 sheet.cssRules。
   textContent 有 ≠ cssRules 有 —— 这一步区分「规则被丢弃」和「规则被覆盖」。

② 特效性的三个陷阱：元素+类的特异性、简写 vs 长写、断言锚字符串而非行为。
   每个都要用变异测试验「删掉它会不会变红」。

③ 断言不能写死总数。
   本轮 `12 个快捷键` 和 `常驻 6 个` 两条因为改键位就变红，
   改成「必须包含这些 id」—— 加功能不该让断言变红。
```

### 一条方法论

```
二分法比读代码快：
「改动前好、改动后白屏」时，把改动撤掉重启看是否恢复，
比在 11MB 产物里找异常快得多。
本次白屏就是这样在 10 分钟内定位的。
```
