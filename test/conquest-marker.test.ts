import { describe, expect, it } from 'vitest';

import {
  CONQUEST_MARKER,
  conquestMarkerDiameter,
  conquestMarkerGeometry,
  conquestMarkerHtml,
} from '@/lib/conquest-marker';

const COUNTS = [1, 9, 12, 99, 128, 999];

/** Pull the three points the path is built from: the two tangent points and
 *  the tip. `M x y A r r 0 1 1 x y L x y Z` */
function pointsOf(path: string) {
  const n = path.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  //        M  x0 y0   A  r  r  0  1  1  x1 y1   L  x2 y2
  //           0  1       2  3  4  5  6   7  8       9  10
  return {
    left: { x: n[0], y: n[1] },
    radius: n[2],
    right: { x: n[7], y: n[8] },
    tip: { x: n[9], y: n[10] },
  };
}

describe('conquestMarkerGeometry', () => {
  it('draws body and tail as ONE path — the whole point of the shape', () => {
    const { path } = conquestMarkerGeometry(12);
    // One move-to, one arc, one line, one close: a second `M` would mean two
    // subpaths, which is the seam this replaced.
    expect(path.match(/M/g)).toHaveLength(1);
    expect(path.match(/A/g)).toHaveLength(1);
    expect(path).toMatch(/Z$/);
  });

  it('meets the circle at its TANGENT points, so the join is invisible', () => {
    for (const count of COUNTS) {
      const g = conquestMarkerGeometry(count);
      const p = pointsOf(g.path);
      for (const t of [p.left, p.right]) {
        // On the circle.
        const rx = t.x - g.centerX;
        const ry = t.y - g.centerY;
        expect(Math.hypot(rx, ry)).toBeCloseTo(g.radius, 2);
        // Radius ⊥ tail line: that is what "tangent" means, and what makes
        // the arc and the straight line share a slope where they meet.
        const dot = rx * (p.tip.x - t.x) + ry * (p.tip.y - t.y);
        expect(dot).toBeCloseTo(0, 1);
      }
      // Symmetric about the tip.
      expect(p.left.y).toBeCloseTo(p.right.y, 6);
      expect((p.left.x + p.right.x) / 2).toBeCloseTo(p.tip.x, 6);
    }
  });

  it('keeps the whole silhouette, stroke included, inside the reported box', () => {
    const g = conquestMarkerGeometry(12);
    const p = pointsOf(g.path);
    const half = CONQUEST_MARKER.stroke / 2;
    expect(g.centerX - g.radius - half).toBeCloseTo(0, 6);
    expect(g.centerX + g.radius + half).toBeCloseTo(g.width, 6);
    expect(p.tip.y + half).toBeCloseTo(g.height, 6);
  });
});

describe('the marker anchors by its TIP', () => {
  // The drawing surface is bigger than the marker so the blurred shadow has
  // somewhere to go, which means the box's bottom edge is NOT the tip. Get
  // this wrong and every bubble floats above the ground it is pointing at.
  it('puts the tip where both platforms will pin it', () => {
    for (const count of COUNTS) {
      const g = conquestMarkerGeometry(count);
      const p = pointsOf(g.path);
      // The tip, in box coords (the path is drawn in silhouette coords, and
      // the viewBox is shifted up/left by the bleed).
      expect(g.tipFromTop).toBeCloseTo(g.bleed + p.tip.y, 6);
      expect(g.anchorY * g.boxHeight).toBeCloseTo(g.tipFromTop, 6);
      expect(g.webOffsetY + g.tipFromTop).toBeCloseTo(g.boxHeight, 6);
      // Horizontally the tip is dead centre, so both anchors stay at 0.5.
      expect(g.bleed + p.tip.x).toBeCloseTo(g.boxWidth / 2, 6);
    }
  });

  it('leaves the blur enough room that the viewport never clips it', () => {
    const g = conquestMarkerGeometry(12);
    // A Gaussian is effectively spent by three standard deviations.
    const spread = CONQUEST_MARKER.shadowBlurStdDeviation * 3 + CONQUEST_MARKER.shadowOffsetY;
    expect(g.bleed).toBeGreaterThanOrEqual(spread);
    expect(g.boxWidth).toBe(g.width + g.bleed * 2);
    expect(g.boxHeight).toBe(g.height + g.bleed * 2);
  });

  it('offsets the shadow copy by exactly the Figma drop-shadow offset', () => {
    const g = conquestMarkerGeometry(12);
    const main = pointsOf(g.path);
    const shadow = pointsOf(g.shadowPath);
    expect(shadow.tip.y - main.tip.y).toBeCloseTo(CONQUEST_MARKER.shadowOffsetY, 6);
    expect(shadow.tip.x).toBeCloseTo(main.tip.x, 6);
  });
});

describe('conquestMarkerDiameter', () => {
  it('fits the count with the stated clearance on every side', () => {
    for (const count of COUNTS) {
      const text =
        (String(count).length + 1) * CONQUEST_MARKER.fontSize * CONQUEST_MARKER.charAdvanceEm;
      const clear = (conquestMarkerDiameter(count) - CONQUEST_MARKER.stroke - text) / 2;
      // This is the regression: the old bubble was a FIXED 28 box, so "+12"
      // (24px of glyphs) had 1px of air and Figma clipped it outright.
      expect(clear).toBeGreaterThanOrEqual(CONQUEST_MARKER.innerPadding);
    }
  });

  it('never shrinks below the base, and never goes odd (centre on a whole px)', () => {
    for (const count of COUNTS) {
      const d = conquestMarkerDiameter(count);
      expect(d).toBeGreaterThanOrEqual(CONQUEST_MARKER.baseDiameter);
      expect(d % 2).toBe(0);
    }
  });

  it('grows monotonically with the digit count', () => {
    expect(conquestMarkerDiameter(9)).toBeLessThan(conquestMarkerDiameter(99));
    expect(conquestMarkerDiameter(99)).toBeLessThan(conquestMarkerDiameter(999));
    expect(conquestMarkerDiameter(1)).toBe(conquestMarkerDiameter(9));
  });
});

describe('conquestMarkerHtml', () => {
  it('carries the opaque ring — never a translucent white over the map', () => {
    const html = conquestMarkerHtml(12, 0);
    expect(html).toContain(`stroke="${CONQUEST_MARKER.ring}"`);
    expect(html).not.toMatch(/rgba\(255,\s*255,\s*255/);
  });

  it('gives each marker its own gradient id', () => {
    expect(conquestMarkerHtml(3, 0)).not.toBe(conquestMarkerHtml(3, 1));
    expect(conquestMarkerHtml(3, 1)).toContain('conquest-fill-1');
  });

  it('renders the count as +N', () => {
    expect(conquestMarkerHtml(12, 0)).toContain('+12');
  });

  it('builds the shadow from feGaussianBlur only', () => {
    const html = conquestMarkerHtml(12, 0);
    expect(html).toContain('feGaussianBlur');
    // react-native-svg 15 ships NO native feDropShadow on either platform,
    // so using one here would render on web and silently vanish on device.
    // Keeping both sides on the one primitive that is implemented natively
    // is what keeps them the same marker.
    expect(html).not.toContain('feDropShadow');
  });
});
