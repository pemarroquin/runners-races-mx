// No env file may ever be committed, and every env filename must be ignored.
//
// THIS REPO IS PUBLIC. A committed env file is published the instant it is
// pushed, and rewriting history does not un-publish it — forks, clones and
// GitHub's cached views keep it. The only safe outcome is never committing
// one, which means the guard has to run in CI rather than living in a
// reviewer's head.
//
// The gap this closes was real: `.gitignore` had `.env*.local`, which matches
// .env.local but NOT a bare `.env`, nor .env.production/.env.staging. Today
// the only variables in play are EXPO_PUBLIC_* ones that ship inside the web
// bundle anyway, so nothing was exposed — but a service-role key dropped into
// `.env` would be a full database compromise and nothing would have caught it.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// fileURLToPath, NOT `new URL(...).pathname` — this workspace lives under
// "Claude Code Pedro", and .pathname percent-encodes the spaces, producing a
// path git cannot chdir into (spawnSync ENOENT).
const REPO = fileURLToPath(new URL('..', import.meta.url));

const git = (...args: string[]) =>
  execFileSync('git', args, { encoding: 'utf8', cwd: REPO });

/** Any path whose basename starts with `.env`, at any depth. `.env.example`
 *  is the one legitimate exception: names with empty values, no secrets. */
const ENV_FILE = /(^|\/)\.env(\..*)?$/;
const ALLOWED = /(^|\/)\.env\.example$/;

describe('env files are never committed', () => {
  it('no tracked file is an env file', () => {
    const tracked = git('ls-files')
      .split('\n')
      .filter((f) => ENV_FILE.test(f) && !ALLOWED.test(f));
    expect(tracked).toEqual([]);
  });

  it('no env file was ever ADDED anywhere in history', () => {
    // --all: branches this one was never merged into count too. A secret in
    // an abandoned branch is just as published as one on main.
    const added = git('log', '--all', '--diff-filter=A', '--name-only', '--format=')
      .split('\n')
      .map((f) => f.trim())
      .filter((f) => f && ENV_FILE.test(f) && !ALLOWED.test(f));
    expect([...new Set(added)]).toEqual([]);
  });

  it('every env filename shape is gitignored', () => {
    // check-ignore exits 1 when a path is NOT ignored, so a plain call would
    // throw. Ask it about all of them at once and compare the echo instead.
    const names = ['.env', '.env.local', '.env.production', '.env.staging', '.env.development.local'];
    let ignored: string[] = [];
    try {
      ignored = git('check-ignore', ...names).split('\n').filter(Boolean);
    } catch {
      // Non-zero exit means at least one was not ignored; `ignored` stays as
      // whatever matched, and the assertion below reports precisely which.
    }
    expect(names.filter((n) => !ignored.includes(n))).toEqual([]);
  });

  it('leaves .env.example trackable, so documenting variable names stays possible', () => {
    let ignored = false;
    try {
      git('check-ignore', '.env.example');
      ignored = true;
    } catch {
      ignored = false;
    }
    expect(ignored).toBe(false);
  });
});
