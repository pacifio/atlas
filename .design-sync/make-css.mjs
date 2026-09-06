// Builds the design-sync CSS entry: the app's compiled stylesheet (tokens +
// generated Tailwind utilities) plus a small surface block.
//
// Why the surface block: the preview-card template inlines
// `body{background:#fff}` AFTER linking styles.css, and light card chrome
// (#e5e7eb borders, grey labels). Atlas is a dark-only, AMOLED-black system —
// on white its text tokens are invisible. `html body` (0,0,2) outranks the
// template's `body` (0,0,1), so the DS's own base surface wins. The
// height/overflow reset undoes the app-shell rule that would otherwise clip
// the card grid to the viewport.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const assets = 'dist/assets';
const src = readdirSync(assets).filter((f) => /^index-.*\.css$/.test(f));
if (src.length !== 1) {
  console.error(`expected exactly one dist/assets/index-*.css, found ${src.length}`);
  process.exit(1);
}
const compiled = readFileSync(join(assets, src[0]), 'utf8');

const surface = `
/* === design-sync preview surface (Atlas is dark-only) === */
html body {
  background: var(--bg-base);
  color: var(--text-primary);
  height: auto;
  overflow: visible;
  -webkit-user-select: auto;
  user-select: auto;
}
body .ds-cell {
  border-color: var(--border-default);
  background: var(--bg-surface);
}
body .ds-cell > h4 { color: var(--text-tertiary); }
`;

writeFileSync('.design-sync/ds.css', compiled + surface);
console.log(`ds.css: ${src[0]} + surface block (${(compiled.length + surface.length) / 1024 | 0} KB)`);
