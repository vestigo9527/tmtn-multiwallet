// 版本管理：检查 GitHub 上的新版本、一键切换到任意发布版本（升级 / 回退）、恢复切换前的备份。
// 只换代码：data/、data-*/、wallets/、.env、node_modules、日志一律不碰；每次切换前把当前代码打包备份到 DATA_DIR/updates/。
// 全部由页面上点按钮触发，不会自动更新。网络请求走 curl（自动用 HTTPS_PROXY 等代理环境变量）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { DATA_DIR } from './live/config.js';

const REPO = process.env.TMTN_UPDATE_REPO || 'bnbxcs/TMTN';
const CACHE_MS = 10 * 60e3;
const KEEP_BACKUPS = 10;
// 不覆盖、不删除、不备份的路径（相对项目根目录的第一段）
const PROTECT_TOP = new Set(['data', 'wallets', 'node_modules', '.git', '.claude', '.agents']);
const isProtected = (rel) => {
  const top = rel.split('/')[0], base = path.basename(rel);
  if (PROTECT_TOP.has(top) || /^data-/.test(top)) return true;
  if (base === '.env' || (/^\.env\./.test(base) && base !== '.env.example')) return true;
  return /\.log$/.test(base) || /\.bak\d*$/.test(base) || /\.bak[-\w]*$/.test(base) || base === '.DS_Store';
};

const run = (cmd, args, opts = {}) => new Promise((ok, no) => {
  execFile(cmd, args, { maxBuffer: 64 << 20, timeout: opts.timeout || 120e3, ...opts }, (e, stdout, stderr) => {
    if (e) { e.message = `${cmd} ${args[0] || ''}：${String(stderr || e.message).trim().split('\n').slice(-3).join(' ')}`; return no(e); }
    ok(String(stdout));
  });
});
const curl = (url, extra = [], timeout = 30e3) => run('curl', ['-fsSL', '--max-time', String(Math.round(timeout / 1000)), '-H', 'User-Agent: tmtn-updater', ...extra, url], { timeout: timeout + 5e3 });
const ghJson = async (p) => JSON.parse(await curl(`https://api.github.com/repos/${REPO}/${p}`, ['-H', 'Accept: application/vnd.github+json']));

const parseVer = (s) => String(s || '').replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
export const cmpVer = (a, b) => { const x = parseVer(a), y = parseVer(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };

// CHANGELOG.md 按「## v3.5 — 2026-10-27」切成每个版本一段
function parseChangelog(md) {
  const out = {}; let cur = null;
  for (const line of String(md || '').split('\n')) {
    const m = /^##\s+(v?[\d.]+)\s*(?:[—-]+\s*(\S+))?/.exec(line);
    if (m) { cur = { tag: m[1].startsWith('v') ? m[1] : 'v' + m[1], date: m[2] || '', body: [] }; out[cur.tag] = cur; continue; }
    if (cur) cur.body.push(line);
  }
  for (const k in out) out[k].body = out[k].body.join('\n').trim();
  return out;
}

const walk = (dir, base = dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name), rel = path.relative(base, abs).split(path.sep).join('/');
    if (isProtected(rel)) continue;
    if (e.isDirectory()) walk(abs, base, out); else if (e.isFile()) out.push(rel);
  }
  return out;
};
const sha = (f) => { try { return crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex'); } catch { return null; } };
const depsOf = (f) => { try { const p = JSON.parse(fs.readFileSync(f, 'utf8')); return JSON.stringify([p.dependencies || {}, p.optionalDependencies || {}]); } catch { return ''; } };

export function mountUpdater(app, { rootDir, peers = 0 }) {
  const UPD = path.join(DATA_DIR, 'updates');
  const pkgVersion = () => { try { return JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')).version; } catch { return '0.0.0'; } };
  const startVersion = pkgVersion();   // 进程启动时的版本：文件换了但还没重启时，页面上显示「待重启」
  const isGit = fs.existsSync(path.join(rootDir, '.git'));
  const inDocker = fs.existsSync('/.dockerenv') || !!process.env.TMTN_IN_DOCKER;
  const blockReason = inDocker ? 'Docker 部署：请在宿主机更新代码后重建容器'
    : process.execArgv.some((a) => a.startsWith('--watch')) ? '用 node --watch（npm run dev）运行时不能在线切换：改文件会让服务中途重启。请用 npm start 运行'
    : process.env.TMTN_UPDATE === '0' ? '已用 TMTN_UPDATE=0 关闭在线更新' : null;
  let cache = null, checking = null;
  let job = null;   // { id, tag, step, log[], done, ok, error, restart }

  async function check(force) {
    if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache;
    if (checking) return checking;
    checking = (async () => {
      try {
        let names;
        try { names = (await ghJson('tags?per_page=100')).map((t) => t.name); }
        catch (e) { names = (await run('git', ['ls-remote', '--tags', `https://github.com/${REPO}.git`])).split('\n').map((l) => /refs\/tags\/([^^\s]+)$/.exec(l)?.[1]).filter(Boolean); }   // API 限流（每小时 60 次）时改用 git
        let tags = [...new Set(names)].filter((n) => /^v?\d+(\.\d+)*$/.test(n)).sort((a, b) => cmpVer(b, a));
        const latest = tags[0] || null;
        let notes = {};
        try { notes = parseChangelog(await curl(`https://raw.githubusercontent.com/${REPO}/${latest || 'main'}/CHANGELOG.md`)); } catch {}
        const releases = tags.map((t) => ({ tag: t, date: notes[t]?.date || '', notes: notes[t]?.body || '' }));
        cache = { at: Date.now(), latest, releases, error: null };
      } catch (e) {
        cache = { at: Date.now(), latest: cache?.latest || null, releases: cache?.releases || [], error: `检查失败：${String(e.message).slice(0, 160)}` };
      } finally { checking = null; }
      return cache;
    })();
    return checking;
  }

  const backups = () => {
    try {
      return fs.readdirSync(UPD).filter((f) => /^backup-.*\.tar\.gz$/.test(f)).sort().reverse().map((f) => {
        const m = /^backup-v?([\d.]+)-(\d+)\.tar\.gz$/.exec(f), st = fs.statSync(path.join(UPD, f));
        return { file: f, version: m?.[1] || '?', at: Number(m?.[2]) || st.mtimeMs, size: st.size };
      });
    } catch { return []; }
  };

  const view = (c) => {
    const current = pkgVersion();
    return {
      current, running: startVersion, pendingRestart: current !== startVersion, repo: REPO, install: isGit ? 'git' : 'files', blocked: blockReason, peers,
      latest: c?.latest || null, hasUpdate: !!(c?.latest && cmpVer(c.latest, current) > 0), checkedAt: c?.at || null, error: c?.error || null,
      releases: c?.releases || [], backups: backups(),
      changelogUrl: `https://github.com/${REPO}/blob/main/CHANGELOG.md`, repoUrl: `https://github.com/${REPO}`,
      job: job && { id: job.id, tag: job.tag, step: job.step, log: job.log.slice(-30), done: job.done, ok: job.ok, error: job.error, restart: job.restart, dirty: job.dirty },
    };
  };

  const step = (s) => { job.step = s; job.log.push(`${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${s}`); console.log(`[update] ${s}`); };

  // 下载某个 tag 的源码包并解压到 dir（去掉最外层目录）
  async function fetchTag(tag, dir) {
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    const tgz = dir + '.tar.gz';
    await curl(`https://codeload.github.com/${REPO}/tar.gz/refs/tags/${encodeURIComponent(tag)}`, ['-o', tgz], 180e3);
    await run('tar', ['-xzf', tgz, '-C', dir, '--strip-components=1']);
    fs.rmSync(tgz, { force: true });
    if (!fs.existsSync(path.join(dir, 'server.js')) || !fs.existsSync(path.join(dir, 'package.json'))) throw new Error(`${tag} 的源码包不完整（没有 server.js / package.json）`);
  }

  async function backupNow() {
    fs.mkdirSync(UPD, { recursive: true });
    const name = `backup-v${pkgVersion()}-${Date.now()}.tar.gz`, files = walk(rootDir);
    const list = path.join(UPD, 'backup-files.txt'); fs.writeFileSync(list, files.join('\n'));
    await run('tar', ['-czf', path.join(UPD, name), '-C', rootDir, '-T', list]);
    fs.rmSync(list, { force: true });
    for (const b of backups().slice(KEEP_BACKUPS)) fs.rmSync(path.join(UPD, b.file), { force: true });
    return name;
  }

  // 本地代码和当前版本的正式发布包有哪些不同（被改过 / 新加的文件）。拿不到正式包时返回 null
  async function localChanges(stageCur) {
    const cur = (await check(false)).releases.find((r) => cmpVer(r.tag, pkgVersion()) === 0);
    if (!cur) return null;
    await fetchTag(cur.tag, stageCur);
    const official = new Set(walk(stageCur)), changed = [];
    for (const f of walk(rootDir)) if (!official.has(f) || sha(path.join(rootDir, f)) !== sha(path.join(stageCur, f))) changed.push(f);
    return { tag: cur.tag, changed, official };
  }

  async function npmInstallIfNeeded(oldDeps) {
    if (depsOf(path.join(rootDir, 'package.json')) === oldDeps) return step('依赖没有变化，跳过 npm install');
    step('依赖有变化，正在 npm install（可能要 1 分钟）…');
    await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: rootDir, timeout: 600e3, shell: process.platform === 'win32' });
    step('依赖安装完成');
  }

  async function switchFiles(tag, force) {
    const stage = path.join(UPD, 'stage'), stageCur = path.join(UPD, 'stage-current');
    step(`下载 ${tag} 源码包…`); await fetchTag(tag, stage);
    step('对比本地代码和当前正式版…');
    const lc = await localChanges(stageCur).catch(() => null);
    if (!force) {
      if (!lc) { job.dirty = { unknown: true, files: [] }; throw new Error('找不到当前版本的正式发布包，没法确认本地有没有改过代码'); }
      if (lc.changed.length) { job.dirty = { unknown: false, files: lc.changed.slice(0, 50), count: lc.changed.length }; throw new Error(`本地有 ${lc.changed.length} 个文件和 ${lc.tag} 正式版不同，切换会覆盖它们`); }
    }
    const oldDeps = depsOf(path.join(rootDir, 'package.json'));
    step('备份当前代码…'); const bk = await backupNow(); step(`已备份到 ${path.relative(rootDir, path.join(UPD, bk))}`);
    const next = walk(stage);
    for (const rel of next) {
      const dst = path.join(rootDir, rel); fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(stage, rel), dst);
    }
    // 旧版本有、新版本没有、本地也没改过的文件删掉（本地改过的留着）
    let removed = 0;
    if (lc) { const keep = new Set(next); for (const rel of lc.official) if (!keep.has(rel) && sha(path.join(rootDir, rel)) === sha(path.join(stageCur, rel))) { fs.rmSync(path.join(rootDir, rel), { force: true }); removed++; } }
    step(`已写入 ${next.length} 个文件${removed ? `，删除 ${removed} 个旧文件` : ''}`);
    fs.rmSync(stage, { recursive: true, force: true }); fs.rmSync(stageCur, { recursive: true, force: true });
    await npmInstallIfNeeded(oldDeps);
  }

  async function switchGit(tag, force) {
    const git = (...a) => run('git', a, { cwd: rootDir });
    const dirty = (await git('status', '--porcelain', '--untracked-files=no')).trim().split('\n').filter(Boolean).map((l) => l.slice(3));
    if (dirty.length && !force) { job.dirty = { unknown: false, files: dirty.slice(0, 50), count: dirty.length }; throw new Error(`本地有 ${dirty.length} 个文件改过还没提交，切换会覆盖它们`); }
    const oldDeps = depsOf(path.join(rootDir, 'package.json'));
    step('备份当前代码…'); const bk = await backupNow(); step(`已备份到 ${path.relative(rootDir, path.join(UPD, bk))}`);
    if (dirty.length) { await git('stash', 'push', '-m', `tmtn-update ${new Date().toISOString()}`); step('本地改动已存进 git stash'); }
    step('git fetch --tags…'); await git('fetch', '--tags', '--force', 'origin');
    step(`git checkout ${tag}…`); await git('-c', 'advice.detachedHead=false', 'checkout', '--detach', `refs/tags/${tag}`);
    await npmInstallIfNeeded(oldDeps);
  }

  async function restoreBackup(file) {
    const f = path.join(UPD, path.basename(file));
    if (!/^backup-.*\.tar\.gz$/.test(path.basename(file)) || !fs.existsSync(f)) throw new Error('备份文件不存在');
    const oldDeps = depsOf(path.join(rootDir, 'package.json'));
    step('先备份当前代码…'); await backupNow();
    step(`解压 ${path.basename(f)}…`); await run('tar', ['-xzf', f, '-C', rootDir]);
    await npmInstallIfNeeded(oldDeps);
  }

  // 重启：起一个和当前完全一样的新进程（同样的参数、环境变量、日志文件），旧进程退出、端口让出来后新进程再监听
  function restart() {
    if (process.env.TMTN_NO_SELF_RESTART === '1') return 'manual';
    if (process.env.pm_id != null || process.env.INVOCATION_ID) { setTimeout(() => process.exit(0), 800); return 'supervisor'; }   // pm2 / systemd 会自己拉起来
    let out = null;
    try { out = process.platform === 'linux' ? fs.readlinkSync('/proc/self/fd/1') : null; } catch {}
    if (!out && process.platform === 'darwin') { try { const r = spawnSync('lsof', ['-a', '-p', String(process.pid), '-d', '1', '-Fn'], { encoding: 'utf8', timeout: 3000 }); out = /^n(\/.+)$/m.exec(r.stdout || '')?.[1] || null; } catch {} }
    if (!out || !fs.existsSync(out) || !fs.statSync(out).isFile()) out = path.join(rootDir, 'tmtn.log');
    const fd = fs.openSync(out, 'a'), args = [...process.execArgv, ...process.argv.slice(1)];
    const child = process.platform === 'win32'
      ? spawn('cmd', ['/c', `timeout /t 2 /nobreak >nul & "${process.execPath}" ${args.map((a) => `"${a}"`).join(' ')}`], { cwd: process.cwd(), env: process.env, detached: true, stdio: ['ignore', fd, fd], windowsHide: true })
      : spawn('/bin/sh', ['-c', 'sleep 2; exec "$0" "$@"', process.execPath, ...args], { cwd: process.cwd(), env: process.env, detached: true, stdio: ['ignore', fd, fd] });
    child.unref();
    setTimeout(() => process.exit(0), 600);
    return out;
  }

  function startJob(tag, fn) {
    if (job && !job.done) throw new Error('上一次切换还没完成');
    job = { id: Date.now(), tag, step: '', log: [], done: false, ok: false, error: null, restart: null, dirty: null };
    (async () => {
      try { await fn(); job.ok = true; step('完成，正在重启服务…'); job.done = true; setTimeout(() => { job.restart = restart(); }, 1500); }
      catch (e) { job.error = e.message; step(`失败：${e.message}`); job.done = true; }
    })();
  }

  const writeGuard = (req, res) => {
    if (blockReason) { res.status(400).json({ error: blockReason }); return false; }
    return true;
  };

  app.get('/api/version', async (req, res) => {
    const c = req.query.refresh ? await check(true) : (cache || (req.query.cached ? null : await check(false)));
    res.json(view(c));
  });
  app.post('/api/version/switch', (req, res) => {
    if (!writeGuard(req, res)) return;
    const tag = String(req.body?.tag || ''), force = !!req.body?.force;
    if (!cache?.releases.some((r) => r.tag === tag)) return res.status(400).json({ error: `没有 ${tag || '这个'} 版本，先点「重新检查」` });
    try { startJob(tag, () => (isGit ? switchGit(tag, force) : switchFiles(tag, force))); res.json(view(cache)); }
    catch (e) { res.status(409).json({ error: e.message }); }
  });
  // 只重启（代码已经换好、或想手动重启时）：和切换版本完成后的重启是同一套
  app.post('/api/version/restart', (req, res) => {
    if (!writeGuard(req, res)) return;
    try { startJob('restart', async () => {}); res.json(view(cache)); }
    catch (e) { res.status(409).json({ error: e.message }); }
  });
  app.post('/api/version/restore', (req, res) => {
    if (!writeGuard(req, res)) return;
    const file = String(req.body?.file || '');
    try { startJob(file, () => restoreBackup(file)); res.json(view(cache)); }
    catch (e) { res.status(409).json({ error: e.message }); }
  });
}

