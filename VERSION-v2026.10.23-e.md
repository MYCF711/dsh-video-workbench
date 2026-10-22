# v2026.10.23-e · 去敏改造 + 配置持久化

> 打包：2026-10-23 04:36
> 归档：`D:\主工作区\_branch-archive\DSH视频工作台-v2026.10.23-e-20261023-043640.zip`（15.2MB，已排除 docs 证据素材）
> 源码备份：`merge-backup-20261023-043640`
> 上一版：`VERSION-v2026.10.23-d.md`

---

## 一 · 验收

| 项 | 结果 |
|---|---|
| `verify-editor-console.mjs` | 139 / 139 |
| `verify-all.mjs --static` | **56 / 56** |

---

## 二 · 本轮做了什么

### 2.1 去敏：移除全部硬编码本机路径

`comfy-launcher.mjs` 原来写死 7 处：

```js
const DESKTOP_ROOT = "D:\\Comfy-Desktop\\ComfyUI-Installs\\My_Comfy_UI";
const DESKTOP_PY   = ...;
const DESKTOP_MAIN = ...;
const EXTRA_YAML   = ...;
const SHARED_OUTPUT = "D:\\Comfy-Desktop\\ComfyUI-Shared\\output";
const SHARED_INPUT  = "D:\\Comfy-Desktop\\ComfyUI-Shared\\input";
```

改成 `resolveComfyPaths()`，四级来源：

| 级 | 来源 | 说明 |
|---|---|---|
| ① | 用户配置 | 设置页填的，存 config.json |
| ② | 环境变量 | `COMFYUI_PATH` / `COMFYUI_OUTPUT` / `COMFYUI_INPUT` |
| ③ | 通用位置探测 | 各盘符 `\ComfyUI`、`\ComfyUI_windows_portable\ComfyUI`、用户主目录 |
| ④ | 无 | 返回 `null` + `needSetup: true`，给可操作错误 |

★ **探测候选里不再含本机专有路径** —— 写进发布代码毫无意义，
还会让别人以为「必须装在 D 盘那个位置」。

### 2.2 用户配置持久化（`user-config.mjs`）

四级回落，从「最确定」到「最不稳」：

```
COMFY_BRIDGE_CONFIG_DIR  →  ctx.dataDir  →  DSH_PROFILE_DIR  →  os.tmpdir()
```

`configInfo()` 会报告 `source` 与两个风险标志：

| 字段 | 含义 |
|---|---|
| `source` | `explicit` / `ctx` / `profile` / `tmp` |
| `fallbackToTmp` | 存到了系统临时目录 ⇒ 重启会丢 |
| `mayBeWrongProfile` | 路径来自 `DSH_PROFILE_DIR`，可能指向别的 profile |

### 2.3 新增路由

| 路由 | 用途 |
|---|---|
| `GET /comfy-bridge/config` | 读配置 + `_info`（存哪了、怎么来的）+ `_effective`（实际生效值） |
| `POST /comfy-bridge/config` | 保存 → **立即生效**（更新闭包里的 `paths`，不用重启） |

实测：POST 三个路径 → 落盘 `config.json` → 重启后 GET 仍能读回，
`_effective` 正确合并。

---

## 三 · 本轮踩的两个坑

### 3.1 `ctx.dataDir` 未 inject 时抛错，不是返回 undefined

```
cannot get property "dataDir" without inject
```

`ctx?.dataDir` **挡不住** —— getter 本身就抛。必须 `try / catch`。
（与 AGENTS §3.1 同一个坑，这是第二次踩。）

### 3.2 `DSH_PROFILE_DIR` 不能判断「当前是哪个 profile」

实测：在 `comfy-test`（19499）里读到的是 `profiles\desktop`。

原因：那个环境变量是**启动 DSH 的父进程**的，
同一个宿主起不同 profile 时它不跟着变。

⇒ 路径合法、可写，但指向**错误的 profile**。
这种「错得不像错」最危险 —— 所以 `configInfo()` 专门给了
`mayBeWrongProfile: true` 让 UI 把它说出来。

---

## 四 · 下一步（E 段未完成部分）

| 项 | 状态 |
|---|---|
| 设置页 UI（填路径的表单） | **未做** |
| 模型需求清单（从工作流反推 + 下载链接） | **未做** |
| 一键体检 | **未做** |
| dsh-editor 并入本项目 | **未做** |
| GitHub 私密仓库 | **未做** |

---

## 五 · 归档策略调整

上一版（`-d`）117.9MB，因为 `docs/` 里有 102.6MB 证据素材（生成的图片/视频）。

这一版**排除 `docs/`**，15.2MB。

★ 两种都要保留：
- 小包（15.2MB）= 真正的代码交付物，用于分发
- 带 docs 的包 = 完整现场（需要追溯实测证据时用）
