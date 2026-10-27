// 本地目录扫描：识别 项目/EP/SEG 结构（与插件 content.js 同规则）
// SEG 目录名含秒数（SEG001-9s）；图片按数字序；提示词取 *.txt（文件名也可兜底解析秒数）
const fs = require('fs');
const path = require('path');

const IMG_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;
// SEG 目录：seg开头 或 名中任意位置含 Ns（如 SEG006-3s / 6s_片头 / 片头 6S / SEG006 3s）
const SEG_HINT = /(^seg|(\d+)\s*s)/i;
const SEC_RE = /(\d+)\s*s/i;
// 提示词：txt/md/doc/docx，只取排序后第一个文件
const TXT_RE = /\.(txt|md|docx?)$/i;
const SEC_IN_TXT = /(\d+)\s*s/i;

const imgOrder = (name) => {
  const m = name.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
};

function scanSeg(dir) {
  const name = path.basename(dir);
  const seg = { name, dir, images: [], promptFile: null, seconds: 0 };
  const m = name.match(SEC_RE);
  if (m) seg.seconds = parseInt(m[1], 10);
  for (const f of fs.readdirSync(dir).sort()) {
    const fp = path.join(dir, f);
    if (!fs.statSync(fp).isFile()) continue;
    if (IMG_RE.test(f)) seg.images.push(fp);
    else if (TXT_RE.test(f)) {
      if (seg.promptFile) continue; // 只取第一个提示词文件
      seg.promptFile = fp;
      if (!seg.seconds) {
        const tm = f.match(SEC_IN_TXT);
        if (tm) seg.seconds = parseInt(tm[1], 10);
      }
    }
  }
  seg.images.sort((a, b) =>
    imgOrder(path.basename(a)) - imgOrder(path.basename(b)) || a.localeCompare(b)
  );
  return seg;
}

// 返回 EP 列表：[{name, dir, segs:[]}]
function collectEpDirs(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  const segDirs = entries.filter((e) => SEG_HINT.test(e.name));
  if (segDirs.length) {
    const segs = segDirs.map((e) => scanSeg(path.join(dir, e.name)));
    segs.sort((a, b) => a.name.localeCompare(b.name));
    return [{ name: path.basename(dir), dir, segs }];
  }
  const out = [];
  for (const e of entries) out.push(...collectEpDirs(path.join(dir, e.name)));
  return out;
}

// rootDir 可为：项目根（含若干EP）、单个EP目录、或含多个项目的父目录
// 返回 projects: [{name, eps:[{name,dir,segs}]}]
function scanRoot(rootDir) {
  const eps = collectEpDirs(rootDir);
  // 根目录本身就是 SEG（直接含图片/提示词，无下级结构）→ 单段导入
  if (!eps.length) {
    const files = fs.readdirSync(rootDir)
      .filter((f) => fs.statSync(path.join(rootDir, f)).isFile());
    if (files.some((f) => IMG_RE.test(f))) {
      const nm = path.basename(rootDir);
      return [{ name: nm, eps: [{ name: nm, dir: rootDir, segs: [scanSeg(rootDir)] }] }];
    }
  }
  const projects = new Map();
  for (const ep of eps) {
    const rel = path.relative(rootDir, ep.dir);
    const parts = rel.split(path.sep);
    // 项目名 = EP 的上级目录名（没有就用根目录名）
    const proj = parts.length > 1 ? parts.slice(0, -1).join('/') : path.basename(rootDir);
    if (!projects.has(proj)) projects.set(proj, { name: proj, eps: [] });
    projects.get(proj).eps.push(ep);
  }
  return [...projects.values()];
}

const readPrompt = (seg) =>
  seg.promptFile ? fs.readFileSync(seg.promptFile, 'utf8').trim() : '';

module.exports = { scanRoot, collectEpDirs, scanSeg, readPrompt };
