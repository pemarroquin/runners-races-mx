// parseRawPath — turns raw_path (written on upload as `[lat, lng, ts]`
// triples, see uploadRun) back into LatLng[] for drawing the Saved tab's
// fence thumbnails with the actual recorded route instead of the fence
// polygon's boundary (the bug `1df2ae6` fixed for the summary map).
//
// Importing '@/lib/territory-sync' for real pulls in @supabase/supabase-js,
// which schedules an internal auto-refresh timer at client-construction time
// that later throws "window is not defined" under Node and fails the whole
// suite (an unhandled rejection, not caught by this file) — the same reason
// upload-queue.test.ts takes an injected Uploader instead of importing
// uploadRun directly. Mocking '@/lib/supabase' avoids ever constructing the
// real client while still exercising the actual parser.
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({
  supabase: {},
  ensureSession: async () => null,
  TERRITORY_ENABLED: false,
}));

const { parseRawPath } = await import('@/lib/territory-sync');

describe('parseRawPath', () => {
  it('parses valid [lat, lng, ts] triples into LatLng points', () => {
    const raw = [
      [25.67, -100.31, 1000],
      [25.671, -100.309, 2000],
    ];
    expect(parseRawPath(raw)).toEqual([
      { lat: 25.67, lng: -100.31 },
      { lat: 25.671, lng: -100.309 },
    ]);
  });

  it('accepts a JSON-text encoded array, the same recoverable case parseFenceGeometry handles', () => {
    const raw = JSON.stringify([[25.67, -100.31, 1000]]);
    expect(parseRawPath(raw)).toEqual([{ lat: 25.67, lng: -100.31 }]);
  });

  it('returns an empty array for an empty path rather than null', () => {
    expect(parseRawPath([])).toEqual([]);
  });

  it('returns null for null', () => {
    expect(parseRawPath(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(parseRawPath(undefined)).toBeNull();
  });

  it('returns null for malformed JSON text', () => {
    expect(parseRawPath('not json at all')).toBeNull();
  });

  it('returns null when the value is not an array at all', () => {
    expect(parseRawPath({ lat: 25.67, lng: -100.31 })).toBeNull();
  });

  it('returns null when an entry is missing a coordinate', () => {
    expect(parseRawPath([[25.67]])).toBeNull();
  });

  it('returns null when an entry is not itself an array', () => {
    expect(parseRawPath([{ lat: 25.67, lng: -100.31 }])).toBeNull();
  });

  it('returns null when a coordinate is not a number', () => {
    expect(parseRawPath([['25.67', '-100.31', 1000]])).toBeNull();
  });

  it('ignores a missing/non-numeric timestamp — only lat/lng are used', () => {
    expect(parseRawPath([[25.67, -100.31]])).toEqual([{ lat: 25.67, lng: -100.31 }]);
  });
});
