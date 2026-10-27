// 任务引擎：并发槽位调度 + 双画布路由 + 节点级清理
// 作业类型：
//   import   — 目录/SEG 导入「用户画布」（插件同款能力，供人工预览；可选 run）
//   seg      — 单个 SEG 目录 → 工作画布执行生成（API 用）
//   generate — API 传入图片+提示词 → 工作画布生成
//   run      — 运行指定/空闲 rh-video 节点（默认工作画布，可 spec.canvas='main'）
// 并发：maxConcurrent 个槽位（默认2），每个槽位占画布一列（lane），完成后归还。
// 清理：工作画布上的任务成功后 shadowRemove 自己创建的全部节点；失败默认保留
//       （cleanOnFail 可配），便于排查。
const fs = require('fs');
const path = require('path');
const { scanRoot, readPrompt } = require('./scanner');

const uid = (p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FALLBACK_VDATA = () => ({
  title: '视频', label: '视频', status: 'idle', subType: 'multimodal-video',
  parameterPresetSnapshot: {
    'text-video': {
      modelCode: 'text-video-rhart-video-minimax-h3-rh-enhanced-t2va',
      params: { aspectRatio: '9:16', resolution: '1080p', duration: '5' },
      generateNum: 1,
    },
  },
  modelCode: 'multimodal-video-rhart-video-minimax-h3-rh-enhanced-ref2va-app',
  generateNum: 1,
  params: {
    prompt: '', aspectRatio: '9:16', resolution: '768p', duration: '6',
    refImage1: '', refImage2: '', refImage3: '', refImage4: '', refImage5: '',
    refImage6: '', refImage7: '', refImage8: '', refImage9: '',
    refAudio1: '', refAudio2: '', refAudio3: '', audioMode: 'native',
  },
  maxConnect: { image: null, text: null, video: null },
  width: 380, height: 676,
});

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', mp4: 'video/mp4', mp3: 'audio/mpeg', wav: 'audio/wav' };

// 节点 data 里挑第一个 http(s) URL
const pickFirstUrl = (d) => {
  if (!d) return '';
  if (typeof d === 'string') return /^https?:\/\//.test(d) ? d : '';
  if (Array.isArray(d)) { for (const it of d) { const u = pickFirstUrl(it); if (u) return u; } return ''; }
  if (typeof d !== 'object') return '';
  for (const k of ['videoUrl', 'resultUrl', 'outputUrl', 'url', 'fileUrl', 'downloadUrl']) {
    const u = pickFirstUrl(d[k]); if (u) return u;
  }
  for (const k of ['output', 'outputs', 'result', 'results', 'nodeOutputHistory']) {
    const u = pickFirstUrl(d[k]); if (u) return u;
  }
  return '';
};

class Engine {
  constructor({ cvMain, getCvWork, log, dataDir, downloadDir, emit, config }) {
    this.cvMain = cvMain;       // 用户画布（导入/预览）
    this.getCvWork = getCvWork; // () => 工作画布 cv 或 null（未配置回落 main）
    this.log = log;
    this.dataDir = dataDir;
    this.downloadDir = downloadDir;
    this.emit = emit || (() => {});
    this.config = config;   // 引用主配置（maxConcurrent 等可热改）
    this.jobsFile = path.join(dataDir, 'jobs.json');
    this.tplFile = path.join(dataDir, 'runTemplate.json');
    this.jobs = [];
    this.runTemplate = null;
    try { this.jobs = JSON.parse(fs.readFileSync(this.jobsFile, 'utf8')); } catch {}
    try { this.runTemplate = JSON.parse(fs.readFileSync(this.tplFile, 'utf8')); } catch {}
    for (const j of this.jobs) if (['pending', 'running'].includes(j.status)) j.status = 'interrupted';

    // 并发槽位：laneUsed[i] = 槽位 i 是否占用（槽位号=画布列号）
    this.laneUsed = [];
    this.chanReady = new Map(); // 'main'|'work' → Promise（通道建立去重）
    this.dropLock = Promise.resolve(); // 页面 storedFiles 是全局的：push+drop 必须串行
  }

  get slots() { return Math.max(1, parseInt(this.config.maxConcurrent) || 2); }
  get runningJobs() { return this.jobs.filter((j) => j.status === 'running').length; }
  get pendingJobs() { return this.jobs.filter((j) => j.status === 'pending'); }

  // 删除一条非活跃记录（running/pending 不让删）
  remove(id) {
    const i = this.jobs.findIndex((j) => j.id === id && !['running', 'pending'].includes(j.status));
    if (i < 0) return false;
    this.jobs.splice(i, 1);
    this.persist();
    return true;
  }

  persist() {
    clearTimeout(this._pt);
    this._pt = setTimeout(() => {
      try { fs.writeFileSync(this.jobsFile, JSON.stringify(this.jobs.slice(-500), null, 1)); } catch {}
    }, 300);
  }

  saveTemplate() {
    try { fs.writeFileSync(this.tplFile, JSON.stringify(this.runTemplate, null, 2)); } catch {}
  }

  addJob(kind, spec) {
    const job = {
      id: uid('job'), kind, spec,
      status: 'pending', progress: '', lane: null, canvas: null,
      nodeId: null, taskId: null, videoUrl: null, filePath: null, error: null,
      createdIds: [], results: [],
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    this.jobs.push(job);
    this.persist();
    this.emit('job', job);
    this.pump();
    return job;
  }

  upd(job, patch) {
    Object.assign(job, patch, { updatedAt: Date.now() });
    this.persist();
    this.emit('job', job);
  }

  allocLane() {
    for (let i = 0; i < this.slots; i++) if (!this.laneUsed[i]) { this.laneUsed[i] = true; return i; }
    return -1;
  }

  // 出队：有槽位 + 有待办 → 启动
  pump() {
    for (;;) {
      const pending = this.pendingJobs;
      if (!pending.length) return;
      const job = pending[0];
      if (job.cancel) { this.upd(job, { status: 'cancelled' }); continue; }
      const lane = this.allocLane();
      if (lane < 0) return;
      job.lane = lane;
      this.exec(job, lane).finally(() => {
        this.laneUsed[lane] = false;
        this.pump();
      });
    }
  }

  // 任务路由画布：import（不run）→ 用户画布；其余 → 工作画布（未配置回落用户画布）
  // spec.canvas='main'|'work' 可强制指定
  cvFor(job) {
    const w = this.getCvWork();
    if (job.spec?.canvas === 'main') return this.cvMain;
    if (job.spec?.canvas === 'work') return w || this.cvMain;
    const useWork = !(job.kind === 'import' && !job.spec.run);
    return useWork && w ? w : this.cvMain;
  }

  chanKey(job) { return this.cvFor(job) === this.getCvWork() && this.getCvWork() ? 'work' : 'main'; }

  async exec(job, lane) {
    const cv = this.cvFor(job);
    job._cv = cv;
    this.upd(job, { status: 'running', canvas: this.chanKey(job), lane });
    try {
      await this.ensureChannel(cv, this.chanKey(job));
      if (job.kind === 'import' || job.kind === 'seg' || job.kind === 'generate') {
        await this.execImport(job, cv, lane);
      } else if (job.kind === 'run') {
        await this.execRun(job, cv);
      }
      if (job.status === 'running') this.upd(job, { status: 'done' });
    } catch (e) {
      // 被取消的任务统一记 cancelled
      this.upd(job, { status: job.cancel ? 'cancelled' : 'failed', error: String(e.message || e) });
      this.log(`[job ${job.id}] ${job.cancel ? '已取消' : '失败'}: ${e.message}`);
    } finally {
      // API 一次性任务（seg/generate）完成后清理自己创建的节点
      // import 类的节点保留（本来就是给人审的）；cleanOnFail 可配
      const cleanable = ['seg', 'generate'].includes(job.kind);
      const ok = job.status === 'done' || job.status === 'partial';
      if (cleanable && job.createdIds.length && (ok || this.config.cleanOnFail)) {
        try {
          const r = await cv('shadowRemove', { ids: job.createdIds });
          this.log(`[job ${job.id}] 清理画布节点 ${r.rmN}+边${r.rmE}`);
          job.cleaned = true;
        } catch (e) { this.log(`[job ${job.id}] 清理失败: ${e.message}`); }
      }
      this.persist();
    }
  }

  // 通道建立去重：同画布并发任务共享一次建连
  async ensureChannel(cv, key) {
    if (!this.chanReady.get(key)) {
      this.chanReady.set(key, (async () => {
        for (;;) {
          const st = await cv('status');
          if (!st.token) throw new Error(`画布(${key})未登录`);
          if (st.shadow?.own?.open && st.shadow.own.synced) return;
          await cv('ownConnect').catch((e) => this.log(`ownConnect(${key}): ${e.message}`));
          await sleep(1800);
          const sc = (await cv('status')).shadow || {};
          if (sc.own?.open) return;
          await cv('shadowSync').catch(() => {});
          await sleep(800);
          const sc2 = (await cv('status')).shadow || {};
          if (sc2.own?.open || sc2.ws) return;
          throw new Error(`画布(${key})协同通道未连接`);
        }
      })().catch((e) => { this.chanReady.delete(key); throw e; }));
    }
    return this.chanReady.get(key);
  }

  markChannelDirty(key) { this.chanReady.delete(key); }

  // 同画布上"压文件→drop→等新节点"整段串行（页面 storedFiles 全局共享）
  withDropLock(fn) {
    const p = this.dropLock.then(fn, fn);
    this.dropLock = p.catch(() => {});
    return p;
  }

  // 全量节点：优先影子 doc（覆盖视口外节点；未同步回落 inspectAll DOM）
  // 全量节点：exportNodes（官方 _exportWorkflow，含图节点）→ shadowDump → inspectAll
  async allNodes(cv) {
    const d = await cv('exportNodes').catch(() => null);
    if (d?.nodes?.length) return d.nodes;
    const d2 = await cv('shadowDump').catch(() => null);
    if (d2?.nodes?.length) return d2.nodes;
    return await cv('inspectAll').catch(() => []);
  }

  async pushFile(cv, absPath) {
    const buf = fs.readFileSync(absPath);
    const name = path.basename(absPath);
    const type = MIME[path.extname(name).slice(1).toLowerCase()] || 'application/octet-stream';
    return await cv('addFile', { name, type, b64: buf.toString('base64') });
  }

  // ---- 一组图片+提示词 → 画布建组（图节点+视频节点+边）----
  async importGroup(job, cv, { images, prompt, duration, params, epName, segName, ctx }) {
    const tag = `${epName || ''}/${segName || job.id}`;
    const nImg = images.length;
    this.upd(job, { progress: `${tag}: 上传 ${nImg} 图` });
    this.log(`[job ${job.id}] ${tag}: ${nImg}图 ${duration || '?'}s 上传中…`);

    const imgIds = await this.withDropLock(async () => {
      await Promise.all(images.map((img) => this.pushFile(cv, img)));
      const watchP = cv('watchNewNodes', { ms: 60000, expect: nImg }, 70000).catch(() => ({ added: [] }));
      await cv('dropStored', { x: ctx.centerX, y: ctx.dropY });
      const w = await watchP;
      return (w.added || []).filter((n) => !['rh-video', 'rh-text'].includes(n.type)).map((n) => n.id);
    });
    if (!imgIds.length) throw new Error('drop 后未检测到新节点（页面可能未加载完）');
    this.log(`[job ${job.id}] ${imgIds.length} 图已落画布`);

    // 等图片节点出现 AND 上传完成（sourceObjects 是真 https URL，不是 blob: 占位——
    // blob 状态下点生成，服务器拿不到图 = 参考图全丢）
    const t0 = Date.now();
    let all = [];
    const uploaded = (n) => {
      const u = n?.data?.sourceObjects?.[0] || '';
      return /^https?:/i.test(u) && !u.startsWith('blob:');
    };
    while (Date.now() - t0 < 25000) {
      all = await this.allNodes(cv);
      const ready = imgIds.filter((id) => { const n = all.find((x) => x.id === id); return n && uploaded(n); }).length;
      if (ready >= imgIds.length) break;
      await sleep(500);
    }
    const imgs = imgIds.map((id) => all.find((n) => n.id === id)).filter(Boolean);
    imgs.sort((a, b) => {
      const na = parseInt(String(a.data?.title || a.data?.label || '').match(/\d+/)?.[0] || '0');
      const nb = parseInt(String(b.data?.title || b.data?.label || '').match(/\d+/)?.[0] || '0');
      return na - nb;
    });
    const rowY = ctx.cursorY;
    const V_W = 380, GAP = 40;
    let cx = ctx.startX + V_W + GAP, maxH = 0;
    let patches = [];
    for (const n of imgs) {
      const w2 = Number(n?.data?.width ?? n?.style?.width ?? 320) || 320;
      const h2 = Number(n?.data?.height ?? n?.style?.height ?? 240) || 240;
      patches.push({ id: n.id, patch: { position: { x: cx, y: rowY } } });
      cx += w2 + GAP;
      maxH = Math.max(maxH, h2);
    }
    // 批量摆位：一次事务；影子迟到的节点按 missing 重试
    for (let tries = 0; tries < 10 && patches.length; tries++) {
      const r = await cv('shadowPatch', { patches }).catch(() => null);
      if (r && !(r.missing || []).length) break;
      patches = r?.missing?.length ? patches.filter((p) => r.missing.includes(p.id)) : patches;
      await sleep(300);
    }
    ctx.cursorY += Math.max(maxH, 300) + 200;
    ctx.colRight = Math.max(ctx.colRight || 0, cx, ctx.startX + V_W);

    const vidId = uid('vid');
    const vdata = ctx.template ? JSON.parse(JSON.stringify(ctx.template.data)) : FALLBACK_VDATA();
    for (const k of ['output', 'outputs', 'taskId', 'estimateTaskId', 'errorMessage', 'videoUrl', 'resultUrl', 'thumbnail', 'prompt', 'duration', 'nodeOutputHistory', 'selectedOutputHistoryId', 'selectedOutputHistoryIndex', 'generationStartedAt']) delete vdata[k];
    if (vdata.params && typeof vdata.params === 'object') {
      for (const k of ['imageUrls', 'audioUrls', 'videoUrls', 'imageurls', 'videourls']) delete vdata.params[k];
    }
    vdata.status = 'idle';
    vdata.params = { ...(vdata.params || {}), prompt, ...(params || {}) };
    if (duration != null) {
      // 时长超范围钳位（可在 API 页关掉对应方向）：
      // clampDurMin=低于4按4（默认开）；clampDurMax=超15按15（默认开）；关掉则原值写入
      let sec = Math.round(Number(duration) || 4);
      if (sec < 4 && this.config.clampDurMin !== false) { sec = 4; this.log(`[job ${job.id}] ${tag}: 时长 ${duration}s 低于下限，按 4s`); }
      else if (sec > 15 && this.config.clampDurMax !== false) { sec = 15; this.log(`[job ${job.id}] ${tag}: 时长 ${duration}s 超上限，按 15s`); }
      vdata.params.duration = String(sec);
    }
    const vstyle = ctx.template?.style ? { ...ctx.template.style } : { width: 380, height: 220 };
    const vnode = { id: vidId, type: 'rh-video', position: { x: ctx.startX, y: rowY }, selectable: true, data: vdata, style: vstyle };
    const edges = imgIds.map((id) => ({ id: `e-${id}-${vidId}`, source: id, target: vidId, sourceHandle: 'output', targetHandle: 'input', type: 'default' }));
    await cv('shadowAdd', { nodes: [vnode], edges });

    await sleep(700);
    const chk = await cv('inspectNode', { id: vidId }).catch(() => null);
    // 边没进 App doc（影子 WS 断线写了也白写）→ 重连补发，最多3轮
    let ec = await cv('edgeCheck', { targetId: vidId, sourceIds: imgIds }).catch(() => null);
    for (let retry = 0; retry < 3 && ec && ec.toTarget < imgIds.length; retry++) {
      this.log(`[job ${job.id}] ${tag}: 边缺失 ${ec.toTarget}/${imgIds.length}，重连补发…`);
      await cv('ownConnect').catch(() => {});
      await sleep(1200);
      await cv('shadowAdd', { nodes: [], edges }).catch(() => {});
      await sleep(700);
      ec = await cv('edgeCheck', { targetId: vidId, sourceIds: imgIds }).catch(() => null);
    }
    if (ec && ec.toTarget < imgIds.length) throw new Error(`${tag}: 参考图连线失败（${ec.toTarget}/${imgIds.length}）——生成会丢参考效果，已中止`);
    this.log(`[job ${job.id}] 节点${chk ? '✓' : '✗'} 边${ec ? `${ec.toTarget}/${imgIds.length}` : '?'}`);
    // 参考图绑定：真实应用连线时会把图URL写进 params.refImageN——我们手动补上
    try {
      const ex = await cv('exportNodes');
      const urlOf = (nid) => ex?.nodes?.find((n) => n.id === nid)?.data?.sourceObjects?.[0];
      const refs = {};
      imgIds.forEach((nid, i) => { const u = urlOf(nid); if (u) refs[`refImage${i + 1}`] = u; });
      if (Object.keys(refs).length) await cv('shadowPatch', { id: vidId, patch: { params: refs } });
      this.log(`[job ${job.id}] refImage填充 ${Object.keys(refs).length}/${imgIds.length}`);
    } catch (e) { this.log(`[job ${job.id}] refImage填充失败: ${e.message}`); }
    job.createdIds.push(vidId, ...imgIds);
    this.upd(job, { nodeId: vidId, progress: `${tag}: 已建节点` });
    return { vidId, imgIds };
  }

  async makeCtx(cv, lane = 0, spec = {}) {
    const allNodes = await this.allNodes(cv);
    const vids = (allNodes || []).filter((n) => n?.type === 'rh-video');
    const configured = vids.filter((n) => n?.data?.modelCode);
    const template = configured.length ? configured[configured.length - 1] : (vids.length ? vids[vids.length - 1] : null);
    // 每个并发槽位一列：lane*N 宽度起排，互不干扰
    const LANE_W = 3000;
    let startX = lane * LANE_W, cursorY = 0;
    // 列归属判定：只看本列范围 [startX, startX+LANE_W) 内的节点；
    // 上列的行可宽 ~2900+，居中±带会算到上列图 → 新列 Y 被迫接在上列底部（阶梯错列）
    const inCol = (x) => x >= startX - 60 && x < startX + LANE_W;
    if (spec?.colSeed && Number.isFinite(spec.colSeed.x)) {
      // 「换列」起点：X 固定在该列，Y 取该列现有内容底部（持续列，多次导入继续往下排）
      startX = spec.colSeed.x;
      let maxY = -Infinity;
      for (const n of allNodes || []) {
        const p = n?.position; if (!p || !inCol(p.x ?? 0)) continue;
        const h = Number(n?.data?.height ?? n?.style?.height ?? 280) || 280;
        maxY = Math.max(maxY, p.y + h);
      }
      cursorY = Number.isFinite(maxY) ? maxY + 220 : (spec.colSeed.y || 0);
    } else if (allNodes?.length) {
      let maxY = -Infinity;
      for (const n of allNodes) {
        const p = n?.position; if (!p || !inCol(p.x ?? 0)) continue;
        const h = Number(n?.data?.height ?? n?.style?.height ?? 280) || 280;
        maxY = Math.max(maxY, p.y + h);
      }
      if (Number.isFinite(maxY)) cursorY = maxY + 220;
    }
    return { template, centerX: 700, dropY: 400 + lane * 240, startX, cursorY, colTop: cursorY, colRight: startX };
  }

  async execImport(job, cv, lane) {
    const ctx = await this.makeCtx(cv, lane, job.spec);
    const spec = job.spec;

    if (job.kind === 'generate') {
      const { vidId } = await this.importGroup(job, cv, {
        images: spec.images, prompt: spec.prompt || '',
        duration: spec.duration, params: spec.params, ctx,
      });
      if (spec.run !== false) {
        await this.runAndFetch(job, cv, vidId, spec.saveName || `${job.id}.mp4`);
        job.results.push({ vidId, status: 'done', filePath: job.filePath, videoUrl: job.videoUrl });
      }
      return;
    }

    let ok = 0;
    const items = spec.segs;
    let lastEp = null;
    for (const it of items) {
      // split 模式：每个 EP 换一列（新列从当前列最右+320、列顶重新往下）
      if (spec.mode === 'split' && lastEp !== null && it.epName !== lastEp) {
        ctx.startX = (ctx.colRight || ctx.startX) + 320;
        ctx.cursorY = ctx.colTop;
        ctx.colRight = ctx.startX;
      }
      lastEp = it.epName;
      if (job.cancel) { this.upd(job, { status: 'cancelled', progress: `已取消 ${ok}/${items.length}` }); return; }
      const seg = it.seg;
      const prompt = spec.promptOverride ?? readPrompt(seg);
      const rec = { ep: it.epName, seg: seg.name };
      job.results.push(rec);
      try {
        const { vidId } = await this.importGroup(job, cv, {
          images: seg.images, prompt,
          duration: seg.seconds, params: spec.params,
          epName: it.epName, segName: seg.name, ctx,
        });
        rec.vidId = vidId; rec.status = 'imported';
        if (spec.run) {
          const saveName = spec.savePattern
            ? spec.savePattern.replace('{ep}', it.epName).replace('{seg}', seg.name)
            : path.join(it.epName.replace(/[\\/:*?"<>|]/g, '_'), `${seg.name}.mp4`);
          await this.runAndFetch(job, cv, vidId, saveName);
          rec.status = 'done'; rec.filePath = job.filePath; rec.videoUrl = job.videoUrl;
        }
        ok++;
      } catch (e) {
        this.log(`[job ${job.id}] ${seg.name} 失败: ${e.message}`);
        rec.status = 'failed'; rec.error = String(e.message || e);
      }
      this.upd(job, { progress: `${ok}/${items.length}` });
      await sleep(250);
    }
    this.upd(job, { status: ok === items.length ? 'done' : (ok ? 'partial' : 'failed'), progress: `完成 ${ok}/${items.length}` });
  }

  // REST 直发 task/run：学到的真实模板优先，兜底三类猜测报文
  // 子图 = 目标节点 + 上游输入图节点 + 边（全量 exportNodes，影子会漏图节点）
  async restRun(job, cv, vidId) {
    const canvasId = job._canvasId || (job._canvasId = (await cv('status')).canvasId);
    const teamId = await cv('eval', { code: "localStorage.getItem('currentTeamId')" }).catch(() => null);
    const tid = teamId ? { teamId } : {};
    const ex = await cv('exportNodes').catch(() => null);
    const dump = ex || await cv('shadowDump').catch(() => null);
    const allN = dump?.nodes || [], allE = dump?.edges || [];
    const target = allN.find((n) => n.id === vidId);
    if (!target) throw new Error(`REST: 画布上找不到节点 ${vidId}`);
    const inEdges = allE.filter((e) => e.target === vidId);
    const srcSet = new Set(inEdges.map((e) => e.source));
    const canvas = { nodes: [target, ...allN.filter((n) => srcSet.has(n.id))], edges: inEdges };
    const cid = String(canvasId);
    const fixCid = (o) => {
      for (const [k, v] of Object.entries(o || {})) {
        if (/canvasid/i.test(k) && typeof v !== 'object') o[k] = typeof v === 'number' ? (Number(cid) || v) : cid;
        else if (v && typeof v === 'object') fixCid(v);
      }
    };
    const tries = [];
    if (this.runTemplate?.body && this.runTemplate.idPaths?.length) {
      const body = JSON.parse(JSON.stringify(this.runTemplate.body));
      body.canvas = canvas; // 换成当前节点的实时子图
      for (const segs of this.runTemplate.idPaths || []) {
        let o = body;
        for (let i = 0; i < segs.length - 1; i++) { o = o?.[segs[i]]; }
        if (o && segs.length) o[segs[segs.length - 1]] = vidId;
      }
      fixCid(body);
      tries.push({ path: this.runTemplate.path, body });
    }
    tries.push(
      { body: { canvasId, targetType: 'NODE', targetId: vidId, canvas, ...tid } },
      { body: { canvasId, targetType: 'NODE', targetId: vidId, ...tid } },
      { body: { canvasId, nodeIds: [vidId], ...tid } },
    );
    let last = null;
    for (const t of tries) {
      const r = await cv('runTask', { payload: t.body, path: t.path }).catch((e) => ({ err: String(e) }));
      last = r;
      this.log(`[run] ${t.path || '/canvas/task/run'} ${JSON.stringify(t.body).slice(0, 160)} → ${r.status ?? r.err}`);
      if (r.status === 200) return { resp: r.json, taskId: r.json?.data?.taskId || r.json?.taskId || r.json?.data || null, via: 'rest' };
    }
    throw new Error(`task/run 全部失败，最后响应: ${JSON.stringify(last).slice(0, 300)}`);
  }

  // 运行视频节点：run 类并发优先 REST（不抢工具栏）；其余先点 ▶ 学习真实模板，失败回退 REST
  async runTaskFor(job, cv, vidId) {
    if (job.kind === 'run' && this.runTemplate?.body) {
      try { return await this.restRun(job, cv, vidId); }
      catch (e) { this.log(`[run] REST 优先失败: ${e.message}，回退点击`); }
    }
    try {
      const r = await cv('clickRun', { id: vidId });
      if (!r?.err) {
        this.log(`[run] click ▶ ${vidId} → ${JSON.stringify(r.clicked || r)}`);
        const t0 = Date.now();
        while (Date.now() - t0 < 30000) {
          const n = await cv('inspectNode', { id: vidId }).catch(() => null);
          const d = n?.data || {};
          const st = String(d.status || '').toLowerCase();
          if (['finished', 'success'].includes(st) && pickFirstUrl(d)) return { via: 'click', instant: true };
          if (d.taskId || d.estimateTaskId || ['running', 'queued', 'pending', 'processing', 'waiting'].includes(st)) {
            return { taskId: d.taskId || d.estimateTaskId || null, via: 'click' };
          }
          await sleep(600);
        }
        this.log('[run] 点击后 30s 未观察到运行态，回退 REST');
      } else {
        this.log(`[run] clickRun: ${r.err}，回退 REST`);
      }
    } catch (e) {
      this.log(`[run] clickRun 不可用: ${e.message}，回退 REST`);
    }

    return this.restRun(job, cv, vidId);
  }

  async runAndFetch(job, cv, vidId, saveName) {
    this.upd(job, { progress: '提交任务…' });
    const { resp, taskId } = await this.runTaskFor(job, cv, vidId);
    if (taskId) this.upd(job, { taskId: typeof taskId === 'string' ? taskId : JSON.stringify(taskId) });
    this.upd(job, { progress: '生成中…' });

    // 快速确认真启动了：~40s 内节点仍 idle 且无 taskId → 运行没触发，别傻等整个超时
    const t0 = Date.now();
    let started = false;
    while (Date.now() - t0 < 40000) {
      const n = await cv('inspectNode', { id: vidId }).catch(() => null);
      const nn = Array.isArray(n) ? n[0] : n;
      const st = nn?.data?.status;
      if (job.cancel) throw new Error('已取消');
      if ((st && st !== 'idle') || nn?.data?.taskId || nn?.data?.output?.length) { started = true; break; }
      await new Promise((r) => setTimeout(r, 4000));
    }
    if (!started) throw new Error('点击运行后节点仍 idle——运行未触发（无 taskId）');

    // watchNode 在页面端跑轮询——cancel 时主动发 watchAbort 中止它
    const killer = setInterval(() => {
      if (job.cancel) cv('watchAbort', { id: vidId }).catch(() => {});
    }, 1500);
    const w = await cv('watchNode', { id: vidId, ms: job.spec.timeoutMs || 900000 }, 920000)
      .finally(() => clearInterval(killer));
    if (job.cancel || w.terminal === 'aborted') throw new Error('已取消');
    if (w.terminal !== 'success') {
      throw new Error(`生成未完成: ${w.terminal} ${w.status || ''} ${w.error || ''}`.trim());
    }
    const url = w.url;
    if (!url) throw new Error('节点成功但未找到视频 URL');
    this.upd(job, { videoUrl: url, progress: '下载中…' });

    const filePath = await this.download(url, saveName);
    this.upd(job, { filePath, progress: '完成' });
    if (job.spec.webhookUrl) this.callWebhook(job).catch(() => {});
    return filePath;
  }

  async execRun(job, cv) {
    const ids = job.spec.nodeIds?.length ? job.spec.nodeIds : await this.idleVideoNodes(cv);
    if (!ids.length) throw new Error('画布上没有可运行的视频节点');
    // 并发工人池：每人循环领节点 触发生成→轮询→下载
    const conc = Math.max(1, Math.min(8, job.spec.runN || 1));
    const queue = ids.slice();
    const retries = {}; // vidId → 已重试次数（并发上限 1520 延迟重试）
    // 并发槽 = 画布上在跑的节点（手动/别的会话也算）+ 本任务已认领的，共 conc 槽
    const RUNNING_ST = ['running', 'queued', 'pending', 'processing', 'waiting'];
    const claimed = new Set(); // 本任务已提交还没完成的——防"已提交未跑"时多抢槽
    const inflightCount = async () => {
      const all = await this.allNodes(cv).catch(() => []);
      const serverSide = all.filter((n) => n?.type === 'rh-video' && !claimed.has(n.id)
        && RUNNING_ST.includes(String(n?.data?.status || '').toLowerCase())).length;
      return serverSide + claimed.size;
    };
    let ok = 0;
    const worker = async () => {
      while (!job.cancel && queue.length) {
        const inflight = await inflightCount();
        if (inflight >= conc) { await sleep(2500); continue; }
        const vidId = queue.shift();
        claimed.add(vidId);
        try {
          const fp = await this.runAndFetch(job, cv, vidId, `${vidId}.mp4`);
          job.results.push({ vidId, status: 'done', filePath: fp || job.filePath });
          ok++;
        } catch (e) {
          const msg = String(e.message || e);
          // 服务端并发上限（1520）/限流 → 重排队尾延后重试，最多3次
          if (/1520|并发.*上限|Concurrency limit/i.test(msg) && (retries[vidId] = (retries[vidId] || 0) + 1) <= 3) {
            this.log(`[job ${job.id}] ${vidId} 服务端并发上限，${25 * retries[vidId]}s 后重试（${retries[vidId]}/3）`);
            await sleep(25000 * retries[vidId]);
            if (!job.cancel) { claimed.delete(vidId); queue.push(vidId); }
            continue;
          }
          this.log(`[job ${job.id}] run ${vidId} 失败: ${msg}`);
          job.results.push({ vidId, status: 'failed', error: msg });
        } finally {
          claimed.delete(vidId);
        }
        this.upd(job, { progress: `运行 ${ok}/${ids.length}` });
      }
    };
    await Promise.all(Array.from({ length: conc }, worker));
    this.upd(job, { status: job.cancel ? 'cancelled' : (ok === ids.length ? 'done' : 'partial'), progress: `运行 ${ok}/${ids.length}` });
  }

  async idleVideoNodes(cv) {
    // 走全量导出（影子 doc 会漏节点——只找一部分空闲节点=只跑一部分）
    const vids = (await this.allNodes(cv)).filter((n) => n?.type === 'rh-video');
    return (vids || [])
      .filter((n) => ['idle', '', undefined].includes(n?.data?.status) && n?.data?.params?.prompt)
      .map((n) => n.id);
  }

  async download(url, saveName) {
    const dest = path.join(this.downloadDir, saveName.replace(/[\\/]+/g, '/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const https = url.startsWith('https') ? require('https') : require('http');
    await new Promise((resolve, reject) => {
      const req = https.get(url, { headers: { Referer: 'https://rhtv.runninghub.cn/' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return this.download(res.headers.location, saveName).then(resolve, reject);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`下载失败 HTTP ${res.statusCode}`)); }
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on('finish', () => out.close(resolve));
        out.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(120000, () => req.destroy(new Error('下载超时')));
    });
    this.log(`[dl] ${saveName} ← ${url.slice(0, 100)}`);
    return dest;
  }

  async callWebhook(job) {
    try {
      await fetch(job.spec.webhookUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: job.id, status: job.status, videoUrl: job.videoUrl, filePath: job.filePath }),
      });
    } catch (e) { this.log(`webhook fail: ${e.message}`); }
  }

  // apiTap 学习 /canvas/task/run 真实报文
  async learnFromApiEvent(e) {
    try {
      if (e.method !== 'POST' || !e.url || e.status !== 200) return;
      const u = new URL(e.url, 'https://x');
      if (!/task\/run/i.test(u.pathname)) return;
      const body = e.reqBody ? JSON.parse(e.reqBody) : null;
      if (!body) return;
      const w = this.getCvWork();
      const vids = new Set(
        (await this.cvMain('nodesByType', { type: 'rh-video' }).catch(() => []))
          .concat(await (w ? w('nodesByType', { type: 'rh-video' }).catch(() => []) : Promise.resolve([])))
          .map((n) => n.id)
      );
      const idPaths = [];
      const walk = (o, trail) => {
        if (Array.isArray(o)) {
          o.forEach((it, i) => {
            if (typeof it === 'string' && vids.has(it)) idPaths.push([...trail, String(i)]);
            else if (it && typeof it === 'object') walk(it, [...trail, String(i)]);
          });
          return;
        }
        for (const [k, v] of Object.entries(o || {})) {
          if (typeof v === 'string' && vids.has(v)) idPaths.push([...trail, k]);
          else if (v && typeof v === 'object') walk(v, [...trail, k]);
        }
      };
      walk(body, []);
      this.runTemplate = { path: u.pathname, body, idPaths, learnedAt: Date.now() };
      this.saveTemplate();
      this.log(`[learn] 已记录 task/run 模板 idPaths=${idPaths.map((p) => p.join('.')).join(',') || '(未匹配到nodeId)'}`);
    } catch (e2) { this.log(`[learn] 模板解析失败: ${e2.message}`); }
  }
}

module.exports = { Engine, scanRoot };
