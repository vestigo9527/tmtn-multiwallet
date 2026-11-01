// 主题切换：<html data-theme="…">，颜色在 theme.css 里覆盖 CSS 变量；选择记在 localStorage.tmtnTheme
// 普通 <script>（不是 module），放在 <head> 里、style.css 之后同步执行，刷新时不会先闪一下别的主题
(() => {
  const THEMES = [
    { id: 'calm', name: '清爽深色' },      // 默认
    { id: 'classic', name: '经典深色' },   // 原来的样子（style.css 原样）
  ];
  const KEY = 'tmtnTheme', DEF = 'calm';
  const root = document.documentElement;
  const get = () => {
    try { let v = localStorage.getItem(KEY); if (v === 'new') { v = 'calm'; localStorage.setItem(KEY, v); }   // 旧名字
      return THEMES.some((t) => t.id === v) ? v : DEF; } catch { return DEF; }
  };

  // 清爽深色的字号只用 11 / 12 / 13 / 16 / 20 五档：把 style.css 里的字号在运行时映射一遍（以后别人加的样式也自动跟上）
  const FS = (px) => (px < 11.5 ? 11 : px < 12.25 ? 12 : px < 14 ? 13 : px < 18 ? 16 : px < 24 ? 20 : px);
  const P = ':root[data-theme="calm"]';
  const pre = (sel) => sel.split(',').map((s) => { s = s.trim(); return /^(html|:root)\b/.test(s) ? s.replace(/^(html|:root)/, P) : P + ' ' + s; }).join(', ');
  function fsRules(rules) {
    let out = '';
    for (const r of rules) {
      if (r.cssRules && (r.media || r.conditionText != null)) {   // @media / @container / @supports
        const inner = fsRules(r.cssRules); if (!inner) continue;
        const kind = r.constructor.name === 'CSSContainerRule' ? '@container' : r.constructor.name === 'CSSSupportsRule' ? '@supports' : '@media';
        out += `${kind} ${r.conditionText || r.media.mediaText} {${inner}}\n`; continue;
      }
      if (!r.selectorText || !r.style) continue;
      const v = r.style.getPropertyValue('font-size'); const m = /^([\d.]+)px$/.exec(v); if (!m) continue;
      const px = +m[1], to = FS(px); if (to === px) continue;
      out += `${pre(r.selectorText)} { font-size: ${to}px${r.style.getPropertyPriority('font-size') ? ' !important' : ''}; }\n`;
    }
    return out;
  }
  let fsDone = false;
  function buildFs() {
    if (fsDone) return; let css = '';
    for (const sh of document.styleSheets) {
      if (!sh.href || !/\/(style|version)\.css/.test(sh.href)) continue;
      try { css += fsRules(sh.cssRules); } catch { return; /* 还没加载完，稍后再来 */ }
    }
    fsDone = true; const st = document.createElement('style'); st.id = 'calmFs'; st.textContent = css;
    const t = document.querySelector('link[href*="theme.css"]'); if (t) t.before(st); else document.head.append(st);   // 放在 theme.css 前面，theme.css 里写的字号优先
  }

  const apply = (id) => {
    root.dataset.theme = id;
    if (id === 'calm') buildFs();
    const btn = document.getElementById('themeBtn');
    if (btn) { const t = THEMES.find((x) => x.id === id); btn.title = `主题：${t.name}（点击切换）`; btn.dataset.cur = id; const n = btn.querySelector('.theme-n'); if (n) n.textContent = t.name; }
    window.dispatchEvent(new CustomEvent('tmtn-theme', { detail: id }));
  };
  const set = (id) => { try { localStorage.setItem(KEY, id); } catch { /* 无痕模式就只管这一页 */ } apply(id); };
  const next = () => { const i = THEMES.findIndex((t) => t.id === get()); set(THEMES[(i + 1) % THEMES.length].id); };
  window.TMTN_THEME = { list: THEMES, get, set, next };
  apply(get());
  // 顶栏按钮：插在「打赏作者」前面
  const mount = () => {
    if (!fsDone && get() === 'calm') buildFs();
    if (document.getElementById('themeBtn')) return;
    const b = document.createElement('button');
    b.id = 'themeBtn'; b.type = 'button'; b.className = 'pill theme-btn';
    b.innerHTML = '<span aria-hidden="true">🎨</span><span class="theme-n">主题</span>';
    b.addEventListener('click', next);
    const at = document.getElementById('donateBtn');
    if (at) at.before(b); else document.querySelector('.topbar')?.append(b);
    apply(get());
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
  // 别的标签页改了主题，这边跟着变
  window.addEventListener('storage', (e) => { if (e.key === KEY) apply(get()); });
})();
