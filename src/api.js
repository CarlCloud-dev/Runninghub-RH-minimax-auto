// 本地 REST API：对外暴露画布自动化能力
// 鉴权：config.apiToken 非空时，/api/* 需带 X-Api-Token 头或 ?token=（/api/ingest 同）
const express = require('express');
const fs = require('fs');
const path = require('path');
const { scanRoot } = require('./scanner');

const pub = (job) => {
  const { spec, ...rest } = job;
  return { ...rest, spec: { ...spec, images: spec.images?.length, segs: spec.segs?.length } };
};

function startApi({ port, token, engine, cv, log, getStatus, onConfig, openMain, hideMain, openWork, hideWork, openDir, uiDir }) {
  const app = express();
  app.use(express.json({ limit: '30mb' }));
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') return res.end();
    next();
  });
  if (token) {
    app.use('/api', (req, res, next) => {
      const t = req.headers['x-api-token'] || req.query.token;
      if (t !== token) return res.status(401).json({ error: 'unauthorized' });
      next();
    });
  }

  const asyncH = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
    log(`[api] ${req.method} ${req.path} → ${e.message}`);
    res.status(500).json({ error: String(e.message || e) });
  });

  const statusPayload = () => ({ ...getStatus(), jobs: engine.jobs.slice(-50).map(pub), uptime: process.uptime() });

  // ---- 状态 ----
  app.get('/api/status', asyncH(async (req, res) => {
    let page = null;
    try { page = await cv('status', null, 15000); } catch (e) { page = { err: e.message }; }
    res.json({ ...statusPayload(), page });
  }));

  // ---- agent 事件回推（apiTap/生命周期）----
  app.post('/api/ingest', asyncH(async (req, res) => {
    const { type, data } = req.body || {};
    if (type === 'api') await engine.learnFromApiEvent(data);
    else if (type === 'agent-ready') log(`[agent] ready @ ${data?.href}`);
    res.json({ ok: true });
  }));

  // ---- 扫描目录结构（不建任务，纯预览）----
  app.post('/api/scan', asyncH(async (req, res) => {
    const { rootDir } = req.body || {};
    if (!rootDir || !fs.existsSync(rootDir)) return res.status(400).json({ error: 'rootDir 不存在' });
    const projects = scanRoot(rootDir).map((p) => ({
      name: p.name,
      eps: p.eps.map((e) => ({
        name: e.name,
        segs: e.segs.map((s) => ({ name: s.name, dir: s.dir, images: s.images.length, seconds: s.seconds, hasPrompt: !!s.promptFile })),
      })),
    }));
    res.json({ projects });
  }));

  // ---- 导入目录到画布（可 run）----
  // body: {rootDir, project?, ep?, segDirs?, run?, mode?:'merge'|'split',
  //        colSeed?:{x,y}, params?, savePattern?, webhookUrl?, prompt?}
  app.post('/api/import', asyncH(async (req, res) => {
    const b = req.body || {};
    const { scanSeg } = require('./scanner');
    let segs = [];
    if (Array.isArray(b.segDirs) && b.segDirs.length) {
      // 精确指定 SEG 目录列表（勾选导入）
      for (const dir of b.segDirs) {
        if (!fs.existsSync(dir)) return res.status(400).json({ error: `SEG 目录不存在: ${dir}` });
        segs.push({ epName: path.basename(path.dirname(dir)), seg: scanSeg(dir) });
      }
    } else {
      if (!b.rootDir || !fs.existsSync(b.rootDir)) return res.status(400).json({ error: 'rootDir 不存在' });
      let projects = scanRoot(b.rootDir);
      if (b.project) projects = projects.filter((p) => p.name === b.project || p.name.endsWith(b.project));
      for (const p of projects) {
        let eps = p.eps;
        if (b.ep) eps = eps.filter((e) => e.name === b.ep);
        for (const e of eps) for (const s of e.segs) segs.push({ epName: `${p.name}/${e.name}`, seg: s });
      }
    }
    if (!segs.length) return res.status(400).json({ error: '未匹配到 SEG' });
    const job = engine.addJob('import', {
      segs, run: !!b.run, mode: b.mode || 'merge', colSeed: b.colSeed,
      params: b.params, savePattern: b.savePattern,
      promptOverride: b.prompt, webhookUrl: b.webhookUrl,
      timeoutMs: b.timeoutMs,
    });
    res.json({ job: pub(job), count: segs.length });
  }));

  // ---- 单 SEG 目录直接跑 ----
  app.post('/api/seg', asyncH(async (req, res) => {
    const { dir, run = true, params, webhookUrl, prompt } = req.body || {};
    if (!dir || !fs.existsSync(dir)) return res.status(400).json({ error: 'dir 不存在' });
    const { scanSeg } = require('./scanner');
    const seg = scanSeg(dir);
    const job = engine.addJob('seg', {
      segs: [{ epName: path.basename(path.dirname(dir)), seg }],
      run, params, promptOverride: prompt, webhookUrl,
    });
    res.json({ job: pub(job) });
  }));

  // ---- 对外主接口：图片+提示词+参数 → 生成 → 下载 ----
  // body: {images:[本地绝对路径], prompt, duration?, params?, saveName?, webhookUrl?}
  app.post('/api/generate', asyncH(async (req, res) => {
    const b = req.body || {};
    const images = (b.images || []).filter((p) => typeof p === 'string' && fs.existsSync(p));
    if (!images.length) return res.status(400).json({ error: 'images 为空或文件不存在（需本地绝对路径）' });
    const job = engine.addJob('generate', {
      images, prompt: b.prompt || '', duration: b.duration,
      params: b.params, run: b.run !== false,
      saveName: b.saveName, webhookUrl: b.webhookUrl, timeoutMs: b.timeoutMs,
    });
    res.json({ job: pub(job) });
  }));

  // ---- 运行画布上已有的视频节点 ----
  app.post('/api/run', asyncH(async (req, res) => {
    const b = req.body || {};
    const job = engine.addJob('run', { nodeIds: b.nodeIds, canvas: b.canvas, timeoutMs: b.timeoutMs, runN: b.runN });
    res.json({ job: pub(job) });
  }));

  app.get('/api/jobs', (req, res) => res.json({
    jobs: engine.jobs.map(pub),
    running: engine.runningJobs, pending: engine.pendingJobs.length, slots: engine.slots,
  }));
  app.get('/api/jobs/:id', (req, res) => {
    const j = engine.jobs.find((x) => x.id === req.params.id);
    j ? res.json(pub(j)) : res.status(404).json({ error: 'not found' });
  });
  // kinds 过滤：{kinds:['import','run']} 只作用对应类型（两页队列各自管自己的）
  app.post('/api/jobs/cancel-all', (req, res) => {
    const kinds = req.body?.kinds;
    const act = engine.jobs.filter((j) => ['running', 'pending'].includes(j.status) && (!kinds?.length || kinds.includes(j.kind)));
    act.forEach((j) => { j.cancel = true; });
    res.json({ ok: true, n: act.length });
  });
  app.post('/api/jobs/clear', (req, res) => {
    const kinds = req.body?.kinds;
    const n0 = engine.jobs.length;
    engine.jobs = engine.jobs.filter((j) => ['running', 'pending'].includes(j.status) || (kinds?.length && !kinds.includes(j.kind)));
    engine.persist();
    res.json({ ok: true, removed: n0 - engine.jobs.length });
  });
  app.post('/api/jobs/:id/clear', (req, res) => {
    res.json({ ok: engine.remove(req.params.id) });
  });
  app.post('/api/jobs/:id/cancel', (req, res) => {
    const j = engine.jobs.find((x) => x.id === req.params.id);
    if (!j) return res.status(404).json({ error: 'not found' });
    j.cancel = true;
    res.json({ ok: true });
  });
  app.get('/api/jobs/:id/file', (req, res) => {
    const j = engine.jobs.find((x) => x.id === req.params.id);
    if (!j?.filePath || !fs.existsSync(j.filePath)) return res.status(404).json({ error: '无文件' });
    res.sendFile(j.filePath);
  });

  // ---- 画布窗口 / 配置 ----
  app.post('/api/canvas/show', (req, res) => { openMain(); res.json({ ok: true }); });
  app.post('/api/canvas/hide', (req, res) => { hideMain(); res.json({ ok: true }); });
  app.post('/api/canvas/work-show', (req, res) => { openWork(); res.json({ ok: true }); });
  app.post('/api/canvas/work-hide', (req, res) => { hideWork(); res.json({ ok: true }); });
  app.post('/api/canvas/url', (req, res) => {
    const { url } = req.body || {};
    if (!/runninghub\.(cn|ai)\/project\/canvas\/\d+/.test(url || '')) return res.status(400).json({ error: '不是画布链接' });
    onConfig({ canvasUrl: url });
    res.json({ ok: true });
  });
  app.post('/api/canvas/work-url', (req, res) => {
    const { url } = req.body || {};
    if (url && !/runninghub\.(cn|ai)\/project\/canvas\/\d+/.test(url)) return res.status(400).json({ error: '不是画布链接（留空=复用导入画布）' });
    onConfig({ workCanvasUrl: url || '' });
    res.json({ ok: true });
  });

  // 全量节点：影子 doc 优先（覆盖视口外；未同步回落 DOM）
  const listNodes = async (fn) => {
    const d = await fn('exportNodes').catch(() => null);
    if (d?.nodes?.length) return d.nodes;
    const d2 = await fn('shadowDump').catch(() => null);
    if (d2?.nodes?.length) return d2.nodes;
    return await fn('inspectAll').catch(() => []);
  };

  // 调试：看画布节点（可过滤 type / 只看视频节点的关键字段）
  app.get('/api/nodes', asyncH(async (req, res) => {
    const all = await listNodes(cv);
    let nodes = all || [];
    if (req.query.type) nodes = nodes.filter((n) => n?.type === req.query.type);
    if (req.query.brief) {
      nodes = nodes.map((n) => ({
        id: n.id, type: n.type,
        status: n.data?.status, taskId: n.data?.taskId,
        url: n.data?.videoUrl || n.data?.resultUrl || n.data?.output || undefined,
        keys: n.data ? Object.keys(n.data) : [],
      }));
    }
    res.json({ count: nodes.length, nodes });
  }));
  app.post('/api/open-downloads', (req, res) => { openDir(getStatus().downloadDir); res.json({ ok: true }); });
  app.get('/api/config', (req, res) => res.json(getStatus()));
  app.post('/api/config', asyncH(async (req, res) => {
    await onConfig(req.body || {});
    res.json({ ok: true });
  }));

  // ---- 调试：API 抓包 + 直接发 canvas 端点 ----
  app.get('/api/apilog', asyncH(async (req, res) => res.json(await cv('apiTap', { n: req.query.n || 100 }))));
  app.post('/api/cv', asyncH(async (req, res) => {
    const { cmd, args, canvas } = req.body || {};
    const fn = canvas === 'work' ? (engine.getCvWork() || cv) : cv;
    res.json(await fn(cmd, args));
  }));
  // 清空画布全部节点（测试/复位用）
  app.post('/api/canvas/clear', asyncH(async (req, res) => {
    const canvas = req.body?.canvas || 'work';
    const fn = canvas === 'work' ? (engine.getCvWork() || cv) : cv;
    const all = await listNodes(fn);
    const ids = (all || []).map((n) => n.id).filter(Boolean);
    if (!ids.length) return res.json({ rmN: 0, rmE: 0 });
    res.json(await fn('shadowRemove', { ids }));
  }));
  // 清理「我们建的」节点：job.createdIds 并集 + vid-*/txt-* 前缀，用户内容不动
  app.post('/api/canvas/clean-imports', asyncH(async (req, res) => {
    const canvas = req.body?.canvas || 'main';
    const fn = canvas === 'work' ? (engine.getCvWork() || cv) : cv;
    const ours = new Set(engine.jobs.flatMap((j) => j.createdIds || []));
    const all = await listNodes(fn);
    const ids = (all || []).map((n) => n?.id).filter((id) => id && (ours.has(id) || /^(vid|txt)-/.test(id)));
    if (!ids.length) return res.json({ rmN: 0, rmE: 0, msg: '没有可清理的导入节点' });
    res.json(await fn('shadowRemove', { ids }));
  }));
  app.post('/api/learn-reset', (req, res) => { engine.runTemplate = null; engine.saveTemplate(); res.json({ ok: true }); });

  app.use(express.static(uiDir));

  const server = app.listen(port, '0.0.0.0', () => log(`[api] http://127.0.0.1:${port}`));
  server.on('error', (e) => log(`[api] 端口 ${port} 不可用: ${e.message}（改 config.json 的 port 或关闭占用进程）`));

  return {
    app, server, statusPayload,
    handleLocal: async (method, p, body) => {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Api-Token': token } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return r.json();
    },
  };
}

module.exports = { startApi };
