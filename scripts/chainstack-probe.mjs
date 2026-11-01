// 查 .env 的 RPC_URL（Chainstack）是不是归档节点、getLogs 一次能查多大区间。只读，不打印 key。
import fs from 'node:fs';
const env = Object.fromEntries(fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').filter((l) => /^\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const url = process.argv[2] ? env[process.argv[2]] : env.RPC_URL;
const mask = (s) => String(s).replace(/(chainstack\.com\/|nodereal\.io\/(?:ws\/)?v1\/|dwellir\.com\/)[A-Za-z0-9-]+/g, '$1***');
let id = 0;
const rpc = async (method, params) => { const t = Date.now(); try { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) }); const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = { error: { message: `HTTP ${r.status} ${txt.slice(0, 160)}` } }; } return { ms: Date.now() - t, ...j }; } catch (e) { return { ms: Date.now() - t, error: { message: e.message } }; } };
const show = (name, r) => console.log(name.padEnd(34), `${r.ms}ms`.padStart(7), r.error ? '❌ ' + mask(r.error.message).slice(0, 200) : '✅ ' + (Array.isArray(r.result) ? `${r.result.length} 条` : String(r.result).slice(0, 40)));
const hex = (n) => '0x' + n.toString(16);
console.log('节点：', mask(url));
const bn = await rpc('eth_blockNumber', []); show('eth_blockNumber', bn); const head = Number(bn.result);
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', USDT = '0x55d398326f99059fF775485246999027B3197955', PORTAL = '0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0';
for (const back of [200, 50_000, 500_000, 3_000_000]) show(`getBalance 往前 ${back} 块`, await rpc('eth_getBalance', [WBNB, hex(head - back)]));
show('eth_call 往前 500000 块', await rpc('eth_call', [{ to: USDT, data: '0x18160ddd' }, hex(head - 500_000)]));
for (const back of [1_000, 200_000, 1_000_000]) show(`getLogs 100 块 @往前 ${back}`, await rpc('eth_getLogs', [{ address: USDT, fromBlock: hex(head - back), toBlock: hex(head - back + 99) }]));
for (const span of [1_000, 5_000, 10_000, 20_000, 49_000]) show(`getLogs 区间 ${span} 块（Portal）`, await rpc('eth_getLogs', [{ address: PORTAL, fromBlock: hex(head - span - 10), toBlock: hex(head - 10) }]));
show('debug_traceTransaction 可用?', await rpc('debug_traceBlockByNumber', [hex(head - 5), { tracer: 'callTracer', tracerConfig: { onlyTopCall: true } }]));
