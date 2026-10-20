// Renders src/icons/icon.svg to the PNG icons with headless Chrome. The
// Apple and maskable variants get a full-bleed square background (iOS shows
// transparency as black; Android crops maskable icons to its own shape).

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../src/icons/', import.meta.url));
const svg = readFileSync(join(dir, 'icon.svg'), 'utf8');
const square = svg.replace('rx="112" fill="url(#bg)"', 'fill="url(#bg)"');
// Maskable: content inside the central 80 % circle.
const maskable = square
  .replace(
    '<g fill="url(#bar)">',
    '<g transform="translate(256 256) scale(.8) translate(-256 -256)"><g fill="url(#bar)">',
  )
  .replace('</svg>', '')
  .replace(/(<circle[^>]*\/>)\s*$/, '$1</g></svg>');

const work = mkdtempSync(join(tmpdir(), 'schall-icons-'));
const render = (source, size, out) => {
  const file = join(work, `${out}.svg`);
  writeFileSync(file, source);
  execFileSync(
    process.env.CHROME ?? 'google-chrome',
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--hide-scrollbars',
      `--user-data-dir=${join(work, 'profile')}`,
      '--default-background-color=00000000',
      `--window-size=${size},${size}`,
      `--screenshot=${join(dir, out)}`,
      `file://${file}`,
    ],
    { stdio: 'ignore' },
  );
};
render(svg, 192, 'icon-192.png');
render(svg, 512, 'icon-512.png');
render(square, 180, 'apple-touch-icon.png');
render(maskable, 512, 'icon-maskable-512.png');
rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
console.info('icons written');
