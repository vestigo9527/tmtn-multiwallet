const STAGE = {
  net: { name: '点击→开始下单', desc: '点下按钮到这个钱包的后端开始处理：含「买 N%」先报价算 BNB、主后端转发给钱包 2' },
  pre: { name: '预检', desc: '钱包锁、余额 / 授权额度检查、报价、链上模拟' },
  approve: { name: '授权', desc: '授权交易的广播 + 上链（预先授权过就没有）' },
  quote: { name: '计价币兑换', desc: 'BNB→计价币（买）或 计价币→BNB（卖）那几笔，含等到账' },
  call: { name: '合约调用', desc: 'baw 签名 + 广播（从发起到拿到交易哈希）' },
  confirm: { name: '上链确认', desc: '广播之后等区块确认' },
  wait: { name: 'App 确认 / 等结果', desc: 'baw 要求在币安 App 里确认（或没等到结果），后台等确认到账的时间，包含你在手机上操作的时间' },
  other: { name: '其他', desc: '确认后收尾（读回执、记账）、换路线重试等' },
};
const ORDER = Object.keys(STAGE);
const RANGE = { '1h': 3600e3, '24h': 86400e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3 };
const f = { range: '1h', side: 'all', wallet: 'all', kind: 'all', group: 'kind', noApp: true, failed: false };
let data = { rows: [], wallets: [] }, open = new Set();
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sec = (ms) => ms == null ? '—' : ms >= 10000 ? (ms / 1000).toFixed(1) + 's' : (ms / 1000).toFixed(2) + 's';
const msTxt = (ms) => ms >= 1000 ? sec(ms) : Math.round(ms) + 'ms';
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)]; };
const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const tm = (ts) => { const d = new Date(ts); const p = (n) => String(n).padStart(2, '0'); return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
const sideTag = (s) => `<span class="tag ${s}">${s === 'buy' ? '买入' : '卖出'}</span>`;
const slowStage = (r) => ORDER.reduce((m, k) => (r.stages[k] > r.stages[m] ? k : m), 'net');

function seg(id, key, onchange) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    f[key] = b.dataset.v; [...$(id).children].forEach((x) => x.classList.toggle('on', x === b)); (onchange || render)();
  });
}
seg('fRange', 'range'); seg('fSide', 'side'); seg('fWallet', 'wallet'); seg('fGroup', 'group');
$('fKind').onchange = (e) => { f.kind = e.target.value; render(); };
$('fApp').onchange = (e) => { f.noApp = e.target.checked; render(); };
$('fFailed').onchange = (e) => { f.failed = e.target.checked; render(); };
$('reload').onclick = load;

async function load() {
  try {
    const r = await fetch('/api/latency/orders?days=30', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    data = await r.json();
    $('updated').textContent = '更新于 ' + tm(data.now).slice(6);
  } catch (e) { $('warns').innerHTML = `<div class="warn">读取失败：${esc(e.message)}（后端是不是在重启？）</div>`; return; }
  const wb = $('fWallet'); const want = ['all', ...data.wallets.map((w) => w.label)];
  if ([...wb.children].map((b) => b.dataset.v).join('|') !== want.join('|')) {
    wb.innerHTML = want.map((v) => `<button data-v="${esc(v)}" class="${v === f.wallet ? 'on' : ''}">${v === 'all' ? '全部钱包' : esc(v)}</button>`).join('');
    if (!want.includes(f.wallet)) { f.wallet = 'all'; wb.firstChild.classList.add('on'); }
  }
  const kinds = [...new Set(data.rows.map((r) => r.kind))].sort();
  $('fKind').innerHTML = `<option value="all">全部路线</option>` + kinds.map((k) => `<option ${k === f.kind ? 'selected' : ''}>${esc(k)}</option>`).join('');
  render();
}

function pick(includeFailed) {
  const since = data.now - RANGE[f.range];
  return data.rows.filter((r) => r.ts >= since && (f.side === 'all' || r.side === f.side) && (f.wallet === 'all' || r.wallet === f.wallet)
    && (f.kind === 'all' || r.kind === f.kind) && (!f.noApp || !r.appWait) && (includeFailed || r.status === 'filled'));
}

function render() {
  const off = data.wallets.filter((w) => !w.ok);
  const partialN = pick(false).filter((r) => r.partial).length, noMainN = pick(false).filter((r) => r.noMain && !r.partial).length;
  $('warns').innerHTML = off.map((w) => `<div class="warn">${esc(w.label)} 的数据没取到：${esc(w.error)}。下面只统计能连上的钱包。</div>`).join('')
    + (partialN ? `<div class="warn">有 ${partialN} 笔是较早的订单，当时没记每一步的时间点，阶段拆分按每步自身耗时估算（总耗时是准的）。</div>` : '')
    + (noMainN ? `<div class="warn">有 ${noMainN} 笔是旧版本下的单，没记到主交易（买 / 卖那一笔）的时间点，那部分算在「其他」里。</div>` : '');
  const rows = pick(false), all = pick(true), tot = rows.map((r) => r.total);
  const failed = all.length - rows.length;
  const tile = (k, v, s = '') => `<div class="tile"><div class="k">${k}</div><div class="v">${v}${s ? ` <small>${s}</small>` : ''}</div></div>`;
  $('tiles').innerHTML = tile('成交笔数', rows.length, failed ? `另失败 ${failed}` : '')
    + tile('中位数 p50', sec(pct(tot, 50))) + tile('p90', sec(pct(tot, 90))) + tile('平均', sec(avg(tot)))
    + tile('最快', sec(tot.length ? Math.min(...tot) : null)) + tile('最慢', sec(tot.length ? Math.max(...tot) : null));
  $('legend').innerHTML = ORDER.map((k) => `<span title="${esc(STAGE[k].desc)}"><i style="background:var(--s-${k})"></i>${STAGE[k].name}</span>`).join('');
  renderGroups(rows); renderHist(tot); renderSlow(rows); renderAll(all);
  const ws = data.wallets.map((w) => `${w.label}${w.ok ? '' : '（未连上）'}`).join('、');
  $('foot').textContent = `数据：${ws}，各自后端的 data/latency.jsonl。总耗时 = 点击到后端收到 + 后端开始处理到订单完成（多笔交易的路线算到最后一笔确认）。`;
}

function stackBar(st, scale, cls = '') {
  return `<div class="bar ${cls}">` + ORDER.filter((k) => st[k] > 0).map((k) =>
    `<span data-k="${k}" data-ms="${Math.round(st[k])}" style="flex:0 0 ${(st[k] / scale * 100).toFixed(3)}%;background:var(--s-${k})"></span>`).join('') + `</div>`;
}

function renderGroups(rows) {
  const keyOf = { kind: (r) => r.kind, wallet: (r) => r.wallet, side: (r) => (r.side === 'buy' ? '买入' : '卖出'), kindside: (r) => `${r.kind} · ${r.side === 'buy' ? '买' : '卖'}` }[f.group];
  const g = {};
  for (const r of rows) (g[keyOf(r)] ||= []).push(r);
  const list = Object.entries(g).map(([k, rs]) => {
    const st = Object.fromEntries(ORDER.map((s) => [s, avg(rs.map((r) => r.stages[s] || 0))]));
    const t = rs.map((r) => r.total);
    return { k, n: rs.length, st, avg: avg(t), p50: pct(t, 50), p90: pct(t, 90) };
  }).sort((a, b) => b.avg - a.avg);
  if (!list.length) { $('groups').innerHTML = `<div class="empty">这个时间段里没有符合条件的成交订单</div>`; return; }
  const scale = Math.max(...list.map((x) => x.avg));
  $('groups').innerHTML = list.map((x) => `<div class="grow" data-g="${esc(x.k)}"><div class="lab" title="${esc(x.k)}"><b>${esc(x.k)}</b> <span class="muted">${x.n} 笔</span></div>`
    + `${stackBar(x.st, scale)}<div class="num">平均 <b>${sec(x.avg)}</b> · ${sec(x.p50)} / ${sec(x.p90)}</div></div>`).join('');
  [...$('groups').querySelectorAll('.grow')].forEach((el, i) => {
    const x = list[i];
    el.querySelector('.bar').addEventListener('mousemove', (e) => {
      const hk = e.target.dataset?.k;
      tip(e, `<div class="t">${esc(x.k)} · ${x.n} 笔</div>` + ORDER.filter((k) => x.st[k] > 0).map((k) =>
        `<div class="r2"><span>${hk === k ? '▶ ' : ''}${STAGE[k].name}</span><span>${msTxt(x.st[k])}</span></div>`).join('')
        + `<div class="r2 muted"><span>平均总耗时</span><span>${sec(x.avg)}</span></div>`);
    });
    el.querySelector('.bar').addEventListener('mouseleave', hideTip);
  });
}

function renderHist(tot) {
  if (!tot.length) { $('hist').innerHTML = `<div class="empty">没有数据</div>`; return; }
  const hi = Math.max(pct(tot, 98), 1000), max = Math.ceil(hi / 1000) * 1000;
  const step = max <= 10000 ? 500 : max <= 30000 ? 1000 : Math.ceil(max / 30000) * 1000;
  const n = Math.ceil(max / step), bins = new Array(n + 1).fill(0);
  for (const t of tot) bins[Math.min(n, Math.floor(t / step))]++;
  const top = Math.max(...bins), W = 100 / bins.length;
  const mark = (v, lab) => `<div class="mark" style="left:${Math.min(100, v / ((n + 1) * step) * 100)}%"><span>${lab} ${sec(v)}</span></div>`;
  $('hist').innerHTML = `<div class="hist">` + bins.map((c, i) => `<div class="hb" data-i="${i}" style="height:${(c / top * 100).toFixed(1)}%"></div>`).join('')
    + mark(pct(tot, 50), 'p50') + mark(pct(tot, 90), 'p90') + `</div>`
    + `<div class="haxis"><span>0s</span><span>${sec(max / 2)}</span><span>${sec(max)}${bins[n] ? '+' : ''}</span></div>`;
  const h = $('hist').querySelector('.hist');
  h.addEventListener('mousemove', (e) => {
    const r = h.getBoundingClientRect(), i = Math.min(bins.length - 1, Math.max(0, Math.floor((e.clientX - r.left) / r.width * bins.length)));
    tip(e, `<div class="t">${sec(i * step)} – ${i === n ? '以上' : sec((i + 1) * step)}</div><div class="r2"><span>成交笔数</span><span>${bins[i]}</span></div>`);
  });
  h.addEventListener('mouseleave', hideTip);
}

function rowHtml(r, scale, cols) {
  const k = slowStage(r), slowStep = r.steps.filter((s) => s.stage === k).sort((a, b) => b.ms - a.ms)[0];
  const tx = r.tx ? `<a href="https://bscscan.com/tx/${esc(r.tx)}" target="_blank" rel="noopener" data-stop class="mono muted">${esc(r.tx.slice(0, 8))}…</a>` : '';
  const st = r.status === 'filled' ? '' : ` <span class="tag r" title="${esc(r.error)}">失败</span>`;
  let h = `<tr class="row" data-id="${esc(r.id)}"><td class="mono muted">${tm(r.ts)}</td><td>${esc(r.wallet)}</td><td>${sideTag(r.side)}${st}</td>`
    + `<td title="${esc(r.token)}">${esc(r.symbol)}</td><td class="hide-sm" title="${esc(r.route)}">${esc(r.kind)}</td>`
    + `<td class="num"><b>${sec(r.total)}</b></td><td style="min-width:140px">${stackBar(r.stages, scale, 'mini')}</td>`
    + `<td class="slow"><i style="background:var(--s-${k})"></i>${STAGE[k].name} <span class="mono">${msTxt(r.stages[k])}</span>`
    + (slowStep && cols ? ` <span class="dim" title="${esc(slowStep.name)}">${esc(slowStep.name.slice(0, 26))}</span>` : '') + `</td><td class="hide-sm">${tx}</td></tr>`;
  if (open.has(r.id)) {
    h += `<tr class="steps"><td colspan="9"><div class="muted" style="margin-bottom:4px">路线：${esc(r.route || r.kind)}${r.gasLevel ? ` · gas ${esc(r.gasLevel)}` : ''}${r.partial ? ' · 老订单，按每步自身耗时估算' : ''}${r.error ? ` · <span class="r">${esc(r.error)}</span>` : ''}</div><ol>`
      + (r.net ? `<li><span class="ms">+${msTxt(r.net)}</span><span class="slow"><i style="background:var(--s-net)"></i></span>点击 → 这个钱包的后端开始下单</li>` : '')
      + r.steps.map((s) => `<li><span class="ms">+${msTxt(s.ms)}</span><span class="slow"><i style="background:var(--s-${s.stage})"></i></span>${esc(s.name)} <span class="dim mono">@${sec(s.at)}</span></li>`).join('')
      + `<li><span class="ms">= ${sec(r.total)}</span>完成</li></ol></td></tr>`;
  }
  return h;
}
const thead = `<thead><tr><th>时间</th><th>钱包</th><th>方向</th><th>代币</th><th class="hide-sm">路线</th><th class="num">总耗时</th><th>阶段</th><th>最慢的一步</th><th class="hide-sm">交易</th></tr></thead>`;
function table(el, list, cols) {
  if (!list.length) { el.innerHTML = `<div class="empty">没有符合条件的订单</div>`; return; }
  const scale = Math.max(...list.map((r) => r.total), 1);
  el.innerHTML = `<table>${thead}<tbody>${list.map((r) => rowHtml(r, scale, cols)).join('')}</tbody></table>`;
  el.querySelectorAll('tr.row').forEach((tr) => tr.addEventListener('click', () => { const id = tr.dataset.id; open.has(id) ? open.delete(id) : open.add(id); render(); }));
  el.querySelectorAll('.bar').forEach((b) => {
    b.addEventListener('mousemove', (e) => { const s = e.target.dataset; if (!s.k) return hideTip(); tip(e, `<div class="r2"><span>${STAGE[s.k].name}</span><span>${msTxt(+s.ms)}</span></div>`); });
    b.addEventListener('mouseleave', hideTip);
  });
}
function renderSlow(rows) { table($('slowest'), [...rows].sort((a, b) => b.total - a.total).slice(0, 15), true); }
function renderAll(all) { table($('all'), (f.failed ? all : all.filter((r) => r.status === 'filled')).slice(0, 150), false); }

const tipEl = $('tip');
function tip(e, html) { tipEl.innerHTML = html; tipEl.style.display = 'block'; const w = tipEl.offsetWidth, h = tipEl.offsetHeight; tipEl.style.left = Math.min(innerWidth - w - 8, e.clientX + 14) + 'px'; tipEl.style.top = Math.max(8, e.clientY - h - 10) + 'px'; }
function hideTip() { tipEl.style.display = 'none'; }

load();
setInterval(() => { if (!document.hidden) load(); }, 30000);
// 交易链接只打开链接，不触发行点击（以前是内联 onclick，开了 CSP 后不能用）
document.addEventListener('click', (e) => { if (e.target.closest('a[data-stop]')) e.stopPropagation(); }, true);
