// 双色背景洪水裁剪：白角(253) + 深海军环(#0e122e) 都算外边，四边种子漫到渐变边界
const { nativeImage, app } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(() => {
  const src = path.join(__dirname, '..', 'assets', 'icon.png');
  const img = nativeImage.createFromPath(src);
  const { width: W, height: H } = img.getSize();
  const bmp = img.getBitmap();
  const I = (x, y) => (y * W + x) * 4;
  const BG = [[253, 253, 253], [13, 18, 46]]; // 白角 + 深环
  const isOut = (x, y) => {
    const o = I(x, y);
    if (bmp[o + 3] < 128) return true;
    for (const bg of BG) {
      if (Math.abs(bmp[o + 2] - bg[0]) + Math.abs(bmp[o + 1] - bg[1]) + Math.abs(bmp[o] - bg[2]) < 80) return true;
    }
    return false;
  };
  const mark = new Uint8Array(W * H);
  const q = [];
  const push = (x, y) => { const i = y * W + x; if (!mark[i]) { mark[i] = 1; q.push([x, y]); } };
  for (let x = 0; x < W; x++) { if (isOut(x, 0)) push(x, 0); if (isOut(x, H - 1)) push(x, H - 1); }
  for (let y = 0; y < H; y++) { if (isOut(0, y)) push(0, y); if (isOut(W - 1, y)) push(W - 1, y); }
  while (q.length) {
    const [x, y] = q.pop();
    if (x > 0 && isOut(x - 1, y)) push(x - 1, y);
    if (x < W - 1 && isOut(x + 1, y)) push(x + 1, y);
    if (y > 0 && isOut(x, y - 1)) push(x, y - 1);
    if (y < H - 1 && isOut(x, y + 1)) push(x, y + 1);
  }
  // 未被洪水覆盖的区域可能散落边角过渡像素——只保留最大连通块（渐变方块本体）
  const mark2 = new Uint8Array(W * H);
  let best = null;
  for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
    const si = y * W + x;
    if (mark[si] || mark2[si] || bmp[I(x, y) + 3] < 128) continue;
    // BFS 这块连通域（含半透明邻居）
    const stack = [[x, y]]; mark2[si] = 1;
    let cnt = 0, bx0 = W, by0 = H, bx1 = 0, by1 = 0;
    while (stack.length) {
      const [cx, cy] = stack.pop(); cnt++;
      if (cx < bx0) bx0 = cx; if (cx > bx1) bx1 = cx; if (cy < by0) by0 = cy; if (cy > by1) by1 = cy;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (!mark[ni] && !mark2[ni] && bmp[I(nx, ny) + 3] > 128) { mark2[ni] = 1; stack.push([nx, ny]); }
      }
    }
    if (!best || cnt > best.cnt) best = { cnt, x0: bx0, y0: by0, x1: bx1, y1: by1 };
  }
  if (!best) { console.log('没有主体'); return app.quit(); }
  const { x0, y0, x1, y1 } = best;
  console.log(`最大连通块 ${best.cnt}px, bbox ${x0},${y0}→${x1},${y1}`);
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  if (cw < 10) { console.log('bbox 无效'); return app.quit(); }
  const crop = img.crop({ x: x0, y: y0, width: cw, height: ch });
  const cb = crop.getBitmap();
  let cleared = 0;
  for (let i = 0; i < cw * ch; i++) {
    const o = i * 4;
    for (const bg of BG) {
      if (Math.abs(cb[o + 2] - bg[0]) + Math.abs(cb[o + 1] - bg[1]) + Math.abs(cb[o] - bg[2]) < 60) { cb[o + 3] = 0; cleared++; break; }
    }
  }
  fs.writeFileSync(src, nativeImage.createFromBitmap(cb, { width: cw, height: ch }).toPNG());
  console.log(`→ ${cw}x${ch}，转透明 ${cleared}px`);
  app.quit();
});
