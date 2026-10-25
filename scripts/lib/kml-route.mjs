// Pure route-line maths for scripts/import-route-kml.mjs, kept separate so
// vitest can cover it without the network.
//
// Organizers who publish a Google My Maps course expose it as KML at
// https://www.google.com/maps/d/kml?mid=<id>&forcekml=1 — a real polyline,
// not a picture. The length check is the safety: a course that doesn't
// measure what the race advertises is the wrong line (a warm-up loop, the
// other distance, a draft) and must not be written.

const R_M = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;

/** Every LineString in a KML document as `{ name, coords: [lat, lng][] }`. */
export function parseKmlLines(kml) {
  const lines = [];
  for (const pm of kml.matchAll(/<Placemark\b[\s\S]*?<\/Placemark>/g)) {
    const block = pm[0];
    const name = (block.match(/<name>([\s\S]*?)<\/name>/) || [])[1]?.replace(/<!\[CDATA\[|\]\]>/g, '').trim() ?? null;
    for (const ls of block.matchAll(/<LineString\b[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/g)) {
      const coords = ls[1]
        .trim()
        .split(/\s+/)
        .map((t) => t.split(',').map(Number))
        .filter((p) => p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))
        .map(([lng, lat]) => [lat, lng]); // KML is lng,lat[,alt]; the app stores [lat, lng]
      if (coords.length > 1) lines.push({ name, coords });
    }
  }
  return lines;
}

/** Great-circle distance in metres between two [lat, lng] points. */
export function haversineM(a, b) {
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R_M * Math.asin(Math.sqrt(s));
}

/** Polyline length in km. */
export function lengthKm(coords) {
  let m = 0;
  for (let i = 1; i < coords.length; i++) m += haversineM(coords[i - 1], coords[i]);
  return m / 1000;
}

/**
 * Advertised distance in km from a race distance label: "21K" -> 21.0975 (a
 * half is a half, whatever the label rounds to), "42K"/"Full" -> 42.195,
 * "10K" -> 10. Null when the label isn't a distance ("Infantil").
 */
export function distanceKmFromLabel(label) {
  if (typeof label !== 'string') return null;
  if (/^half$|medio/i.test(label)) return 21.0975;
  if (/^full$|^marat[oó]n$/i.test(label)) return 42.195;
  const m = label.match(/(\d+(?:[.,]\d+)?)\s*k/i);
  if (!m) return null;
  const km = Number(m[1].replace(',', '.'));
  if (km === 21) return 21.0975;
  if (km === 42) return 42.195;
  return km;
}

/**
 * The line whose length best matches one of the advertised distances, with
 * its relative error. Null when there are no lines or no usable distances.
 */
export function pickBestLine(lines, targetsKm) {
  let best = null;
  for (const line of lines) {
    const km = lengthKm(line.coords);
    for (const target of targetsKm) {
      const error = Math.abs(km - target) / target;
      if (!best || error < best.error) best = { line, km, targetKm: target, error };
    }
  }
  return best;
}

/**
 * Douglas-Peucker on a local equirectangular projection (metres), which is
 * accurate to well under a metre across a city-sized course. Keeps the first
 * and last points, so the start pin and the finish stay exact.
 */
export function simplify(coords, toleranceM = 5) {
  if (coords.length < 3) return coords.slice();
  const lat0 = rad(coords[0][0]);
  const xy = coords.map(([lat, lng]) => [rad(lng) * Math.cos(lat0) * R_M, rad(lat) * R_M]);
  const keep = new Uint8Array(coords.length);
  keep[0] = keep[coords.length - 1] = 1;
  const stack = [[0, coords.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = segmentDistance(xy[i], xy[s], xy[e]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx !== -1 && maxD > toleranceM) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return coords.filter((_, i) => keep[i]);
}

function segmentDistance(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Round every coordinate to 5 decimals (~1 m), the precision the app stores. */
export function round5(coords) {
  return coords.map(([lat, lng]) => [Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5]);
}

/** The My Maps id from a full URL (`…/maps/d/…?mid=XYZ…`) or a bare id. */
export function myMapsId(input) {
  const m = String(input).match(/[?&]mid=([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{10,}$/.test(input) ? input : null;
}
