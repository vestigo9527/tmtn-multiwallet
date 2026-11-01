#!/usr/bin/env node
// 钱包备注管理台 —— 零依赖本地服务
// 数据来源仍是 TMTN 的那套布局：wallets/labels.env、wallets/walletN/{address,live,mac}、根 .env
// 改备注/改实盘都会调用 TMTN 里现成的脚本，保证「页面点的」和「命令行跑的」是同一套逻辑
//
//   node wallet-manager/server.mjs         # 默认 http://127.0.0.1:8899
//   PM_PORT=9000 node wallet-manager/server.mjs
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMTN = process.env.TMTN_ROOT || path.resolve(HERE, '..', 'TMTN');
const PORT = Number(process.env.PM_PORT || 8899);
const HOST = process.env.PM_HOST || '127.0.0.1';
const PUBLIC = path.join(HERE, 'public');

// ---------- 小工具 ----------
const readText = (p, d = '') => { try { return fs.readFileSync(p, 'utf8'); } catch { return d; } };
const readEnv = (p) => {
  const out = {};
  for (const line of readText(p).split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
};
const writeEnvKey = (p, key, val) => {
  const lines = readText(p).split('\n');
  let hit = false;
  const out = lines.map((l) => {
    if (l.startsWith(`${key}=`)) { hit = true; return `${key}=${val}`; }
    return l;
  });
  if (!hit) out.push(`${key}=${val}`);
  fs.writeFileSync(p, out.join('\n'));
};
function sh(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: TMTN, timeout: opts.timeout ?? 120000, maxBuffer: 8 << 20, ...opts }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, out: `${stdout || ''}${stderr || ''}`.trim() });
    });
  });
}
const dockerNames = async () => {
  const r = await sh('docker', ['ps', '--format', '{{.Names}}'], { timeout: 8000 });
  return new Set(r.code === 0 ? r.out.split('\n').map((s) => s.trim()).filter(Boolean) : []);
};
async function walletInfo(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/wallet-info`, { signal: AbortSignal.timeout(1800) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// ---------- 读状态 ----------
function readLabels() {
  const out = {};
  for (const line of readText(path.join(TMTN, 'wallets/labels.env')).split('\n')) {
    const m = /^WALLET_LABEL_(\d+)=(.*)$/.exec(line.trim());
    if (m) out[Number(m[1])] = m[2];
  }
  return out;
}
async function buildState() {
  const env1 = readEnv(path.join(TMTN, '.env'));
  const labels = readLabels();
  const slots = new Set([1, ...Object.keys(labels).map(Number)]);
  try {
    for (const d of fs.readdirSync(path.join(TMTN, 'wallets'))) {
      const m = /^wallet(\d+)$/.exec(d);
      if (m) slots.add(Number(m[1]));
    }
  } catch { /* 没有 wallets 目录就当只有钱包 1 */ }
  const names = await dockerNames();
  const list = [...slots].sort((a, b) => a - b);

  const wallets = await Promise.all(list.map(async (slot) => {
    const port = slot === 1 ? Number(env1.PORT || 8787) : 8787 + slot;
    const dir = path.join(TMTN, 'wallets', `wallet${slot}`);
    const info = await walletInfo(port);
    return {
      slot,
      label: labels[slot] || `钱包 ${slot}`,
      port,
      container: slot === 1 ? '本机进程' : `tmtn-wallet${slot}`,
      up: slot === 1 ? Boolean(info) : names.has(`tmtn-wallet${slot}`),
      address: slot === 1 ? (env1.WALLET_ADDRESS || '') : readText(path.join(dir, 'address')).trim(),
      live: slot === 1 ? env1.LIVE_TRADE === '1' : readText(path.join(dir, 'live')).trim() === '1',
      auth: info ? info.auth : 'unknown',
      agentId: info ? (info.agentId || '') : '',
      addressLive: info ? (info.address || '') : '',
      expect: info ? (info.expect || '') : '',
      bnb: info ? info.bnb : null,
      mac: slot === 1 ? '' : readText(path.join(dir, 'mac')).trim(),
      url: `http://127.0.0.1:${port}`,
    };
  }));
  const maxSlot = Math.max(...wallets.map((w) => w.slot));
  return { tmtn: TMTN, port: PORT, wallets, nextSlot: maxSlot + 1, signin: signinState(), at: Date.now() };
}

// ---------- 写操作 ----------
async function setLabel(slot, label) {
  const clean = String(label || '').replace(/[\r\n\t]/g, ' ').trim();
  if (!clean) return { ok: false, error: '备注不能为空' };
  if (clean.length > 40) return { ok: false, error: '备注最多 40 个字' };
  const r = await sh('bash', ['scripts/wallets.sh', 'label', String(slot), clean], { timeout: 180000 });
  return { ok: r.code === 0, out: r.out.slice(-1500), needRestartMain: slot === 1 };
}
async function setLive(slot, live) {
  if (slot === 1) {
    writeEnvKey(path.join(TMTN, '.env'), 'LIVE_TRADE', live ? '1' : '0');
    return { ok: true, out: '已改 .env：LIVE_TRADE=' + (live ? 1 : 0), needRestartMain: true };
  }
  const r = await sh('bash', ['scripts/add-wallet.sh', String(slot), live ? '--live' : '--quote-only'], { timeout: 180000 });
  return { ok: r.code === 0, out: r.out.slice(-1200), needRestartMain: false };
}
// 直接写 labels.env（格式同 scripts/labels.sh：一行一个 WALLET_LABEL_N=备注）
function writeLabelFile(slot, label) {
  const p = path.join(TMTN, 'wallets/labels.env');
  const key = `WALLET_LABEL_${slot}=`;
  const lines = readText(p).split('\n').filter((l) => l !== '');
  const i = lines.findIndex((l) => l.startsWith(key));
  if (i >= 0) lines[i] = key + label; else lines.push(key + label);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, lines.join('\n') + '\n');
}

async function addWallet({ slot, label, live, restart }) {
  const n = Number(slot);
  if (!Number.isInteger(n) || n < 2) return { ok: false, error: '序号要从 2 开始（钱包 1 是本机进程）' };
  if (n > 30) return { ok: false, error: '序号太大（最多 30）' };
  const clean = String(label || '').replace(/[\r\n\t]/g, ' ').trim() || `钱包 ${n}`;
  if (clean.length > 40) return { ok: false, error: '备注最多 40 个字' };
  if (fs.existsSync(path.join(TMTN, 'wallets', `wallet${n}`, 'docker-compose.yml'))) {
    return { ok: false, error: `钱包 ${n} 已经存在（端口 ${8787 + n}），直接改备注就行` };
  }
  const logs = [];
  const step = async (title, fn) => {
    logs.push(`── ${title}`);
    const r = await fn();
    logs.push((r.out || '').split('\n').slice(-6).join('\n'));
    return r;
  };

  // 1) 代理通道：容器要能连币安
  const netUp = await step('检查容器出网通道', () => sh('bash', ['scripts/wallet-net.sh', 'up'], { timeout: 240000 }));
  if (netUp.code !== 0) return { ok: false, out: logs.join('\n'), error: '出网通道起不来' };

  // 2) 先写备注，add-wallet.sh 建容器时就会带上
  writeLabelFile(n, clean);
  logs.push(`── 备注：${clean}`);

  // 3) 建容器（镜像已有，通常 10–40 秒）
  const mk = await step(`创建容器 tmtn-wallet${n}（端口 127.0.0.1:${8787 + n}）`,
    () => sh('bash', ['scripts/add-wallet.sh', String(n), ...(live ? ['--live'] : [])], { timeout: 900000 }));
  if (mk.code !== 0) return { ok: false, out: logs.join('\n'), error: '容器创建失败' };

  // 4) 同步给主后端
  await step('同步 WALLET_PEERS 到 .env', () => sh('bash', ['scripts/add-wallet.sh', '--peers', '--write-env'], { timeout: 120000 }));

  // 5) 重启主后端让钱包列表生效
  let restarted = false;
  if (restart) {
    const r = await step('重启钱包 1 主后端', () => restartMain());
    restarted = r.ok;
  }

  // 6) 顺手把扫码链接取出来
  const link = await signinLink(n).catch(() => null);
  return {
    ok: true, slot: n, label: clean, port: 8787 + n, restarted, signin: link && link.ok ? link : null,
    out: logs.join('\n'),
  };
}

async function restartMain() {
  const env1 = readEnv(path.join(TMTN, '.env'));
  const port = Number(env1.PORT || 8787);
  const r = await sh('bash', ['-c', `pkill -f "node .*server.js" >/dev/null 2>&1; lsof -ti tcp:${port} | xargs -r kill 2>/dev/null; sleep 2; nohup npm run live > data/live.log 2>&1 & sleep 1; echo started`], { timeout: 30000 });
  for (let i = 0; i < 40; i++) {
    await new Promise((r2) => setTimeout(r2, 1500));
    if (await walletInfo(port)) return { ok: true, out: `主后端已重启（端口 ${port}）` };
  }
  return { ok: false, out: `启动超时，看 ${TMTN}/data/live.log\n${r.out.slice(-500)}` };
}
async function signinLink(slot) {
  const cmd = slot === 1 ? ['baw', ['--json', 'auth', 'signin']] : ['docker', ['exec', `tmtn-wallet${slot}`, 'baw', '--json', 'auth', 'signin']];
  const r = await sh(cmd[0], cmd[1], { timeout: 60000 });
  const m = /\{[\s\S]*\}/.exec(r.out);
  if (!m) return { ok: false, error: 'baw 没有返回 JSON（可能已经在登录流程里）', out: r.out.slice(-400) };
  try {
    const raw = JSON.parse(m[0]);
    // baw 有的版本返回扁平结构，有的包一层 {success, data}
    const j = raw.data && (raw.data.urlForWeb || raw.data.qrCodeId) ? raw.data : raw;
    if (!j.urlForWeb) return { ok: false, error: 'baw 没给登录链接（可能已在登录流程中）', out: r.out.slice(-400) };
    return { ok: true, urlForWeb: j.urlForWeb, pairingCode: j.pairingCode, expireAt: Number(j.expireAt) };
  } catch (e) {
    return { ok: false, error: String(e.message), out: r.out.slice(-400) };
  }
}

// ---------- 扫码登录作业：signin 之后必须一直挂着 verify，否则扫码也不会落地 ----------
const signinJobs = new Map();   // slot -> { status, urlForWeb, pairingCode, expireAt, out, child }

function verifyArgs(slot, qrCodeId) {
  return slot === 1
    ? ['baw', ['--json', 'auth', 'verify', '--qrCodeId', qrCodeId]]
    : ['docker', ['exec', `tmtn-wallet${slot}`, 'baw', '--json', 'auth', 'verify', '--qrCodeId', qrCodeId]];
}

function startVerify(slot, job) {
  const [cmd, args] = verifyArgs(slot, job.qrCodeId);
  const child = spawn(cmd, args, { cwd: TMTN, stdio: ['ignore', 'pipe', 'pipe'] });
  job.child = child;
  let buf = '';
  const eat = (d) => { buf += d.toString(); if (buf.length > 20000) buf = buf.slice(-20000); };
  child.stdout.on('data', eat);
  child.stderr.on('data', eat);
  child.on('exit', (code) => {
    job.out = buf.trim().slice(-800);
    if (/"status"\s*:\s*"SUCCESS"/.test(buf)) job.status = 'success';
    else if (/EXPIRED|FAILED|CANCELED|DECLINED/i.test(buf)) job.status = 'failed';
    else job.status = code === 0 && job.status === 'waiting' ? 'success' : (job.status === 'waiting' ? 'failed' : job.status);
    job.endedAt = Date.now();
  });
  const ttl = Math.max(30000, (job.expireAt || 0) - Date.now() + 25000);
  const t = setTimeout(() => {
    if (job.status === 'waiting') { job.status = 'expired'; try { child.kill(); } catch {} }
    signinJobs.delete(slot);   // 过期清掉，避免一直显示
  }, ttl);
  t.unref?.();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startSignin(slot) {
  const prev = signinJobs.get(slot);
  if (prev?.child) { try { prev.child.kill(); } catch {} }
  signinJobs.delete(slot);

  let last = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const link = await signinLink(slot);
    if (!link.ok) return link;
    const job = { slot, qrCodeId: link.qrCodeId, urlForWeb: link.urlForWeb, pairingCode: link.pairingCode,
                  expireAt: link.expireAt, status: 'waiting', startedAt: Date.now(), out: '' };
    signinJobs.set(slot, job);
    startVerify(slot, job);
    await sleep(3000);                       // 等 3 秒看 verify 是否被服务端直接拒掉
    if (job.status === 'waiting') {          // 正常：verify 正在等扫码
      return { ok: true, slot, urlForWeb: job.urlForWeb, pairingCode: job.pairingCode,
               expireAt: job.expireAt, status: job.status, attempt };
    }
    last = job;
    if (!/AUTH_REJECTED|does not exist or expired/i.test(job.out || '')) break;   // 不是旧流程未清的锅就别重试
    try { job.child?.kill(); } catch {}
    signinJobs.delete(slot);
    await sleep(8000);   // 取码太勤会被币安限流（SERVICE_ERROR / System abnormality），拉长间隔
  }
  return { ok: false, slot, error: last?.status || 'unknown', out: (last?.out || '').slice(0, 300),
           urlForWeb: last?.urlForWeb, pairingCode: last?.pairingCode };
}

function signinState() {
  const out = {};
  for (const [slot, j] of signinJobs) {
    out[slot] = { status: j.status, pairingCode: j.pairingCode, urlForWeb: j.urlForWeb,
                  expireAt: j.expireAt, out: j.out, startedAt: j.startedAt };
    if (j.status === 'success' && Date.now() - (j.endedAt || Date.now()) > 60000) signinJobs.delete(slot);
  }
  return out;
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const body = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } }); });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/state') return json(res, 200, await buildState());
    if (url.pathname === '/api/label' && req.method === 'POST') {
      const b = await body(req); return json(res, 200, await setLabel(b.slot, b.label));
    }
    if (url.pathname === '/api/live' && req.method === 'POST') {
      const b = await body(req); return json(res, 200, await setLive(b.slot, Boolean(b.live)));
    }
    if (url.pathname === '/api/restart-main' && req.method === 'POST') return json(res, 200, await restartMain());
    if (url.pathname === '/api/lock' && req.method === 'POST') {
      const r = await sh('bash', ['scripts/wallets.sh', 'lock'], { timeout: 600000 });
      return json(res, 200, { ok: r.code === 0, out: r.out.slice(-1500) });
    }
    if (url.pathname === '/api/add' && req.method === 'POST') {
      const b = await body(req);
      return json(res, 200, await addWallet({ slot: b.slot, label: b.label, live: Boolean(b.live), restart: Boolean(b.restart) }));
    }
    if (url.pathname === '/api/signin' && req.method === 'POST') {
      const b = await body(req); return json(res, 200, await startSignin(Number(b.slot)));
    }
    if (url.pathname === '/api/health') return json(res, 200, { ok: true, tmtn: TMTN });

    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.join(PUBLIC, path.normalize(rel).replace(/^([.][.][/\\])+/, ''));
    if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'forbidden' });
    const data = await fsp.readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    return res.end(data);
  } catch (e) {
    return json(res, 500, { error: String(e && e.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`钱包备注管理台 → http://${HOST}:${PORT}`);
  console.log(`TMTN 目录：${TMTN}`);
});
