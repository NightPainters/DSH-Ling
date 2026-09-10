// zstd concatenated-frames reader — thin CLI wrapper over lib/host/zstd.js.
import { readFileSync } from 'node:fs';
import { decodeAll } from '../lib/host/zstd.js';

// CLI: node tools/zstd-read.mjs <file> [grep-term]
if (process.argv[1] && process.argv[1].endsWith('zstd-read.mjs')) {
  const file = process.argv[2];
  const term = process.argv[3];
  const text = decodeAll(readFileSync(file));
  const lines = text.split('\n').filter((l) => l.trim());
  console.log(`decoded ${text.length} chars, ${lines.length} lines`);
  const hits = term ? lines.filter((l) => l.includes(term)) : lines;
  for (const l of hits.slice(0, 5)) console.log(l.slice(0, 800));
}
