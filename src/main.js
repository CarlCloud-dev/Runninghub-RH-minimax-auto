// RH Canvas App — Electron 主进程
// 两个隐藏画布会话：canvasSession（用户画布，导入/预览）+ workSession（工作画布，API 生成）
// 本地 REST API + 任务队列 + 下载器 + 控制台 UI（导入页 / API 设置页）
const { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

// 便携版：PORTABLE_EXECUTABLE_DIR 由 electron-builder 便携运行时注入，
// 把 userData（含登录会话/config/jobs/log）重定向到 exe 旁边，数据跟着应用走
if (process.env.PORTABLE_EXECUTABLE_DIR) {
  app.setPath('userData', path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'rh-canvas-app-data'));
}

const DATA_DIR = path.join(app.getPath('userData'), 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

// stdout 管道断裂(EPIPE)是桌面应用常态——吞掉不弹崩溃窗；别的异常记文件
process.on('uncaughtException', (e) => {
  try { fs.appendFileSync(path.join(DATA_DIR, 'app.log'), `[uncaught] ${e.stack || e}\n`); } catch {}
});

const OLD_PORTS = new Set([8787, 8080, 3000, 5000]); // 历史默认/常见端口，自动迁移走
const DEFAULTS = {
  port: 19387,
  canvasUrl: 'https://rhtv.runninghub.cn/project/canvas/2113009431580438530',
  workCanvasUrl: '',          // 工作画布（API 任务执行处），未配置时回落用户画布
  downloadDir: path.join(app.getPath('userData'), 'downloads'),
  apiToken: '',               // 非空则 /api/* 需带 X-Api-Token
  maxConcurrent: 2,           // 并发生成槽位
  cleanOnFail: false,         // 失败任务是否也清理画布节点
  clampDurMin: true,          // 时长低于4s → 按4s
  clampDurMax: true,          // 时长超15s → 按15s
};

const loadConfig = () => {
  let cfg;
  try { cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; }
  catch { cfg = { ...DEFAULTS }; }
  if (OLD_PORTS.has(cfg.port)) cfg.port = DEFAULTS.port; // 旧默认端口迁移到新默认
  return cfg;
};
const saveConfig = () => fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
const config = loadConfig();
fs.mkdirSync(config.downloadDir, { recursive: true });

// 单实例
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', () => {
  if (controlWin) { controlWin.show(); controlWin.focus(); }
});

const AGENT_FILE = path.join(__dirname, 'agent.js');
const YJS_FILE = path.join(__dirname, '..', 'vendor', 'yjs-bundle.js');
const isCanvasUrl = (u) => /runninghub\.(cn|ai)\/project\/canvas\/\d+/.test(u || '');

const log = (m) => {
  const line = `[${new Date().toLocaleTimeString()}] ${m}`;
  try { console.log(line); } catch {} // stdout 管道断裂(EPIPE)不能崩主进程
  try { fs.appendFileSync(path.join(DATA_DIR, 'app.log'), line + '\n'); } catch {}
  controlWin?.webContents?.send('log', line);
};

let controlWin = null;

// ============ 画布会话（窗口 + agent 注入 + cv 调用）============
class CanvasSession {
  constructor(name, title) {
    this.name = name;         // 'main' | 'work'
    this.title = title;
    this.win = null;
    this.url = '';
    this.agentReady = false;
    this.injectSeq = Promise.resolve();
  }

  async open(url) {
    this.url = url;
    if (!this.win || this.win.webContents.isDestroyed()) {
      this.win = new BrowserWindow({
        width: 1400, height: 900, show: false,
        title: this.title, frame: false, icon: APP_ICON,
        webPreferences: {
          partition: 'persist:rh',
          backgroundThrottling: false,
          contextIsolation: true,
          nodeIntegration: false,
          preload: path.join(__dirname, 'canvas-preload.js'),
        },
      });
      this.win.setMenuBarVisibility(false);
      this.win.webContents.on('did-finish-load', () => { this.injectChrome(); this.tryInject(); });
      this.win.webContents.on('did-navigate', () => { this.agentReady = false; });
      this.win.on('closed', () => { this.win = null; this.agentReady = false; });
    }
    const u = new URL(url);
    if (!u.searchParams.has('canvas_debug')) u.searchParams.set('canvas_debug', '1');
    this.agentReady = false;
    await this.win.loadURL(u.toString());
    return this;
  }

  // 无边框自绘标题栏：可拖动 + 隐藏按钮（不抢页面原生体验）
  async injectChrome() {
    if (!this.win || this.win.webContents.isDestroyed()) return;
    const title = JSON.stringify(this.title);
    const code = `(() => {
      if (document.getElementById('__rh-chrome')) return true;
      const cid = (location.pathname.match(/canvas\\/(\\d+)/) || [])[1] || '';
      const bar = document.createElement('div');
      bar.id = '__rh-chrome';
      bar.innerHTML = '<span style="font-size:12px;color:#9aa0bf;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;pointer-events:none">' + ${title} + (cid ? ' · ' + cid : '') + '</span>'
        + '<button id="__rh-hide" title="隐藏窗口"><span style="font-size:13px;line-height:1">–</span>&nbsp;隐藏画布</button>';
      bar.style.cssText = 'position:fixed;top:0;left:0;right:0;height:30px;z-index:2147483647;display:flex;align-items:center;gap:8px;padding:0 5px 0 10px;box-sizing:border-box;background:rgba(11,13,20,.94);backdrop-filter:blur(8px);-webkit-app-region:drag;user-select:none;border-bottom:1px solid #262b42;font:12px "Segoe UI","Microsoft YaHei",sans-serif';
      const b = bar.querySelector('#__rh-hide');
      b.style.cssText = '-webkit-app-region:no-drag;margin-left:auto;flex:none;display:flex;align-items:center;justify-content:center;gap:3px;height:22px;padding:0 10px;background:#1a1e30;border:1px solid #2a2f4a;border-radius:6px;color:#9aa0bf;cursor:pointer;font:12px "Segoe UI","Microsoft YaHei",sans-serif';
      b.onmouseenter = () => { b.style.background = '#2a2f4a'; b.style.color = '#e6e8f4'; };
      b.onmouseleave = () => { b.style.background = '#1a1e30'; b.style.color = '#9aa0bf'; };
      b.onclick = () => window.__rhui && window.__rhui.hide();
      document.body.appendChild(bar);
      return true;
    })()`;
    try { await this.win.webContents.executeJavaScript(code); } catch {}
  }

  async tryInject() {
    if (!isCanvasUrl(this.win?.webContents.getURL())) return;
    for (const wait of [1200, 2500, 5000]) {
      await new Promise((r) => setTimeout(r, wait));
      if (!this.win || this.win.webContents.isDestroyed()) return;
      await this.inject();
      if (this.agentReady) break;
    }
  }

  inject() {
    this.injectSeq = this.injectSeq.then(async () => {
      try {
        // yjs bundle 只注入一次：重复执行会换掉 window.RHCI_Y 整套类，
        // 使旧 doc 与新建 Y.Map 分属两个 AbstractType 世界 → "Unexpected content type"
        const yjsCode = 'if (!window.RHCI_Y) {\n' + fs.readFileSync(YJS_FILE, 'utf8') + '\n}';
        await this.win.webContents.executeJavaScript(yjsCode);
        await this.win.webContents.executeJavaScript(fs.readFileSync(AGENT_FILE, 'utf8'));
        const ok = await this.win.webContents.executeJavaScript(
          `window.__rhci && window.__rhci.init({port:${config.port},token:${JSON.stringify(config.apiToken || '')}})`
        );
        this.agentReady = !!ok;
        log(`[agent:${this.name}] injected=${this.agentReady}`);
      } catch (e) {
        this.agentReady = false;
        this.lastInjectErr = e.message;
        log(`[agent:${this.name}] inject fail: ${e.message}`);
      }
    });
    return this.injectSeq;
  }

  async call(cmd, args, timeoutMs = 90000) {
    if (!this.win || this.win.webContents.isDestroyed()) throw new Error(`画布窗口(${this.name})未就绪`);
    if (!this.agentReady) {
      await this.inject();
      if (!this.agentReady) throw new Error(`agent(${this.name})未注入: ${this.lastInjectErr || 'executeJavaScript 返回 false'}`);
    }
    const expr = `window.__rhci.run(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? null)})`;
    return await Promise.race([
      this.win.webContents.executeJavaScript(expr, true),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`cv(${cmd}) 超时`)), timeoutMs)),
    ]);
  }

  show() { this.win?.show(); }
  hide() { this.win?.hide(); }
  status() { return { url: this.url, open: !!this.win, visible: this.win?.isVisible() ?? false, agentReady: this.agentReady }; }
}

const canvasSession = new CanvasSession('main', 'RH 画布（导入）');
let workSession = null;
const cvMain = (cmd, args, t) => canvasSession.call(cmd, args, t);
let cvWork = null; // workCanvasUrl 配置后为函数，否则 null

async function ensureWorkSession() {
  if (!config.workCanvasUrl) { cvWork = null; return null; }
  if (!workSession || !workSession.win || workSession.win.webContents.isDestroyed() || workSession.url !== config.workCanvasUrl) {
    workSession = new CanvasSession('work', 'RH 工作画布（API）');
    await workSession.open(config.workCanvasUrl);
  }
  cvWork = (cmd, args, t) => workSession.call(cmd, args, t);
  return workSession;
}

const APP_ICON = path.join(__dirname, '..', 'assets', 'icon.png');
const ICON_IMG = nativeImage.createFromPath(APP_ICON);
let tray = null, quitting = false;

// 系统托盘：关闭窗口只隐藏，任务继续跑；双击/菜单可唤起，「退出」才真正结束
function createTray() {
  tray = new Tray(ICON_IMG);
  tray.setToolTip('RH 画布视频生成');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示控制台', click: () => { controlWin?.show(); controlWin?.focus(); } },
    { label: '显示画布', click: () => canvasSession?.show?.() },
    { label: '显示工作画布', click: () => workSession?.show?.() },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('double-click', () => { controlWin?.show(); controlWin?.focus(); });
}

function createControlWindow() {
  controlWin = new BrowserWindow({
    width: 940, height: 640, minWidth: 780, minHeight: 520,
    title: 'RH 画布视频生成', frame: false, icon: APP_ICON,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'ui', 'preload.js') },
  });
  controlWin.setMenuBarVisibility(false);
  controlWin.loadFile(path.join(__dirname, 'ui', 'index.html'));
  controlWin.on('close', (e) => {
    if (!quitting) { e.preventDefault(); controlWin.hide(); }
  });
  controlWin.on('closed', () => { controlWin = null; });
}

app.whenReady().then(async () => {
  // 页面内点「下载」按钮 → 直接存下载目录，不弹保存框
  const { session } = require('electron');
  const rhSess = session.fromPartition('persist:rh');
  rhSess.on('will-download', (e, item) => {
    const fname = item.getFilename() || `dl-${Date.now()}.mp4`;
    const dest = path.join(config.downloadDir, fname);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    item.setSavePath(dest);
    log(`[dl] 页面下载开始: ${fname}`);
    item.once('done', (ev, state) => {
      log(`[dl] ${fname} → ${state}${state === 'completed' ? '  ' + dest : ''}`);
    });
  });

  await canvasSession.open(config.canvasUrl);
  await ensureWorkSession();
  createTray();
  createControlWindow();
  app.on('before-quit', () => { quitting = true; });

  const { Engine } = require('./engine');
  const engine = new Engine({
    cvMain,
    getCvWork: () => cvWork,           // workSession 配置后才有值，否则回落主画布
    log,
    dataDir: DATA_DIR,
    downloadDir: config.downloadDir,
    emit: (type, data) => controlWin?.webContents?.send('evt', { type, data }),
    config,
  });

  const { startApi } = require('./api');
  const server = startApi({
    port: config.port,
    token: config.apiToken,
    engine,
    cv: cvMain,
    log,
    getStatus: () => ({
      main: canvasSession.status(),
      work: workSession?.status() || { url: config.workCanvasUrl || '', open: false },
      canvasUrl: config.canvasUrl,
      workCanvasUrl: config.workCanvasUrl,
      downloadDir: config.downloadDir,
      port: config.port,
      version: app.getVersion(),
      apiTokenSet: !!config.apiToken,
      apiToken: config.apiToken || '',
      maxConcurrent: config.maxConcurrent,
      cleanOnFail: config.cleanOnFail,
      clampDurMin: config.clampDurMin,
      clampDurMax: config.clampDurMax,
      runTemplate: !!engine.runTemplate,
      running: engine.runningJobs,
      pending: engine.pendingJobs.length,
      lanes: engine.laneUsed.map((u, i) => u ? i : null).filter((x) => x !== null),
    }),
    onConfig: async (patch) => {
      Object.assign(config, patch);
      saveConfig();
      if (patch.maxConcurrent != null) engine.pump(); // 槽位变了立刻尝试出队
      if (patch.downloadDir) { engine.downloadDir = patch.downloadDir; fs.mkdirSync(patch.downloadDir, { recursive: true }); }
      if (patch.canvasUrl && isCanvasUrl(patch.canvasUrl)) await canvasSession.open(config.canvasUrl);
      if (patch.workCanvasUrl !== undefined) await ensureWorkSession();
    },
    openMain: () => canvasSession.show(),
    hideMain: () => canvasSession.hide(),
    openWork: () => workSession?.show(),
    hideWork: () => workSession?.hide(),
    openDir: (p) => shell.openPath(p),
    uiDir: path.join(__dirname, 'ui'),
  });
  engine.api = server;

  ipcMain.handle('ui:status', () => server.statusPayload());
  ipcMain.handle('ui:win-min', () => controlWin?.minimize());
  ipcMain.handle('ui:win-close', () => controlWin?.close());
  ipcMain.handle('ui:win-hide', (e) => BrowserWindow.fromWebContents(e.sender)?.hide());
  ipcMain.handle('ui:pick-dir', async () => {
    const r = await dialog.showOpenDialog(controlWin, { properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('ui:api', (e, method, p, body) => server.handleLocal(method, p, body));
});

app.on('window-all-closed', () => { if (!controlWin) app.quit(); });
