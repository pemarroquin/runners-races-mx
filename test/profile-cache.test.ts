// The display-name cache — what makes Settings > Profile paint the runner's
// real name instead of an empty field while the network is in flight.
//
// The distinction worth testing is the three-state one, because getting it
// wrong is invisible: "never cached" (null — wait for the server) must stay
// separate from "the server says this runner has no name" (empty string —
// show the anonymous fallback now). Collapse them and a nameless runner
// waits ~30 seconds to be told they have no name.
import { beforeEach, describe, expect, it } from 'vitest';

import { getPref, setPref } from '@/lib/db';
import { getCachedDisplayName, setCachedDisplayName } from '@/lib/profile-cache';

const KEY = 'profileDisplayName';

describe('profile display-name cache', () => {
  beforeEach(() => {
    setPref(KEY, '');
    // The stub store has no delete; an explicit round trip below covers the
    // never-cached case instead of trying to clear it.
  });

  it('returns what was stored', () => {
    setCachedDisplayName('Pedro 2');
    expect(getCachedDisplayName()).toBe('Pedro 2');
  });

  it('keeps "no name set" distinct from "never fetched"', () => {
    setCachedDisplayName(null);
    // Stored, and empty — not null. A screen can act on this immediately.
    expect(getCachedDisplayName()).toBe('');
    expect(getCachedDisplayName()).not.toBeNull();
  });

  it('reads back through the same pref key the store holds', () => {
    setCachedDisplayName('Ana');
    expect(getPref(KEY)).toBe('Ana');
  });

  it('overwrites rather than accumulating', () => {
    setCachedDisplayName('First');
    setCachedDisplayName('Second');
    expect(getCachedDisplayName()).toBe('Second');
  });

  it('trims nothing — the server value is stored verbatim', () => {
    // updateDisplayName already trims and caps before it writes; a second,
    // different normalisation here would make the cached value and the
    // leaderboard value disagree.
    setCachedDisplayName('  spaced  ');
    expect(getCachedDisplayName()).toBe('  spaced  ');
  });
});
