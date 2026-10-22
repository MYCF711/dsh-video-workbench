/**
 * dsh-artcraft-tab · host 侧入口
 *
 * 本插件没有 host 侧能力 —— 纯客户端 UI 挂载。
 * ArtCraft 需要的数据（资产、工程）由 dsh-comfy-workbench-tab 的
 * HTTP 路由提供，本插件只消费。
 */
export const name = "dsh-artcraft-tab";
export function apply() {
  // 无 host 侧能力
}
