# RH 画布视频生成 · 独立应用

> **便携版**：`dist\RH画布视频生成-0.1.0-便携版.exe`（82MB 单文件，双击即用）
> 数据（登录会话/配置/任务/日志/下载）存 exe 旁边 `rh-canvas-app-data\`，整包拷走即用。
> 重新打包：`npm run dist`（electron-builder → portable target）

把浏览器插件「rh-canvas-importer」升级成桌面应用：隐藏画布窗口常驻
RunningHub 画布（免费 MiniMax 模型），本地 REST API 对外提供
**图片+提示词 → 画布生成 → 自动下载** 的完整流水线。

## 架构

```
外部应用 ──POST──▶ 本地 REST API (:19387)
                        │
            并发槽位调度 (默认 maxConcurrent=2，超出排队)
                        │
        ┌───────────────┴───────────────┐
   导入画布会话                    工作画布会话（可复用同一画布）
   （插件能力：目录导入/预览）      （API 任务：建节点→运行→下载→清理）
        └──── 隐藏窗口 + 注入 agent.js ────┘
        Yjs 协同影子doc / drop上传 / ▶点击运行 / 节点状态监听
                        │
              视频回写节点 → 捕获 output[].url → 下载到 downloads/
              任务完成 → shadowRemove 清除自己创建的节点
```

- 登录一次，session 持久化（`persist:rh`）
- **双画布**：导入画布给人审；API 任务在工作画布跑，互不干扰
- **并发限制**：`maxConcurrent` 个槽位，每个槽位占画布一列（lane），任务隔离
- **自动清理**：seg/generate 任务成功后删除自己创建的全部节点+边；
  失败默认保留节点便于排查（`cleanOnFail` 可开）
- 运行 = 点节点 `▶`（官方 `nw()` 构造含 canvas 子图报文），兜底 REST 重放

## 安装启动

```bash
cd rh-canvas-app
npm install
npm start           # 开发模式
npm run dist        # 打包 win 安装包（dist/）
```

Windows 双击即用：

- **`start.bat`** — 一键启动（已运行则只唤起控制台；等 API 就绪才返回）
- **`test.bat`** — API 冒烟测试（连通/登录/影子同步/扫描/队列）
- **`test.bat gen`** — 完整链路冒烟（真实建节点 → 任务完成 → 自动清理，不消耗生成额度）

## 首次使用

1. 启动后控制台「显示导入画布」→ **登录 RunningHub**
2. （可选）「API 服务」页填**工作画布**链接——API 任务专用画布；
   留空则复用导入画布（任务完成后照样清理自己建的节点）
3. 调 `POST /api/import` 或页面选目录导入测试

## 目录约定

`项目/EP/SEGxxx-Ns/`：图片为参考帧，`Ns-视频提示词.txt` 为提示词；
时长取 SEG 名里的秒数。

## REST API

默认 `http://127.0.0.1:19387`（`config.json` 可改 `port`）。
若设 `apiToken`，请求带 `X-Api-Token` 头。

| 端点 | 说明 |
|---|---|
| `GET /api/status` | 状态总览（登录/agent/槽位/队列/jobs） |
| `POST /api/generate` | **对外主接口**：`{images:[绝对路径],prompt,duration?,params?,saveName?,webhookUrl?}` |
| `POST /api/seg` | 单 SEG 目录直接跑 `{dir, run?, params?, prompt?}` |
| `POST /api/import` | 目录导入画布 `{rootDir, run?, ep?, project?, savePattern?, prompt?}` |
| `POST /api/run` | 跑画布空闲/指定节点 `{nodeIds?, canvas?:'main'|'work'}` |
| `GET /api/jobs` | 全部任务 + `running/pending/slots` |
| `GET /api/jobs/:id` | 单任务详情（含 `results[]` 每条明细） |
| `POST /api/jobs/:id/cancel` | 取消（排队中即时取消；运行中断当前 SEG） |
| `GET /api/jobs/:id/file` | 取下载好的视频文件 |
| `POST /api/scan` | 预览目录 `{rootDir}` |
| `POST /api/canvas/url` `{url}` | 切换导入画布 |
| `POST /api/canvas/work-url` `{url}` | 设置/清空工作画布 |
| `POST /api/canvas/clear` `{canvas}` | 清空画布全部节点（测试/复位） |
| `POST /api/config` `{maxConcurrent,apiToken,cleanOnFail,...}` | 热改配置 |
| `GET /api/jobs`/`/api/nodes`/`/api/cv`/`/api/apilog` | 调试接口 |

## 调用示例

```bash
# 生成并等结果
curl -X POST http://127.0.0.1:19387/api/generate \
  -H "Content-Type: application/json" \
  -d '{"images":["E:/a/1.png","E:/a/2.png"],"prompt":"...","duration":6,"saveName":"test.mp4"}'
# → {"job":{"id":"job-xxx"}}

curl http://127.0.0.1:19387/api/jobs/job-xxx     # 轮询 status: done
curl -O http://127.0.0.1:19387/api/jobs/job-xxx/file   # 拿视频
# 或带 webhookUrl 完成即回调
```

并发语义：同时最多 `maxConcurrent` 个任务在跑，其余排队（pending），
完成一个腾一个槽位；每个任务结束后自动清除它在画布上建的节点。

## 机制备忘（已实测验证）

- 画布 = React Flow + Yjs CRDT；协同 WS 真实形态：
  `wss://www.runninghub.cn/canvas/ws/<canvasId>?roomId&userId&token&type=canvas&version&durableAck&durableFlow&yjsClientId`
  （agent 优先抓 App 原始 URL，抓不到按模板构造）
- 上传 = 页面内 DataTransfer drop → 官方 STS→COS 管线；
  图节点 `data.sourceObjects=[url]`（`rh-canvas-files.xiaoyaoyou.com`）
- **运行 = DOM 点节点 `▶`（`.rh-node-play-icon`）**：官方 `nw()` 构造
  `{canvasId,targetType:"NODE",targetId,canvas:{nodes,edges},teamId}`，
  POST `/canvas/task/run`——不逆向参数打包，天然正确
- 结果回写：`data.status` → `finished`，`data.output=[{code:0,url,outputType:'mp4',taskId,jobId}]`；
  历史在 `nodeOutputHistory[].outputs[].url`；URL 公开可下（tencent-cos）
- 影子 doc 坑：`instanceof Y.Map` 在双 Y 实例下不可靠，用 duck-type `m.get('id')`
- 页面 `storedFiles` 全局共享：push+drop 必须引擎侧串行（dropLock）
- 兜底：`POST /canvas/task/run` REST 重放（模板经 apiTap 学习，`data/runTemplate.json`）
- 隐藏窗口 `backgroundThrottling:false`；单实例锁
- 文件：`agent.js`(页面内) `main.js`(主进程+双会话) `engine.js`(队列/并发/下载)
  `api.js`(REST) `scanner.js`(EP/SEG) `ui/`(导入页+API页) `vendor/yjs-bundle.js`
- 数据：`%APPDATA%/rh-canvas-app/data/`（config/jobs/runTemplate），`downloads/`
