// 版本管理面板：底栏右下角的版本号。检查 GitHub 上的新版本、更新、一键回退到历史版本、恢复切换前的备份。全部点按钮才执行
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const vNorm = (s) => String(s || '').replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
const cmp = (a, b) => { const x = vNorm(a), y = vNorm(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };
const short = (v) => 'v' + String(v || '').replace(/^v/i, '').replace(/(\.\d+)\.0$/, '$1');
const hm = (t) => new Date(t).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const md = (s) => esc(s).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
  l = l.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');
  return /^#{3,}\s/.test(l) ? `<div class="vm-nh">${l.replace(/^#+\s/, '')}</div>` : `<div class="vm-nl">${l}</div>`;
}).join('');

let V = null, open = false, histOpen = false, polling = null, restarting = null;
let ask = null, msg = null;   // 面板里的确认框 { title, lines[], ok, danger, run } / 错误提示（不用浏览器自带的 confirm / alert）
const btn = $('#vmBtn'), pop = $('#vmPop');

async function load(refresh) {
  try {
    const r = await fetch(`/api/version${refresh ? '?refresh=1' : ''}`, { cache: 'no-store' });
    V = await r.json();
  } catch { if (!restarting) V = V && { ...V, error: '连不上本地服务' }; }
  paint();
}

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 404 && !j.error) throw new Error('服务还在跑旧版本，没有这个功能的接口。请先用原来的方式重启一次服务（例如 restart-all.sh），之后就能在这里操作了');
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  V = j; paint(); watchJob();
}

function watchJob() {
  clearInterval(polling);
  polling = setInterval(async () => {
    if (restarting) {   // 服务重启中：等新进程起来、版本号变了就刷新页面
      try {
        const r = await fetch('/api/version?cached=1', { cache: 'no-store' });
        const j = r.ok ? await r.json() : null;   // 回退到没有版本管理的老版本时这个接口是 404，也说明新进程起来了
        if (!j?.job || j.job.id !== restarting) { clearInterval(polling); location.reload(); }
      } catch {}
      if (Date.now() - restarting > 120e3) { clearInterval(polling); restarting = null; V.job.error = '服务 2 分钟内没有重新启动，请手动重启（数据和设置都在）'; paint(); }
      return;
    }
    await load(false);
    if (V?.job?.done) {
      if (V.job.ok) { restarting = V.job.id; paint(); }
      else clearInterval(polling);
    }
  }, 1200);
}

const fail = (e) => { msg = e.message; paint(); };
const confirmAsk = (a) => { ask = a; msg = null; paint(); };
function switchTo(tag, force) {
  const up = cmp(tag, V.current) > 0;
  const run = () => post('/api/version/switch', { tag, force: !!force }).catch(fail);
  if (force) return run();
  confirmAsk({ title: `${up ? '更新' : '回退'}到 ${short(tag)}？`, ok: up ? '更新' : '回退', run,
    lines: ['只替换程序代码，data/、.env、钱包登录都不动', '切换前自动备份当前代码，随时能恢复', '完成后服务自动重启（约 5–10 秒），期间不能下单，跟单和狙击会暂停'] });
}
function restartNow() {
  confirmAsk({ title: '现在重启服务？', ok: '重启', run: () => post('/api/version/restart', {}).catch(fail),
    lines: ['大约 5–10 秒，页面会自动刷新', '重启期间不能下单，跟单和狙击会暂停', 'data/、.env、钱包登录都不动'] });
}
function restore(file) {
  confirmAsk({ title: '恢复这份备份？', ok: '恢复', danger: true, run: () => post('/api/version/restore', { file }).catch(fail),
    lines: [file, '先备份当前代码，再换回这份备份', '完成后服务自动重启'] });
}

function paint() {
  if (!V) return;
  const upd = V.hasUpdate;
  btn.innerHTML = `TMTN ${short(V.running)}${upd ? '<i class="vm-new">NEW</i>' : ''}`;
  document.querySelectorAll('.brand-v').forEach((el) => { el.textContent = short(V.running); });   // 顶栏和右下角都显示正在运行的版本（同一个来源），不用 index.html 里写死的
  btn.classList.toggle('on', open);
  btn.title = upd ? `有新版本 ${V.latest}，点开查看` : '版本管理：检查更新、回退历史版本';
  if (!open) return;
  const j = V.job, busy = j && !j.done, blocked = V.blocked;
  const newer = V.releases.filter((r) => cmp(r.tag, V.current) > 0);
  const status = V.error ? `<span class="r">${esc(V.error)}</span>`
    : !V.latest ? '<span class="muted">还没检查</span>'
    : upd ? `<span class="y">发现新版本 ${esc(V.latest)}</span>` : '<span class="g">已是最新版本</span>';
  let jobHtml = '';
  if (j && (busy || restarting || j.error || j.ok)) {
    const head = restarting ? '<span class="y">服务正在重启，起来后页面会自动刷新…</span>'
      : busy ? `<span class="y">${j.tag === 'restart' ? '正在重启…' : `正在切换到 ${esc(j.tag)}…`}</span>`
      : j.error ? `<span class="r">${esc(j.error)}</span>` : '<span class="g">完成</span>';
    const dirty = j.dirty && !busy ? `<div class="vm-dirty">${j.dirty.unknown ? '这台机器上的代码可能被改过（开发版或手动改过）。' : `这些文件改过（共 ${j.dirty.count} 个）：<div class="vm-files mono">${j.dirty.files.map(esc).join('<br>')}${j.dirty.count > j.dirty.files.length ? '<br>…' : ''}</div>`}继续的话会先整体备份，再覆盖。<button class="vm-b warn" data-vm-force="${esc(j.tag)}">仍然切换（先备份）</button></div>` : '';
    jobHtml = `<div class="vm-job"><div>${head}</div><div class="vm-log mono">${j.log.map(esc).join('<br>')}</div>${dirty}</div>`;
  }
  const notes = upd ? newer.map((r) => `<div class="vm-rel"><div class="vm-rt"><b>${esc(r.tag)}</b><span class="muted">${esc(r.date)}</span></div>${r.notes ? md(r.notes) : '<div class="muted">（没有说明）</div>'}</div>`).join('') : '';
  const cur = V.releases.find((r) => cmp(r.tag, V.current) === 0);
  pop.innerHTML = `
    <div class="vm-h"><b>版本管理</b>${upd ? '<i class="vm-new">NEW</i>' : ''}<span class="spacer"></span><button class="vm-x" data-vm-close>×</button></div>
    ${ask ? `<div class="vm-ask"><b>${esc(ask.title)}</b><ul>${ask.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul><div class="vm-ask-b"><button class="vm-b" data-vm-ask="no">取消</button><button class="vm-b ${ask.danger ? 'warn' : 'primary'}" data-vm-ask="yes">${esc(ask.ok)}</button></div></div>` : ''}
    ${msg ? `<div class="vm-err"><span>${esc(msg)}</span><button class="vm-x" data-vm-msg>×</button></div>` : ''}
    <div class="vm-line">当前版本 <b class="mono">${esc(short(V.current))}</b> · ${status}</div>
    <div class="vm-sub muted">${V.checkedAt ? `上次检查 ${hm(V.checkedAt)} · ` : ''}来源 <a href="${esc(V.repoUrl)}" target="_blank" rel="noopener">${esc(V.repo)}</a>${V.install === 'git' ? ' · git 安装' : ''}</div>
    ${V.pendingRestart ? `<div class="vm-warn vm-row2"><span>代码已经是 ${esc(short(V.current))}，但服务还在跑 ${esc(short(V.running))}，重启后生效</span><button class="vm-b sm" data-vm-restart ${busy || blocked ? 'disabled' : ''}>立即重启</button></div>` : ''}
    ${blocked ? `<div class="vm-warn">${esc(blocked)}</div>` : ''}
    ${upd ? `<div class="vm-notes">${notes}</div><button class="vm-b primary" data-vm-switch="${esc(V.latest)}" ${busy || blocked ? 'disabled' : ''}>更新到 ${esc(V.latest)}</button>`
      : cur?.notes ? `<details class="vm-cur"><summary>本版更新内容</summary><div class="vm-notes">${md(cur.notes)}</div></details>` : '<div class="vm-sub">暂未取得本版简介，可查看完整说明。</div>'}
    ${jobHtml}
    <div class="vm-btns"><button class="vm-b" data-vm-check ${busy ? 'disabled' : ''}>重新检查</button><a class="vm-link" href="${esc(V.changelogUrl)}" target="_blank" rel="noopener">完整说明</a></div>
    ${V.peers ? `<div class="vm-sub muted">多钱包：其他钱包的后端（容器）要另外更新、重建才会生效。</div>` : ''}
    <div class="vm-hist ${histOpen ? 'open' : ''}">
      <button class="vm-ht" data-vm-hist><span>${histOpen ? '▼' : '▶'}</span> 一键回退历史版本</button>
      ${histOpen ? `<div class="vm-hb">
        ${V.releases.length ? V.releases.map((r) => { const c = cmp(r.tag, V.current); return `<div class="vm-row"><b class="mono">${esc(r.tag)}</b><span class="muted">${esc(r.date)}</span><span class="spacer"></span>${c === 0 ? '<span class="g">当前</span>' : `<button class="vm-b sm" data-vm-switch="${esc(r.tag)}" ${busy || blocked ? 'disabled' : ''}>${c > 0 ? '更新' : '回退'}</button>`}</div>`; }).join('') : '<div class="muted">还没拿到版本列表，先点「重新检查」</div>'}
        ${V.backups.length ? `<div class="vm-bt muted">切换前的自动备份（本机）</div>${V.backups.map((b) => `<div class="vm-row"><span class="mono">${esc(short(b.version))}</span><span class="muted">${hm(b.at)} · ${(b.size / 1048576).toFixed(1)} MB</span><span class="spacer"></span><button class="vm-b sm" data-vm-restore="${esc(b.file)}" ${busy || blocked ? 'disabled' : ''}>恢复</button></div>`).join('')}` : ''}
      </div>` : ''}
    </div>`;
}

btn.addEventListener('click', () => { open = !open; pop.classList.toggle('hidden', !open); paint(); if (open && !V?.checkedAt) load(false); });
pop.addEventListener('click', (e) => {
  const t = e.target.closest('[data-vm-close],[data-vm-check],[data-vm-switch],[data-vm-force],[data-vm-hist],[data-vm-restore],[data-vm-restart],[data-vm-ask],[data-vm-msg]');
  if (!t) return;
  if (t.dataset.vmClose != null) { open = false; pop.classList.add('hidden'); paint(); }
  else if (t.dataset.vmCheck != null) { t.textContent = '检查中…'; load(true); }
  else if (t.dataset.vmSwitch) switchTo(t.dataset.vmSwitch, false);
  else if (t.dataset.vmForce) switchTo(t.dataset.vmForce, true);
  else if (t.dataset.vmHist != null) { histOpen = !histOpen; paint(); }
  else if (t.dataset.vmRestore) restore(t.dataset.vmRestore);
  else if (t.dataset.vmRestart != null) restartNow();
  else if (t.dataset.vmAsk) { const a = ask; ask = null; paint(); if (t.dataset.vmAsk === 'yes') a?.run(); }
  else if (t.dataset.vmMsg != null) { msg = null; paint(); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) { open = false; pop.classList.add('hidden'); paint(); } });
window.tmtnPop?.(pop, [btn], () => { open = false; pop.classList.add('hidden'); paint(); }, () => open);   // 点面板外面关闭（app.js 里的统一机制）

load(false);
setInterval(() => { if (!open) load(false); }, 30 * 60e3);   // 后台每 30 分钟看一次（服务端缓存 10 分钟），有新版本时版本号旁边亮 NEW
