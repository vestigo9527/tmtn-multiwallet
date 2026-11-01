// 发版前静态检查（不联网、不读钱包）：
// 1. node --check：所有 .js / .mjs 语法检查
// 2. 「注释吞字段」：本项目习惯把很长的对象字面量写在一行里，行尾注释后面要是再接字段（track: …, pad: …），
//    这些字段就成了注释的一部分，语法照样合法、启动也不报错，只有下单时才出错（2026-10-28 Gang 新盘全走老盘、买入回滚 UnknownToken 就是这样）。
//    这里把每条 // 行尾注释的内容拿出来，看里面是不是还藏着一段能编译的「字段: 值, …」或语句，是就报错。
// 用法：node scripts/check/lint.mjs [目录]（默认仓库根目录）。有问题时退出码 1
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
const SKIP_DIR = new Set(['node_modules', 'data', '.git', 'vendor', '.claude', '.agents']);

export function listFiles(root = ROOT) {
  try {   // git 仓库：只查提交了的和新加的文件（备份文件 *.bakNN 在 .gitignore 里）
    const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '--', '*.js', '*.mjs'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter((f) => f && !f.split('/').some((p) => SKIP_DIR.has(p) || p.startsWith('data-'))).map((f) => path.join(root, f));
  } catch {   // 不是 git 仓库（live 目录）：自己遍历
    const res = [];
    const walk = (d) => { for (const n of readdirSync(d)) { const p = path.join(d, n); if (SKIP_DIR.has(n) || n.startsWith('data-') || n.startsWith('.')) continue; const s = statSync(p); if (s.isDirectory()) walk(p); else if (/\.(m?js)$/.test(n)) res.push(p); } };
    walk(root); return res;
  }
}

// 简单的 JS 词法扫描：找出真正的 // 注释（跳过字符串、模板字符串、正则、块注释）。返回 [{ line, col, text, codeBefore }]
export function lineComments(src) {
  const out = []; let i = 0, line = 1, lineStart = 0, prev = '';   // prev：上一个有意义的字符 / 词，用来判断 / 是除号还是正则
  const tplDepth = [];
  const regexOk = () => !prev || /[(,=:[!&|?{};+\-*%<>~^]$/.test(prev) || /^(return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/.test(prev);
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '\n') { line++; lineStart = i + 1; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && d === '/') {
      let j = src.indexOf('\n', i); if (j < 0) j = src.length;
      const codeBefore = src.slice(lineStart, i);
      out.push({ line, col: i - lineStart + 1, text: src.slice(i + 2, j), codeBefore });
      i = j; continue;
    }
    if (c === '/' && d === '*') { const j = src.indexOf('*/', i + 2); const body = src.slice(i, j < 0 ? src.length : j + 2); for (const ch of body) if (ch === '\n') line++; const nl = body.lastIndexOf('\n'); if (nl >= 0) lineStart = i + nl + 1; i = j < 0 ? src.length : j + 2; continue; }
    if (c === '"' || c === "'") { let j = i + 1; while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1; i = j + 1; prev = 'str'; continue; }
    if (c === '`' || (c === '}' && tplDepth.length && tplDepth[tplDepth.length - 1] === 0)) {
      if (c === '}') tplDepth.pop();
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '\n') { line++; lineStart = j + 1; }
        if (src[j] === '`') { j++; break; }
        if (src[j] === '$' && src[j + 1] === '{') { tplDepth.push(0); j += 2; break; }
        j++;
      }
      i = j; prev = 'str'; continue;
    }
    if (c === '/' && regexOk()) {
      let j = i + 1, cls = false;
      while (j < src.length && src[j] !== '\n') { if (src[j] === '\\') { j += 2; continue; } if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; else if (src[j] === '/' && !cls) break; j++; }
      j++; while (/[a-z]/i.test(src[j] || '')) j++;
      i = j; prev = 'str'; continue;
    }
    if (tplDepth.length) { if (c === '{') tplDepth[tplDepth.length - 1]++; else if (c === '}') tplDepth[tplDepth.length - 1]--; }
    const w = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 40));
    if (w) { prev = w[0]; i += w[0].length; continue; }
    prev = c; i++;
  }
  return out;
}

const compiles = (code) => { try { new vm.Script(code); return true; } catch { return false; } };
// 注释里是不是藏着代码：从每个「ASCII 标识符 + 英文冒号」或语句开头往后取到注释结尾，能编译成对象字段 / 语句且像代码才算
export function swallowed(text) {
  const body = text.replace(/\s+$/, '');
  const starts = [];
  for (const m of body.matchAll(/(?:^|[\s,;(（，。；：])([A-Za-z_$][\w$]*\s*:(?!:)\s*\S)/g)) starts.push(m.index + m[0].indexOf(m[1]));
  for (const m of body.matchAll(/(?:^|\s)((?:const|let|var|if|return|await|this\.[\w$]+\s*=)[\s(])/g)) starts.push(m.index + m[0].indexOf(m[1]));
  for (const s of starts) for (const end of [body.length, ...[...body.slice(s).matchAll(/\s\/\/|\s\/\*/g)].map((m) => s + m.index)]) {   // 注释里又有一段 // 注释：也试只取到它前面
    const tail = body.slice(s, end).replace(/\s+$/, '').replace(/[,;]\s*$/, '');
    if (tail.length < 8) continue;
    const field = /^[A-Za-z_$][\w$]*\s*:/.test(tail);
    if (field && compiles(`({ ${tail} })`) && (/,\s*[A-Za-z_$][\w$]*\s*:/.test(tail) || /[?(['"`]|\?\?|&&|\|\|/.test(tail.replace(/^[^:]*:/, '')))) return tail;
    if (!field && /[;=(]/.test(tail) && compiles(`(async () => { ${tail} })`) && /[;)]\s*$|[;)]\s*\S/.test(tail)) return tail;
  }
  return null;
}

export function lint(files = listFiles()) {
  const problems = [];
  for (const f of files) {
    try { execFileSync(process.execPath, ['--check', f], { stdio: ['ignore', 'ignore', 'pipe'] }); }
    catch (e) { problems.push({ file: f, line: 0, kind: 'syntax', msg: String(e.stderr || e.message).trim().split('\n').slice(0, 5).join(' | ') }); }
    const src = readFileSync(f, 'utf8');
    for (const c of lineComments(src)) {
      if (!c.codeBefore.trim()) continue;   // 整行注释（说明文字里举的代码例子）不算，只查跟在代码后面的行尾注释
      if (/lint-ok/.test(c.text)) continue;   // 确实是举例：注释里写 lint-ok 跳过
      const hit = swallowed(c.text);
      if (hit) problems.push({ file: f, line: c.line, kind: 'comment-swallow', msg: `行尾注释里像是有代码（会被当成注释、不执行）：${hit.slice(0, 120)}` });
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = listFiles(); const p = lint(files);
  for (const x of p) console.log(`✗ ${path.relative(ROOT, x.file)}:${x.line} [${x.kind}] ${x.msg}`);
  console.log(p.length ? `\n静态检查：${files.length} 个文件，${p.length} 处问题` : `✓ 静态检查：${files.length} 个文件，语法正常，没有被注释吞掉的字段`);
  process.exit(p.length ? 1 : 0);
}
