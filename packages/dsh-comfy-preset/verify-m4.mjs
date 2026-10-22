/**
 * M4 验收 —— presets 是纯文件，验四件事：
 *   ① preset.yml 有 name / description / order
 *   ② agent.cordis.yml 是合法 YAML，且含 persona / skills / tools 三行
 *   ③ skills/comfy-mode-dispatch/SKILL.md 有 frontmatter（name + description）
 *   ④ persona 里的 mode 表与 M1 实际报告的模式一致（不写死过期内容）
 *
 * 第 ④ 项是关键：preset 里若写了 krea2/qwen21-edit/yz，
 * 而 M1 实际只报 krea2/qwen21/yz，就是文档与实现脱节。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = process.env.BRIDGE_URL ?? 'http://127.0.0.1:19499/comfy-bridge';
const COOKIE_FILE = 'C:/Users/Administrator/dsh-tok.txt';

let pass = 0, fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? '\n     ' + detail : ''}`); fail++; failures.push(name); }
}

// 极简 YAML 检查（不引依赖，只查结构）
function yamlRows(text) {
  return text.split('\n')
    .filter((l) => /^- id:/.test(l))
    .map((l) => l.replace(/^- id:\s*/, '').trim());
}

console.log('═══ ① preset.yml ═══');
const presetPath = path.join(HERE, 'preset.yml');
const preset = fs.existsSync(presetPath) ? fs.readFileSync(presetPath, 'utf8') : '';
check('文件存在', preset.length > 0);
check('有 name', /^name:\s*\S+/m.test(preset));
check('有 description', /^description:\s*\S+/m.test(preset));
check('有 order', /^order:\s*\d+/m.test(preset));
const order = Number((preset.match(/^order:\s*(\d+)/m) ?? [])[1]);
console.log(`     order=${order}`);

console.log('\n═══ ② agent.cordis.yml ═══');
const agentPath = path.join(HERE, 'agent.cordis.yml');
const agent = fs.existsSync(agentPath) ? fs.readFileSync(agentPath, 'utf8') : '';
check('文件存在', agent.length > 0);
const rows = yamlRows(agent);
console.log(`     行：${rows.join(', ')}`);
check('有 persona 行', rows.includes('persona'), `实际 ${rows.join(',')}`);
check('有 skills 行', rows.includes('skills'));
check('有 tools 行', rows.some((r) => r.startsWith('tools')));
check('persona 有 prefix', /prefix:\s*\|/.test(agent));
check('persona 含三个 mode id', ['krea2', 'qwen21-edit', 'yz'].every((m) => agent.includes(m)),
  '缺：' + ['krea2', 'qwen21-edit', 'yz'].filter((m) => !agent.includes(m)).join(','));
check('persona 含 17k+5 网格', agent.includes('17k+5'));

console.log('\n═══ ③ SKILL.md ═══');
const skillPath = path.join(HERE, 'skills', 'comfy-mode-dispatch', 'SKILL.md');
const skill = fs.existsSync(skillPath) ? fs.readFileSync(skillPath, 'utf8') : '';
check('文件存在', skill.length > 0);
check('有 frontmatter', skill.startsWith('---'));
const fm = skill.slice(0, skill.indexOf('\n---', 4) + 1);
check('frontmatter 有 name', /^name:\s*\S+/m.test(fm));
check('frontmatter 有 description', /^description:\s*\S+/m.test(fm));
const descLen = ((fm.match(/description:\s*(.+)/) ?? [])[1] ?? '').length;
console.log(`     description ${descLen} 字符`);
check('description 足够长（> 50）', descLen > 50, `实际 ${descLen}`);
check('技能含三个 mode', ['krea2', 'qwen21-edit', 'yz'].every((m) => skill.includes(m)));

console.log('\n═══ ④ preset 的 mode 表 vs M1 实际报告 ═══');
try {
  let cookie = '';
  if (fs.existsSync(COOKIE_FILE)) {
    const tok = fs.readFileSync(COOKIE_FILE, 'utf8').trim();
    cookie = `dsh-auth-CK36o8O6fn6VWHrnbEp0bsjzKPKRmilHp-TBfPBH65k=${tok}`;
  }
  const res = await fetch(BRIDGE + '/modes', { headers: { Cookie: cookie } });
  const modes = await res.json();
  const actual = modes.map((m) => m.id).sort();
  console.log(`     M1 实际：${actual.join(', ')}`);

  // preset 里提到的每个 mode 都必须真实存在
  const claimed = ['krea2', 'qwen21-edit', 'yz'].filter((m) => agent.includes(m) || skill.includes(m));
  const missing = claimed.filter((m) => !actual.includes(m));
  check('preset 声称的 mode 在 M1 里都存在', missing.length === 0,
    `M1 缺：${missing.join(', ')}（实际有 ${actual.join(',')}）`);
} catch (err) {
  check('M1 可达', false, err.message);
}

console.log('\n' + '═'.repeat(54));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(' · ')}`);
  process.exit(1);
}
console.log('  M4 验收全过');
