/**
 * Single source of truth for what the pipeline fetches and how it names things.
 *
 * The snapshot list is not guessed — it is the actual set of world_*.geojson files
 * in aourednik/historical-basemaps as of 2026-08. `verify-data.mjs` asserts the
 * built output matches it exactly, so a source repo change surfaces as a failure
 * rather than as a silently shorter timeline.
 */

export const BORDERS_BASE =
  'https://raw.githubusercontent.com/aourednik/historical-basemaps/master/geojson';
export const NE_BASE =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';

/** 53 historical snapshots, 123,000 BCE - 2010 CE. */
export const HISTORICAL_YEARS = [
  -123000, -10000, -8000, -5000, -4000, -3000, -2000, -1500, -1000, -700, -500,
  -400, -323, -300, -200, -100, -1, 100, 200, 300, 400, 500, 600, 700, 800, 900,
  1000, 1100, 1200, 1279, 1300, 1400, 1492, 1500, 1530, 1600, 1650, 1700, 1715,
  1783, 1800, 1815, 1880, 1900, 1914, 1920, 1930, 1938, 1945, 1960, 1994, 2000,
  2010,
];

/**
 * Natural Earth supplies a 54th stop, closing the gap the historical set leaves
 * after 2010. It is flagged in the manifest so the UI can say where it came from.
 */
export const MODERN_YEAR = 2026;

export const ALL_YEARS = [...HISTORICAL_YEARS, MODERN_YEAR];

/** historical-basemaps encodes negative years as `bc<n>`, not `-<n>`. */
export function sourceFileFor(year) {
  return year < 0 ? `world_bc${Math.abs(year)}.geojson` : `world_${year}.geojson`;
}

/** Our own output naming keeps the sign, which sorts and parses far more easily. */
export function outputFileFor(year) {
  return `world_${year}.json`;
}

/**
 * Districts and municipalities, worldwide — geoBoundaries CGAZ, CC BY 4.0.
 *
 * A second source of modern boundaries because Natural Earth has no global
 * layer below admin-1: its `ne_10m_admin_2_counties` is the United States and
 * nothing else. This one is 49,349 units across 218 countries.
 */
export const ADM2_FILE = 'geoBoundariesCGAZ_ADM2.gpkg';
export const ADM2_SOURCE =
  'https://github.com/wmgeolab/geoBoundaries/raw/main/releaseData/CGAZ/geoBoundariesCGAZ_ADM2.gpkg';

export const NE_LAYERS = {
  land: 'ne_110m_land.geojson',
  ocean: 'ne_110m_ocean.geojson',
  /**
   * Present-day countries, for the 2026 stop and the reference overlay.
   *
   * 50m rather than 110m. 110m is built for a whole world on one screen and
   * falls apart the moment somebody zooms: Iran came out of it with 51
   * vertices where the 2010 historical file gives 153, so the modern map — the
   * one people zoom into most — was the coarsest in the atlas, and stepping
   * from 2018 to 2019 visibly degraded the borders. The detail tier could not
   * help, because 38% of a 110m outline is still a 110m outline.
   *
   * Unlike admin1, this file at 50m IS the same set at finer resolution rather
   * than a subset, so nothing is lost by moving up. 3 MB against 800 KB, paid
   * once at build time.
   */
  countries: 'ne_50m_admin_0_countries.geojson',
  /**
   * States and provinces, for when the map is zoomed past a country.
   *
   * 10m rather than 50m despite being 39 MB against 2. The 50m file is not the
   * same set at lower resolution — it is a 294-feature subset covering only
   * the large federal countries. It has all 51 US states and none of France,
   * Germany, Japan or Kenya, so zooming into the United States would divide it
   * and zooming into France would not. 10m carries all 4,596 units across 253
   * countries; the size is paid once at build time and the layer it produces
   * is fetched lazily, by the people who zoom in.
   */
  admin1: 'ne_10m_admin_1_states_provinces.geojson',
};

/**
 * Era bands, used for the timeline ruler and the year readout.
 * Boundaries are conventional rather than precise — history does not have
 * hard edges — so the UI presents them as labels, never as facts.
 */
export const ERAS = [
  { from: -Infinity, to: -10000, name: 'Upper Palaeolithic' },
  { from: -10000, to: -3300, name: 'Neolithic' },
  { from: -3300, to: -1200, name: 'Bronze Age' },
  { from: -1200, to: -550, name: 'Iron Age' },
  { from: -550, to: 500, name: 'Classical Antiquity' },
  { from: 500, to: 1500, name: 'Middle Ages' },
  { from: 1500, to: 1800, name: 'Early Modern' },
  { from: 1800, to: 1914, name: 'Industrial Age' },
  { from: 1914, to: 1945, name: 'World Wars' },
  { from: 1945, to: Infinity, name: 'Modern' },
];

export function eraFor(year) {
  for (const e of ERAS) if (year >= e.from && year < e.to) return e.name;
  return '';
}
