// Every href the app navigates to must correspond to a real route file.
//
// This is the check `experiments.typedRoutes` in app.json is supposed to
// provide, done in a way CI can actually run. Typed routes work by
// generating `.expo/types/router.d.ts` — an augmentation that narrows
// expo-router's `Href` to the literal union of this app's routes. That file
// is written ONLY by the dev server: `npx expo export -p web` does not
// produce it (verified 2026-09-04), there is no `expo typegen` command, and
// expo-router's published `typed-routes/types.js` is empty at runtime — it
// ships declarations, not a generator. `.expo/` is gitignored, and CI runs
// `npm ci` + `tsc` on a fresh checkout, so the augmentation has never once
// existed in CI. Typed routes have been enforcing nothing there.
//
// Worse than nothing, in fact: a STALE generated file is authoritative to
// tsc. One left over from an earlier route layout failed the build on
// `/settings/profile` — a route that exists — while the real gap (a prop
// typed `string`, widening past `Href` entirely) went unnoticed.
//
// So: `Href` is used at the call sites, which enforces on any machine that
// has run the dev server, and this test covers CI. It walks src/app the same
// way expo-router does and resolves every literal href against it.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '..', 'src');
const APP = path.join(SRC, 'app');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/**
 * Every route this app serves, in URL form. Mirrors expo-router's file
 * conventions: `(groups)` are invisible in the URL, `index` maps to the
 * directory itself, `_layout` is not a route, and `[param]` matches any
 * single segment.
 */
function routeUrls(): string[] {
  return walk(APP)
    .filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts'))
    .map((f) => path.relative(APP, f).replace(/\.tsx?$/, ''))
    .filter((r) => !path.basename(r).startsWith('_'))
    .map((r) =>
      r
        .split(path.sep)
        .filter((seg) => !/^\(.*\)$/.test(seg))
        .join('/'),
    )
    .map((r) => (r.endsWith('index') ? r.slice(0, -'index'.length) : r))
    .map((r) => '/' + r.replace(/\/$/, ''));
}

/** Literal hrefs written in the app: `href="/x"`, `href={'/x'}`, and
 *  router.push/replace/navigate('/x'). Template literals and variables are
 *  deliberately out of scope — this catches typos and deleted routes, which
 *  is what typed routes was bought for. */
function literalHrefs(): { href: string; file: string }[] {
  const found: { href: string; file: string }[] = [];
  for (const file of walk(SRC)) {
    if (!/\.tsx?$/.test(file) || file.endsWith('.d.ts')) continue;
    const source = readFileSync(file, 'utf8');
    const patterns = [
      /href=["'](\/[^"'`]*)["']/g,
      /href=\{\s*["'](\/[^"'`]*)["']\s*\}/g,
      /router\.(?:push|replace|navigate)\(\s*["'](\/[^"'`]*)["']/g,
    ];
    for (const re of patterns) {
      for (const m of source.matchAll(re)) {
        found.push({ href: m[1], file: path.relative(SRC, file) });
      }
    }
  }
  return found;
}

/** A route matches if every segment matches, treating `[param]` as a
 *  wildcard for exactly one segment. */
function matches(href: string, route: string): boolean {
  const h = href.split('?')[0].split('#')[0].replace(/\/$/, '') || '/';
  const a = h.split('/');
  const b = route.split('/');
  if (a.length !== b.length) return false;
  return b.every((seg, i) => (/^\[.+\]$/.test(seg) ? a[i].length > 0 : seg === a[i]));
}

describe('route hrefs', () => {
  const routes = routeUrls();

  it('finds the app\'s routes at all — a guard on this test, not the app', () => {
    // If the walk broke (a moved src/app, a convention change), every href
    // below would "pass" by matching nothing to nothing. It must not.
    expect(routes.length).toBeGreaterThan(5);
    expect(routes).toContain('/');
    expect(routes).toContain('/settings');
  });

  it('finds the hrefs it is meant to check', () => {
    expect(literalHrefs().length).toBeGreaterThan(3);
  });

  it('every literal href resolves to a real route', () => {
    const broken = literalHrefs().filter(({ href }) => !routes.some((r) => matches(href, r)));
    expect(broken.map(({ href, file }) => `${href} (${file})`)).toEqual([]);
  });
});
