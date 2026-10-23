# v2026.10.23-f · 设置页 + 模型清单

> 打包：2026-10-23 04:55
> 归档：`<WORKSPACE>\_branch-archive\DSH视频工作台-v2026.10.23-f-20261023-045519.zip`（15.2MB）
> 源码备份：`merge-backup-20261023-045519`
> 上一版：`VERSION-v2026.10.23-e.md`

---

## 一 · 验收

| 项 | 结果 |
|---|---|
| `verify-editor-console.mjs` | **145 / 145**（从 139 增至 145） |
| `verify-all.mjs --static` | **56 / 56** |
| 变异测试 | **5 / 5** 全部能变红 |

---

## 二 · 设置页（设置 → ComfyUI 与环境）

### 2.1 界面

三个路径框 + 四个按钮：

| 字段 | 说明 |
|---|---|
| ComfyUI 安装目录 | 应有 `ComfyUI\main.py` 与 `ComfyUI\.venv\Scripts\python.exe` |
| 输出目录 | 留空则用 `<ComfyUI>\output` |
| 输入目录 | 留空则用 `<ComfyUI>\input` |

| 按钮 | 作用 |
|---|---|
| 保存 | POST /config，**立即生效**（不用重启） |
| 体检 | 同时查 `/health` 与 `/models/required` |
| 启动 ComfyUI | POST /ensure |
| 重新读取 | 重新 GET /config |

### 2.2 每个路径框旁有状态

「已填 / 未填 / 看起来不是绝对路径」—— 轻量判断，
真实检测在体检里（只做轻量判断是为了边打字边给反馈，不每次都发请求）。

### 2.3 配置存放位置会显示给用户

```
配置文件：D:\...\profiles\desktop\.comfy-bridge\config.json
（来自 DSH_PROFILE_DIR，可能属于另一个 profile；可用 COMFY_BRIDGE_CONFIG_DIR 指定）
```

★ 两种风险必须说出来：
- `fallbackToTmp` → 在临时目录，重启可能丢失
- `mayBeWrongProfile` → 来自 DSH_PROFILE_DIR，可能指向别的 profile

---

## 三 · 模型需求清单

### 3.1 怎么反推

遍历 `workflows/*.json` 的每个节点 inputs，两套判据取**并集**：

1. **扩展名**：`.safetensors / .ckpt / .pt / .pth / .bin / .gguf / .onnx / .sft`
2. **字段名**：`ckpt_name / lora_name / model_name / vae_name / control_net_name / ...`

★ 为什么两套都要：只看扩展名会漏掉不带扩展名的自定义节点；
只看字段名会漏掉新节点的字段。**宁可多列。**

排除项（避免误报）：URL、base64、图片/视频/音频/字幕扩展名。

**实测结果**：从 4 个工作流反推出 **26 个**模型引用。

### 3.2 怎么判断「已找到」

用 ComfyUI 自己的 `/object_info` —— 每个加载器节点都有 `*_name` 的合法值列表。

**为什么扫磁盘不行**：`extra_model_paths.yaml` 可以让模型散落在多个目录，
自己扫必然不全。而 `/object_info` 是 ComfyUI 自己列的，与它实际能加载的完全一致。

**实测结果**：26 个中 25 个已找到，缺 1 个：
```
Krea2-功能\Krea2-亚洲hina_krea2Turbo_lora_tqd_v4.0.safetensors
  → 应放到 models/loras
```

### 3.3 三态而不是两态

| found | 显示 | 含义 |
|---|---|---|
| `true` | 绿点 | 已找到 |
| `false` | 红点 | 缺失（附「应放到哪」提示） |
| `null` | 灰点 | **判断不了**（ComfyUI 未连接） |

★★ 这一条是本轮的**真 bug 修复**：
第一版前端只写 `found ? 绿 : 红` —— 把 `null` 当 `false`。
ComfyUI 没开时用户会看到「26 个模型全缺失」，而实际只是没启动。

后端早就返回了 `unknown: true`，**前端没消费** ——
这与 AGENTS §6.38「生产方产出、消费方没接」是同一个模式。

修法：前端判 `models.unknown === true` 时显示黄色提示条
「ComfyUI 未连接，无法确认这些模型是否存在」，状态点用中性灰。

---

## 四 · 新增后端模块

| 文件 | 职责 |
|---|---|
| `user-config.mjs` | 配置读写（原子写、多级位置回落、风险标记） |
| `model-manifest.mjs` | 模型反推 + `/object_info` 校验 + 三态 |

| 路由 | 用途 |
|---|---|
| `GET /comfy-bridge/config` | 读配置 + `_info` + `_effective` |
| `POST /comfy-bridge/config` | 保存 + 立即生效 |
| `GET /comfy-bridge/models/required` | 模型清单 |

---

## 五 · 新增 6 条验收

| 断言 | 防什么 |
|---|---|
| 设置页已注册到 settings.section | 页面消失 |
| 三个路径输入框 | 字段被删 |
| 保存失败会显示错误 | 静默失败 |
| 配置存放位置显示给用户 | 用户不知道存哪 |
| 体检同时查 health 与模型清单 | 只查一半 |
| **模型清单区分「已找到」与「判断不了」** | 把「没开 ComfyUI」误报成「缺模型」 |

---

## 六 · 下一步（未完成）

| 项 | 状态 |
|---|---|
| dsh-editor 并入本项目 | **未做** |
| 去敏（`dsh-editor` 那侧的硬编码） | **未做** |
| `link:` 绝对路径依赖改相对 | **未做** |
| GitHub 私密仓库 | **未做** |
| README / 安装说明 | **未做** |
| 一键安装脚本 | **未做** |

---

## 七 · 现在的可移植性状态

| 项 | 状态 |
|---|---|
| bridge（M1）硬编码路径 | ✅ 已清除 |
| 路径配置 | ✅ 用户可填、可持久化 |
| 模型清单 | ✅ 自动生成、标注下载位置 |
| `dsh-editor` 硬编码路径 | ❌ 未处理 |
| 依赖声明 | ❌ 3 个 `link:` 绝对路径 |

**结论：还不可以给别人装。** 差 dsh-editor 那一步。
