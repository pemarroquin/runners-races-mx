import fs from 'node:fs';
import { SourceMapConsumer } from 'source-map';

const jsPath = process.argv[2];
const mapPath = process.argv[3];

const js = fs.readFileSync(jsPath, 'utf8');
const lines = js.split('\n');
const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));

const consumer = await new SourceMapConsumer(map);

// Bucket: for each generated line, find all mapping start-columns on that
// line (sorted), then attribute the byte span [start, nextStart) to the
// mapping's source file. This is an approximation (doesn't account for
// minified multi-statement packing precisely) but is accurate enough to
// rank which source files dominate the bundle.
const perLineMappings = new Map(); // line -> [{col, source}]

consumer.eachMapping((m) => {
  if (!m.source) return;
  const line = m.generatedLine;
  if (!perLineMappings.has(line)) perLineMappings.set(line, []);
  perLineMappings.get(line).push({ col: m.generatedColumn, source: m.source });
});

const bytesBySource = new Map();

for (const [lineNo, mappings] of perLineMappings) {
  const lineText = lines[lineNo - 1];
  if (lineText == null) continue;
  const lineLen = lineText.length;
  mappings.sort((a, b) => a.col - b.col);
  for (let i = 0; i < mappings.length; i++) {
    const start = Math.min(mappings[i].col, lineLen);
    const end = i + 1 < mappings.length ? Math.min(mappings[i + 1].col, lineLen) : lineLen;
    const span = Math.max(0, end - start);
    const src = mappings[i].source;
    bytesBySource.set(src, (bytesBySource.get(src) || 0) + span);
  }
}

consumer.destroy();

// Roll up by top-level node_modules package (or app source dir).
const bytesByPackage = new Map();
for (const [src, bytes] of bytesBySource) {
  const nmMatch = src.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
  // Dependencies roll up to their package; everything else — app source above
  // all — stays keyed by its own file, which is the interesting granularity.
  const key = nmMatch ? `node_modules/${nmMatch[1]}` : src;
  bytesByPackage.set(key, (bytesByPackage.get(key) || 0) + bytes);
}

const sorted = [...bytesByPackage.entries()].sort((a, b) => b[1] - a[1]);
const totalAttributed = sorted.reduce((s, [, v]) => s + v, 0);

console.log(`Total generated bundle size: ${js.length} bytes`);
console.log(`Total attributed (mapped): ${totalAttributed} bytes\n`);
console.log('Top 40 by attributed size:\n');
for (const [key, bytes] of sorted.slice(0, 40)) {
  console.log(`${(bytes / 1024).toFixed(1).padStart(8)} KiB  ${key}`);
}
