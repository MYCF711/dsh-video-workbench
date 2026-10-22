/**
 * Host loader entry for dsh-editor.
 *
 * 直接 re-export src/index-host.mjs —— 它是原生 ESM，宿主按 import 加载。
 * 不打包：host 侧有真实的 node 环境，可以直接跑 .mjs。
 */
export { apply, inject, name } from "../src/index-host.mjs";
