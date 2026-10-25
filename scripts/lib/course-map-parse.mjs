// Pure parsing for scripts/fetch-course-maps.mjs, kept separate so vitest can
// cover it without the network.
//
// Asdeporte serves every event's course images on `/evento/<slug>/ruta`,
// server-rendered, from one CloudFront bucket with a fixed name shape:
//   https://<cdn>.cloudfront.net/upload/2026/9/1790631826020_Villanos-26-ruta-5y10k.jpg
// The 13-digit prefix is the upload time in ms, which is how the 2026-10-25
// findings measured that maps go up 20-111 days before race day.

const IMAGE_RE =
  /https:\/\/[a-z0-9]+\.cloudfront\.net\/upload\/\d{4}\/\d{1,2}\/(\d{13})_([^"'\s\\)<>]+?\.(?:jpe?g|png|webp))/gi;
// The page also carries logos, sponsor banners and kit photos from the same
// bucket; only these words mark a course image.
const COURSE_NAME_RE = /ruta|route|mapa|recorr|altimetr/i;
const ELEVATION_RE = /altimetr|elevac|elevation|perfil/i;

/** Course images on an Asdeporte /ruta page, deduped, in page order. */
export function extractCourseMapImages(html) {
  const seen = new Set();
  const out = [];
  for (const m of html.matchAll(IMAGE_RE)) {
    const [url, ts, name] = m;
    if (!COURSE_NAME_RE.test(decodeSafe(name))) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, uploadedAt: new Date(Number(ts)).toISOString().slice(0, 10), name });
  }
  return out;
}

/** 'elevation' for an altimetría / elevation chart, else 'route'. */
export function classifyKind(name) {
  return ELEVATION_RE.test(decodeSafe(name)) ? 'elevation' : 'route';
}

/**
 * The distance an image is labelled for, from its filename: `ruta-5k` -> "5K",
 * `rutas-5y10K` and `Ruta 5k y 10k` -> "5K/10K", `RUTA 21 KMt` -> "21K".
 * Null when the name carries no distance.
 *
 * A number counts only when a K follows it, directly or through a y / & / +
 * list (`5y10K`). A bare number is dropped: that's how the organizer writes
 * the YEAR (`Villanos-26-ruta-…`) and image sizes (`1500x852`), and a hyphen
 * is never a list separator, or `26-ruta-10k` would invent a "26K".
 */
export function distanceFromName(name) {
  const base = decodeSafe(name).replace(/\.[a-z]+$/i, '');
  const TOKEN = /(?<![\d.,])(\d+(?:[.,]\d+)?)(?!\d)\s*(k(?:ms?|mt)?(?![a-z]))?\s*((?:y|&|\+)(?=\s*\d))?/gi;
  const out = [];
  let group = [];
  for (const [, num, k, sep] of base.matchAll(TOKEN)) {
    group.push(num.replace(',', '.'));
    if (k) {
      out.push(...group);
      group = [];
    } else if (!sep) {
      group = [];
    }
  }
  const unique = [...new Set(out)];
  return unique.length ? unique.map((n) => `${n}K`).join('/') : null;
}

function decodeSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Merge freshly-found maps into a race's existing list. Additive only: an
 * existing entry is never removed or rewritten, so a hand-corrected label
 * survives every scheduled run. Returns the new list and how many were added.
 */
export function mergeCourseMaps(existing, found) {
  const list = Array.isArray(existing) ? [...existing] : [];
  const have = new Set(list.map((m) => m.url));
  let added = 0;
  for (const f of found) {
    if (have.has(f.url)) continue;
    list.push({ url: f.url, distance: distanceFromName(f.name), kind: classifyKind(f.name) });
    have.add(f.url);
    added++;
  }
  return { list, added };
}

/** The Asdeporte event base URL (`https://…/evento/<slug>`) for a race, or null. */
export function asdeporteEventBase(race) {
  for (const u of [race.signupUrl, race.sourceUrl]) {
    const m = typeof u === 'string' && u.match(/^(https?:\/\/(?:www\.)?asdeporte\.com\/evento\/[^/?#]+)/i);
    if (m) return m[1];
  }
  return null;
}
