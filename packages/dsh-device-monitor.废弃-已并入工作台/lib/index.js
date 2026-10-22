/**
 * Host loader entry —— 直接 re-export src/index-host.mjs（原生 ESM）。
 */
export { apply, inject, name } from "../src/index-host.mjs";
