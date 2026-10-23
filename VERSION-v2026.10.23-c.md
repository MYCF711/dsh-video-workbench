# v2026.10.23-c · 增量修复记录

> 打包：2026-10-23 02:11
> 归档：`<WORKSPACE>\_branch-archive\DSH视频工作台-v2026.10.23-c-20261023-021105.zip`（82.8MB）
> 源码备份：`merge-backup-20261023-021105`
> 上一版：`VERSION-v2026.10.23.md`（含 b 版说明）

---

## 一 · 本轮修的 6 项

| # | 问题 | 根因 | 证据 |
|---|---|---|---|
| 1 | 撤销/重做图标重复 | 两个按钮都写了 `icon: "refresh"` | DSH 图标集无 undo/redo，改内联 SVG |
| 2 | 整个剪辑台找不到导出 | `ExportButton` 只在 `editor-header` 里，而我们用 `mountTimeline` | 加「···」菜单项 + 调 `editor.project.export()` |
| 3 | 检查器预览失效 | `it.thumbUrl \|\| it.url` 恒为 null | `/comfy-assets/library` 只返回 `{id, src, rel}`，`img` 元素实测 0 个 |
| 4 | 视频缩略图空白 | `<img>` 解不了 mp4 | mp4 套 img 时 `naturalWidth === 0`；改 `<video preload="metadata">` |
| 5 | 列表模式卡片重叠 | `.ac-media-list` 是 flex column，卡片被压缩到 12px | CSS 写 `height: 44px`，`computed` 是 `12px`；缩略图 30px 溢出压住下一行 |
| 6 | 剪辑台贴死对话框 | `boxSizing: border-box` 下 padding 在盒内，不产生外间隙 | 改 `height: calc(100% - 16px)`，gap 实测 0 → **16px** |

---

## 二 · 关键教训

### 2.1 「height 写了却不生效」的第一嫌疑是 flex-shrink

```
.ac-media-list { display: flex; flex-direction: column; }
.ac-media-list .ac-media-card { height: 44px; }   ← 实测 computed: 12px
```

881 张卡总高远超容器 ⇒ 浏览器按比例压缩每一张。
`height` 只是「期望值」，被 `flex-shrink: 1` 覆盖。

**修法**：`flex: none` + `min-height`。
**判据**：flex 容器里写固定高度，必须同时写 `flex: none`。

### 2.2 视频缩略图必须用 `<video>`，不能 `<img>`

`mediaAssets.js:137-150` 早就记过「视频的 thumbnailUrl 必须是首帧图」，
但它说的是「拿首帧」—— DSH 这边没有转码能力。

**零转码方案**：`<video preload="metadata" muted>` 让浏览器自己取首帧。
实测 83 个视频全部 `readyState >= 1`。

### 2.3 接口字段名不能猜

```
❌ it.thumbUrl || it.url || null     → 恒为 null
✅ /comfy-assets/file?src=<src>&rel=<rel>
```

`/comfy-assets/library` 实测返回：
```
{ id, src, rel, dir, name, kind, sizeBytes, mtime, displayName, fav, renamed, role, folder, … }
```
**没有 thumbUrl，也没有 url。**

### 2.4 上游组件在哪渲染，决定功能是否可见

`ExportButton` 只在 `editor-header.tsx` 里（`VideoEditor` 整机版才有）。
我们用的是 `mountTimeline`（只挂 `<Timeline>`）⇒ 导出入口整个消失。

**判据**：从「整机」改成「局部挂载」时，要盘一遍被丢掉的入口。

---

## 三 · 验收

```
verify-editor-console.mjs   128 / 128  （从 116 增至 128）
verify-all.mjs --static      54 / 56   （2 失败均为 ComfyUI 8188 未运行）
```

### 变异测试（6/6 能变红）

| 变异 | 结果 |
|---|---|
| 撤销图标退回 `refresh` | ✅ 变红 |
| 删掉导出菜单项 | ✅ 变红 |
| 导出改成假调用 | ✅ 变红 |
| `rel` 来自 `it.rel` 改成 `""` | ✅ 变红 |
| 视频退回用 `<img>` | ✅ 变红 |
| 列表卡片 `flex: none` → `1 1 auto` | ✅ 变红 |

---

## 四 · 两次假通过（必须记）

### 4.1 断言只测「拼接字符串」，不测「取值来源」

```js
// 第一版
/\/comfy-assets\/file\?src=/.test(src)
// 把 const rel = it.rel || ""; 改成 const rel = "";  仍通过 ❌

// 第二版（加 rel 参数）
/?src=${encodeURIComponent(src)}&rel=${encodeURIComponent(rel)}/
// 同样通过 ❌ —— 拼接代码还在，只是变量值变了

// 第三版（测取值来源）
/const src = it\.src/.test(src) && /const rel = it\.rel/.test(src)
// ✅ 能变红
```

**判据**：断言的应该是「数据从哪来」，不是「代码长什么样」。
一个 bug 的根因在取值来源时，测形状永远测不到。

### 4.2 变异测试的 replace 没匹配上 = 白测

```
M 'editor.css.js' '  flex: none;
  min-height: 44px;' ''   ← 带注释时缩进不同，未匹配
```
PowerShell 里 replace 静默失败（`$new -eq $raw` 才该报，但我没检查）。
**修**：函数里先 `if ($new -eq $raw) { 报未匹配; return }`。

---

## 五 · 本轮又一次文件事故

`editor/index.js` 从 206 行被切到 123 行 —— **同一个错误第三次**：
`$s = -1`（没找到锚点）没检查就 `$l[0..($s-1)]`。

从 10 分钟前的备份恢复，损失极小。

**这次真正生效的教训**：改 JS 源码用 `edit` 工具做文本替换，
不用 PowerShell 行号切片。本轮后半段已全部改用 `edit`。

---

## 六 · 仍欠

| 项 | 状态 |
|---|---|
| 脱敏 + 可移植插件 | **未做** —— `dsh-editor` 是外部包、`verify-m4.mjs` 硬编码路径、3 个 `link:` 绝对路径、`.models/` 3.9GB |
| 实时进度真机数据 | **未验证** —— ComfyUI 全程离线 |
| OpenCut AGPL 授权 | **待主人确认** —— 剪辑台底座是 OpenCut（`opencut-wasm`），但我们拿到的是 `@storyteller/ui-video-editor` 的改编版 |
