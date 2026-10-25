// Course maps: the Asdeporte /ruta parser behind scripts/fetch-course-maps.mjs,
// and the app-side sanitizer + ordering in src/lib/races.ts.
//
// The filenames below are real ones from Asdeporte's CDN (2026-10-25). The
// parser is what the 2026-10-24 route pass lacked: it reported "no course
// map" for all 8 races that already had one.
import { describe, expect, it } from 'vitest';

import { courseMapsOf, isValidRouteCoords, sanitizeCourseMaps, type Race } from '@/lib/races';
import {
  asdeporteEventBase,
  classifyKind,
  distanceFromName,
  extractCourseMapImages,
  mergeCourseMaps,
} from '../scripts/lib/course-map-parse.mjs';

const CDN = 'https://d3cnkhyiyh0ve2.cloudfront.net/upload';

describe('distanceFromName', () => {
  it.each([
    ['Petalo-26-ruta-3k.jpg', '3K'],
    ['Farmatodo-26-ruta-3K.jpg', '3K'],
    ['Villanos-26-ruta-5y10k.jpg', '5K/10K'],
    ['Farmatodo-26-rutas-5y10K.jpg', '5K/10K'],
    ['Ruta%20Puebla%205k%20y%2010k.png', '5K/10K'],
    ['ruta%205%20kmt.jpg', '5K'],
    ['RUTA%2021%20KMt.jpg', '21K'],
    ['Ruta%20Puebla%201K.png', '1K'],
    ['ruta-2,5k.jpg', '2.5K'],
  ])('%s -> %s', (name, expected) => {
    expect(distanceFromName(name)).toBe(expected);
  });

  it('never reads the edition year as a distance', () => {
    // `-26-` is the year; a hyphen is not a list separator, or this is "26K/10K".
    expect(distanceFromName('Invierno-CDMX-26-ruta-10k.jpg')).toBe('10K');
  });

  it('returns null when only sizes and years are in the name', () => {
    expect(distanceFromName('RR-Mexico-26-ruta-1500x852-sep-3.jpg')).toBeNull();
    expect(distanceFromName('Altimetr%C3%83%C2%ADa%20MMM2026.jpg')).toBeNull();
  });
});

describe('classifyKind', () => {
  it('spots an elevation chart, including a mis-encoded altimetría', () => {
    expect(classifyKind('Altimetr%C3%83%C2%ADa%20MMM2026.jpg')).toBe('elevation');
    expect(classifyKind('perfil-elevacion-21k.png')).toBe('elevation');
  });
  it('treats everything else as a route map', () => {
    expect(classifyKind('UVM-26-ruta-5k.jpg')).toBe('route');
  });
});

describe('extractCourseMapImages', () => {
  const html = `
    <img src="${CDN}/2026/9/1788365579333_Farmatodo-26-ruta-3K.jpg">
    <img src="${CDN}/2026/9/1788365579333_Farmatodo-26-ruta-3K.jpg">
    "${CDN}/2026/9/1788365609093_Farmatodo-26-rutas-5y10K.jpg\\"
    <img src="${CDN}/2026/9/1788300000000_logo-farmatodo.png">
    <img src="${CDN}/2026/9/1788300000001_playera-kit.jpg">`;

  it('keeps course images only, deduped, without escaped-quote debris', () => {
    const found = extractCourseMapImages(html);
    expect(found.map((f: { url: string }) => f.url)).toEqual([
      `${CDN}/2026/9/1788365579333_Farmatodo-26-ruta-3K.jpg`,
      `${CDN}/2026/9/1788365609093_Farmatodo-26-rutas-5y10K.jpg`,
    ]);
  });

  it('reads the upload date out of the 13-digit timestamp', () => {
    expect(extractCourseMapImages(html)[0].uploadedAt).toBe('2026-09-02');
  });
});

describe('mergeCourseMaps', () => {
  const found = [
    { url: `${CDN}/2026/10/1_UVM-26-ruta-3k.jpg`, name: 'UVM-26-ruta-3k.jpg' },
    { url: `${CDN}/2026/10/2_UVM-26-ruta-5k.jpg`, name: 'UVM-26-ruta-5k.jpg' },
  ];

  it('adds new maps with a parsed distance and kind', () => {
    const { list, added } = mergeCourseMaps(null, found);
    expect(added).toBe(2);
    expect(list[1]).toEqual({ url: found[1].url, distance: '5K', kind: 'route' });
  });

  it('never removes or rewrites an existing entry (a hand-fixed label survives)', () => {
    const existing = [{ url: found[0].url, distance: '3K caminata', kind: 'route' }];
    const { list, added } = mergeCourseMaps(existing, found);
    expect(added).toBe(1);
    expect(list[0]).toEqual(existing[0]);
  });
});

describe('asdeporteEventBase', () => {
  it('strips the tab suffix from a signup URL', () => {
    expect(
      asdeporteEventBase({ signupUrl: 'https://asdeporte.com/evento/barbie-run-puebla-2026-kwq/datos-del-evento' }),
    ).toBe('https://asdeporte.com/evento/barbie-run-puebla-2026-kwq');
  });
  it('falls back to the source URL, and is null for other hosts', () => {
    expect(asdeporteEventBase({ signupUrl: null, sourceUrl: 'https://www.asdeporte.com/evento/carrera-x' })).toBe(
      'https://www.asdeporte.com/evento/carrera-x',
    );
    expect(asdeporteEventBase({ signupUrl: 'https://tritour.org/evento/x', sourceUrl: 'https://tritour.org' })).toBeNull();
  });
});

describe('sanitizeCourseMaps', () => {
  const good = { url: 'https://cdn.example/a.jpg', distance: '5K', kind: 'route' };

  it('returns the same array when every entry is fine (keeps object identity)', () => {
    const maps = [good];
    expect(sanitizeCourseMaps(maps)).toBe(maps);
  });

  it('drops only the bad entries — a hostile scheme, an unknown kind, a non-string label', () => {
    const maps = [
      good,
      { url: 'javascript:alert(1)', distance: null, kind: 'route' },
      { url: 'https://cdn.example/b.jpg', distance: null, kind: 'photo' },
      { url: 'https://cdn.example/c.jpg', distance: 5, kind: 'route' },
    ];
    expect(sanitizeCourseMaps(maps)).toEqual([good]);
  });

  it('is null for a non-array', () => {
    expect(sanitizeCourseMaps('https://cdn.example/a.jpg')).toBeNull();
  });
});

describe('courseMapsOf', () => {
  const base = { courseMaps: null, courseMapUrl: null } as unknown as Race;

  it('puts route maps before elevation charts', () => {
    const race = {
      ...base,
      courseMaps: [
        { url: 'https://x/e.jpg', distance: '21K', kind: 'elevation' },
        { url: 'https://x/r.jpg', distance: '21K', kind: 'route' },
      ],
    } as Race;
    expect(courseMapsOf(race).map((m) => m.kind)).toEqual(['route', 'elevation']);
  });

  it('falls back to the legacy courseMapUrl from an old payload', () => {
    expect(courseMapsOf({ ...base, courseMapUrl: 'https://x/old.jpg' } as Race)).toEqual([
      { url: 'https://x/old.jpg', distance: null, kind: 'route' },
    ]);
  });

  it('is empty with neither', () => {
    expect(courseMapsOf(base)).toEqual([]);
  });
});

describe('isValidRouteCoords', () => {
  it('accepts 2+ in-range [lat, lng] pairs', () => {
    expect(isValidRouteCoords([[25.18, -99.82], [25.19, -99.83]])).toBe(true);
  });
  it('rejects a single point, swapped/out-of-range values, and wrong shapes', () => {
    expect(isValidRouteCoords([[25.18, -99.82]])).toBe(false);
    expect(isValidRouteCoords([[25.18, -199.82], [25.19, -99.83]])).toBe(false);
    expect(isValidRouteCoords([[25.18, -99.82, 500], [25.19, -99.83]])).toBe(false);
    expect(isValidRouteCoords([[25.18, Number.NaN], [25.19, -99.83]])).toBe(false);
    expect(isValidRouteCoords(null)).toBe(false);
  });
});
