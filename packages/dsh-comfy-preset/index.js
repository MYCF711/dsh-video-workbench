/**
 * dsh-comfy-preset —— host 侧入口。
 *
 * 本包【不贡献任何 host 或 client 代码】—— 它只是一个 agent preset 的载体：
 *   preset.yml        预设元数据（name / description / order）
 *   agent.cordis.yml  预设组合（persona + skills + tools）
 *   skills/           技能文件
 *
 * 生成能力全在 dsh-comfy-bridge，本包通过 persona 里的 HTTP 说明来调用。
 * 这样拆分的好处：改 persona / 加技能不会碰到 ComfyUI 桥的代码。
 */
export function apply() {}
