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
import {
  getCachedAccountStatus,
  getCachedDisplayName,
  setCachedAccountStatus,
  setCachedDisplayName,
} from '@/lib/profile-cache';

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

// Same three states for the account-link status, which Profile › Account's
// "Your account" section seeds from. Here the empty string means "checked:
// anonymous" and must render the link form at once, not wait.
describe('account status cache', () => {
  const ACCOUNT_KEY = 'accountEmail';

  it('reads "never checked" as null, so the section waits for the server', () => {
    // First in this block and nothing above writes this key, so this is a
    // fresh device's store (the stub has no delete to reset it with).
    expect(getPref(ACCOUNT_KEY)).toBeNull();
    expect(getCachedAccountStatus()).toBeNull();
  });

  it('keeps "anonymous" distinct from "never checked"', () => {
    setCachedAccountStatus({ linked: false });
    expect(getPref(ACCOUNT_KEY)).toBe('');
    expect(getCachedAccountStatus()).toEqual({ linked: false });
  });

  it('round-trips a linked email', () => {
    setCachedAccountStatus({ linked: true, email: 'runner@example.com' });
    expect(getCachedAccountStatus()).toEqual({ linked: true, email: 'runner@example.com' });
  });

  it('follows an identity change instead of keeping the old address', () => {
    setCachedAccountStatus({ linked: true, email: 'first@example.com' });
    setCachedAccountStatus({ linked: false });
    expect(getCachedAccountStatus()).toEqual({ linked: false });
  });
});
