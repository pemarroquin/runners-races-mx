// Shared marker geometry for the conquest "+N" bubble and the lap "+N"
// bubble. ONE silhouette (teardrop: circle + tangent tail) shared by the
// native maps (components/conquest-marker.tsx, lap-marker.tsx) and the web
// maps' DOM markers (fence-map.web.tsx, track-map.web.tsx via
// lib/lap-marker-web.ts), so platforms can't drift.
//
// ConquestMarker: Figma master Atoms/Bubble/ConquestMarker (node 49:6,
// page "Organisms — Chrome over the Map") — purple, shows "+N taken tiles".
// LapMarker: blue variant, shows "+N" — N laps of the same ground
// (laps.ts's detectLaps, only once the run qualifies). Used to show the
// "10pt" cycle bonus instead, which read as a lap count nobody could map to
// anything (Pedro, 2026-10-15: "+X, X being the number of laps").
//
// It replaces a circle + a separately drawn triangle. That composite always
// read as two pieces, for two reasons, both fixed here:
//
//  1. The ring was `rgba(255,255,255,0.55)` over the purple body. White at
//     55% is not a colour, it is a blend of whatever sits behind it — over
//     the body it landed on ~#c4a6f7, but the triangle carried no ring at
//     all, and where the ring overhung the body it blended with the MAP
//     instead, so the same stroke was a different colour on every tile it
//     crossed. The ring is now an opaque hex (that same #c4a6f7), so it is
//     one colour everywhere.
//  2. The triangle was butted onto the circle's bottom with `marginTop: -1`,
//     so the circle's ring ran straight across the join. No stroke colour
//     fixes that — the two shapes have to become one outline.
//
// So the marker is a single path: a circle with two lines running from the
// circle's TANGENT points down to the tip. Tangent, not "somewhere on the
// arc" — the lines meet the arc at the same slope the arc has there, which
// is what makes the join invisible. One path takes one stroke and one fill,
// and the tail can no longer disagree with the body about either.
//
// The body stays a circle at every count. A pill (the old `minWidth` + flex
// padding) would break the construction: the tangent is computed against a
// circle of radius `diameter / 2`, and a stretched body has no single such
// radius. Long counts widen the circle instead.

export const CONQUEST_MARKER = {
  /** Smallest body, for a single digit. */
  baseDiameter: 28,
  /** Tail length as a share of the diameter — 10px of tail on a 28px body,
   *  12 on the 34px two-digit body Figma ships. Proportional so a wider
   *  count doesn't get a stubby tail. */
  tailRatio: 5 / 14,
  stroke: 2,
  /** Clear space between the count and the ring, per side. */
  innerPadding: 4,
  fontSize: 13,
  /** Line box for the count, matching the Figma text frame's 16px height so
   *  web and native centre the glyphs on the same baseline. */
  lineHeight: 16,
  /** Advance width of one bold digit (and of "+") in ems. Measured off the
   *  Figma master: "+12" at Bold 13 is exactly 24px = 3 x 0.6em. The old
   *  bubble had no such measure — it was a FIXED 28px box with the count
   *  free to overflow it, which is why the Figma component was visibly
   *  clipping "+12" and the app quietly rendered a 38px pill instead of the
   *  28px circle the spec claimed. */
  charAdvanceEm: 0.6,
  /** Opaque, deliberately — see the note above. */
  ring: '#c4a6f7',
  fillTop: '#9166ff',
  fillBottom: '#7c3aed',
  /** Figma: drop shadow, radius 8, offset (0, 2), rgba(0,0,0,0.5). A CSS/SVG
   *  blur radius is two standard deviations, hence 4. */
  shadowBlurStdDeviation: 4,
  shadowOffsetY: 2,
  shadowOpacity: 0.5,
  shadowColor: '#000000',
} as const;

export type ConquestMarkerGeometry = {
  /** The silhouette itself, stroke included (the stroke straddles the path,
   *  so half of it sits outside the body and needs its own room). */
  width: number;
  height: number;
  /** The drawing surface: the silhouette plus room for the blurred shadow on
   *  every side. Bigger than the marker — see `anchorY` / `webOffsetY`. */
  boxWidth: number;
  boxHeight: number;
  bleed: number;
  viewBox: string;
  diameter: number;
  radius: number;
  /** Body centre in SILHOUETTE coords — add `bleed` for box coords. */
  centerX: number;
  centerY: number;
  /** Distance from the top of the BOX down to the tip. The tip is the
   *  marker's anchor, so this is what pins it to its coordinate. */
  tipFromTop: number;
  /** Native: `<Marker anchor={{ x: 0.5, y: anchorY }} />`. */
  anchorY: number;
  /** Web: `new Marker({ anchor: 'bottom', offset: [0, webOffsetY] })` —
   *  shifts the box down so the tip, not the box's bottom edge, sits on the
   *  coordinate. */
  webOffsetY: number;
  /** The whole silhouette, body and tail, as one SVG path. */
  path: string;
  /** The same path pushed down by the shadow's offset. */
  shadowPath: string;
};

/** Blue palette for the lap marker — same teardrop shape as ConquestMarker,
 *  different colour, shows "+N" laps. */
export const LAP_MARKER = {
  baseDiameter: 28,
  tailRatio: 5 / 14,
  stroke: 2,
  innerPadding: 4,
  fontSize: 13,
  lineHeight: 16,
  charAdvanceEm: 0.6,
  ring: '#93c5fd',
  fillTop: '#60a5fa',
  fillBottom: '#2563eb',
  shadowBlurStdDeviation: 4,
  shadowOffsetY: 2,
  shadowOpacity: 0.5,
  shadowColor: '#000000',
} as const;

const round = (n: number) => Math.round(n * 1000) / 1000;

// Shared teardrop geometry — called by both marker types. Everything about
// shape/size lives here; callers supply only the diameter and shadow params.
function _teardropGeometry(
  diameter: number,
  tailRatio: number,
  stroke: number,
  shadowBlurStdDeviation: number,
  shadowOffsetY: number,
): ConquestMarkerGeometry {
  const r = diameter / 2;
  const tail = Math.round(diameter * tailRatio * 2) / 2;
  const d = r + tail;
  const phi = Math.acos(r / d);
  const tx = r * Math.sin(phi);
  const ty = r * Math.cos(phi);
  const pad = stroke / 2;
  const cx = pad + r;
  const cy = pad + r;
  const at = (dy: number) =>
    `M ${round(cx - tx)} ${round(cy + ty + dy)} ` +
    `A ${r} ${r} 0 1 1 ${round(cx + tx)} ${round(cy + ty + dy)} ` +
    `L ${cx} ${round(cy + d + dy)} Z`;
  const width = diameter + stroke;
  const height = diameter + tail + stroke;
  const bleed = Math.ceil(shadowBlurStdDeviation * 3) + shadowOffsetY;
  const boxWidth = width + bleed * 2;
  const boxHeight = height + bleed * 2;
  const tipFromTop = bleed + cy + d;
  return {
    width,
    height,
    boxWidth,
    boxHeight,
    bleed,
    viewBox: `${-bleed} ${-bleed} ${boxWidth} ${boxHeight}`,
    diameter,
    radius: r,
    centerX: cx,
    centerY: cy,
    tipFromTop,
    anchorY: tipFromTop / boxHeight,
    webOffsetY: boxHeight - tipFromTop,
    path: at(0),
    shadowPath: at(shadowOffsetY),
  };
}

/** The body diameter that fits `+N` with even clearance on every side. */
export function conquestMarkerDiameter(count: number): number {
  const chars = String(Math.abs(Math.round(count))).length + 1; // the "+"
  const needed =
    chars * CONQUEST_MARKER.fontSize * CONQUEST_MARKER.charAdvanceEm +
    CONQUEST_MARKER.innerPadding * 2 +
    CONQUEST_MARKER.stroke;
  return Math.max(CONQUEST_MARKER.baseDiameter, Math.ceil(needed / 2) * 2);
}

export function conquestMarkerGeometry(count: number): ConquestMarkerGeometry {
  return _teardropGeometry(
    conquestMarkerDiameter(count),
    CONQUEST_MARKER.tailRatio,
    CONQUEST_MARKER.stroke,
    CONQUEST_MARKER.shadowBlurStdDeviation,
    CONQUEST_MARKER.shadowOffsetY,
  );
}

/** The body diameter that fits "+N" laps — same metrics as the conquest
 *  bubble, so a "+2" lap marker and a "+2" conquest marker are one size. */
export function lapMarkerDiameter(laps: number): number {
  return conquestMarkerDiameter(laps);
}

export function lapMarkerGeometry(laps: number): ConquestMarkerGeometry {
  return _teardropGeometry(
    lapMarkerDiameter(laps),
    LAP_MARKER.tailRatio,
    LAP_MARKER.stroke,
    LAP_MARKER.shadowBlurStdDeviation,
    LAP_MARKER.shadowOffsetY,
  );
}

/** The same marker as an HTML string, for the web map's DOM markers.
 *  `uid` keeps each marker's gradient and filter ids unique in the document. */
export function conquestMarkerHtml(count: number, uid: string | number): string {
  const g = conquestMarkerGeometry(count);
  const fillId = `conquest-fill-${uid}`;
  const shadowId = `conquest-shadow-${uid}`;
  return (
    `<svg width="${g.boxWidth}" height="${g.boxHeight}" viewBox="${g.viewBox}" ` +
    `style="display:block;pointer-events:none;">` +
    `<defs>` +
    `<linearGradient id="${fillId}" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="${CONQUEST_MARKER.fillTop}"/>` +
    `<stop offset="1" stop-color="${CONQUEST_MARKER.fillBottom}"/>` +
    `</linearGradient>` +
    // feGaussianBlur alone, not feDropShadow: it is the only filter
    // primitive react-native-svg implements on BOTH platforms, so native and
    // web draw the shadow the same way rather than diverging here.
    `<filter id="${shadowId}" x="-50%" y="-50%" width="200%" height="200%">` +
    `<feGaussianBlur stdDeviation="${CONQUEST_MARKER.shadowBlurStdDeviation}"/>` +
    `</filter>` +
    `</defs>` +
    `<g filter="url(#${shadowId})" opacity="${CONQUEST_MARKER.shadowOpacity}">` +
    `<path d="${g.shadowPath}" fill="${CONQUEST_MARKER.shadowColor}"/>` +
    `</g>` +
    `<path d="${g.path}" fill="url(#${fillId})" stroke="${CONQUEST_MARKER.ring}" ` +
    `stroke-width="${CONQUEST_MARKER.stroke}" stroke-linejoin="round"/>` +
    `</svg>` +
    // The count rides on top as real text rather than <text>, so it picks up
    // the app's font stack and tabular figures exactly as the native side's
    // <Text> does. Centred on the body circle, not on the box.
    `<div style="position:absolute;left:0;top:${g.bleed}px;width:${g.boxWidth}px;` +
    `height:${g.centerY * 2}px;display:flex;align-items:center;justify-content:center;` +
    `color:#fff;font-weight:700;font-size:${CONQUEST_MARKER.fontSize}px;` +
    `line-height:${CONQUEST_MARKER.lineHeight}px;font-variant-numeric:tabular-nums;` +
    `pointer-events:none;">+${count}</div>`
  );
}

/** The blue lap marker's SVG + "+N" label, for the web maps' DOM markers.
 *  The animated wrapper around it lives in lib/lap-marker-web.ts. */
export function lapMarkerHtml(laps: number, uid: string | number): string {
  const g = lapMarkerGeometry(laps);
  const fillId = `lap-fill-${uid}`;
  const shadowId = `lap-shadow-${uid}`;
  return (
    `<svg width="${g.boxWidth}" height="${g.boxHeight}" viewBox="${g.viewBox}" ` +
    `style="display:block;pointer-events:none;">` +
    `<defs>` +
    `<linearGradient id="${fillId}" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="${LAP_MARKER.fillTop}"/>` +
    `<stop offset="1" stop-color="${LAP_MARKER.fillBottom}"/>` +
    `</linearGradient>` +
    `<filter id="${shadowId}" x="-50%" y="-50%" width="200%" height="200%">` +
    `<feGaussianBlur stdDeviation="${LAP_MARKER.shadowBlurStdDeviation}"/>` +
    `</filter>` +
    `</defs>` +
    `<g filter="url(#${shadowId})" opacity="${LAP_MARKER.shadowOpacity}">` +
    `<path d="${g.shadowPath}" fill="${LAP_MARKER.shadowColor}"/>` +
    `</g>` +
    `<path d="${g.path}" fill="url(#${fillId})" stroke="${LAP_MARKER.ring}" ` +
    `stroke-width="${LAP_MARKER.stroke}" stroke-linejoin="round"/>` +
    `</svg>` +
    `<div class="lap-marker__count" style="position:absolute;left:0;top:${g.bleed}px;width:${g.boxWidth}px;` +
    `height:${g.centerY * 2}px;display:flex;align-items:center;justify-content:center;` +
    `color:#fff;font-weight:700;font-size:${LAP_MARKER.fontSize}px;` +
    `line-height:${LAP_MARKER.lineHeight}px;font-variant-numeric:tabular-nums;` +
    `pointer-events:none;"><span>+${laps}</span></div>`
  );
}
