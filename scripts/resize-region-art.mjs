// One-time batch resize of the region-art image set, driven by a live
// PageSpeed Insights finding (2026-08-11): every hero/compact image on the
// feed ships 2-4.6x more pixels than it displays at, even on a high-DPR
// test device (Moto G Power, 2.625 DPR). Original sizing assumed a ~3x DPR
// and a wider on-screen card than the tested viewport actually renders.
//
// New targets carry ~25% headroom above PSI's reported minimum-needed
// dimensions (not the bare literal minimum) so higher-DPR real devices
// don't visibly upscale/blur — this isn't tuned to exactly one synthetic
// benchmark run.
//   hero:    1000x750 -> 832x624  (4:3, ~44% fewer pixels)
//   compact:  648x432 -> 384x256  (3:2, ~65% fewer pixels)
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = 'assets/images/regions';
const HERO_SIZE = { width: 832, height: 624 };
const COMPACT_SIZE = { width: 384, height: 256 };
const QUALITY = 82; // matches the visual-quality bar the original WebP pass targeted

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith('.webp')) yield full;
  }
}

let heroBefore = 0,
  heroAfter = 0,
  compactBefore = 0,
  compactAfter = 0,
  heroCount = 0,
  compactCount = 0;

for await (const file of walk(ROOT)) {
  const isCompact = file.endsWith('-compact.webp');
  const target = isCompact ? COMPACT_SIZE : HERO_SIZE;
  const before = (await sharp(file).metadata()).size ?? 0;
  const buf = await sharp(file)
    .resize(target.width, target.height, { fit: 'cover' })
    .webp({ quality: QUALITY })
    .toBuffer();
  await writeFile(file, buf);
  const after = buf.length;
  if (isCompact) {
    compactBefore += before;
    compactAfter += after;
    compactCount++;
  } else {
    heroBefore += before;
    heroAfter += after;
    heroCount++;
  }
}

const fmt = (n) => (n / 1024).toFixed(1) + ' KiB';
console.log(`Hero (${heroCount} files):    ${fmt(heroBefore)} -> ${fmt(heroAfter)}  (${(100 * (1 - heroAfter / heroBefore)).toFixed(0)}% smaller)`);
console.log(`Compact (${compactCount} files): ${fmt(compactBefore)} -> ${fmt(compactAfter)}  (${(100 * (1 - compactAfter / compactBefore)).toFixed(0)}% smaller)`);
console.log(`Total: ${fmt(heroBefore + compactBefore)} -> ${fmt(heroAfter + compactAfter)}`);
