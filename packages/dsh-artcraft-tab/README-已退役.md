# dsh-artcraft-tab —— 已退役（2026-10-22）

## 状态：不再是插件包

**本包的代码已全部并入 `dsh-comfy-workbench-tab`。**

主人原话：
> 「为什么不做到同一个包？？剪辑是视频工作台的一部分」
> 「之前说过的，最小交付房间理论，剪辑可以作为一个独立的大模块接入插件」

我把「模块边界」误解成了「包边界」，做成了两个独立插件。
正确形态是：**一个插件包 + 内部一个独立大模块**。

## 现在代码在哪

```
dsh-comfy-workbench-tab/src/editor/     ← 剪辑台全部源码（23 个文件）
  ├── index.js          模块入口：mountEditorModule(ctx)
  ├── editorHost.js     剪辑台客户端主逻辑（原名 client.js）
  ├── ArtCraftTab.js    四区块主壳
  ├── EditorToolbar.js  工具栏 17→6
  ├── Inspector.js      右侧检查器
  ├── PreviewPane.js    预览区
  ├── agentSync.js      Agent 实时反馈
  ├── shortcuts.js      快捷键系统
  ├── ShortcutSettings.js
  ├── dsh-primitives.js DSH 原生 UI 基元接入
  ├── dshHandleGuard.js DSH 列宽手柄屏蔽
  ├── timelineZoomGestures.js 滚动条滚轮缩放
  ├── editor.css.js     外壳样式
  ├── dsh-native.css.js DSH 对齐层
  ├── _artcraft-payload.js  ArtCraft 产物（base64，10.43MB）
  └── …
```

验收脚本也搬到了 `dsh-comfy-workbench-tab/verify-*.mjs`。

## 本目录还留着什么

| 文件 | 留着的原因 |
|---|---|
| `build-payload.mjs` | **仍在使用**：只在 ArtCraft 上游变了时跑，重新生成 `_artcraft-payload.js` / `_artcraft-css.js` |
| `src/` | 仅作历史参考。**不再是真源** —— 真源在 `dsh-comfy-workbench-tab/src/editor/` |
| `lib/` | 旧的构建产物，已无插件加载它 |

## ⚠ 改代码请去新位置

```
编辑   dsh-comfy-workbench-tab/src/editor/*.js
构建   cd dsh-comfy-workbench-tab && node build.mjs
验收   node verify-editor-console.mjs
```

## 为什么留着这个目录而不是删掉

1. `packages/verify-all.mjs` 里还有对本目录 `build-payload.mjs` 的引用
2. 删除后万一要回滚没有参照（本项目无 git）
3. 34.7MB 的完整备份在 `D:\主工作区\_branch-archive\merge-backup-*`

**确认稳定后可以整目录删除。**
