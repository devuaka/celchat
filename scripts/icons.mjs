// Renders client/public/icon.svg to the PNG sizes app stores and installers need.
//   node scripts/icons.mjs
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(path.join(root, 'client/public/icon.svg'), 'utf8');
const out = path.join(root, 'client/public/icons');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();
async function render(size, file, { maskable = false } = {}) {
  // maskable icons need the artwork inside the central 80% "safe zone"
  const inner = maskable ? Math.round(size * 0.74) : size;
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;width:${size}px;height:${size}px;display:grid;place-items:center;background:${maskable ? '#0f1820' : 'transparent'}">
      <div style="width:${inner}px;height:${inner}px">${svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</div></body></html>`,
  );
  writeFileSync(path.join(out, file), await page.screenshot({ omitBackground: !maskable, type: 'png' }));
  console.log('wrote', file);
}
for (const s of [16, 32, 48, 64, 128, 192, 256, 512]) await render(s, `icon-${s}.png`);
await render(512, 'maskable-512.png', { maskable: true });
await render(192, 'maskable-192.png', { maskable: true });
await render(180, 'apple-touch-icon.png', { maskable: true });
await browser.close();
