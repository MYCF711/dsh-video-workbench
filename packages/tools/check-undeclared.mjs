#!/usr/bin/env node
/**
 * 检查「引用了未声明的变量」—— ReferenceError 的静态形态。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要这个工具
 *
 *   2026-10-23 实测事故：
 *     我给 onGenerate 加「步数太小」校验时写了 `mode?._workflow`，
 *     而组件里工作流对象叫 `currentMode` —— `mode` 根本没声明。
 *
 *     症状：点「生成」毫无反应。不报错、不发请求、按钮不变。
 *     页面上抓到的异常是 ReferenceError: mode is not defined。
 *
 *   ★ 为什么难发现：
 *     可空链 `?.` 只能防「值是 null/undefined」，
 *     **防不住「变量根本没声明」** —— 未声明会直接抛 ReferenceError。
 *
 *   ★ 为什么现有手段都抓不到：
 *     · `node --check` 只查语法，`mode?.x` 是合法语法
 *     · 任何断言都不会触发（除非刚好执行到那一行）
 *     · IDE 能查，但写的时候容易以为「有 ?. 就安全」
 *
 * ── 为什么用 acorn 而不是自己写正则
 *
 *   ★ 我试了三版手写，全部不合格（记下来避免重走）：
 *     第一版「声明收集 + 成员访问正则」：
 *       8 处全误报（函数参数、解构名被判未声明），正则在大文件上还爆栈。
 *     第二版「全文包含判断」：
 *       误报归零，但把真实 bug 也漏了 ——
 *       因为 `applyDefaults(mode)` 的形参让 mode「看起来声明过」。
 *     第三版「函数级作用域」：
 *       37 处误报（catch 变量、箭头参数、跨行解构）。
 *
 *   ⇒ 结论：作用域分析必须用真 AST。手工做必然漏，方向是错的。
 *
 * ── acorn 装在哪
 *   packages/tools/node_modules/acorn（开发依赖，不进插件运行时）
 *
 *   ★ 装的时候踩了坑：`npm install acorn` 报 EPERM mkdir 'D:\\' ——
 *     npm 在中文路径下把 prefix 解析错了，跑去 D:\ 根建目录被拒。
 *     修法：显式 `--prefix <绝对路径> --no-package-lock`。
 *
 * 用法：
 *   node tools/check-undeclared.mjs [目录...]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

/* acorn 装在本目录的 node_modules 里 —— 用 createRequire 从本文件位置解析 */
const requireFromHere = createRequire(import.meta.url);
let acorn;
try {
  acorn = requireFromHere("acorn");
} catch {
  console.log("");
  console.log("  ❌ 找不到 acorn。装法：");
  console.log(`     cd "${HERE}"`);
  console.log("     npm install acorn --no-save --prefix . --no-package-lock");
  console.log("");
  console.log("     ★ 必须加 --prefix，否则在中文路径下 npm 会去 D:\\ 根建目录而报 EPERM。");
  console.log("");
  process.exit(2);
}

const dirs = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
    "dsh-comfy-workbench-tab/src",
    "dsh-comfy-bridge/src",
    "dsh-editor/src",
    "dsh-video-knowledge/src",
  ].map((d) => path.join(ROOT, d));

/** 运行时全局名 —— 不算未声明。 */
const GLOBALS = new Set([
  "Object", "Array", "String", "Number", "Boolean", "Symbol", "BigInt",
  "Math", "JSON", "Date", "RegExp", "Error", "TypeError", "RangeError",
  "SyntaxError", "ReferenceError", "EvalError", "URIError", "AggregateError",
  "Promise", "Map", "Set", "WeakMap", "WeakSet", "WeakRef", "FinalizationRegistry",
  "Proxy", "Reflect", "Intl", "Infinity", "NaN", "undefined", "globalThis",
  "Function", "ArrayBuffer", "SharedArrayBuffer", "Uint8Array", "Int8Array",
  "Uint16Array", "Int16Array", "Uint32Array", "Int32Array", "Float32Array",
  "Float64Array", "BigInt64Array", "BigUint64Array", "DataView", "Atomics",
  "structuredClone", "queueMicrotask", "setTimeout", "clearTimeout",
  "setInterval", "clearInterval", "console", "performance", "crypto",
  "window", "document", "navigator", "location", "history", "localStorage",
  "sessionStorage", "fetch", "URL", "URLSearchParams", "Headers", "Request",
  "Response", "AbortController", "AbortSignal", "FormData", "Blob", "File",
  "FileReader", "Image", "Audio", "HTMLElement", "Element", "Node", "Event",
  "CustomEvent", "MutationObserver", "IntersectionObserver", "ResizeObserver",
  "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle",
  "matchMedia", "alert", "confirm", "prompt", "atob", "btoa",
  "DOMParser", "XMLSerializer", "WebSocket", "EventSource", "TextDecoder",
  "TextEncoder", "MediaRecorder", "AudioContext", "OffscreenCanvas",
  "requestIdleCallback", "Buffer", "process", "require", "module", "exports",
  "global", "React", "h", "hostRequire", "arguments", "eval", "isNaN",
  "parseInt", "parseFloat", "encodeURIComponent", "decodeURIComponent",
  "encodeURI", "decodeURI",
  /* ★ 2026-10-23：CSS 是浏览器全局（CSS.escape / CSS.supports），不是未声明 */
  "CSS",
]);

/**
 * 对一个 AST 做作用域分析。
 *
 * ★ 只查两种引用点，噪声最小：
 *     · MemberExpression 的对象（a.b 里的 a）
 *     · ChainExpression 里的成员对象（a?.b 里的 a）
 *   不查函数调用的实参 —— 那会把大量属性名误判。
 */
/**
 * 对一个 AST 做【词法作用域】分析。
 *
 * ★★ 2026-10-23 第二次修正：只做「全文声明集合」仍然漏
 *
 *   实测：把真实 bug（onGenerate 里写 `mode?._workflow`）还原回去，
 *   全文集合版仍然报「没有未声明变量」—— 因为 `applyDefaults(mode)`
 *   的形参叫 mode，被收进了同一个 declared 集合。
 *
 *   ⇒ 必须按【作用域链】判：一个引用只能被
 *     ① 它所在函数（或更内层）的声明  ② 外层函数的声明  ③ 全局  看到。
 *     **同级另一个函数的形参，看不见。**
 *
 * ★ 实现：递归下降，进函数时开新作用域，出函数时关掉。
 */
function analyzeAst(ast) {
  const problems = [];
  const stack = [];   // 作用域栈，每层 Set<string>

  const isDeclared = (name) => {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].has(name)) return true;
    }
    return GLOBALS.has(name);
  };

  /** 把模式里的名字声明进【当前】作用域。 */
  function declarePattern(node) {
    if (!node) return;
    const top = stack[stack.length - 1];
    switch (node.type) {
      case "Identifier":
        top.add(node.name);
        break;
      case "ObjectPattern":
        for (const p of node.properties) {
          if (p.type === "RestElement") declarePattern(p.argument);
          else declarePattern(p.value);
        }
        break;
      case "ArrayPattern":
        for (const el of node.elements) if (el) declarePattern(el);
        break;
      case "RestElement":
        declarePattern(node.argument);
        break;
      case "AssignmentPattern":
        declarePattern(node.left);
        break;
      default:
        break;
    }
  }

  /** 把 var / function 声明提升到给定作用域。 */
  function hoist(node, scope) {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "VariableDeclaration" && node.kind === "var") {
      for (const d of node.declarations) {
        const collect = (p) => {
          if (!p) return;
          if (p.type === "Identifier") scope.add(p.name);
          else if (p.type === "ObjectPattern") p.properties.forEach((x) =>
            collect(x.type === "RestElement" ? x.argument : x.value));
          else if (p.type === "ArrayPattern") p.elements.forEach((x) => collect(x));
          else if (p.type === "AssignmentPattern") collect(p.left);
          else if (p.type === "RestElement") collect(p.argument);
        };
        collect(d.id);
      }
    }
    /* ★ 不进入嵌套函数 —— 它们有自己的作用域 */
    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression"
        || node.type === "ArrowFunctionExpression" || node.type === "ClassDeclaration"
        || node.type === "ClassExpression") {
      if (node.type === "FunctionDeclaration" && node.id) scope.add(node.id.name);
      if (node.type === "ClassDeclaration" && node.id) scope.add(node.id.name);
      return;
    }
    for (const k of Object.keys(node)) {
      if (k === "type" || k === "loc" || k === "start" || k === "end") continue;
      const v = node[k];
      if (Array.isArray(v)) { for (const x of v) hoist(x, scope); }
      else if (v && typeof v.type === "string") hoist(v, scope);
    }
  }

  /** 记录一个成员访问的基对象是否未声明。 */
  function checkMemberBase(node) {
    let o = node.object;
    while (o && (o.type === "MemberExpression" || o.type === "ChainExpression")) {
      o = o.type === "MemberExpression" ? o.object : o.expression;
    }
    if (o && o.type === "Identifier" && !isDeclared(o.name)) {
      problems.push({ name: o.name, line: o.loc?.start?.line ?? 0 });
    }
  }

  function check(node) {
    if (!node || typeof node.type !== "string") return;

    switch (node.type) {
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression": {
        /* 声明式函数名对外可见 */
        if (node.type === "FunctionDeclaration" && node.id) {
          stack[stack.length - 1].add(node.id.name);
        }
        const scope = new Set();
        stack.push(scope);
        /* 形参 + 函数名自身 */
        if (node.id && node.type !== "FunctionDeclaration") scope.add(node.id.name);
        for (const p of node.params) declarePattern(p);
        /* var 提升 */
        if (node.body && node.body.type === "BlockStatement") hoist(node.body, scope);

        if (node.body) {
          if (node.body.type === "BlockStatement") {
            /* 函数体本身不再开新块作用域 —— 顶层 let/const 归本函数作用域 */
            const body = node.body;
            for (const s of body.body) {
              if (s.type === "VariableDeclaration" && s.kind !== "var") {
                for (const d of s.declarations) declarePattern(d.id);
              }
              if (s.type === "ClassDeclaration" && s.id) scope.add(s.id.name);
            }
            for (const s of body.body) check(s);
          } else {
            check(node.body);
          }
        }
        stack.pop();
        return;
      }

      case "ClassDeclaration":
      case "ClassExpression": {
        if (node.id) stack[stack.length - 1].add(node.id.name);
        const scope = new Set();
        stack.push(scope);
        if (node.superClass) check(node.superClass);
        if (node.body) check(node.body);
        stack.pop();
        return;
      }

      case "CatchClause": {
        const scope = new Set();
        stack.push(scope);
        if (node.param) declarePattern(node.param);
        if (node.body) {
          hoist(node.body, scope);
          /**
           * ★ 2026-10-23 补：catch 块里的 let/const 也要登记
           *
           *   实测误报：subtitle.mjs:187 报 `raw` 未声明，
           *   而 `const raw = ...` 就在同一个 catch 块的 L179。
           *   原因：这里只 hoist 了 var，漏了 let/const。
           */
          for (const s of node.body.body) {
            if (s.type === "VariableDeclaration" && s.kind !== "var") {
              for (const d of s.declarations) declarePattern(d.id);
            }
            if (s.type === "ClassDeclaration" && s.id) scope.add(s.id.name);
            if (s.type === "FunctionDeclaration" && s.id) scope.add(s.id.name);
          }
          for (const s of node.body.body) check(s);
        }
        stack.pop();
        return;
      }

      case "BlockStatement": {
        const scope = new Set();
        stack.push(scope);
        for (const s of node.body) {
          if (s.type === "VariableDeclaration" && s.kind !== "var") {
            for (const d of s.declarations) declarePattern(d.id);
          }
          if (s.type === "ClassDeclaration" && s.id) scope.add(s.id.name);
          if (s.type === "FunctionDeclaration" && s.id) scope.add(s.id.name);
        }
        for (const s of node.body) check(s);
        stack.pop();
        return;
      }

      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement": {
        const scope = new Set();
        stack.push(scope);
        for (const k of ["init", "left", "right", "test", "update", "body"]) {
          const v = node[k];
          if (!v) continue;
          if (v.type === "VariableDeclaration") {
            for (const d of v.declarations) declarePattern(d.id);
          }
          check(v);
        }
        stack.pop();
        return;
      }

      case "VariableDeclarator": {
        if (node.init) check(node.init);
        return;
      }

      case "MemberExpression": {
        checkMemberBase(node);
        check(node.object);
        if (node.computed) check(node.property);
        return;
      }

      case "ChainExpression": {
        /* a?.b 被包成 ChainExpression —— 检查里面的成员基对象 */
        if (node.expression && node.expression.type === "MemberExpression") {
          checkMemberBase(node.expression);
        }
        check(node.expression);
        return;
      }

      default: {
        for (const k of Object.keys(node)) {
          if (k === "type" || k === "loc" || k === "start" || k === "end") continue;
          const v = node[k];
          if (Array.isArray(v)) { for (const x of v) check(x); }
          else if (v && typeof v.type === "string") check(v);
        }
      }
    }
  }

  /* 模块顶层 */
  const top = new Set();
  stack.push(top);

  /**
   * ★★ 2026-10-23 修：export 包裹的声明之前全漏了
   *
   *   实测 6 处误报（VIEW_PREFIX / VIEWS / LOCKABLE / REVERSE_TARGETS /
   *   TRACK_KINDS / TRANSITIONS），全是 `export const XXX = ...` 形式。
   *
   *   根因：ast.body 里它们是 ExportNamedDeclaration，
   *   里面的 declaration 才是 VariableDeclaration。
   *   第一版只判 s.type === "VariableDeclaration"，直接被 export 包住时漏掉。
   *
   *   ⇒ 先剥一层 export：
   *     ExportNamedDeclaration / ExportDefaultDeclaration 都取 .declaration。
   */
  const unwrap = (s) => {
    if (!s) return null;
    if (s.type === "ExportNamedDeclaration" || s.type === "ExportDefaultDeclaration") {
      return s.declaration ?? null;
    }
    return s;
  };

  for (const raw of ast.body) {
    if (raw.type === "ImportDeclaration") {
      for (const sp of raw.specifiers) if (sp.local) top.add(sp.local.name);
    }
    const s = unwrap(raw);
    if (!s) continue;
    if (s.type === "FunctionDeclaration" && s.id) top.add(s.id.name);
    if (s.type === "ClassDeclaration" && s.id) top.add(s.id.name);
    if (s.type === "VariableDeclaration") {
      for (const d of s.declarations) declarePattern(d.id);
    }
  }
  hoist(ast, top);
  for (const raw of ast.body) {
    const s = unwrap(raw);
    if (s) check(s);
  }
  stack.pop();

  return problems;
}

let files = 0;
let problems = 0;

function walkDir(dir) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walkDir(full); continue; }
    if (!/\.m?js$/.test(e.name) || /\.bak/.test(e.name)) continue;
    /* 跳过构建产物：变量名被 minify，AST 里全是短名，静态判不了 */
    if (e.name === "client.js" && /[\\/]lib[\\/]/.test(full)) continue;

    files += 1;
    const src = fs.readFileSync(full, "utf8");

    let ast;
    try {
      ast = acorn.parse(src, {
        ecmaVersion: "latest",
        sourceType: "module",
        locations: true,
        allowHashBang: true,
      });
    } catch (err) {
      console.log(`  ✗ ${full.replace(ROOT + path.sep, "")}  解析失败：${String(err.message).split("\n")[0]}`);
      problems += 1;
      continue;
    }

    const bad = analyzeAst(ast);
    const seen = new Set();
    for (const b of bad) {
      const key = b.name;
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(`  ✗ ${full.replace(ROOT + path.sep, "")}:${b.line}  引用了未声明的 \`${b.name}\``);
      problems += 1;
    }
  }
}

console.log("");
console.log("═".repeat(66));
console.log("  未声明变量检查（acorn 真解析器 · 词法作用域）");
console.log("═".repeat(66));
console.log("");

for (const d of dirs) walkDir(d);

console.log("");
console.log("─".repeat(66));
if (problems === 0) {
  console.log(`  ✅ ${files} 个文件，没有引用未声明的变量`);
  console.log("");
  process.exit(0);
}
console.log(`  ❌ ${files} 个文件里发现 ${problems} 处`);
console.log("");
console.log("  ★ 这类错误不会被 node --check 抓到（语法合法），");
console.log("    也不会被现有断言抓到（除非刚好执行到那一行）。");
console.log("    而它一旦出现在 onGenerate 里，整条生成链路就死了，");
console.log("    界面上却只表现为「点了没反应」。");
console.log("");
process.exit(1);
