// 路由自检（运行时）：代币记录里的平台 / 盘型 / pad 和「发现它的来源」对不上时，在 live.log 和页面上大声报警。
// 起因：2026-10-28 gangChain 里 track / pad 被行尾注释吞掉，链上 V2 / V3 新盘全被记成老盘，买入发到老盘 0x315B 回滚 UnknownToken。
// 这里的期望值只从「哪个合约发出的创建事件」推出来，不读被检查的那段代码，所以那段代码再被改坏也能发现。
// 只读：不发交易。下单前发现「来源确定、记录不对」的硬矛盾会拦下这笔订单（反正会回滚）；ROUTE_GUARD=warn 只报警不拦。
import { EventEmitter } from 'node:events';
import { GANG_PAD as GANG_OLD_PAD } from './gangTrade.js';
import { V2_PADS } from './gangV2Pads.js';
import { isV3Pad, T_V3_CREATED, T_FAIR_CREATED } from './gangV3.js';

export const routeEvents = new EventEmitter();   // 'alert' (row)
export const routeAlerts = [];   // 最近的报警（新的在前），页面初次加载时从 /api/state 读
const seen = new Map();
const BLOCK = (process.env.ROUTE_GUARD || 'block') !== 'warn';
const lc = (a) => String(a || '').toLowerCase();
const OLD = lc(GANG_OLD_PAD), V2 = new Set(V2_PADS.map(lc));
const MODULE = { v1: '老盘 0x315B ', v2: 'V2 / V3 pad ', v3: 'V2 / V3 pad ', v3fair: '打新 Router ' };   // 盘型 → 下单走的合约（liveTrader.useGang / useGangV2 / fairMinting）

// 发出创建事件的合约 → 应该是哪种 Gang 盘。认不出的合约返回 null（不检查）
export function expectedGangTrack(pad, topic0) {
  const p = lc(pad);
  if (isV3Pad(p)) return topic0 === T_FAIR_CREATED ? 'v3fair' : 'v3';
  if (topic0 === T_V3_CREATED || topic0 === T_FAIR_CREATED) return null;   // V3 事件但 pad 还没核对过：verifyV3Pad 会处理
  if (p === OLD) return 'v1';
  if (V2.has(p)) return 'v2';
  return null;
}

export function alert(where, t, problems) {
  const key = `${lc(t?.address)}|${problems.join(';')}`;
  if (seen.has(key) && Date.now() - seen.get(key) < 600_000) return;   // 同一个币同样的问题 10 分钟只报一次
  seen.set(key, Date.now()); if (seen.size > 2000) seen.delete(seen.keys().next().value);
  const row = { at: Date.now(), where, token: lc(t?.address), symbol: t?.symbol || '?', problems };
  routeAlerts.unshift(row); if (routeAlerts.length > 50) routeAlerts.length = 50;
  console.error(`\n[路由自检 ✗✗✗] ${where} · ${row.symbol} ${row.token}\n  ${problems.join('\n  ')}\n  （这个币的买卖可能发到错误的合约；请检查最近改过的代码，修好前别手动买它）\n`);
  routeEvents.emit('alert', row);
}

// gangChain.handle 产出的新盘对象：track / pad / 报价币是否和发出事件的合约一致
export function checkGangChain(it) {
  const want = expectedGangTrack(it.srcPad, it.srcTopic), problems = [];
  if (!want) return problems;
  if (it.track !== want) problems.push(`盘型应为 ${want}（创建事件来自 ${it.srcPad}），记录里是 ${it.track ?? '空'}`);
  if (want.startsWith('v3') && lc(it.pad) !== lc(it.srcPad)) problems.push(`V3 pad 应为 ${it.srcPad}，记录里是 ${it.pad ?? '空'}`);
  if (want !== 'v1' && !/^0x[0-9a-f]{40}$/.test(lc(it.quoteAddress))) problems.push(`${want} 盘应带报价币地址，记录里是 ${it.quoteAddress ?? '空'}`);
  if (problems.length) alert('Gang 链上新盘', it, problems);
  return problems;
}

// 行情里的代币记录（liveMarket 的 t）。hard = 来源确定、记录肯定不对（下单前会拦）；soft = 可疑，只报警
export function checkToken(t) {
  const hard = [], soft = [];
  if (!t || t.stage !== 'curve' || t.migrated) return { hard, soft };
  if (t.source === 'gang') {
    if (!['v1', 'v2', 'v3', 'v3fair'].includes(t.gangTrack)) hard.push(`Gang 内盘的盘型无效：${t.gangTrack ?? '空'}`);
    const want = t._srcPad ? expectedGangTrack(t._srcPad, t._srcTopic) : null;
    if (want && MODULE[t.gangTrack] !== MODULE[want]) hard.push(`盘型应为 ${want}（链上创建事件来自 ${t._srcPad}），记录里是 ${t.gangTrack}：买卖会发到${MODULE[t.gangTrack] || '错误的'}合约`);   // V2 / V3 同一套买卖（按 curves() 找 pad），互相标错不影响下单，不报
    if (t.gangTrack && t.gangTrack !== 'v1' && !t.quoteAddress) soft.push(`${t.gangTrack} 盘没有报价币地址`);
  } else if (t.source === 'agent-curve') {
    if (!/^0x[0-9a-f]{40}$/.test(lc(t.market))) hard.push(`Flap Agent Curve 没有 market 合约地址：${t.market ?? '空'}`);
    if (t.quote && t.quote !== 'BNB' && !t.quoteAddress) hard.push(`Flap Agent Curve 报价币 ${t.quote} 没有地址`);
  } else if (t.source === 'flap-nft') {
    if (t.quote && t.quote !== 'BNB' && !t.quoteAddress) soft.push(`Flap 门槛盘报价币 ${t.quote} 没有地址`);
  }
  return { hard, soft };
}

export function watchToken(t, where) {
  const { hard, soft } = checkToken(t);
  if (hard.length || soft.length) alert(where, t, [...hard, ...soft]);
  return hard.length + soft.length === 0;
}

// 下单前调用：硬矛盾直接拦下（不发交易），并报警
export function preTrade(t, side) {
  const { hard, soft } = checkToken(t);
  if (!hard.length && !soft.length) return;
  alert(`下单前（${side === 'buy' ? '买' : '卖'}）`, t, [...hard, ...soft]);
  if (hard.length && BLOCK) throw Object.assign(new Error(`路由自检不通过，已拦下这笔订单（没有发出交易）：${hard.join('；')}`), { code: 'ROUTE_GUARD' });
}
