'use strict';

// Rasterise resources/*.svg into the PNG and multi-size ICO files the app and
// installer need. Runs inside Electron so Chromium does the SVG rendering:
//   npx electron scripts/make-icons.js

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const RES = path.join(__dirname, '..', 'resources');
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];

function icoFromPngs(pngs) {
  // ICO container with PNG-compressed entries (supported since Windows Vista).
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2);
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...pngs.map(p => p.data)]);
}

async function rasterise(win, svg, size) {
  const dataUrl = await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = c.height = ${size};
        const g = c.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, 0, 0, ${size}, ${size});
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = () => reject(new Error('svg load failed'));
      img.src = 'data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}';
    })`);
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<html><body></body></html>');
  try {
    const logo = fs.readFileSync(path.join(RES, 'logo.svg'), 'utf8');
    const doc = fs.readFileSync(path.join(RES, 'md-file.svg'), 'utf8');

    fs.writeFileSync(path.join(RES, 'icon.png'), await rasterise(win, logo, 512));
    const appPngs = [];
    for (const size of ICO_SIZES) appPngs.push({ size, data: await rasterise(win, logo, size) });
    fs.writeFileSync(path.join(RES, 'icon.ico'), icoFromPngs(appPngs));

    const docPngs = [];
    for (const size of ICO_SIZES) docPngs.push({ size, data: await rasterise(win, doc, size) });
    fs.writeFileSync(path.join(RES, 'md-file.ico'), icoFromPngs(docPngs));
    fs.writeFileSync(path.join(RES, 'md-file.png'), await rasterise(win, doc, 256));

    console.log('icons written to', RES);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
  app.quit();
});
