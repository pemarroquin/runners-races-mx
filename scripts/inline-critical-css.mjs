// Inlines small first-party stylesheets referenced from dist/index.html
// directly into a <style> tag, dropping the external <link rel="preload">
// + <link rel="stylesheet"> pair entirely.
//
// Expo's web export always emits one such file — a tiny (~400 byte)
// `_expo/static/css/global-*.css` with the RNW font-variable reset — as a
// render-blocking external request. On Porkbun's static hosting (no origin
// config for HTTP/2 push or 103 Early Hints) that's a full extra
// connection+round-trip before first paint for a file smaller than this
// script's own comment block. PageSpeed Insights flags it as a
// "Render-blocking requests" finding (~230-460ms, 2026-08-11 audit).
// Only inlines files under INLINE_MAX_BYTES so a future large stylesheet
// (e.g. mapbox-gl.css, already loaded lazily at runtime, not from
// index.html) never gets swept in by accident.
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';

const DIST = path.resolve(process.argv[2] ?? 'dist');
const INDEX = path.join(DIST, 'index.html');
const INLINE_MAX_BYTES = 4096;

let html = readFileSync(INDEX, 'utf8');

const linkRe = /<link rel="preload" href="([^"]+\.css)" as="style">\s*<link rel="stylesheet" href="\1">/g;

let inlined = 0;
html = html.replace(linkRe, (match, href) => {
  const filePath = path.join(DIST, href.replace(/^\//, ''));
  let size;
  try {
    size = statSync(filePath).size;
  } catch {
    console.warn(`inline-critical-css: ${href} referenced in index.html but not found on disk, leaving as-is`);
    return match;
  }
  if (size > INLINE_MAX_BYTES) return match;
  const css = readFileSync(filePath, 'utf8');
  inlined++;
  return `<style>${css}</style>`;
});

writeFileSync(INDEX, html);
console.log(`inline-critical-css: inlined ${inlined} stylesheet(s) into ${path.relative(process.cwd(), INDEX)}`);
