// The seam between the Feed's hero/grid card layout and the region-identity
// illustration set (Higgsfield-generated, see
// Source Data/Outputs/Running App/region-art-manifest.json for provenance/prompts).
//
// Bundled as local assets, not fetched from a remote URL — unlike races.json,
// which refreshes live because race data genuinely changes week to week, this
// art is static and never changes, so a live fetch would only add a runtime
// network dependency for zero benefit. Metro needs literal require() paths (no
// dynamic construction), so this file is generated, not hand-maintained — see
// scripts referenced in the claude/image-perf branch commit that added the
// two-variant setup below if these need regenerating.
//
// Two size variants per image (image-perf pass): the compact 2-column grid
// slot is roughly a quarter the pixel area of the full-width hero slot, so
// reusing one ~1000px source for both meant every grid card (which vastly
// outnumber hero cards in a scrolled feed) decoded/held ~4x more pixels than
// it ever displayed. heroSource stays at the original ~1000px-wide, native
// 4:3 asset; compactSource is a separately generated 648x432 (3:2, matching
// RaceCard's COMPACT_IMAGE_RATIO) crop sized for the compact card's real
// on-screen width (~170-200pt across current devices, i.e. FlatList's
// contentContainerStyle padding + gridRow gap subtracted from screen width
// and split across two flex:1 columns — see race-card.tsx/index.tsx) at a
// common 3x device pixel ratio, rounded to a clean 3:2 multiple. Both
// variants are WebP, not JPEG — re-encoding the same illustrations as WebP
// at a matching visual quality measured 38-45% smaller than JPEG (see the
// image-perf branch commit for exact before/after byte counts), comfortably
// past the >15-20% bar that justified the format switch; expo-image and RN
// Web both decode WebP natively, so this added zero new dependencies.
//
// chih has no art yet (the generation run went 66/75 before running out of
// Higgsfield credits) — its array stays empty, which pickRegionArt() already
// handles as a text-only-card fallback, same as every region did before this.
import type { ImageSourcePropType } from 'react-native';

import { REGIONS } from '@/lib/regions';

// Shared between RaceCard (feed) and the race detail screen, both of which
// render a heroSource/compactSource picked from the same table below — kept
// here rather than duplicated per-file so the ratio can never drift from
// what the assets actually are.
export const HERO_IMAGE_RATIO = 4 / 3; // matches the generation's native 2048x1536
export const COMPACT_IMAGE_RATIO = 3 / 2; // a shorter crop, see compactSource note below

export interface RegionArtEntry {
  key: string; // e.g. 'mty-fundidora'
  heroSource: ImageSourcePropType;
  compactSource: ImageSourcePropType;
}

export const REGION_ART: Record<string, RegionArtEntry[]> = {
  mty: [
    {
      key: 'mty-cerro-silla',
      heroSource: require('../../assets/images/regions/mty/mty-cerro-silla.webp'),
      compactSource: require('../../assets/images/regions/mty/mty-cerro-silla-compact.webp'),
    },
    {
      key: 'mty-fundidora',
      heroSource: require('../../assets/images/regions/mty/mty-fundidora.webp'),
      compactSource: require('../../assets/images/regions/mty/mty-fundidora-compact.webp'),
    },
    {
      key: 'mty-guadalupe',
      heroSource: require('../../assets/images/regions/mty/mty-guadalupe.webp'),
      compactSource: require('../../assets/images/regions/mty/mty-guadalupe-compact.webp'),
    },
    {
      key: 'mty-macroplaza',
      heroSource: require('../../assets/images/regions/mty/mty-macroplaza.webp'),
      compactSource: require('../../assets/images/regions/mty/mty-macroplaza-compact.webp'),
    },
    {
      key: 'mty-san-pedro',
      heroSource: require('../../assets/images/regions/mty/mty-san-pedro.webp'),
      compactSource: require('../../assets/images/regions/mty/mty-san-pedro-compact.webp'),
    },
    {
      key: 'mty-santiago',
      heroSource: require('../../assets/images/regions/mty/mty-santiago.webp'),
      compactSource: require('../../assets/images/regions/mty/mty-santiago-compact.webp'),
    },
    {
      key: 'mty-uanl',
      heroSource: require('../../assets/images/regions/mty/mty-uanl.webp'),
      compactSource: require('../../assets/images/regions/mty/mty-uanl-compact.webp'),
    },
  ],
  cdmx: [
    {
      key: 'cdmx-amecameca',
      heroSource: require('../../assets/images/regions/cdmx/cdmx-amecameca.webp'),
      compactSource: require('../../assets/images/regions/cdmx/cdmx-amecameca-compact.webp'),
    },
    {
      key: 'cdmx-chapultepec',
      heroSource: require('../../assets/images/regions/cdmx/cdmx-chapultepec.webp'),
      compactSource: require('../../assets/images/regions/cdmx/cdmx-chapultepec-compact.webp'),
    },
    {
      key: 'cdmx-polanco',
      heroSource: require('../../assets/images/regions/cdmx/cdmx-polanco.webp'),
      compactSource: require('../../assets/images/regions/cdmx/cdmx-polanco-compact.webp'),
    },
    {
      key: 'cdmx-reforma-angel',
      heroSource: require('../../assets/images/regions/cdmx/cdmx-reforma-angel.webp'),
      compactSource: require('../../assets/images/regions/cdmx/cdmx-reforma-angel-compact.webp'),
    },
    {
      key: 'cdmx-toluca',
      heroSource: require('../../assets/images/regions/cdmx/cdmx-toluca.webp'),
      compactSource: require('../../assets/images/regions/cdmx/cdmx-toluca-compact.webp'),
    },
    {
      key: 'cdmx-unam',
      heroSource: require('../../assets/images/regions/cdmx/cdmx-unam.webp'),
      compactSource: require('../../assets/images/regions/cdmx/cdmx-unam-compact.webp'),
    },
    {
      key: 'cdmx-valle-de-bravo',
      heroSource: require('../../assets/images/regions/cdmx/cdmx-valle-de-bravo.webp'),
      compactSource: require('../../assets/images/regions/cdmx/cdmx-valle-de-bravo-compact.webp'),
    },
    {
      key: 'cdmx-zocalo',
      heroSource: require('../../assets/images/regions/cdmx/cdmx-zocalo.webp'),
      compactSource: require('../../assets/images/regions/cdmx/cdmx-zocalo-compact.webp'),
    },
  ],
  gdl: [
    {
      key: 'gdl-andares',
      heroSource: require('../../assets/images/regions/gdl/gdl-andares.webp'),
      compactSource: require('../../assets/images/regions/gdl/gdl-andares-compact.webp'),
    },
    {
      key: 'gdl-catedral',
      heroSource: require('../../assets/images/regions/gdl/gdl-catedral.webp'),
      compactSource: require('../../assets/images/regions/gdl/gdl-catedral-compact.webp'),
    },
    {
      key: 'gdl-minerva',
      heroSource: require('../../assets/images/regions/gdl/gdl-minerva.webp'),
      compactSource: require('../../assets/images/regions/gdl/gdl-minerva-compact.webp'),
    },
    {
      key: 'gdl-tlajomulco',
      heroSource: require('../../assets/images/regions/gdl/gdl-tlajomulco.webp'),
      compactSource: require('../../assets/images/regions/gdl/gdl-tlajomulco-compact.webp'),
    },
    {
      key: 'gdl-tlaquepaque',
      heroSource: require('../../assets/images/regions/gdl/gdl-tlaquepaque.webp'),
      compactSource: require('../../assets/images/regions/gdl/gdl-tlaquepaque-compact.webp'),
    },
    {
      key: 'gdl-zapopan-basilica',
      heroSource: require('../../assets/images/regions/gdl/gdl-zapopan-basilica.webp'),
      compactSource: require('../../assets/images/regions/gdl/gdl-zapopan-basilica-compact.webp'),
    },
  ],
  qro: [
    {
      key: 'qro-acueducto',
      heroSource: require('../../assets/images/regions/qro/qro-acueducto.webp'),
      compactSource: require('../../assets/images/regions/qro/qro-acueducto-compact.webp'),
    },
    {
      key: 'qro-corregidora',
      heroSource: require('../../assets/images/regions/qro/qro-corregidora.webp'),
      compactSource: require('../../assets/images/regions/qro/qro-corregidora-compact.webp'),
    },
    {
      key: 'qro-jardin-zenea',
      heroSource: require('../../assets/images/regions/qro/qro-jardin-zenea.webp'),
      compactSource: require('../../assets/images/regions/qro/qro-jardin-zenea-compact.webp'),
    },
    {
      key: 'qro-jurica',
      heroSource: require('../../assets/images/regions/qro/qro-jurica.webp'),
      compactSource: require('../../assets/images/regions/qro/qro-jurica-compact.webp'),
    },
    {
      key: 'qro-pueblito',
      heroSource: require('../../assets/images/regions/qro/qro-pueblito.webp'),
      compactSource: require('../../assets/images/regions/qro/qro-pueblito-compact.webp'),
    },
  ],
  pue: [
    {
      key: 'pue-atlixcayotl',
      heroSource: require('../../assets/images/regions/pue/pue-atlixcayotl.webp'),
      compactSource: require('../../assets/images/regions/pue/pue-atlixcayotl-compact.webp'),
    },
    {
      key: 'pue-cholula',
      heroSource: require('../../assets/images/regions/pue/pue-cholula.webp'),
      compactSource: require('../../assets/images/regions/pue/pue-cholula-compact.webp'),
    },
    {
      key: 'pue-ecoparque',
      heroSource: require('../../assets/images/regions/pue/pue-ecoparque.webp'),
      compactSource: require('../../assets/images/regions/pue/pue-ecoparque-compact.webp'),
    },
    {
      key: 'pue-serdan',
      heroSource: require('../../assets/images/regions/pue/pue-serdan.webp'),
      compactSource: require('../../assets/images/regions/pue/pue-serdan-compact.webp'),
    },
    {
      key: 'pue-zocalo-volcan',
      heroSource: require('../../assets/images/regions/pue/pue-zocalo-volcan.webp'),
      compactSource: require('../../assets/images/regions/pue/pue-zocalo-volcan-compact.webp'),
    },
  ],
  mid: [
    {
      key: 'mid-itzimna',
      heroSource: require('../../assets/images/regions/mid/mid-itzimna.webp'),
      compactSource: require('../../assets/images/regions/mid/mid-itzimna-compact.webp'),
    },
    {
      key: 'mid-montejo',
      heroSource: require('../../assets/images/regions/mid/mid-montejo.webp'),
      compactSource: require('../../assets/images/regions/mid/mid-montejo-compact.webp'),
    },
    {
      key: 'mid-monumento-patria',
      heroSource: require('../../assets/images/regions/mid/mid-monumento-patria.webp'),
      compactSource: require('../../assets/images/regions/mid/mid-monumento-patria-compact.webp'),
    },
    {
      key: 'mid-progreso',
      heroSource: require('../../assets/images/regions/mid/mid-progreso.webp'),
      compactSource: require('../../assets/images/regions/mid/mid-progreso-compact.webp'),
    },
    {
      key: 'mid-uxmal',
      heroSource: require('../../assets/images/regions/mid/mid-uxmal.webp'),
      compactSource: require('../../assets/images/regions/mid/mid-uxmal-compact.webp'),
    },
  ],
  tij: [
    {
      key: 'tij-arco',
      heroSource: require('../../assets/images/regions/tij/tij-arco.webp'),
      compactSource: require('../../assets/images/regions/tij/tij-arco-compact.webp'),
    },
    {
      key: 'tij-ensenada',
      heroSource: require('../../assets/images/regions/tij/tij-ensenada.webp'),
      compactSource: require('../../assets/images/regions/tij/tij-ensenada-compact.webp'),
    },
    {
      key: 'tij-mexicali',
      heroSource: require('../../assets/images/regions/tij/tij-mexicali.webp'),
      compactSource: require('../../assets/images/regions/tij/tij-mexicali-compact.webp'),
    },
    {
      key: 'tij-playas',
      heroSource: require('../../assets/images/regions/tij/tij-playas.webp'),
      compactSource: require('../../assets/images/regions/tij/tij-playas-compact.webp'),
    },
    {
      key: 'tij-rosarito',
      heroSource: require('../../assets/images/regions/tij/tij-rosarito.webp'),
      compactSource: require('../../assets/images/regions/tij/tij-rosarito-compact.webp'),
    },
    {
      key: 'tij-tecate',
      heroSource: require('../../assets/images/regions/tij/tij-tecate.webp'),
      compactSource: require('../../assets/images/regions/tij/tij-tecate-compact.webp'),
    },
    {
      key: 'tij-valle-guadalupe',
      heroSource: require('../../assets/images/regions/tij/tij-valle-guadalupe.webp'),
      compactSource: require('../../assets/images/regions/tij/tij-valle-guadalupe-compact.webp'),
    },
  ],
  leon: [
    {
      key: 'leon-alhondiga',
      heroSource: require('../../assets/images/regions/leon/leon-alhondiga.webp'),
      compactSource: require('../../assets/images/regions/leon/leon-alhondiga-compact.webp'),
    },
    {
      key: 'leon-arco-calzada',
      heroSource: require('../../assets/images/regions/leon/leon-arco-calzada.webp'),
      compactSource: require('../../assets/images/regions/leon/leon-arco-calzada-compact.webp'),
    },
    {
      key: 'leon-cristo-rey',
      heroSource: require('../../assets/images/regions/leon/leon-cristo-rey.webp'),
      compactSource: require('../../assets/images/regions/leon/leon-cristo-rey-compact.webp'),
    },
    {
      key: 'leon-dolores-hidalgo',
      heroSource: require('../../assets/images/regions/leon/leon-dolores-hidalgo.webp'),
      compactSource: require('../../assets/images/regions/leon/leon-dolores-hidalgo-compact.webp'),
    },
    {
      key: 'leon-plaza-paz',
      heroSource: require('../../assets/images/regions/leon/leon-plaza-paz.webp'),
      compactSource: require('../../assets/images/regions/leon/leon-plaza-paz-compact.webp'),
    },
    {
      key: 'leon-poliforum',
      heroSource: require('../../assets/images/regions/leon/leon-poliforum.webp'),
      compactSource: require('../../assets/images/regions/leon/leon-poliforum-compact.webp'),
    },
  ],
  cun: [
    {
      key: 'cun-bacalar',
      heroSource: require('../../assets/images/regions/cun/cun-bacalar.webp'),
      compactSource: require('../../assets/images/regions/cun/cun-bacalar-compact.webp'),
    },
    {
      key: 'cun-chetumal',
      heroSource: require('../../assets/images/regions/cun/cun-chetumal.webp'),
      compactSource: require('../../assets/images/regions/cun/cun-chetumal-compact.webp'),
    },
    {
      key: 'cun-cozumel',
      heroSource: require('../../assets/images/regions/cun/cun-cozumel.webp'),
      compactSource: require('../../assets/images/regions/cun/cun-cozumel-compact.webp'),
    },
    {
      key: 'cun-fcp',
      heroSource: require('../../assets/images/regions/cun/cun-fcp.webp'),
      compactSource: require('../../assets/images/regions/cun/cun-fcp-compact.webp'),
    },
    {
      key: 'cun-tulum',
      heroSource: require('../../assets/images/regions/cun/cun-tulum.webp'),
      compactSource: require('../../assets/images/regions/cun/cun-tulum-compact.webp'),
    },
    {
      key: 'cun-zona-hotelera',
      heroSource: require('../../assets/images/regions/cun/cun-zona-hotelera.webp'),
      compactSource: require('../../assets/images/regions/cun/cun-zona-hotelera-compact.webp'),
    },
  ],
  slp: [
    {
      key: 'slp-aquismon',
      heroSource: require('../../assets/images/regions/slp/slp-aquismon.webp'),
      compactSource: require('../../assets/images/regions/slp/slp-aquismon-compact.webp'),
    },
    {
      key: 'slp-arena',
      heroSource: require('../../assets/images/regions/slp/slp-arena.webp'),
      compactSource: require('../../assets/images/regions/slp/slp-arena-compact.webp'),
    },
    {
      key: 'slp-ciudad-valles',
      heroSource: require('../../assets/images/regions/slp/slp-ciudad-valles.webp'),
      compactSource: require('../../assets/images/regions/slp/slp-ciudad-valles-compact.webp'),
    },
    {
      key: 'slp-jardin-hidalgo',
      heroSource: require('../../assets/images/regions/slp/slp-jardin-hidalgo.webp'),
      compactSource: require('../../assets/images/regions/slp/slp-jardin-hidalgo-compact.webp'),
    },
    {
      key: 'slp-rioverde',
      heroSource: require('../../assets/images/regions/slp/slp-rioverde.webp'),
      compactSource: require('../../assets/images/regions/slp/slp-rioverde-compact.webp'),
    },
    {
      key: 'slp-tangamanga',
      heroSource: require('../../assets/images/regions/slp/slp-tangamanga.webp'),
      compactSource: require('../../assets/images/regions/slp/slp-tangamanga-compact.webp'),
    },
  ],
  slw: [
    {
      key: 'slw-bosque-carranza',
      heroSource: require('../../assets/images/regions/slw/slw-bosque-carranza.webp'),
      compactSource: require('../../assets/images/regions/slw/slw-bosque-carranza-compact.webp'),
    },
    {
      key: 'slw-monclova',
      heroSource: require('../../assets/images/regions/slw/slw-monclova.webp'),
      compactSource: require('../../assets/images/regions/slw/slw-monclova-compact.webp'),
    },
    {
      key: 'slw-museo-desierto',
      heroSource: require('../../assets/images/regions/slw/slw-museo-desierto.webp'),
      compactSource: require('../../assets/images/regions/slw/slw-museo-desierto-compact.webp'),
    },
    {
      key: 'slw-saltillo-catedral',
      heroSource: require('../../assets/images/regions/slw/slw-saltillo-catedral.webp'),
      compactSource: require('../../assets/images/regions/slw/slw-saltillo-catedral-compact.webp'),
    },
    {
      key: 'slw-torreon-skyline',
      heroSource: require('../../assets/images/regions/slw/slw-torreon-skyline.webp'),
      compactSource: require('../../assets/images/regions/slw/slw-torreon-skyline-compact.webp'),
    },
  ],
  chih: [],
};

// Every region id in REGIONS must have an entry above (even if empty) — this
// guards against a future new region silently having no key in the map.
if (REGIONS.some((r) => !(r.id in REGION_ART))) {
  throw new Error('region-art.ts is missing an entry for a region in REGIONS');
}

// Small, dependency-free FNV-1a hash — good enough for picking a stable
// index into a short array, no crypto needed.
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministically picks one region-art source for a given race, so the same
 * race always shows the same image identity across renders/sessions *and*
 * across both size variants — hero and compact requests for the same
 * regionId+raceId land on the same array index (one shared hash, one shared
 * entries array), they just read a different field off that entry. Returns
 * `undefined` when the region has no art (chih, for now) — that is the
 * fallback path that keeps cards text-only, and it must work correctly
 * against an empty array.
 */
export function pickRegionArt(
  regionId: string,
  raceId: string,
  variant: 'hero' | 'compact',
): ImageSourcePropType | undefined {
  const entries = REGION_ART[regionId];
  if (!entries || entries.length === 0) return undefined;
  const index = fnv1a(raceId) % entries.length;
  const entry = entries[index];
  return variant === 'hero' ? entry.heroSource : entry.compactSource;
}
