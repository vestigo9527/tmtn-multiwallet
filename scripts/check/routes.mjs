// 发版前在线路由体检（只读：只发 eth_call / HTTP GET，绝不签名、不发交易，不调用 baw）：
// 从正在运行的终端（默认 http://127.0.0.1:8788）取当前内盘代币，每种「平台 / 盘型 / 计价币」各抽最近有成交的几个，逐个核对：
//   1. 链上真相：Gang 币到底在哪个合约上（V2 / V3 pad 的 curves()、老盘 quoteBuy、V3 打新 kindOf），和终端识别的盘型、买入路由是否一致
//   2. 终端报价 /api/preview（和真实下单同一条代码路径，用真实钱包地址 eth_call）能否给出 > 0 的报价
//   3. 一笔就完成的 BNB 买入（Gang 老盘 buy、Flap 门槛盘 swapExactInput）：把真实下单的 calldata 用钱包地址 eth_call 模拟一遍
// 用法：node scripts/check/routes.mjs [--url http://127.0.0.1:8788] [--app ~/Downloads/bsc-agent-trader] [--per 2] [代币地址 …]
//   --app：读那个目录的 .env（RPC_URL、TMTN_API_TOKEN、PORT）和 data/api-token；默认同级的 bsc-agent-trader，没有就用本仓库
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv.splice(i, 2)[1] : d; };
const APP = path.resolve(opt('--app', process.env.CHECK_APP_DIR || (existsSync(path.join(REPO, '..', 'bsc-agent-trader', '.env')) ? path.join(REPO, '..', 'bsc-agent-trader') : REPO)));
const PER = Number(opt('--per', 2)) || 2;
const envFile = {};
try { for (const l of readFileSync(path.join(APP, '.env'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) envFile[m[1]] = m[2].replace(/^['"]|['"]$/g, ''); } } catch { /* 没有 .env */ }
for (const k of ['RPC_URL', 'NODEREAL_RPC', 'TRADE_RPC_URL', 'GANG_V3_PAD']) if (envFile[k] && process.env[k] === undefined) process.env[k] = envFile[k];
// 安全：这个进程里不可能下单——LIVE_TRADE 关、baw 指向不存在的程序（万一有代码绕过下面的模拟 send 去调 baw，也只会报错）
process.env.LIVE_TRADE = '0'; process.env.BAW_BIN = '/nonexistent/baw-disabled-in-check';
const URL0 = opt('--url', process.env.CHECK_URL || `http://127.0.0.1:${envFile.PORT || 8788}`).replace(/\/$/, '');
const TOKEN = process.env.TMTN_API_TOKEN || envFile.TMTN_API_TOKEN || (() => { try { return readFileSync(path.join(APP, envFile.DATA_DIR || 'data', 'api-token'), 'utf8').trim(); } catch { return ''; } })();
const EXTRA = argv.filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a)).map((a) => a.toLowerCase());

const { ethers } = await import('ethers');
const { GangV2, V2_PADS } = await import('../../engine/live/gangV2Pads.js');
const { GangTrade, GANG_PAD } = await import('../../engine/live/gangTrade.js');
const { FlapNft } = await import('../../engine/live/flapNft.js');
const { isV3Pad, V3_PADS, v3PadAbi } = await import('../../engine/live/gangV3.js');
const { checkToken } = await import('../../engine/live/routeGuard.js');
const RPC = process.env.RPC_URL || 'https://bsc-dataseed.bnbchain.org';
const provider = new ethers.JsonRpcProvider(RPC, 56, { staticNetwork: true, batchMaxCount: 1 });

export const SIM_OK = 'SIM_OK';
const noSend = async () => { throw Object.assign(new Error('体检进程不发交易（calldata 模拟已通过）'), { code: SIM_OK }); };   // 下单模块走到「发交易」这一步就停
const gangV2 = new GangV2(provider, noSend), gangTrade = new GangTrade(provider, noSend), flapNft = new FlapNft(provider, noSend);
flapNft.save = () => {};   // 不写 data/

async function api(p) {
  const r = await fetch(URL0 + p, { headers: TOKEN ? { 'x-tmtn-token': TOKEN } : {}, signal: AbortSignal.timeout(20_000) });
  const j = await r.json().catch(() => null); if (!r.ok) throw new Error(`${p} → HTTP ${r.status} ${j?.error || ''}`); return j;
}
const short = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '?');
const SOFT = /上限|BuyCap|NFTGatedOnly|门槛 NFT|余额不足|insufficient|已毕业|graduat|已发射|MIGRATED|打新已|开盘|没有可卖/i;   // 和这个钱包 / 时机有关、不是路由错误的，只记警告

// 链上真相：Gang 币在哪个合约
async function gangTruth(token, wallet) {
  try { const { pad } = await gangV2.curve(token); return { track: isV3Pad(pad) ? 'v3' : 'v2', pad: pad.toLowerCase() }; }
  catch (e) {
    if (e.code === 'V3_FAIR') return { track: 'v3fair', pad: V3_PADS[0] };
    if (!/不是 gang\.fun V2/.test(e.message)) throw e;
  }
  const q = await gangTrade.quoteBuy(token, wallet, '0.001').catch(() => null);
  return q ? { track: 'v1', pad: GANG_PAD.toLowerCase() } : { track: null, pad: null };
}
const MOD = { v1: 'old', v2: 'v2v3', v3: 'v2v3', v3fair: 'fair' };
const ROUTE = { v1: /^Gang 内盘/, v2: /^Gang V[23] 内盘/, v3: /^Gang V[23] 内盘/, v3fair: /^Gang 打新/ };

async function checkOne(sum, w) {
  const res = { token: sum.address, symbol: sum.symbol, cat: catOf(sum), fail: [], warn: [], ok: [] };
  const d = await api(`/api/token/${sum.address}`).catch((e) => { res.fail.push(`读详情失败：${e.message}`); return null; });
  if (!d) return res;
  if (d.stage !== 'curve') { res.warn.push(`已不在内盘（${d.stage}），跳过`); return res; }
  const g = checkToken(d); for (const x of g.hard) res.fail.push(`路由自检：${x}`); for (const x of g.soft) res.warn.push(`路由自检：${x}`);
  const pv = await api(`/api/preview?wallet=${encodeURIComponent(w.id)}&token=${d.address}&side=buy&amount=0.001&slippage=35`).catch((e) => ({ error: e.message }));
  const route = pv?.route || '';
  if (d.source === 'gang') {
    const truth = await gangTruth(d.address, w.address).catch((e) => { res.warn.push(`链上核对出错：${e.shortMessage || e.message}`); return null; });
    if (truth && !truth.track) res.fail.push('链上哪个 Gang 合约都不认这个币');
    else if (truth) {
      if (MOD[d.gangTrack] !== MOD[truth.track]) res.fail.push(`盘型识别错：终端是 ${d.gangTrack}，链上是 ${truth.track}（pad ${truth.pad}）——买入会发到错误的合约`);
      else res.ok.push(`链上 ${truth.track} pad ${short(truth.pad)} ✓`);
      if (!ROUTE[truth.track].test(route)) res.fail.push(`买入路由不对：应为 ${ROUTE[truth.track]}，终端给「${route.slice(0, 60)}」`);
      if (truth.track === 'v2' || truth.track === 'v3') {   // pad 认这个钱包（walletRoom 不回滚 = pad 认这个币）
        const room = await provider.call({ to: truth.pad, data: new ethers.Interface(['function walletRoom(address,address) view returns (uint256)']).encodeFunctionData('walletRoom', [d.address, w.address]) }).catch((e) => e);
        if (room instanceof Error) res.fail.push(`pad.walletRoom 回滚：${room.shortMessage || room.message}`.slice(0, 160)); else res.ok.push('walletRoom ✓');
      }
      if (truth.track === 'v1') {   // 真实下单的 calldata：quoteBuy → buy{value} 用钱包地址 eth_call
        try { await gangTrade.buy({ wallet: w.address, token: d.address, amountBnb: '0.001', slippage: 35, step: () => {} }); res.fail.push('模拟买入没有走到发交易这一步'); }
        catch (e) { if (e.code === SIM_OK) res.ok.push('buy calldata eth_call ✓'); else (SOFT.test(e.message) ? res.warn : res.fail).push(`老盘 buy 模拟失败：${e.message}`.slice(0, 200)); }
      }
    }
  } else if (d.source === 'flap-nft') {
    if (!/^Flap 内盘|^币安 Web3 DEX 聚合/.test(route)) res.fail.push(`买入路由不对：「${route.slice(0, 60)}」`);
    if (/^Flap 内盘/.test(route)) {
      try { await flapNft.previewBuy({ wallet: w.address, token: d.address, amountBnb: '0.001', step: () => {} }); res.ok.push('swapExactInput calldata eth_call ✓'); }
      catch (e) { (SOFT.test(e.message) ? res.warn : res.fail).push(`Flap 门槛盘模拟买入失败：${e.message}`.slice(0, 200)); }
    }
  } else if (d.source === 'agent-curve') {
    if (!/^Flap Agent Curve/.test(route)) res.fail.push(`买入路由不对：「${route.slice(0, 60)}」`);
  } else if (d.source === 'four-agent') {
    if (!/^Four Agent 专属内盘/.test(route)) res.fail.push(`买入路由不对：「${route.slice(0, 60)}」`);
  }
  if (d.source === 'gang' && d.gangTrack === 'v3fair' && pv?.error) res.warn.push('打新币终端没有报价（按固定价认购，下单走 GangRouter.fairMintBNB），只核对了链上盘型');
  else if (pv?.error) (SOFT.test(pv.error) ? res.warn : res.fail).push(`终端报价失败：${pv.error}`.slice(0, 200));
  else if (!(pv?.out > 0)) (SOFT.test(pv?.note || '') ? res.warn : res.fail).push(`终端报价为 0${pv?.note ? '：' + pv.note : ''}`);
  else res.ok.push(`报价 ✓`);
  return res;
}
const catOf = (t) => `${t.source}${t.source === 'gang' ? '·' + (t.gangTrack || '?') : ''}·${!t.quote || t.quote === 'BNB' || t.quote === 'WBNB' ? 'BNB' : '报价币'}`;
const WANT = ['gang·v1·BNB', 'gang·v2·报价币', 'gang·v3·BNB', 'gang·v3fair·BNB', 'flap-nft·BNB', 'agent-curve·BNB', 'four-agent·BNB'];   // 希望每次都覆盖到的类别（当前没有内盘币时只提示）

export async function runRoutes() {
  let st;
  try { st = await api('/api/state'); } catch (e) { return { skipped: `连不上终端 ${URL0}（${e.message}）` }; }
  const w = (st.wallets || []).find((x) => x.address) || null;
  if (!w) return { skipped: '终端没有登录的钱包，无法用钱包地址模拟' };
  const curve = (st.tokens || []).filter((t) => t.stage === 'curve');
  const byCat = new Map();
  for (const t of curve.sort((a, b) => (b.lastTradeAt || 0) - (a.lastTradeAt || 0))) { const k = catOf(t); const l = byCat.get(k) || []; if (l.length < PER) { l.push(t); byCat.set(k, l); } }
  const picks = [...byCat.values()].flat();
  for (const a of EXTRA) if (!picks.some((p) => p.address === a)) picks.push({ address: a, symbol: '?', source: '指定' });
  const out = [];
  for (let i = 0; i < picks.length; i += 4) out.push(...await Promise.all(picks.slice(i, i + 4).map((p) => checkOne(p, w).catch((e) => ({ token: p.address, symbol: p.symbol, cat: catOf(p), fail: [`体检出错：${e.message}`], warn: [], ok: [] })))));
  return { url: URL0, rpc: RPC.replace(/\/[^/]{16,}$/, '/…'), wallet: w, results: out, missing: WANT.filter((k) => !byCat.has(k)) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = await runRoutes();
  if (r.skipped) { console.log(`⚠ 在线路由体检跳过：${r.skipped}`); process.exit(2); }
  console.log(`在线路由体检：终端 ${r.url}，节点 ${r.rpc}，钱包 ${r.wallet.label || r.wallet.id} ${short(r.wallet.address)}（只读，不发交易）`);
  for (const x of r.results) console.log(`${x.fail.length ? '✗' : x.warn.length ? '⚠' : '✓'} [${x.cat}] ${x.symbol} ${short(x.token)}  ${[...x.fail, ...x.warn, ...x.ok].join(' · ')}`);
  if (r.missing.length) console.log(`（当前没有内盘币、没覆盖到：${r.missing.join('、')}）`);
  const nf = r.results.filter((x) => x.fail.length).length;
  console.log(nf ? `\n在线路由体检：${r.results.length} 个币，${nf} 个失败` : `\n✓ 在线路由体检：${r.results.length} 个币全部通过`);
  process.exit(nf ? 1 : 0);
}
