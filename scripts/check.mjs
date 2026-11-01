// 发版前检查：npm run check（打 tag 前必须全绿）
//   1. 静态检查：node --check + 「行尾注释吞掉字段」（scripts/check/lint.mjs）
//   2. 离线路由检查：构造链上创建事件走一遍发现 → 行情 → 路由代码（scripts/check/offline.mjs）
//   3. 在线路由体检：对正在运行的终端（默认 8788）抽查各类内盘币，链上核对 + eth_call 模拟买入，只读（scripts/check/routes.mjs）
// --offline 只跑 1、2；连不上终端时第 3 步记为跳过（--strict 时算失败）
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2), offline = args.includes('--offline'), strict = args.includes('--strict');
const pass = args.filter((a) => !['--offline', '--strict'].includes(a));
const steps = [['静态检查', 'lint.mjs', []], ['离线路由检查', 'offline.mjs', []], ...(offline ? [] : [['在线路由体检', 'routes.mjs', pass]])];
let bad = 0;
for (const [name, f, a] of steps) {
  console.log(`\n=== ${name} ===`);
  const r = spawnSync(process.execPath, [path.join(HERE, 'check', f), ...a], { stdio: 'inherit', timeout: 300_000 });
  if (r.status === 2 && !strict) continue;   // 在线体检跳过（终端没开）
  if (r.status !== 0) bad++;
}
console.log(bad ? `\n✗ 发版前检查没通过（${bad} 步失败），别打 tag` : '\n✓ 发版前检查全部通过');
process.exit(bad ? 1 : 0);
