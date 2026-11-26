import { describe, expect, it } from 'vitest';

import { platformOf, platformOfUrl } from '../scripts/lib/platforms.mjs';

describe('platformOfUrl', () => {
  it('maps known hosts, with or without www or a subdomain', () => {
    expect(platformOfUrl('https://www.asdeporte.com/evento/x')).toBe('asdeporte');
    expect(platformOfUrl('https://web.rockthesport.com/es/evento/x')).toBe('rockthesport');
    expect(platformOfUrl('https://tritour.org/x')).toBe('tritour');
  });
  it('returns null for unknown hosts, look-alikes and junk', () => {
    expect(platformOfUrl('https://facebook.com/events/1')).toBeNull();
    expect(platformOfUrl('https://notasdeporte.com/x')).toBeNull();
    expect(platformOfUrl('not a url')).toBeNull();
    expect(platformOfUrl(null)).toBeNull();
  });
});

describe('platformOf', () => {
  it('prefers the signup link, falls back to the source link', () => {
    expect(platformOf({ signupUrl: 'https://marcate.com.mx/a', sourceUrl: 'https://asdeporte.com/b' })).toBe('marcate');
    expect(platformOf({ signupUrl: null, sourceUrl: 'https://asdeporte.com/b' })).toBe('asdeporte');
    expect(platformOf({ signupUrl: 'https://facebook.com/x', sourceUrl: 'https://idemsport.com/b' })).toBe('idemsport');
  });
});
