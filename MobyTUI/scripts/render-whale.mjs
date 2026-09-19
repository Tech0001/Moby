// Regenerate terminal artwork from the desktop's vector logo.
// Run from any directory after installing MobyGUI's development dependencies.
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../MobyGUI/package.json', import.meta.url));
const sharp = require('sharp');
const source = await readFile(new URL('../../MobyGUI/src/ui/components/ui/WhaleIcon.tsx', import.meta.url), 'utf8');
const svg = source.match(/<svg[\s\S]*?<\/svg>/)[0]
  .replace('{...props}', 'xmlns="http://www.w3.org/2000/svg"')
  .replaceAll('currentColor', '#e4bc63')
  .replaceAll('strokeLinejoin', 'stroke-linejoin')
  .replaceAll('strokeLinecap', 'stroke-linecap')
  .replaceAll('strokeWidth', 'stroke-width');
const input = Buffer.from(svg);
await sharp(input).resize({ width: 512 }).png().toFile(new URL('../assets/whale.png', import.meta.url).pathname);

// Braille offers 2x4 dots per character for a recognizable text-only silhouette.
for (const [name, columns, rows] of [['whale-header', 14, 3], ['whale-header-compact', 10, 2], ['whale-launch', 42, 10]]) {
  const width = columns * 2;
  const { data } = await sharp(input).resize(width, rows * 4, {
    fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 },
  }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const lines = [];
  for (let row = 0; row < rows; row++) {
    let line = '';
    for (let column = 0; column < columns; column++) {
      let bits = 0;
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 2; x++) {
          const i = ((row * 4 + y) * width + column * 2 + x) * 4;
          // Leave the dark outline and eye empty against the dark terminal.
          if (data[i + 3] >= 80 && data[i] > data[i + 1] && data[i + 1] > data[i + 2]) {
            bits |= 1 << [[0, 1, 2, 6], [3, 4, 5, 7]][x][y];
          }
        }
      }
      line += bits ? String.fromCodePoint(0x2800 + bits) : ' ';
    }
    lines.push(line.trimEnd());
  }
  await writeFile(new URL(`../assets/${name}.txt`, import.meta.url), lines.join('\n') + '\n');
}
