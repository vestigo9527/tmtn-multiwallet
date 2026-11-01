// 发版前离线检查（不联网、不读钱包、不发交易）：用构造好的链上「创建」事件走一遍真实代码
//   gangChain.handle → liveMarket.onGangChainToken / upsertGang → liveTrader.route / useGang* / preview 前的路由自检，
// 断言每种 Gang 盘（老盘 / V2 / stocks / V3 / 打新）的盘型、pad、报价币和下单路由；再对 Flap / Four 的记录断言路由。
// 2026-10-28 那次 track / pad 被注释吞掉，这里第一条 V2 / V3 断言就会失败。用法：node scripts/check/offline.mjs
import { ethers } from 'ethers';
import { GangChain, GANG_OLD_PAD, GANG_V2_LAUNCHPAD, GANG_STOCKS_PAD } from '../../engine/live/gangChain.js';
import { T_V3_CREATED, T_FAIR_CREATED, OFFICIAL_V3_PAD } from '../../engine/live/gangV3.js';
import { LiveMarket } from '../../engine/live/liveMarket.js';
import { LiveTrader } from '../../engine/live/liveTrader.js';
import { checkGangChain, checkToken, expectedGangTrack } from '../../engine/live/routeGuard.js';
import { swallowed } from './lint.mjs';

const T_OLD = '0xe57a519fe6a031fac5d360f4b8ce246c86dd280b40dc37b68c0a7cc7394ef9c0';
const T_V2 = '0xd23a447045c377a966a79f59983bae21db7b92fead61df8ace4aea5628043791';
const GANG = '0x0c6302401aa5325c2e36f170f52c00b1d220b405', WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', BNCB = '0x4902c5ebc598265ed2212b559b042de8a5eeec3f';
const coder = ethers.AbiCoder.defaultAbiCoder();
const topic = (a) => ethers.zeroPadValue(a, 32);
const fakeAddr = (n) => ethers.getAddress('0x' + n.toString(16).padStart(40, '0'));
const CREATOR = fakeAddr(0xc0ffee);

const log0 = console.log, err0 = console.error;
console.log = (...a) => { if (!/^\[Gang 链上\]/.test(String(a[0]))) log0(...a); };   // 被测代码自己的日志不打
let fails = 0, passes = 0;
const ok = (cond, msg) => { if (cond) passes++; else { fails++; console.log(`✗ ${msg}`); } };

// 假节点：只回答 handle 可能用到的区块时间；别的调用一律报错（离线）
const provider = { getBlock: async () => ({ timestamp: 1_800_000_000 }), getBlockNumber: async () => 1, call: async () => { throw new Error('offline'); } };

const CASES = [
  { name: 'Gang 老盘', pad: GANG_OLD_PAD, t0: T_OLD, quote: null, track: 'v1', use: 'useGang', route: /^Gang 内盘/ },
  { name: 'Gang V2（GANG 计价）', pad: GANG_V2_LAUNCHPAD, t0: T_V2, quote: GANG, track: 'v2', use: 'useGangV2', route: /^Gang V2 内盘/ },
  { name: 'Gang stocks（BNCB 计价）', pad: GANG_STOCKS_PAD, t0: T_V2, quote: BNCB, track: 'v2', use: 'useGangV2', route: /^Gang V2 内盘/ },
  { name: 'Gang V3（WBNB 计价）', pad: OFFICIAL_V3_PAD, t0: T_V3_CREATED, quote: WBNB, track: 'v3', use: 'useGangV2', route: /^Gang V3 内盘/, v3pad: true },
  { name: 'Gang V3 打新', pad: OFFICIAL_V3_PAD, t0: T_FAIR_CREATED, quote: WBNB, track: 'v3fair', use: 'fairMinting', route: /^Gang 打新认购/, v3pad: true },
];
const USES = ['useGang', 'useGangV2', 'fairMinting', 'useOpenFour', 'useFlapNft'];

function logFor(c, i) {
  const token = fakeAddr(0xa0000 + i);
  const data = c.t0 === T_OLD ? coder.encode(['string', 'string'], [`Old${i}`, `OLD${i}`])
    : coder.encode(['string', 'string', 'string', 'uint256', 'address', 'uint256'], [`Tok${i}`, `TK${i}`, 'ipfs://bafyTest', 0n, ethers.ZeroAddress, 0n]);
  const topics = [c.t0, topic(token), topic(CREATOR), ...(c.quote ? [topic(c.quote)] : [])];
  return { address: ethers.getAddress(c.pad), topics, data, blockNumber: 100 + i, transactionHash: '0x' + String(i).padStart(64, '0') };
}

// 行情对象：只用到 upsertGang / onGangChainToken 需要的部分，联网的方法换成空操作
const market = Object.create(LiveMarket.prototype);
Object.assign(market, { tokens: new Map(), qUsd: {}, bnbUsd: 600, names: { set() {}, peek() { return null; } }, gang: { seen: new Map(), setHot() {} }, provider,
  emit() {}, gangFairState: async () => {}, gangV2Curve: async () => {}, applyFair() {} });
const trader = Object.create(LiveTrader.prototype);
trader.market = market;

const gc = new GangChain(provider);
const emitted = [];
gc.on('token', (it) => emitted.push(it));
for (const [i, c] of CASES.entries()) {
  emitted.length = 0;
  await gc.handle(logFor(c, i));
  const it = emitted[0];
  ok(!!it, `${c.name}：gangChain.handle 没有产出新盘`); if (!it) continue;
  ok(it.track === c.track, `${c.name}：gangChain 盘型应为 ${c.track}，实际 ${it.track}`);
  ok(c.v3pad ? it.pad === OFFICIAL_V3_PAD.toLowerCase() : it.pad == null, `${c.name}：gangChain pad 应为 ${c.v3pad ? OFFICIAL_V3_PAD : '空'}，实际 ${it.pad}`);
  ok(c.quote ? it.quoteAddress === c.quote : it.quoteAddress == null, `${c.name}：报价币应为 ${c.quote}，实际 ${it.quoteAddress}`);
  ok(it.logo == null || /^https:\/\//.test(it.logo), `${c.name}：logo 地址异常 ${it.logo}`);
  ok(expectedGangTrack(it.srcPad, it.srcTopic) === c.track, `${c.name}：routeGuard 按来源推出的盘型不对（${expectedGangTrack(it.srcPad, it.srcTopic)}）`);
  ok(checkGangChain(it).length === 0, `${c.name}：路由自检报了问题`);
  market.onGangChainToken(it);
  const t = market.get(it.address);
  ok(t?.source === 'gang' && t.stage === 'curve', `${c.name}：行情里没有这个内盘记录`); if (!t) continue;
  ok(t.gangTrack === c.track, `${c.name}：行情记录 gangTrack 应为 ${c.track}，实际 ${t.gangTrack}`);
  ok(t._srcPad === it.srcPad, `${c.name}：行情记录没有带上来源 pad`);
  for (const u of USES) ok(trader[u](t) === (u === c.use), `${c.name}：${u}() 应为 ${u === c.use}`);
  const r = trader.route(t, 'buy');
  ok(c.route.test(r), `${c.name}：买入路由应匹配 ${c.route}，实际「${r}」`);
  ok(checkToken(t).hard.length === 0, `${c.name}：路由自检报硬矛盾 ${checkToken(t).hard}`);
  // 反向：把记录改成别的盘型，自检必须拦下（模拟字段被吞后的状态）
  const bad = { ...t, gangTrack: c.track === 'v1' ? 'v2' : 'v1' };
  ok(checkToken(bad).hard.length > 0, `${c.name}：盘型被改错（${bad.gangTrack}）时路由自检没有拦下`);
}
// 字段被吞的 gangChain 产物（track / pad 缺失）：自检必须报警
console.error = () => {};
ok(checkGangChain({ address: '0x1', symbol: 'X', srcPad: OFFICIAL_V3_PAD, srcTopic: T_V3_CREATED, quoteAddress: WBNB }).length > 0, '缺 track / pad 的 V3 新盘，路由自检没有报警');
console.error = err0;

// 其他平台：按记录断言路由（这些记录由各自的发现模块产生，这里只保证路由分支没被改坏）
const OTHER = [
  { name: 'Flap Agent Curve（BNB）', t: { source: 'agent-curve', platform: 'flap', stage: 'curve', market: fakeAddr(0xbeef1), quote: 'BNB' }, route: /^Flap Agent Curve · Portal\.buy/ },
  { name: 'Flap Agent Curve（BNCB）', t: { source: 'agent-curve', platform: 'flap', stage: 'curve', market: fakeAddr(0xbeef2), quote: 'BNCB', quoteAddress: BNCB }, route: /buyWithQuote/ },
  { name: 'Flap 门槛盘（BNB）', t: { source: 'flap-nft', platform: 'flap', stage: 'curve', quote: 'BNB', nftGate: { name: 'Agent ID' } }, use: 'useFlapNft', route: /^Flap 内盘（Agent ID 门槛）· Portal\.swapExactInput/ },
  { name: 'Flap 普通盘（漫威 MRVLB 计价）', t: { source: 'flap-nft', platform: 'flap', stage: 'curve', quote: 'MRVLB', quoteAddress: fakeAddr(0x3a1), nftGate: { plain: true } }, use: 'useFlapNft', route: /^Flap 内盘（普通盘）.*Portal 内部 BNB⇄MRVLB/ },
  { name: 'Flap 门槛盘（xOPAI，Portal 没开原生 BNB）', t: { source: 'flap-nft', platform: 'flap', stage: 'curve', quote: 'xOPAI', quoteAddress: '0x7ddef360f3c2db4cc41c3967984fefa2598cc9a6', flapNativeSwap: false }, route: /^币安 Web3 DEX 聚合/ },
  { name: 'Four Agent 专属', t: { source: 'four-agent', platform: 'four', stage: 'curve', quote: 'BNB' }, use: 'useOpenFour', route: /^Four Agent 专属内盘 · OpenFour Core\.buy/ },
  { name: '外盘代币', t: { source: 'dex', platform: 'dex', stage: 'dex', quote: 'BNB' }, route: /^币安 Web3 DEX 聚合.*普通外盘代币/ },
  { name: '已发射的 Gang V2', t: { source: 'gang', platform: 'gang', stage: 'dex', gangTrack: 'v2', quote: 'GANG', quoteAddress: GANG }, route: /^币安 Web3 DEX 聚合/ },
];
for (const c of OTHER) {
  const r = trader.route(c.t, 'buy');
  ok(c.route.test(r), `${c.name}：买入路由应匹配 ${c.route}，实际「${r}」`);
  for (const u of USES) ok(trader[u](c.t) === (u === c.use), `${c.name}：${u}() 应为 ${u === c.use}`);
  ok(checkToken(c.t).hard.length === 0, `${c.name}：路由自检误报 ${checkToken(c.t).hard}`);
}

// 静态检查规则自测：2026-10-28 那一行必须被抓到，正常写法不能误报
ok(!!swallowed(" V3 Created 事件里是 ipfs://CID：换成 gang.fun 自己的网关（Flap 的网关不给别家的 CID，返回 403） track: fair ? 'v3fair' : v3 ? 'v3' : v2 ? 'v2' : 'v1', pad: v3 ? log.address.toLowerCase() : null,"), 'lint 没抓到 7266e40 的「注释吞掉 track / pad」');
ok(!!swallowed(' 剩余可售：V2 从合约读  holders: it.holders ?? null, pair: it.pair || t.pair || null, tradeCount: it.trades ?? 0,'), 'lint 没抓到「注释吞掉 holders / pair」');
ok(!!swallowed(" 注释 track: fair ? 'v3fair' : 'v1', pad: v3 ? log.address.toLowerCase() : null,   // logo：换成 gang.fun 的网关"), 'lint 没抓到「注释后面还有一段 // 注释」时被吞的字段');
ok(!swallowed(' 例如 GANG_V3_PAD=0x… 或 https://gang.fun 上的 logo：ipfs://CID'), 'lint 把正常注释误报成代码');

console.log(fails ? `\n离线检查：${passes} 项通过，${fails} 项失败` : `✓ 离线检查：${passes} 项全部通过（Gang 老盘 / V2 / stocks / V3 / 打新 + Flap / Four / 外盘路由）`);
process.exit(fails ? 1 : 0);
