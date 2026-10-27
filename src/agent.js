// RH Canvas Agent — 由 Electron 主进程注入画布页面 (MAIN world)。
// 移植自浏览器插件 page.js：影子 Y.Doc + 自建协同 WS + drop 上传 + 节点读写。
// 新增：REST API 抓包(apiTap)、任务运行(runTask)、节点状态监控(watchNode)、
//       主进程文件注入(addFile/dropStoredFiles)、事件回推(push → /api/ingest)。
// 主进程通过 webContents.executeJavaScript 调 window.__rhci.run(cmd, args)。
(() => {
  if (window.__rhci) return; // 防重复注入
  const log = (...a) => console.log('[rh-agent]', ...a);

  let cfg = { port: 19387 };
  const getToken = () => localStorage.getItem('Rh-Accesstoken') || '';
  const getUserId = () => {
    try { return JSON.parse(localStorage.getItem('userInfo') || '{}').id || ''; } catch { return ''; }
  };
  const getCanvasId = () => {
    const m = location.pathname.match(/canvas\/(\d+)/);
    return m ? m[1] : '';
  };

  const apiFetch = async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${getToken()}`,
        version: '1.0.46',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'include',
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text: json ? undefined : text.slice(0, 800) };
  };

  // ---- 事件回推到本地服务（agent → 主进程单向通道）----
  const push = (type, data) => {
    try {
      fetch(`http://127.0.0.1:${cfg.port}/api/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(cfg.token ? { 'X-Api-Token': cfg.token } : {}) },
        body: JSON.stringify({ type, data, t: Date.now() }),
      }).catch(() => {});
    } catch {}
  };

  // ================= REST API 抓包 =================
  // 记录 app 自己发出的 /canvas/* 请求（方法/URL/请求体/响应），用于学习
  // task/run、结果查询等内部接口的真实报文。
  const apiLog = [];
  const recApi = (e) => {
    apiLog.push(e);
    if (apiLog.length > 300) apiLog.shift();
    if (/task|run|result|status|output|video/i.test(e.url)) push('api', e);
  };
  try {
    const of = window.fetch;
    window.fetch = async (...a) => {
      const req = a[0];
      const url = typeof req === 'string' ? req : req?.url;
      const method = String(a[1]?.method || (req && req.method) || 'GET').toUpperCase();
      let reqBody;
      // task/run 报文是 learnTemplate 的学习源——不能截断，其余 6000 够了
      const lim = /task\/run/i.test(String(url)) ? 400000 : 6000;
      try { reqBody = a[1]?.body ? String(a[1].body).slice(0, lim) : undefined; } catch {}
      const res = await of(...a);
      try {
        if (url && String(url).includes('/canvas/')) {
          const txt = await res.clone().text().catch(() => '');
          recApi({ via: 'fetch', method, url: String(url), status: res.status, reqBody, resp: txt.slice(0, 6000) });
        }
      } catch {}
      return res;
    };
    const O = XMLHttpRequest.prototype.open, S = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { this.__rhM = m; this.__rhU = u; return O.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function (b) {
      const xhr = this;
      if (xhr.__rhU && String(xhr.__rhU).includes('/canvas/')) {
        xhr.addEventListener('load', () => {
          recApi({
            via: 'xhr', method: String(xhr.__rhM || 'GET').toUpperCase(), url: String(xhr.__rhU),
            status: xhr.status,
            reqBody: b ? String(b).slice(0, /task\/run/i.test(String(xhr.__rhU)) ? 400000 : 6000) : undefined,
            resp: String(xhr.responseText || '').slice(0, 6000),
          });
        });
      }
      return S.apply(this, arguments);
    };
  } catch (e) { log('api tap failed', e); }

  // ================= 影子 Y.Doc =================
  const R = () => window.RHCI_Y;
  const shadow = { doc: null, ws: null, wsUrl: '', msgsSeen: 0, applied: 0, lastErr: '' };

  const yMap = () => shadow.doc?.getMap('canvas');
  const yContent = () => yMap()?.get('canvas_content');
  const ynodes = () => yContent()?.get('nodes');
  const yedges = () => yContent()?.get('edges');

  const feedShadow = (data) => {
    const { syncProtocol, encoding, decoding } = R();
    try {
      const dec = decoding.createDecoder(new Uint8Array(data));
      const msgType = decoding.readVarUint(dec);
      if (msgType !== 0) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.readSyncMessage(dec, enc, shadow.doc, 'rhci-remote');
      shadow.applied += encoding.length(enc) > 1 ? 0 : 1;
    } catch (e) { shadow.lastErr = String(e && e.message || e); }
  };

  const sendOnAppSocket = (payloadEnc) => {
    const { encoding } = R();
    const ws = shadow.ws;
    if (!ws || ws.readyState !== 1) throw new Error('app socket 未连接');
    ws.send(encoding.toUint8Array(payloadEnc));
  };

  // ============ 自己的 ws 连接：作为第二协作者 ============
  const own = { ws: null, url: '', synced: false, err: '', msgs: 0 };

  const ownSend = (enc) => {
    const { encoding } = R();
    const ws = own.ws;
    if (!ws || ws.readyState !== 1) throw new Error('own socket 未连接');
    ws.send(encoding.toUint8Array(enc));
  };

  // 优先用捕获到的 App socket URL；否则按已知参数自行构造
  const ownWsUrl = () => {
    if (!shadow.doc) initShadowDoc();
    if (shadow.wsUrl) {
      const u = new URL(shadow.wsUrl);
      u.searchParams.set('yjsClientId', String(shadow.doc.clientID));
      return u.toString();
    }
    const p = new URLSearchParams({
      roomId: getCanvasId(), userId: getUserId(),
      token: getToken(), type: 'canvas',
      yjsClientId: String(shadow.doc.clientID),
    });
    return `wss://${location.host}/canvas/ws?${p}`;
  };

  const ownConnect = () => {
    const token = getToken(), cid = getCanvasId();
    if (!token) throw new Error('未登录（无 Rh-Accesstoken）');
    if (!cid) throw new Error('不在画布页面');
    const { syncProtocol, encoding, decoding } = R();
    if (!shadow.doc) initShadowDoc();
    try { own.ws?.close(); } catch {}
    own.url = ownWsUrl();
    own.synced = false;
    const ws = new WebSocket(own.url);
    ws.binaryType = 'arraybuffer';
    own.ws = ws;
    ws.onopen = () => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeSyncStep1(enc, shadow.doc);
      ws.send(encoding.toUint8Array(enc));
      log('own ws open → syncStep1 sent');
      push('ws', { url: own.url.replace(/token=[^&]+/, 'token=***') });
    };
    ws.onmessage = (e) => {
      own.msgs++;
      if (!(e.data instanceof ArrayBuffer)) return;
      try {
        const dec = decoding.createDecoder(new Uint8Array(e.data));
        const msgType = decoding.readVarUint(dec);
        if (msgType === 0) {
          const enc = encoding.createEncoder();
          encoding.writeVarUint(enc, 0);
          const st = syncProtocol.readSyncMessage(dec, enc, shadow.doc, 'rhci-remote');
          if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
          if (st === 1 || st === 2) own.synced = true;
        }
      } catch (err) { own.err = String(err && err.message || err); }
    };
    ws.onerror = () => { own.err = 'ws error'; };
    ws.onclose = (e) => {
      own.err = `closed ${e.code}`;
      // 非正常断开自动重连（换了新 ws 的不重连）
      if (own.ws === ws && e.code !== 1000) {
        setTimeout(() => { try { ownConnect(); } catch {} }, 3000);
      }
    };
    return { url: own.url.replace(/token=[^&]+/, 'token=***') };
  };

  const ownStatus = () => ({
    open: !!own.ws && own.ws.readyState === 1,
    state: own.ws?.readyState,
    synced: own.synced,
    msgs: own.msgs,
    err: own.err,
  });

  const shadowCounts = () => ({
    own: ownStatus(),
    ws: !!shadow.ws && shadow.ws.readyState === 1,
    wsUrl: shadow.wsUrl ? shadow.wsUrl.replace(/token=[^&]+/, 'token=***') : '',
    msgsSeen: shadow.msgsSeen,
    applied: shadow.applied,
    nodes: ynodes()?.length ?? -1,
    edges: yedges()?.length ?? -1,
    lastErr: shadow.lastErr,
  });

  const shadowSync = () => {
    const { syncProtocol, encoding } = R();
    if (!shadow.doc) initShadowDoc();
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.writeSyncStep1(enc, shadow.doc);
    if (own.ws?.readyState === 1) ownSend(enc);
    else sendOnAppSocket(enc);
    return shadowCounts();
  };

  const initShadowDoc = () => {
    if (shadow.doc) return;
    const { Y } = R();
    shadow.doc = new Y.Doc();
    shadow.doc.on('update', (update, origin) => {
      if (origin !== 'rhci-local') return;
      const { syncProtocol, encoding } = R();
      try {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, 0);
        syncProtocol.writeUpdate(enc, update);
        if (own.ws?.readyState === 1) ownSend(enc);
        else sendOnAppSocket(enc);
      } catch (e) { shadow.lastErr = 'send:' + e.message; }
    });
  };

  const captureWs = (ws, url) => {
    shadow.ws = ws;
    shadow.wsUrl = String(url);
    initShadowDoc();
    ws.addEventListener('message', (e) => {
      shadow.msgsSeen++;
      if (e.data instanceof ArrayBuffer) feedShadow(e.data);
    });
    log('captured canvas socket', String(url).slice(0, 120));
  };

  // WebSocket 构造钩子（agent 注入较早时才能捕到 App 的连接；捕不到也能自建）
  try {
    const OrigWS = window.WebSocket;
    class WSHook extends OrigWS {
      constructor(url, protocols) {
        super(url, protocols);
        if (String(url).includes('/canvas/ws')) captureWs(this, url);
      }
    }
    WSHook.CONNECTING = OrigWS.CONNECTING;
    WSHook.OPEN = OrigWS.OPEN;
    WSHook.CLOSING = OrigWS.CLOSING;
    WSHook.CLOSED = OrigWS.CLOSED;
    window.WebSocket = WSHook;
  } catch (e) { log('WS hook failed', e); }

  // ---------- Y 结构工具 ----------
  const toY = (v) => {
    const { Y } = R();
    if (v == null || typeof v !== 'object') return v;
    if (Array.isArray(v)) {
      const a = new Y.Array();
      a.push(v.map(toY));
      return a;
    }
    const m = new Y.Map();
    for (const [k, vv] of Object.entries(v)) m.set(k, toY(vv));
    return m;
  };

  const shadowAddGraph = ({ nodes, edges }) => {
    if (!shadow.doc) throw new Error('shadow doc 未就绪');
    const yn = ynodes(), ye = yedges();
    if (!yn || !ye) throw new Error('未找到 canvas_content.nodes/edges（先 ownConnect）');
    // 写通道必须活着——不然写进影子 doc 也同步不到 App doc（悄悄丢节点/边）
    const sendOk = (own.ws?.readyState === 1) || (shadow.ws?.readyState === 1);
    if (!sendOk) throw new Error('协同写通道未连接（own/app socket 都断）');
    shadow.doc.transact(() => {
      for (const n of nodes || []) yn.push([toY(n)]);
      for (const e of edges || []) ye.push([toY(e)]);
    }, 'rhci-local');
    return shadowCounts();
  };

  const findYNode = (id) => {
    const yn = ynodes();
    if (!yn) return null;
    for (let i = 0; i < yn.length; i++) {
      const m = yn.get(i);
      if (m instanceof R().Y.Map && m.get('id') === id) return { map: m, index: i };
    }
    return null;
  };

  const yMerge = (ym, patch) => {
    for (const [k, v] of Object.entries(patch)) {
      const cur = ym.get(k);
      if (cur instanceof R().Y.Map && v && typeof v === 'object' && !Array.isArray(v)) {
        yMerge(cur, v);
      } else {
        ym.set(k, toY(v));
      }
    }
  };

  // 单个 {id,patch} 或批量 {patches:[{id,patch}]}——批量走一次事务一个 WS 往返
  const shadowPatchNode = ({ id, patch, patches }) => {
    if (!shadow.doc) throw new Error('shadow doc 未就绪');
    const sendOk = (own.ws?.readyState === 1) || (shadow.ws?.readyState === 1);
    if (!sendOk) throw new Error('协同写通道未连接');
    const list = patches || [{ id, patch }];
    const missing = [];
    shadow.doc.transact(() => {
      for (const it of list) {
        const f = findYNode(it.id);
        if (!f) { missing.push(it.id); continue; }
        yMerge(f.map, it.patch);
      }
    }, 'rhci-local');
    if (missing.length === list.length && !patches) throw new Error(`节点不存在: ${id}`);
    return { ok: true, missing };
  };

  const shadowHas = ({ ids }) => {
    const yn = ynodes();
    if (!yn) return { present: [], missing: ids.slice() };
    const have = new Set();
    for (let i = 0; i < yn.length; i++) {
      const m = yn.get(i);
      if (m instanceof R().Y.Map) have.add(m.get('id'));
    }
    const present = ids.filter((id) => have.has(id));
    return { present, missing: ids.filter((id) => !have.has(id)) };
  };

  const idOf = (m) => (m && typeof m.get === 'function' ? m.get('id') : m?.id);
  const keyOf = (m, k) => (m && typeof m.get === 'function' ? m.get(k) : m?.[k]);

  const shadowNodesByType = (type) => {
    const yn = ynodes();
    const out = [];
    if (!yn) return out;
    for (let i = 0; i < yn.length; i++) {
      const m = yn.get(i);
      if (keyOf(m, 'type') === type) out.push(m && m.toJSON ? m.toJSON() : m);
    }
    return out;
  };

  const shadowAllNodes = () => {
    const yn = ynodes();
    if (!yn) return [];
    return yn.toArray().map((m) => (m && m.toJSON ? m.toJSON() : m));
  };

  const shadowRemoveNodes = ({ ids }) => {
    if (!shadow.doc) throw new Error('shadow doc 未就绪');
    const yn = ynodes(), ye = yedges();
    if (!yn || !ye) throw new Error('shadow 未同步');
    const sendOk = (own.ws?.readyState === 1) || (shadow.ws?.readyState === 1);
    if (!sendOk) throw new Error('协同写通道未连接');
    const want = new Set(ids);
    let rmN = 0, rmE = 0;
    shadow.doc.transact(() => {
      for (let i = yn.length - 1; i >= 0; i--) {
        const m = yn.get(i);
        if (want.has(idOf(m))) { yn.delete(i, 1); rmN++; }
      }
      for (let i = ye.length - 1; i >= 0; i--) {
        const m = ye.get(i);
        if (want.has(keyOf(m, 'source')) || want.has(keyOf(m, 'target')) || want.has(keyOf(m, 'id'))) {
          ye.delete(i, 1); rmE++;
        }
      }
    }, 'rhci-local');
    return { rmN, rmE, ynLen: yn.length };
  };

  const shadowDump = () => ({
    canvasMeta: yMap() ? yMap().toJSON() : null,
    nodes: shadowAllNodes(),
    edges: yedges() ? yedges().toArray().map((m) => (m && m.toJSON ? m.toJSON() : m)) : [],
  });

  // 最右起点：用官方全量导出（影子会漏 rh-image，算出来的 x/y 会偏）
  const shadowFreeOrigin = (gap = 80) => {
    const nodes = typeof window._exportWorkflow === 'function'
      ? (window._exportWorkflow()?.nodes || [])
      : shadowAllNodes();
    if (!nodes.length) return { x: 0, y: 0 };
    let maxX = -Infinity, minY = Infinity;
    for (const j of nodes) {
      const p = j?.position; if (!p) continue;
      const w = Number(j?.data?.width ?? j?.style?.width ?? 320) || 320;
      maxX = Math.max(maxX, p.x + w);
      minY = Math.min(minY, p.y);
    }
    return maxX === -Infinity ? { x: 0, y: 0 } : { x: maxX + gap, y: minY };
  };

  // ---------- 文件注入 + 拖放 ----------
  // 主进程读本地文件 → base64 推到页面内存 → 组装 DataTransfer drop
  const stored = [];
  const addFile = ({ name, type, b64 }) => {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    stored.push(new File([u8], name, { type: type || 'application/octet-stream' }));
    return stored.length;
  };
  const clearFiles = () => { const n = stored.length; stored.length = 0; return n; };

  const doDrop = (files, x, y) => {
    const pane =
      document.querySelector('.react-flow__pane') ||
      document.querySelector('.react-flow') ||
      document.body;
    const rect = pane.getBoundingClientRect();
    const cx = x ?? rect.left + rect.width / 2;
    const cy = y ?? rect.top + rect.height / 2;
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    for (const type of ['dragenter', 'dragover', 'drop']) {
      pane.dispatchEvent(new DragEvent(type, {
        bubbles: true, cancelable: true, composed: true,
        clientX: cx, clientY: cy, dataTransfer: dt,
      }));
    }
    return { target: pane.className || pane.tagName, count: dt.files.length };
  };
  const cmdDropFiles = ({ files, x, y }) => doDrop(files, x, y);
  const cmdDropStored = ({ x, y } = {}) => {
    const files = stored.splice(0);
    if (!files.length) throw new Error('无待发文件（先 addFile）');
    return doDrop(files, x, y);
  };

  // MutationObserver 跟踪新增的 react-flow 节点
  const cmdWatchNewNodes = ({ ms = 30000, expect = 0 }) => new Promise((resolve) => {
    const viewport = document.querySelector('.react-flow__viewport') || document.querySelector('.react-flow');
    if (!viewport) return resolve({ error: 'no react-flow', added: [] });
    const seen = new Set(
      [...viewport.querySelectorAll('.react-flow__node')].map((n) => n.dataset.id)
    );
    const added = [];
    let done = false, lastAdd = 0;
    const finish = () => { if (!done) { done = true; obs.disconnect(); clearInterval(idleT); resolve({ added }); } };
    const obs = new MutationObserver(() => {
      for (const n of viewport.querySelectorAll('.react-flow__node')) {
        if (!seen.has(n.dataset.id)) {
          seen.add(n.dataset.id);
          const cls = [...n.classList].find((c) => c.startsWith('react-flow__node-'));
          added.push({ id: n.dataset.id, type: cls?.replace('react-flow__node-', '') || '' });
          lastAdd = Date.now();
        }
      }
      if (expect && added.length >= expect) finish();
    });
    obs.observe(viewport, { childList: true, subtree: true });
    const idleT = setInterval(() => {
      if (added.length && Date.now() - lastAdd > 3000) finish();
    }, 500);
    setTimeout(finish, ms);
  });

  // ---------- 任务运行 ----------
  // payload 由主进程提供（先经 apiTap 学习真实报文，或手动指定）
  const cmdRunTask = ({ payload, path }) =>
    apiFetch(path || '/canvas/task/run', { method: 'POST', body: payload });

  // 通用：对任意 canvas REST 端点发请求（调试用）
  const cmdApi = ({ path, method, body }) => apiFetch(path, { method: method || (body ? 'POST' : 'GET'), body });

  // ---------- 节点状态监控：等终态 ----------
  // 轮询影子 doc 中节点 JSON，直到出现终态标志或拿到输出 URL。
  const TERMINAL_OK = ['success', 'succeeded', 'complete', 'completed', 'finish', 'finished', 'done'];
  const TERMINAL_BAD = ['error', 'failed', 'fail', 'cancelled', 'canceled'];
  const URL_KEYS = ['videoUrl', 'resultUrl', 'outputUrl', 'url', 'fileUrl', 'downloadUrl', 'video'];
  const pickUrl = (d) => {
    if (!d) return '';
    if (typeof d === 'string') return /^https?:\/\//.test(d) ? d : '';
    if (Array.isArray(d)) {
      for (const it of d) { const u = pickUrl(it); if (u) return u; }
      return '';
    }
    if (typeof d !== 'object') return '';
    for (const k of URL_KEYS) {
      const v = d[k];
      if (typeof v === 'string' && /^https?:\/\//.test(v)) return v;
      if (Array.isArray(v)) {
        for (const it of v) {
          const u = typeof it === 'string' ? it : (it?.url || it?.videoUrl || it?.fileUrl);
          if (typeof u === 'string' && /^https?:\/\//.test(u)) return u;
        }
      }
      if (v && typeof v === 'object') {
        const u = pickUrl(v);
        if (u) return u;
      }
    }
    // output/outputs 常见结构
    for (const k of ['output', 'outputs', 'result', 'results']) {
      const v = d[k];
      if (typeof v === 'string' && /^https?:\/\//.test(v)) return v;
      if (v && typeof v === 'object') { const u = pickUrl(v); if (u) return u; }
    }
    return '';
  };
  // 生成监控可中止：watchAbort 置标志 → 下一轮 tick 提前返回 aborted
  const watchFlags = new Set();
  const cmdWatchAbort = ({ id }) => { watchFlags.add(id); return true; };
  const cmdWatchNode = ({ id, ms = 600000, interval = 800 }) => new Promise((resolve) => {
    const t0 = Date.now();
    let lastJson = '';
    const hist = [];
    const tick = () => {
      if (watchFlags.has(id)) {
        watchFlags.delete(id);
        return resolve({ terminal: 'aborted', hist: hist.slice(-20) });
      }
      // 优先读 App 真实 doc（_exportWorkflow 永远最新）——影子 WS 断了也不影响监控
      let j = null;
      if (typeof window._exportWorkflow === 'function') {
        try { j = (window._exportWorkflow()?.nodes || []).find((n) => n.id === id) || null; } catch {}
      }
      if (!j) {
        const f = findYNode(id);
        try { j = f?.map?.toJSON?.() || null; } catch {}
      }
      const s = JSON.stringify(j);
      if (s !== lastJson) {
        lastJson = s;
        const d = j?.data || {};
        hist.push({ t: Date.now() - t0, status: d.status, keys: Object.keys(d) });
      }
      const d = j?.data || {};
      const st = String(d.status || '').toLowerCase();
      const url = pickUrl(d);
      // 服务端软失败：status=finished 但 output[].code!==0（如1520并发上限）→ 当失败处理
      const outs = d.output || d.outputs;
      const errOut = Array.isArray(outs) ? outs.find((o) => o && ((o.code != null && o.code !== 0) || o.errorMsg)) : null;
      if (errOut && !url) {
        return resolve({ terminal: 'failed', status: d.status, error: errOut.errorMsg || `code ${errOut.code}`, node: j, hist: hist.slice(-20) });
      }
      if (TERMINAL_BAD.includes(st)) {
        return resolve({ terminal: 'failed', status: d.status, error: d.errorMessage || d.error || '', node: j, hist: hist.slice(-20) });
      }
      if (TERMINAL_OK.includes(st) || url) {
        return resolve({ terminal: 'success', status: d.status, url, node: j, hist: hist.slice(-20) });
      }
      if (Date.now() - t0 > ms) {
        return resolve({ terminal: 'timeout', status: d.status, node: j, hist: hist.slice(-20) });
      }
      setTimeout(tick, interval);
    };
    tick();
  });

  // ---------- 其它命令（移植自插件） ----------
  const cmdModelDuration = async ({ keyword = 'minimax' }) => {
    const r = await apiFetch('/canvas/model/list', { method: 'POST', body: {} });
    const list = r.json?.data ?? r.json;
    const models = Array.isArray(list) ? list : (list?.list || list?.models || []);
    const found = [];
    const scan = (m) => {
      const name = `${m?.modelName || m?.name || ''} ${m?.modelCode || m?.code || ''}`.toLowerCase();
      if (!name.includes(keyword.toLowerCase())) return;
      const cfg2 = m?.config || m?.params || [];
      for (const p of (Array.isArray(cfg2) ? cfg2 : [])) {
        const pn = String(p?.paramName || '').replace(/[_-]/g, '').toLowerCase();
        const tt = `${p?.title || ''} ${p?.titleEn || ''}`.toLowerCase();
        if (['duration', 'durationsec', 'videoduration'].includes(pn) || tt.includes('时长') || tt.includes('duration')) {
          found.push({ model: m.modelName || m.name, code: m.modelCode || m.code, paramName: p.paramName, options: p.optionValue || p.options || null });
        }
      }
    };
    for (const m of models) scan(m);
    return { count: models.length, found };
  };

  const cmdStatus = () => ({
    token: !!getToken(),
    userId: getUserId(),
    canvasId: getCanvasId(),
    debugHook: typeof window._exportYjsJSON === 'function',
    href: location.href,
    shadow: shadowCounts(),
    stored: stored.length,
  });

  const cmdInspectNode = ({ id }) => {
    if (typeof window._canvasGetYjsNode === 'function') {
      const n = window._canvasGetYjsNode(id);
      return n && n.toJSON ? n.toJSON() : n;
    }
    return findYNode(id)?.map?.toJSON?.() || null;
  };

  // 全量节点/边：走官方序列化（不受视口渲染限制，含 rh-image 等全部类型）
  const cmdExportNodes = () => {
    if (typeof window._exportWorkflow === 'function') {
      const w = window._exportWorkflow() || {};
      return { nodes: w.nodes || [], edges: w.edges || [] };
    }
    return { nodes: shadowAllNodes(), edges: yedges() ? yedges().toArray().map((m) => (m.toJSON ? m.toJSON() : m)) : [] };
  };

  const cmdInspectAll = () => {
    if (typeof window._canvasGetYjsNode === 'function') {
      const els = [...document.querySelectorAll('.react-flow__node')];
      const out = [];
      for (const el of els) {
        const id = el.dataset.id;
        try {
          const n = window._canvasGetYjsNode(id);
          out.push(n && n.toJSON ? n.toJSON() : n);
        } catch (e) { out.push({ id, err: String(e) }); }
      }
      return out;
    }
    return shadowAllNodes();
  };

  const cmdEdgeCheck = ({ targetId, sourceIds }) => {
    let edges = [];
    if (typeof window._exportWorkflow === 'function') {
      edges = window._exportWorkflow()?.edges || [];
    } else {
      const ye = yedges();
      edges = ye ? ye.toArray().map((m) => (m && m.toJSON ? m.toJSON() : m)) : [];
    }
    const toTarget = edges.filter((e) => String(e.target) === String(targetId));
    const missing = (sourceIds || []).filter(
      (s) => !toTarget.some((e) => String(e.source) === String(s))
    );
    return { total: edges.length, toTarget: toTarget.length, missing };
  };

  // ---------- DOM：节点的运行按钮 ----------
  const nodeEl = (id) => document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`);

  const cmdDomInfo = ({ id }) => {
    const el = nodeEl(id);
    if (!el) throw new Error(`DOM 无节点 ${id}`);
    const btns = [...el.querySelectorAll('button,[role="button"],[class*="run"],[class*="play"],[title]')]
      .map((b) => ({
        tag: b.tagName, title: b.getAttribute('title') || '', aria: b.getAttribute('aria-label') || '',
        cls: String(b.className || '').slice(0, 80), text: (b.textContent || '').trim().slice(0, 30),
      }));
    return { cls: el.className, btns, html: el.outerHTML.slice(0, 2500) };
  };

  // 点击节点上的运行按钮（让官方代码自己构造并提交任务）
  // dry:true 只返回将命中的候选，不真点
  // 视口外节点 React Flow 不渲染（DOM 里没有）→ 把节点挪到视口中心让它渲染
  const ensureVisible = async (id) => {
    try { await nodeEl(id); return true; } catch {}
    const vp = document.querySelector('.react-flow__viewport');
    const pane = document.querySelector('.react-flow__pane') || document.querySelector('.react-flow');
    if (!vp || !pane) return false;
    const r = pane.getBoundingClientRect();
    const m = (getComputedStyle(vp).transform || '').match(/matrix\(([^)]+)\)/);
    let x = 0, y = 0;
    if (m) {
      const [a,, , , tx, ty] = m[1].split(',').map(Number);
      x = (r.width / 2 - tx) / (a || 1);
      y = (r.height / 2 - ty) / (a || 1);
    }
    try { shadowPatchNode({ id, patch: { position: { x: Math.round(x), y: Math.round(y) } } }); } catch (e) { return false; }
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 400));
      try { await nodeEl(id); return true; } catch {}
    }
    return false;
  };

  const cmdClickRun = async ({ id, dry }) => {
    // 节点经 Yjs 写入后 React 渲染有延迟，等 DOM 出现；视口外则挪进视口
    let el = null;
    for (let i = 0; i < 20 && !el; i++) {
      try { el = nodeEl(id); } catch {}
      if (!el) await new Promise((r) => setTimeout(r, 500));
    }
    if (!el) {
      await ensureVisible(id).catch(() => false);
      try { el = nodeEl(id); } catch {}
    }
    if (!el) return { err: `DOM 无节点 ${id}` };
    let cands;
    try {
      cands = [...el.querySelectorAll('button,[role="button"],[class*="run"],[class*="play"],[title*="运行"],[aria-label*="run"]')];
    } catch (e) { return { err: 'qsa: ' + e.message }; }
    const score = (b) => {
      const s = `${b.getAttribute('title') || ''} ${b.getAttribute('aria-label') || ''} ${b.className || ''} ${b.textContent || ''}`.toLowerCase();
      let v = 0;
      if (/run|运行|生成|play|生成视频|play-icon/.test(s)) v += 10;
      if (/disabled|stop|取消|停止/.test(s)) v -= 20;
      if (b.disabled) v -= 30;
      if (b.tagName === 'BUTTON') v += 2;
      return v;
    };
    cands.sort((a, b) => score(b) - score(a));
    let top = cands[0];

    // 新建节点是 ready-state，节点内无运行按钮 → 选中节点弹底部配置条 →「开始生成」
    if (!top || score(top) <= 0) {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      const find = () => [...document.querySelectorAll('button.generate-action-button, button[aria-label*="生成"], button[aria-label*="run"], button[aria-label*="开始"]')]
        .find((b) => b.offsetWidth > 0);
      const ready = (b) => b && !b.disabled && !/loading|blocked|disabled/i.test(b.className || '');
      for (let i = 0; i < 40; i++) {
        top = find();
        if (ready(top)) break;
        if (top && /blocked/i.test(top.className)) {
          // blocked 可能是别的节点在生成（并发时工具栏串台）——查自己的节点状态
          const mine = window._canvasGetYjsNode?.(id)?.toJSON?.() || {};
          const mineSt = String(mine?.data?.status || '').toLowerCase();
          if (['running', 'queued', 'processing', 'finished', 'success', 'done'].includes(mineSt)) {
            if (dry) return { wouldClick: null, mode: 'toolbar', blocked: true };
            return { clicked: null, mode: 'toolbar', blocked: true, note: '按钮 blocked，节点已在生成' };
          }
          // 自己节点还 idle——工具栏被别的节点占了，重选再试
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        }
        await new Promise((r) => setTimeout(r, 400));
      }
      if (dry) return { wouldClick: top ? { aria: top.getAttribute('aria-label'), cls: String(top.className).slice(0, 60) } : null, mode: 'toolbar' };
      if (!ready(top)) return { err: '底部生成按钮未就绪（loading/不存在）' };
      top.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return { clicked: { aria: top.getAttribute('aria-label'), cls: String(top.className).slice(0, 60) }, mode: 'toolbar' };
    }

    const before = { title: top.getAttribute('title') || '', cls: String(top.className || '').slice(0, 80), text: (top.textContent || '').trim().slice(0, 30) };
    if (dry) return { wouldClick: before, score: score(top), candidates: cands.length };
    try {
      top.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return { clicked: before, candidates: cands.length };
    } catch (e) { return { err: 'dispatch: ' + e.message }; }
  };

  // 点节点的「下载」按钮：先选中节点等预览工具条出来，再点 aria-label=下载
  const cmdClickDownload = async ({ id }) => {
    let el = null;
    for (let i = 0; i < 10 && !el; i++) {
      try { el = nodeEl(id); } catch {}
      if (!el) await new Promise((r) => setTimeout(r, 400));
    }
    if (!el) return { err: `DOM 无节点 ${id}` };
    // 选中节点（预览工具条需要选中态）
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    let btn = null;
    for (let i = 0; i < 15 && !btn; i++) {
      await new Promise((r) => setTimeout(r, 300));
      btn = [...document.querySelectorAll('button.ce-toolbar-btn,button[aria-label*="下载"],button[aria-label*="download"],button[title*="下载"]')]
        .find((b) => /下载|download/i.test(`${b.getAttribute('aria-label') || ''}${b.getAttribute('title') || ''}${b.textContent || ''}`) && !b.disabled);
    }
    if (!btn) return { err: '下载按钮未出现（工具条未弹出？）' };
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return { clicked: true, aria: btn.getAttribute('aria-label') || btn.getAttribute('title') || '' };
  };

  // 任意 JS（调试用，本地工具）
  const cmdEval = async ({ code }) => {
    // eslint-disable-next-line no-eval
    const r = await eval(code); // await 展开 Promise
    return r && typeof r === 'object' ? JSON.parse(JSON.stringify(r)) : r;
  };

  const COMMANDS = {
    status: cmdStatus,
    shadowStatus: () => shadowCounts(),
    shadowSync,
    exportNodes: cmdExportNodes,
    ownConnect,
    ownStatus,
    shadowAdd: shadowAddGraph,
    shadowDump,
    shadowPatch: shadowPatchNode,
    shadowHas: (a) => shadowHas(a),
    shadowRemove: shadowRemoveNodes,
    nodesByType: (a) => shadowNodesByType(a?.type),
    allNodes: cmdInspectAll,
    freeOrigin: (a) => shadowFreeOrigin(a?.gap),
    modelDuration: cmdModelDuration,
    inspectNode: cmdInspectNode,
    inspectAll: cmdInspectAll,
    edgeCheck: cmdEdgeCheck,
    dropFiles: cmdDropFiles,
    dropStored: cmdDropStored,
    addFile,
    clearFiles,
    watchNewNodes: cmdWatchNewNodes,
    watchNode: cmdWatchNode,
    watchAbort: cmdWatchAbort,
    runTask: cmdRunTask,
    api: cmdApi,
    apiTap: ({ n } = {}) => apiLog.slice(-(n || 100)),
    clearApiTap: () => { apiLog.length = 0; return true; },
    domInfo: cmdDomInfo,
    clickRun: cmdClickRun,
    clickDownload: cmdClickDownload,
    eval: cmdEval,
  };

  window.__rhci = {
    init(c) { cfg = { ...cfg, ...(c || {}) }; return true; },
    async run(cmd, args) {
      const fn = COMMANDS[cmd];
      if (!fn) throw new Error(`unknown cmd: ${cmd}`);
      return await fn(args || {});
    },
    push,
  };

  push('agent-ready', { href: location.href });
  log('agent ready');
})();
