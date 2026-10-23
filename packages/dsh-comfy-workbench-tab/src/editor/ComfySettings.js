/**
 * 设置页 · ComfyUI 与环境配置（2026-10-23）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要这个页面
 *
 *   去敏之后插件不再硬编码本机路径（见 VERSION-v2026.10.23-e.md §2.1）。
 *   路径从哪来？必须是用户填。填的地方就是这里。
 *
 * ── 这一页解决三个问题
 *   ① 告诉用户「插件在找什么」—— 三个路径输入框 + 当前检测结果
 *   ② 告诉用户「还缺什么」—— 模型清单，逐个标 已找到 / 缺失
 *   ③ 让用户「一键确认环境是好的」—— 体检按钮
 *
 * ── 设计纪律（照 refactoring-ui）
 *   · 路径框旁边必须有【实际检测结果】，不能只有一个输入框让用户猜
 *   · 缺什么要说「怎么补」，不是只说「缺」
 *   · 保存失败必须显式报错 —— 用户以为存上了但没存是最糟的
 *
 * ── 为什么不做「自动扫描磁盘找 ComfyUI」
 *   不可靠且慢。用户知道自己装在哪，填一下比扫描十秒快。
 *   但可以给「常见位置提示」降低思考成本。
 */

import React from "react";

const h = React.createElement;

const BRIDGE = "/comfy-bridge";

/** 统一的字段行。标签 + 输入框 + 检测结果。 */
function Field({ label, hint, value, onChange, status, placeholder, disabled }) {
  return h("div", { style: { marginBottom: 14 } },
    h("div", { style: { display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 } },
      h("label", {
        style: {
          fontSize: 12, fontWeight: 500,
          color: "var(--dsw-alias-label-primary, #0f1115)",
        },
      }, label),
      status
        ? h("span", {
            style: {
              fontSize: 11,
              color: status.ok
                ? "var(--dsw-alias-label-tertiary, #81858c)"
                : "rgb(207,34,46)",
            },
          }, status.text)
        : null
    ),
    h("input", {
      type: "text",
      value: value ?? "",
      placeholder: placeholder ?? "",
      disabled,
      onChange: (e) => onChange(e.target.value),
      spellCheck: false,
      style: {
        width: "100%", boxSizing: "border-box",
        height: 30, padding: "0 9px",
        border: "0.5px solid var(--dsw-alias-border-l3, #0000001f)",
        borderRadius: 6,
        background: "var(--dsw-alias-bg-base, #fff)",
        color: "var(--dsw-alias-label-primary, #0f1115)",
        font: "12px/18px ui-monospace, SFMono-Regular, Menlo, monospace",
        outline: "none",
      },
    }),
    hint
      ? h("div", {
          style: {
            marginTop: 4, fontSize: 11, lineHeight: "16px",
            color: "var(--dsw-alias-label-tertiary, #81858c)",
          },
        }, hint)
      : null
  );
}

/** 一行按钮。 */
function Btn({ children, onClick, primary, disabled, title }) {
  return h("button", {
    type: "button",
    onClick,
    disabled,
    title,
    style: {
      height: 28, padding: "0 12px",
      border: 0, borderRadius: 6,
      background: disabled
        ? "var(--dsw-alias-interactive-bg-active, #f1f3f5)"
        : primary
          ? "var(--dsw-alias-state-business-primary, #4176e6)"
          : "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05))",
      color: disabled
        ? "var(--dsw-alias-label-tertiary, #81858c)"
        : primary
          ? "var(--dsw-alias-label-primary-foreground, #fff)"
          : "var(--dsw-alias-label-primary, #0f1115)",
      font: "12px/18px inherit", fontWeight: 500,
      cursor: disabled ? "not-allowed" : "pointer",
      flex: "none",
    },
  }, children);
}

/** 一行「已找到 / 缺失 / 判断不了」。 */
function ModelRow({ name, note, found, size }) {
  /**
   * ★ 三态：true 绿 / false 红 / null 灰（判断不了）。
   *   把 null 当 false 会在 ComfyUI 没开时报「全缺失」，误导用户。
   */
  const dotColor = found === true
    ? "var(--dsw-alias-state-success-primary, #3fb950)"
    : found === false
      ? "var(--dsw-alias-state-error-primary, #f85149)"
      : "var(--dsw-alias-label-tertiary, #81858c)";

  return h("div", {
    style: {
      display: "flex", alignItems: "flex-start", gap: 8,
      padding: "6px 0",
      borderBottom: "0.5px solid var(--dsw-alias-border-l2, #0000001a)",
    },
  },
    /* 状态点 */
    h("span", {
      style: {
        width: 6, height: 6, borderRadius: "50%", marginTop: 5,
        background: dotColor,
        flex: "none",
      },
      "aria-hidden": "true",
    }),
    h("div", { style: { flex: "1 1 auto", minWidth: 0 } },
      h("div", {
        style: {
          fontSize: 12, lineHeight: "17px",
          color: "var(--dsw-alias-label-primary, #0f1115)",
          wordBreak: "break-all",
        },
      }, name),
      note
        ? h("div", {
            style: {
              fontSize: 11, lineHeight: "15px", marginTop: 1,
              color: "var(--dsw-alias-label-tertiary, #81858c)",
            },
          }, note)
        : null
    ),
    size
      ? h("span", {
          style: {
            fontSize: 11, flex: "none",
            color: "var(--dsw-alias-label-tertiary, #81858c)",
            fontVariantNumeric: "tabular-nums",
          },
        }, size)
      : null
  );
}

/**
 * 设置页主体。
 *
 * ★ 所有网络动作都容错：桥 404 / 网络断，页面本身不能白。
 *   每个 try/catch 都把错误显示出来，不吞。
 */
export function ComfySettingsSection() {
  const [cfg, setCfg] = React.useState(null);          // 当前配置
  const [info, setInfo] = React.useState(null);        // 存哪了
  const [models, setModels] = React.useState(null);    // 模型清单
  const [health, setHealth] = React.useState(null);    // /health（版本/延迟，兼容旧渲染）
  const [doctor, setDoctor] = React.useState(null);    // /doctor 五项体检结果
  const [busy, setBusy] = React.useState("");
  const [msg, setMsg] = React.useState(null);          // { kind, text }

  /* 表单草稿（用户改动先存这里，点保存才提交） */
  const [draft, setDraft] = React.useState({ comfyPath: "", modelsDir: "", outputDir: "", inputDir: "" });

  const j = async (path, init) => {
    const res = await fetch(BRIDGE + path, init);
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = { error: text.slice(0, 200) }; }
    if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
    return body;
  };

  const load = React.useCallback(async () => {
    try {
      const r = await j("/config");
      setCfg(r);
      setInfo(r?._info ?? null);
      setDraft({
        comfyPath: r?.comfyPath ?? "",
        modelsDir: r?.modelsDir ?? "",
        outputDir: r?.outputDir ?? "",
        inputDir: r?.inputDir ?? "",
      });
    } catch (e) {
      setMsg({ kind: "error", text: `读取配置失败：${e.message}` });
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const doSave = async () => {
    setBusy("save");
    setMsg(null);
    try {
      const r = await j("/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      setCfg(r);
      setInfo(r?._info ?? null);
      setMsg({ kind: "ok", text: "已保存并立即生效" });
    } catch (e) {
      /**
       * ★ 保存失败必须显式报错。
       *   用户以为存上了但没存 → 下次启动又找不到 ComfyUI → 无从排查。
       */
      setMsg({ kind: "error", text: `保存失败：${e.message}` });
    } finally { setBusy(""); }
  };

  const doCheck = async () => {
    setBusy("check");
    setMsg(null);
    try {
      /**
       * ★★ 2026-10-23 改：体检改走 /doctor（E3 要求五项全覆盖）
       *
       *   主人原话：「一键体检：ComfyUI 目录对不对、模型齐不齐、
       *              ffmpeg 在不在、端到端探活」
       *
       *   之前这里只查 /health 与 /models/required 两项，
       *   目录有效性和 ffmpeg 完全没覆盖 —— 用户配错目录只能靠猜。
       *
       *   ★ /doctor 的返回结构是固定的 checks 数组，每项带 ok/detail/fix，
       *     所以这里不需要自己判断，直接把结果交给渲染层。
       *   ★ 仍然并行拉 models（那份带每个模型的明细，/doctor 只给汇总）。
       */
      const [doc, md] = await Promise.all([
        j("/doctor"),
        j("/models/required").catch(() => null),
      ]);
      setDoctor(doc);
      setModels(md);
      /* health 兼容旧渲染分支（版本/延迟），失败不影响体检结果 */
      const hlt = await j("/health").catch(() => null);
      if (hlt) setHealth(hlt);

      setMsg({
        kind: doc?.ok ? "ok" : "error",
        text: doc?.summary ?? (doc?.ok ? "环境完整" : "环境有问题"),
      });
    } catch (e) {
      setMsg({ kind: "error", text: `体检失败：${e.message}` });
    } finally { setBusy(""); }
  };

  const doStartComfy = async () => {
    setBusy("start");
    setMsg(null);
    try {
      const r = await j("/ensure", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      setMsg({
        kind: r?.ok ? "ok" : "error",
        text: r?.reason ?? (r?.ok ? "已启动" : "启动失败"),
      });
      /* ★ needSetup ⇒ 明确引导去填路径，不是说一句「失败了」就完 */
      if (r?.needSetup) {
        setMsg({ kind: "error", text: `需要先填 ComfyUI 路径。${r.reason ?? ""}` });
      }
    } catch (e) {
      setMsg({ kind: "error", text: `启动失败：${e.message}` });
    } finally { setBusy(""); }
  };

  const statusOf = (v) => {
    if (!v) return { ok: false, text: "未填" };
    /* 只做「像不像路径」的轻量判断，真实检测在体检里 */
    const looksLikePath = /^[A-Za-z]:[\\/]/.test(v) || v.startsWith("/");
    return looksLikePath ? { ok: true, text: "已填" } : { ok: false, text: "看起来不是绝对路径" };
  };

  return h("div", { style: { fontSize: 13, lineHeight: "20px" } },

    /* ── 说明 ── */
    h("div", {
      style: {
        marginBottom: 16, padding: "8px 10px",
        borderRadius: 6,
        background: "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05))",
        fontSize: 12, lineHeight: "18px",
        color: "var(--dsw-alias-label-secondary, #61666b)",
      },
    },
      "插件不内置任何本机路径。填好下面四项，状态栏那个 ComfyUI 圆点就能一键启停。"),

    /* ── 四个路径 ── */
    h(Field, {
      label: "ComfyUI 安装目录",
      value: draft.comfyPath,
      onChange: (v) => setDraft((d) => ({ ...d, comfyPath: v })),
      status: statusOf(draft.comfyPath),
      placeholder: "例如 D:\\ComfyUI   或   C:\\ComfyUI_windows_portable\\ComfyUI",
      hint: "该目录下应有 ComfyUI\\main.py 与 ComfyUI\\.venv\\Scripts\\python.exe",
    }),

    /**
     * ★★ 2026-10-23 补 E1 缺项：模型放置目录
     *
     *   主人原话：「需要增加一个模型配置页面，填模型放置目录，comfy ui目录，
     *             然后模型需求清单列出来让用户去下载」
     *
     *   前两版我只做了 comfyPath / outputDir / inputDir —— 把「模型放置目录」漏了。
     *   而模型恰恰是换机器时最大的门槛（H3 主模型 19.5GB）。
     *
     * ── 这一项影响什么
     *   ① 模型清单的「已找到」判定：优先用 ComfyUI 的 /object_info（权威），
     *      但它读不到时（ComfyUI 未启动 / 自定义目录没写进 extra_model_paths.yaml），
     *      可以退回本地目录扫描。
     *   ② 缺失模型时能告诉用户「放到这个目录的哪个子目录」。
     */
    h(Field, {
      label: "模型放置目录（models 根目录）",
      value: draft.modelsDir,
      onChange: (v) => setDraft((d) => ({ ...d, modelsDir: v })),
      status: statusOf(draft.modelsDir),
      placeholder: "例如 D:\\ComfyUI\\models   或   C:\\ComfyUI_windows_portable\\ComfyUI\\models",
      hint: "留空则用 <ComfyUI>\\models。模型清单的「缺失」项会提示应放到这个目录下的哪个子目录。",
    }),

    h(Field, {
      label: "输出目录（产物写到哪）",
      value: draft.outputDir,
      onChange: (v) => setDraft((d) => ({ ...d, outputDir: v })),
      status: statusOf(draft.outputDir),
      placeholder: "留空则用 <ComfyUI>\\output",
      hint: "★ 建议显式填。不填时产物可能和你在 ComfyUI 里看到的不是同一批。",
    }),

    h(Field, {
      label: "输入目录（上传的素材写到哪）",
      value: draft.inputDir,
      onChange: (v) => setDraft((d) => ({ ...d, inputDir: v })),
      status: statusOf(draft.inputDir),
      placeholder: "留空则用 <ComfyUI>\\input",
    }),

    /* ── 操作按钮 ── */
    h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 } },
      h(Btn, { onClick: doSave, primary: true, disabled: busy === "save" },
        busy === "save" ? "保存中…" : "保存"),
      h(Btn, { onClick: doCheck, disabled: busy === "check" },
        busy === "check" ? "检测中…" : "体检"),
      h(Btn, { onClick: doStartComfy, disabled: busy === "start" },
        busy === "start" ? "启动中…" : "启动 ComfyUI"),
      h(Btn, { onClick: load }, "重新读取")
    ),

    /* ── 配置存哪了 ── */
    info
      ? h("div", {
          style: {
            marginBottom: 12, fontSize: 11, lineHeight: "16px",
            color: "var(--dsw-alias-label-tertiary, #81858c)",
            wordBreak: "break-all",
          },
        },
          `配置文件：${info.path}`,
          info.fallbackToTmp
            ? h("span", { style: { color: "rgb(207,34,46)" } }, "（在临时目录，重启可能丢失）")
            : null,
          info.mayBeWrongProfile
            ? h("span", { style: { color: "rgb(207,34,46)" } },
                "（来自 DSH_PROFILE_DIR，可能属于另一个 profile；可用环境变量 COMFY_BRIDGE_CONFIG_DIR 指定）")
            : null
        )
      : null,

    /* ── 消息条 ── */
    msg
      ? h("div", {
          role: "status",
          style: {
            marginBottom: 14, padding: "6px 10px", borderRadius: 6,
            fontSize: 12, lineHeight: "18px",
            background: msg.kind === "error"
              ? "rgba(248,81,73,.10)"
              : msg.kind === "warn"
                ? "rgba(210,153,34,.12)"
                : "rgba(63,185,80,.10)",
            color: msg.kind === "error"
              ? "rgb(207,34,46)"
              : msg.kind === "warn"
                ? "rgb(154,103,0)"
                : "rgb(31,136,61)",
          },
        }, msg.text)
      : null,

    /* ── 体检结果（/doctor 五项）── */
    /**
     * ★ 2026-10-23：新增五项体检渲染
     *
     *   主人要求：「一键体检：ComfyUI 目录对不对、模型齐不齐、
     *              ffmpeg 在不在、端到端探活」
     *
     *   每行：状态点 + 标签 + 详情；不通过时额外给一行【怎么修】。
     *   ★ 三态：true 绿 / false 红 / null 灰（判断不了）。
     */
    doctor && Array.isArray(doctor.checks)
      ? h("div", { style: { marginBottom: 14 } },
          h("div", {
            style: {
              display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6,
            },
          },
            h("span", {
              style: {
                fontSize: 12, fontWeight: 600,
                color: "var(--dsw-alias-label-primary, #0f1115)",
              },
            }, "环境体检"),
            h("span", {
              style: {
                fontSize: 11,
                color: doctor.ok
                  ? "rgb(31,136,61)"
                  : "rgb(207,34,46)",
              },
            }, doctor.summary ?? "")),
          doctor.checks.map((c) =>
            h("div", {
              key: c.id,
              style: {
                display: "flex", alignItems: "flex-start", gap: 8,
                padding: "5px 0",
                borderBottom: "0.5px solid var(--dsw-alias-border-l2, #0000001a)",
              },
            },
              h("span", {
                style: {
                  width: 6, height: 6, borderRadius: "50%", marginTop: 5, flex: "none",
                  background: c.ok === true
                    ? "var(--dsw-alias-state-success-primary, #3fb950)"
                    : c.ok === false
                      ? "var(--dsw-alias-state-error-primary, #f85149)"
                      : "var(--dsw-alias-label-tertiary, #81858c)",
                },
                "aria-hidden": "true",
              }),
              h("div", { style: { flex: "1 1 auto", minWidth: 0 } },
                h("div", {
                  style: {
                    fontSize: 12, lineHeight: "17px",
                    color: "var(--dsw-alias-label-primary, #0f1115)",
                  },
                }, c.label),
                c.detail
                  ? h("div", {
                      style: {
                        fontSize: 11, lineHeight: "15px", marginTop: 1,
                        color: "var(--dsw-alias-label-tertiary, #81858c)",
                        wordBreak: "break-all",
                      },
                    }, c.detail)
                  : null,
                /* ★ 只在失败时给修复建议 —— 通过了不需要看怎么修 */
                c.ok === false && c.fix
                  ? h("div", {
                      style: {
                        fontSize: 11, lineHeight: "15px", marginTop: 2,
                        color: "rgb(154,103,0)",
                      },
                    }, `→ ${c.fix}`)
                  : null
              )))
        )
      : null,

    /* ── health 摘要（保留：版本/延迟/工作流数）── */
    health
      ? h("div", { style: { marginBottom: 14 } },
          h("div", {
            style: {
              fontSize: 12, fontWeight: 600, marginBottom: 6,
              color: "var(--dsw-alias-label-primary, #0f1115)",
            },
          }, "ComfyUI 状态"),
          h("div", {
            style: { fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-secondary, #61666b)" },
          },
            health.ok
              ? `已连接 · 版本 ${health.comfyuiVersion ?? "未知"} · 延迟 ${health.latencyMs ?? "?"}ms · ${health.modes ?? "?"} 个工作流`
              : `未连接${health.error ? `：${health.error}` : ""}`)
        )
      : null,

    /* ── 模型清单 ── */
    models
      ? h("div", null,
          (() => {
            const items = models.items ?? [];
            /**
             * ★★ unknown 必须区分出来（2026-10-23）
             *
             *   后端在 ComfyUI 不可用时把每条 found 设为 null，
             *   并给 unknown: true。
             *   如果前端把 null 当成 false 显示红点，
             *   用户会看到「26 个模型全缺失」——而实际只是 ComfyUI 没开。
             *   ⇒ 三种状态：已找到 / 缺失 / 判断不了。
             */
            const isUnknown = models.unknown === true;
            const foundCount = items.filter((x) => x.found === true).length;
            const missingCount = items.filter((x) => x.found === false).length;

            const summary = isUnknown
              ? `模型需求（无法判断 —— ComfyUI 未连接，共 ${items.length} 项）`
              : `模型需求（${foundCount}/${items.length} 已就位${missingCount ? `，缺 ${missingCount}` : ""} · ${(models.groups ?? []).length} 类）`;

            return h("div", null,
              h("div", {
                style: {
                  fontSize: 12, fontWeight: 600, marginBottom: 2,
                  color: "var(--dsw-alias-label-primary, #0f1115)",
                },
              }, summary),

              isUnknown
                ? h("div", {
                    style: {
                      fontSize: 11, lineHeight: "16px", marginBottom: 6, padding: "5px 8px",
                      borderRadius: 5,
                      background: "rgba(210,153,34,.12)",
                      color: "rgb(154,103,0)",
                    },
                  }, "ComfyUI 未连接，无法确认这些模型是否存在。启动 ComfyUI 后再体检。")
                : null,

              items.length === 0
                ? h("div", {
                    style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary, #81858c)", padding: "6px 0" },
                  }, "工作流没有声明模型依赖，或没读到工作流文件。")
                : (() => {
                    /**
                     * ★★ 2026-10-23 改：按【作用】分组渲染
                     *
                     *   主人：「然后还要根据模型作用分类吧？」
                     *        「你现在弄一起，看起来也看不懂」
                     *
                     *   原来 26 项平铺，看不出哪个是 LoRA、哪个是 VAE、
                     *   哪个缺了会真的跑不起来。
                     *
                     *   现在按后端给的 groups 渲染（后端用【工作流字段名】分类，
                     *   不是按文件名猜 —— 字段名就是 ComfyUI 加载器的输入名）。
                     *
                     *   ★ 每组标题后面直接给「缺 N」，用户一眼看到哪一类不齐。
                     *   ★ 组标题下面一行写【该放哪个目录】—— 这是最实用的信息。
                     */
                    const groups = Array.isArray(models.groups) ? models.groups : null;
                    if (!groups) {
                      /* 后端老版本没有 groups ⇒ 退回平铺，不白屏 */
                      return h("div", null,
                        items.map((m, i) =>
                          h(ModelRow, {
                            key: `${m.name}-${i}`,
                            name: m.name,
                            note: m.note,
                            found: m.found,
                            size: m.sizeText,
                          })));
                    }
                    return h("div", null,
                      groups.map((g) => {
                        const bad = (g.missing ?? 0) + (g.unknownCnt ?? 0);
                        return h("div", { key: g.role, style: { marginTop: 10 } },
                          /* 组标题 */
                          h("div", {
                            style: {
                              display: "flex", alignItems: "baseline", gap: 6,
                              marginBottom: 2,
                            },
                          },
                            h("span", {
                              style: {
                                fontSize: 12, fontWeight: 600,
                                color: "var(--dsw-alias-label-primary, #0f1115)",
                              },
                            }, g.label),
                            h("span", {
                              style: {
                                fontSize: 11,
                                color: g.missing > 0
                                  ? "rgb(207,34,46)"
                                  : "var(--dsw-alias-label-tertiary, #81858c)",
                              },
                            },
                              `${g.items.length} 个` +
                              (g.missing ? ` · 缺 ${g.missing}` : "") +
                              (g.unknownCnt ? ` · ${g.unknownCnt} 未知` : "")),
                          ),
                          /* ★ 该放哪个目录 —— 最实用的信息，放在组标题下 */
                          h("div", {
                            style: {
                              fontSize: 11, lineHeight: "15px", marginBottom: 2,
                              color: "var(--dsw-alias-label-tertiary, #81858c)",
                              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                            },
                          }, g.dir),
                          h("div", null,
                            g.items.map((m, i) =>
                              h(ModelRow, {
                                key: `${m.name}-${i}`,
                                name: m.name,
                                /* ★ 显示来源字段名，方便对着工作流核对 */
                                note: (m.byField ? `[${m.byField}] ` : "") + (m.note ?? ""),
                                found: m.found,
                                size: m.sizeText,
                              })))
                        );
                      }));
                  })()
            );
          })()
        )
      : null
  );
}



