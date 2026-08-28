// Every `android="..."` icon name used anywhere in src/ must have a glyph in
// icon.web.tsx, or it renders as NOTHING on web while tsc, lint and
// `expo export -p web` all stay green.
//
// This trap has now been hit four times (the file's own header records
// three). The previous fixes each added the one missing glyph; this test is
// the fix for the CLASS, because it fails the moment a call site is added
// without its glyph rather than waiting for someone to look at the web build.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(full) ? [full] : [];
  });
}

describe('web icon glyph coverage', () => {
  it('has a web glyph for every android icon name used in src/', () => {
    const used = new Set<string>();
    for (const file of walk(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/android=["']([a-z_]+)["']/g)) used.add(m[1]);
    }

    const iconWeb = readFileSync(path.join(SRC, 'components/ui/icon.web.tsx'), 'utf8');
    const defined = new Set(
      Array.from(iconWeb.matchAll(/^ {2}([a-z_]+): \(c\)/gm), (m) => m[1]),
    );

    const missing = [...used].filter((name) => !defined.has(name)).sort();
    expect(missing, `no web glyph in icon.web.tsx for: ${missing.join(', ')}`).toEqual([]);
  });
});
