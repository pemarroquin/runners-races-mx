// The "+N" conquest marker's shape and palette — ONE silhouette, shared by
// the native map (components/conquest-marker.tsx) and the web map's DOM
// markers (components/fence-map.web.tsx), so the two can't drift.
//
// Every number here is the Figma master, Atoms/Bubble/ConquestMarker (node
// 49:6 in Races-MX, page "Organisms — Chrome over the Map").
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

const round = (n: number) => Math.round(n * 1000) / 1000;

/** The body diameter that fits `+N` with even clearance on every side. Grows
 *  the CIRCLE, never a pill: the tail is tangent to a circle of one radius,
 *  and a stretched body has no such radius. */
export function conquestMarkerDiameter(count: number): number {
  const chars = String(Math.abs(Math.round(count))).length + 1; // the "+"
  const needed =
    chars * CONQUEST_MARKER.fontSize * CONQUEST_MARKER.charAdvanceEm +
    CONQUEST_MARKER.innerPadding * 2 +
    CONQUEST_MARKER.stroke;
  // Even numbers keep the centre on a whole pixel.
  return Math.max(CONQUEST_MARKER.baseDiameter, Math.ceil(needed / 2) * 2);
}

export function conquestMarkerGeometry(count: number): ConquestMarkerGeometry {
  const diameter = conquestMarkerDiameter(count);
  const r = diameter / 2;
  const tail = Math.round(diameter * CONQUEST_MARKER.tailRatio * 2) / 2;
  // Distance from the body's centre down to the tip.
  const d = r + tail;
  // Angle at the centre between "straight down" and the tangent point: the
  // tangent meets the tip at a right angle, so the centre/tangent/tip
  // triangle has hypotenuse d and adjacent side r.
  const phi = Math.acos(r / d);
  const tx = r * Math.sin(phi);
  const ty = r * Math.cos(phi);
  const pad = CONQUEST_MARKER.stroke / 2;
  const cx = pad + r;
  const cy = pad + r;

  // Left tangent point → the long way round the circle (large-arc, drawn
  // clockwise in SVG's y-down space) → right tangent point → tip → close.
  const at = (dy: number) =>
    `M ${round(cx - tx)} ${round(cy + ty + dy)} ` +
    `A ${r} ${r} 0 1 1 ${round(cx + tx)} ${round(cy + ty + dy)} ` +
    `L ${cx} ${round(cy + d + dy)} Z`;

  const width = diameter + CONQUEST_MARKER.stroke;
  const height = diameter + tail + CONQUEST_MARKER.stroke;
  // A blurred shadow spreads about three standard deviations past the shape,
  // and the SVG viewport clips anything outside it — on Android there is no
  // CSS filter to escape into, so the room has to be in the drawing surface.
  const bleed =
    Math.ceil(CONQUEST_MARKER.shadowBlurStdDeviation * 3) + CONQUEST_MARKER.shadowOffsetY;
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
    shadowPath: at(CONQUEST_MARKER.shadowOffsetY),
  };
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
