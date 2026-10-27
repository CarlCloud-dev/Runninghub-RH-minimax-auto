// 用 Electron nativeImage 把 assets/icon.png 缩出多尺寸 → 打包成多分辨率 icon.ico
// 用法：ELECTRON_RUN_AS_NODE= node_modules/.bin/electron scripts/make-icon.cjs
const { nativeImage, app } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(() => {
  const src = path.join(__dirname, '..', 'assets', 'icon.png');
  const img = nativeImage.createFromPath(src);
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = sizes.map((s) => img.resize({ width: s, height: s }).toPNG());

  // ICONDIR: reserved(2)=0 type(2)=1 count(2)=N
  const n = sizes.length;
  const header = Buffer.alloc(6 + n * 16);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(n, 4);
  let off = 6 + n * 16;
  sizes.forEach((s, i) => {
    const e = 6 + i * 16;
    header.writeUInt8(s >= 256 ? 0 : s, e);
    header.writeUInt8(s >= 256 ? 0 : s, e + 1);
    header.writeUInt8(0, e + 2); header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4); header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(pngs[i].length, e + 8);
    header.writeUInt32LE(off, e + 12);
    off += pngs[i].length;
  });
  const ico = Buffer.concat([header, ...pngs]);
  fs.writeFileSync(path.join(__dirname, '..', 'assets', 'icon.ico'), ico);
  console.log('icon.ico written:', ico.length, 'bytes, sizes:', sizes.join('/'));
  app.quit();
});
