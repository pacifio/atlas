// The converter's ts-morph project is configured without tsconfig `paths`, so
// `@/...` specifiers in the emitted .d.ts tree resolve to nothing and every
// props body comes out empty. Rewrite them to relative paths after tsc emit.
import { readFileSync, writeFileSync } from 'node:fs';
import { relative, dirname, join } from 'node:path';
import { execSync } from 'node:child_process';

const root = 'dist/types';
const files = execSync(`find ${root} -name '*.d.ts'`, { encoding: 'utf8' }).trim().split('\n');
let n = 0;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const out = src.replace(/(["'])@\/([^"']+)\1/g, (_m, q, sub) => {
    let rel = relative(dirname(f), join(root, 'src', sub));
    if (!rel.startsWith('.')) rel = './' + rel;
    return q + rel + q;
  });
  if (out !== src) { writeFileSync(f, out); n++; }
}
console.log(`rewrote @/ aliases in ${n}/${files.length} .d.ts files`);
