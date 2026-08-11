// The seam between the Feed's hero/grid card layout and the region-identity
// illustration set (Higgsfield-generated, see
// Source Data/Outputs/Running App/region-art-manifest.json for provenance/prompts).
//
// Bundled as local assets, not fetched from a remote URL — unlike races.json,
// which refreshes live because race data genuinely changes week to week, this
// art is static and never changes, so a live fetch would only add a runtime
// network dependency for zero benefit. Metro needs literal require() paths (no
// dynamic construction), so this file is generated, not hand-maintained — see
// the one-off script in the commit that added it if these need regenerating.
//
// chih has no art yet (the generation run went 66/75 before running out of
// Higgsfield credits) — its array stays empty, which pickRegionArt() already
// handles as a text-only-card fallback, same as every region did before this.
import type { ImageSourcePropType } from 'react-native';

import { REGIONS } from '@/lib/regions';

export interface RegionArtEntry {
  key: string; // e.g. 'mty-fundidora'
  source: ImageSourcePropType;
}

export const REGION_ART: Record<string, RegionArtEntry[]> = {
  mty: [
    { key: 'mty-cerro-silla', source: require('../../assets/images/regions/mty/mty-cerro-silla.jpg') },
    { key: 'mty-fundidora', source: require('../../assets/images/regions/mty/mty-fundidora.jpg') },
    { key: 'mty-guadalupe', source: require('../../assets/images/regions/mty/mty-guadalupe.jpg') },
    { key: 'mty-macroplaza', source: require('../../assets/images/regions/mty/mty-macroplaza.jpg') },
    { key: 'mty-san-pedro', source: require('../../assets/images/regions/mty/mty-san-pedro.jpg') },
    { key: 'mty-santiago', source: require('../../assets/images/regions/mty/mty-santiago.jpg') },
    { key: 'mty-uanl', source: require('../../assets/images/regions/mty/mty-uanl.jpg') },
  ],
  cdmx: [
    { key: 'cdmx-amecameca', source: require('../../assets/images/regions/cdmx/cdmx-amecameca.jpg') },
    { key: 'cdmx-chapultepec', source: require('../../assets/images/regions/cdmx/cdmx-chapultepec.jpg') },
    { key: 'cdmx-polanco', source: require('../../assets/images/regions/cdmx/cdmx-polanco.jpg') },
    { key: 'cdmx-reforma-angel', source: require('../../assets/images/regions/cdmx/cdmx-reforma-angel.jpg') },
    { key: 'cdmx-toluca', source: require('../../assets/images/regions/cdmx/cdmx-toluca.jpg') },
    { key: 'cdmx-unam', source: require('../../assets/images/regions/cdmx/cdmx-unam.jpg') },
    { key: 'cdmx-valle-de-bravo', source: require('../../assets/images/regions/cdmx/cdmx-valle-de-bravo.jpg') },
    { key: 'cdmx-zocalo', source: require('../../assets/images/regions/cdmx/cdmx-zocalo.jpg') },
  ],
  gdl: [
    { key: 'gdl-andares', source: require('../../assets/images/regions/gdl/gdl-andares.jpg') },
    { key: 'gdl-catedral', source: require('../../assets/images/regions/gdl/gdl-catedral.jpg') },
    { key: 'gdl-minerva', source: require('../../assets/images/regions/gdl/gdl-minerva.jpg') },
    { key: 'gdl-tlajomulco', source: require('../../assets/images/regions/gdl/gdl-tlajomulco.jpg') },
    { key: 'gdl-tlaquepaque', source: require('../../assets/images/regions/gdl/gdl-tlaquepaque.jpg') },
    { key: 'gdl-zapopan-basilica', source: require('../../assets/images/regions/gdl/gdl-zapopan-basilica.jpg') },
  ],
  qro: [
    { key: 'qro-acueducto', source: require('../../assets/images/regions/qro/qro-acueducto.jpg') },
    { key: 'qro-corregidora', source: require('../../assets/images/regions/qro/qro-corregidora.jpg') },
    { key: 'qro-jardin-zenea', source: require('../../assets/images/regions/qro/qro-jardin-zenea.jpg') },
    { key: 'qro-jurica', source: require('../../assets/images/regions/qro/qro-jurica.jpg') },
    { key: 'qro-pueblito', source: require('../../assets/images/regions/qro/qro-pueblito.jpg') },
  ],
  pue: [
    { key: 'pue-atlixcayotl', source: require('../../assets/images/regions/pue/pue-atlixcayotl.jpg') },
    { key: 'pue-cholula', source: require('../../assets/images/regions/pue/pue-cholula.jpg') },
    { key: 'pue-ecoparque', source: require('../../assets/images/regions/pue/pue-ecoparque.jpg') },
    { key: 'pue-serdan', source: require('../../assets/images/regions/pue/pue-serdan.jpg') },
    { key: 'pue-zocalo-volcan', source: require('../../assets/images/regions/pue/pue-zocalo-volcan.jpg') },
  ],
  mid: [
    { key: 'mid-itzimna', source: require('../../assets/images/regions/mid/mid-itzimna.jpg') },
    { key: 'mid-montejo', source: require('../../assets/images/regions/mid/mid-montejo.jpg') },
    { key: 'mid-monumento-patria', source: require('../../assets/images/regions/mid/mid-monumento-patria.jpg') },
    { key: 'mid-progreso', source: require('../../assets/images/regions/mid/mid-progreso.jpg') },
    { key: 'mid-uxmal', source: require('../../assets/images/regions/mid/mid-uxmal.jpg') },
  ],
  tij: [
    { key: 'tij-arco', source: require('../../assets/images/regions/tij/tij-arco.jpg') },
    { key: 'tij-ensenada', source: require('../../assets/images/regions/tij/tij-ensenada.jpg') },
    { key: 'tij-mexicali', source: require('../../assets/images/regions/tij/tij-mexicali.jpg') },
    { key: 'tij-playas', source: require('../../assets/images/regions/tij/tij-playas.jpg') },
    { key: 'tij-rosarito', source: require('../../assets/images/regions/tij/tij-rosarito.jpg') },
    { key: 'tij-tecate', source: require('../../assets/images/regions/tij/tij-tecate.jpg') },
    { key: 'tij-valle-guadalupe', source: require('../../assets/images/regions/tij/tij-valle-guadalupe.jpg') },
  ],
  leon: [
    { key: 'leon-alhondiga', source: require('../../assets/images/regions/leon/leon-alhondiga.jpg') },
    { key: 'leon-arco-calzada', source: require('../../assets/images/regions/leon/leon-arco-calzada.jpg') },
    { key: 'leon-cristo-rey', source: require('../../assets/images/regions/leon/leon-cristo-rey.jpg') },
    { key: 'leon-dolores-hidalgo', source: require('../../assets/images/regions/leon/leon-dolores-hidalgo.jpg') },
    { key: 'leon-plaza-paz', source: require('../../assets/images/regions/leon/leon-plaza-paz.jpg') },
    { key: 'leon-poliforum', source: require('../../assets/images/regions/leon/leon-poliforum.jpg') },
  ],
  cun: [
    { key: 'cun-bacalar', source: require('../../assets/images/regions/cun/cun-bacalar.jpg') },
    { key: 'cun-chetumal', source: require('../../assets/images/regions/cun/cun-chetumal.jpg') },
    { key: 'cun-cozumel', source: require('../../assets/images/regions/cun/cun-cozumel.jpg') },
    { key: 'cun-fcp', source: require('../../assets/images/regions/cun/cun-fcp.jpg') },
    { key: 'cun-tulum', source: require('../../assets/images/regions/cun/cun-tulum.jpg') },
    { key: 'cun-zona-hotelera', source: require('../../assets/images/regions/cun/cun-zona-hotelera.jpg') },
  ],
  slp: [
    { key: 'slp-aquismon', source: require('../../assets/images/regions/slp/slp-aquismon.jpg') },
    { key: 'slp-arena', source: require('../../assets/images/regions/slp/slp-arena.jpg') },
    { key: 'slp-ciudad-valles', source: require('../../assets/images/regions/slp/slp-ciudad-valles.jpg') },
    { key: 'slp-jardin-hidalgo', source: require('../../assets/images/regions/slp/slp-jardin-hidalgo.jpg') },
    { key: 'slp-rioverde', source: require('../../assets/images/regions/slp/slp-rioverde.jpg') },
    { key: 'slp-tangamanga', source: require('../../assets/images/regions/slp/slp-tangamanga.jpg') },
  ],
  slw: [
    { key: 'slw-bosque-carranza', source: require('../../assets/images/regions/slw/slw-bosque-carranza.jpg') },
    { key: 'slw-monclova', source: require('../../assets/images/regions/slw/slw-monclova.jpg') },
    { key: 'slw-museo-desierto', source: require('../../assets/images/regions/slw/slw-museo-desierto.jpg') },
    { key: 'slw-saltillo-catedral', source: require('../../assets/images/regions/slw/slw-saltillo-catedral.jpg') },
    { key: 'slw-torreon-skyline', source: require('../../assets/images/regions/slw/slw-torreon-skyline.jpg') },
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
 * race always shows the same image across renders/sessions while different
 * races in the same region get visual variety. Returns `undefined` when the
 * region has no art (chih, for now) — that is the fallback path that keeps
 * cards text-only, and it must work correctly against an empty array.
 */
export function pickRegionArt(regionId: string, raceId: string): ImageSourcePropType | undefined {
  const entries = REGION_ART[regionId];
  if (!entries || entries.length === 0) return undefined;
  const index = fnv1a(raceId) % entries.length;
  return entries[index].source;
}
