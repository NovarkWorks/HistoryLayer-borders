#!/usr/bin/env node
/**
 * Simplify each raw snapshot and emit one TopoJSON file per year, plus a manifest.
 *
 * Two settings here are correctness-critical, not performance tuning. Both were
 * found by diffing polity names through the pipeline (see README):
 *
 *   NO -clean        `-clean` removes ~460 named polygons from the 1492 file.
 *                    They are the smallest ones, which in that file are almost
 *                    entirely Indigenous American nations. European states, being
 *                    larger, survive. A size optimisation that deletes only the
 *                    small nations is not a size optimisation.
 *
 *   precision 0.005  Coarser rounding collapses sub-kilometre polygons to null
 *                    geometry (Halalt; Seminole Tribe of Florida, Tampa Reservation).
 *
 * The name diff runs on every build and fails the build on any loss.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mapshaper from 'mapshaper';
import { feature as topoFeature } from 'topojson-client';
// Same normalisation the app uses, so the manifest's dependency count and the
// colours on screen can never disagree. Requires --experimental-strip-types.
import { isDependency } from '../src/rulers.ts';
import {
  HISTORICAL_YEARS, MODERN_YEAR, ALL_YEARS, NE_LAYERS,
  sourceFileFor, outputFileFor, eraFor,
} from './sources.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'data', 'raw');
const OUT_YEARS = join(ROOT, 'public', 'data', 'years');
const OUT_DETAIL = join(ROOT, 'public', 'data', 'detail');
const OUT_BASE = join(ROOT, 'public', 'data', 'base');
const OUT_DATA = join(ROOT, 'public', 'data');

/**
 * Fields kept from the source.
 *
 * NAME / SUBJECTO / BORDERPRECISION are universal. PARTOF and ABBREVN are
 * present on ~58% of features — the same coverage as NAME — and were being
 * discarded for no reason: PARTOF gives the cultural grouping a polity belongs
 * to, ABBREVN a short label for tight spaces.
 *
 * The schema drifts, so TYPE and type are both named here; mapshaper ignores a
 * field that a given file does not carry. Everything else in the source
 * (wikipedia, weblnks, INFO_UR, CONTROL) is populated on well under 1% of
 * features and is not worth the bytes.
 */
const KEEP_FIELDS = 'NAME,SUBJECTO,BORDERPRECISION,PARTOF,ABBREVN,SOCIETY';

/**
 * `-filter-fields` throws if a file does not carry one of the named fields, and
 * the schema drifts between years — so every kept field is first written into
 * existence. This also folds the TYPE/type spelling split into one SOCIETY
 * field, which is the whole reason the drift mattered.
 */
const NORMALISE_FIELDS =
  `-each 'this.properties.PARTOF = this.properties.PARTOF || "", ` +
  `this.properties.ABBREVN = this.properties.ABBREVN || "", ` +
  `this.properties.SOCIETY = this.properties.TYPE || this.properties.type || ""'`;

/**
 * Two levels of detail.
 *
 * One level cannot serve both jobs: at world zoom 6% is indistinguishable from
 * the full geometry, but by 30x the coastline is visibly faceted. The detail
 * tier is only fetched once you zoom past the threshold, so the world view
 * still costs ~19 KB per year.
 */
/**
 * 6% was chosen while the size budget was still measured in raw bytes, and kept
 * only 18 vertices per feature against the source's 201 — which is why the world
 * view looked faceted while the zoomed view did not. 25% lands near 55, about
 * what Natural Earth carries, for roughly twice the transfer.
 */
const SIMPLIFY = '25%';
const PRECISION = 0.002;
const DETAIL_SIMPLIFY = '38%';
const DETAIL_PRECISION = 0.0008;

/**
 * Budget is on the *gzipped* size, because that is what the browser waits for.
 * Raw bytes overstate the cost by roughly 4x for this kind of JSON and would
 * push us into over-simplifying for no user-visible gain.
 */
const GZIP_BUDGET_KB = 280;   // 1492 carries 1,813 features and sets this floor

/**
 * Names of polities that can actually be DRAWN.
 *
 * Checking only that a name string survived is not enough: a feature can keep
 * its name and lose its geometry, which reads as "nothing was lost" while the
 * polity has silently vanished from the map. Renderability is the real test.
 */
function namesOf(geojson, requireGeometry = true) {
  const out = new Set();
  for (const f of geojson.features ?? []) {
    const n = f.properties?.NAME;
    if (!n) continue;
    if (requireGeometry && !f.geometry) continue;
    out.add(n);
  }
  return out;
}

/**
 * Any polygon smaller than this in square degrees cannot be drawn at world scale
 * no matter what the pipeline does — roughly a hundredth of a square kilometre.
 */
const DEGENERATE_AREA = 1e-6;

function ringArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(a / 2);
}

function maxRingArea(geom) {
  if (!geom) return 0;
  const rings = geom.type === 'Polygon'
    ? geom.coordinates
    : geom.type === 'MultiPolygon' ? geom.coordinates.flat() : [];
  let best = 0;
  for (const r of rings) if (Array.isArray(r) && r.length > 2) best = Math.max(best, ringArea(r));
  return best;
}

/**
 * Names whose largest polygon in the SOURCE is already degenerate. These are
 * defects in the upstream data, not something the pipeline broke, and no
 * setting can recover them — e.g. Switzerland in 1994 is a 4-point sliver with
 * an area of 1.34e-7 deg².
 *
 * Classifying by evidence rather than by a hand-maintained allowlist means a
 * genuine pipeline regression still fails the build, while a bad upstream
 * polygon is reported and carried into the manifest for the UI to disclose.
 */
function degenerateInSource(geojson) {
  const best = new Map();
  for (const f of geojson.features ?? []) {
    const n = f.properties?.NAME;
    if (!n) continue;
    best.set(n, Math.max(best.get(n) ?? 0, maxRingArea(f.geometry)));
  }
  return new Set([...best].filter(([, a]) => a < DEGENERATE_AREA).map(([n]) => n));
}

async function readJSON(p) {
  return JSON.parse(await readFile(p, 'utf8'));
}

/**
 * Run a mapshaper command and return the named output as a parsed object.
 * mapshaper's programmatic API keeps everything in memory, which is far faster
 * than shelling out 54 times.
 */
async function runMapshaper(cmd, inputName, inputBuffer, outName) {
  const out = await mapshaper.applyCommands(cmd, { [inputName]: inputBuffer });
  const key = outName ?? Object.keys(out)[0];
  if (!out[key]) throw new Error(`mapshaper produced no ${key} (got ${Object.keys(out)})`);
  return JSON.parse(Buffer.from(out[key]).toString('utf8'));
}

async function buildYear(year, isModern) {
  const srcName = isModern ? NE_LAYERS.countries : sourceFileFor(year);
  const srcPath = join(RAW, srcName);
  const buf = await readFile(srcPath);

  let cmd;
  if (isModern) {
    /**
     * Natural Earth uses its own schema; map it onto ours.
     *
     * Sovereignty comes from the ADM0_A3 / SOV_A3 code pair, which is
     * authoritative: a unit is a dependency exactly when its own code differs
     * from its sovereign's. Comparing the name strings instead would call
     * Tanzania a colony of the "United Republic of Tanzania" — the same state
     * under its formal title — and there are eight such cases.
     */
    cmd = `-i ${srcName} ` +
          `-each 'BORDERPRECISION=3, SUBJECTO = (SOV_A3 !== ADM0_A3 ? SOVEREIGNT : NAME), ` +
          `PARTOF = CONTINENT || "", ABBREVN = ISO_A3 || "", SOCIETY = TYPE || ""' ` +
          `-filter-fields ${KEEP_FIELDS} ` +
          `-simplify visvalingam keep-shapes ${SIMPLIFY} ` +
          `-filter remove-empty ` +
          `-o out.json format=topojson precision=${PRECISION}`;
  } else {
    cmd = `-i ${srcName} ${NORMALISE_FIELDS} -filter-fields ${KEEP_FIELDS} ` +
          `-simplify visvalingam keep-shapes ${SIMPLIFY} ` +
          // Degenerate source features (4-point slivers) survive simplification
          // as null geometry. They render nothing and only cost bytes.
          `-filter remove-empty ` +
          `-o out.json format=topojson precision=${PRECISION}`;
  }

  const topo = await runMapshaper(cmd, srcName, buf, 'out.json');

  /**
   * Quantisation can collapse a shape to nothing *after* `-filter remove-empty`
   * has already run, leaving entries with `type: null` in the topology. They
   * draw nothing, so drop them here rather than shipping bytes the client has
   * to filter out on every load (1492 alone carries 58 of them).
   */
  const objKey = Object.keys(topo.objects)[0];
  const collection = topo.objects[objKey];
  if (Array.isArray(collection?.geometries)) {
    collection.geometries = collection.geometries.filter((g) => g && g.type);
  }

  /**
   * Every check below runs against the TopoJSON we actually ship, decoded the
   * same way the browser will decode it. Checking a parallel GeoJSON pass would
   * be checking a file nobody downloads — and the two can disagree by a feature
   * when quantisation collapses a shape.
   */
  const shipped = topoFeature(topo, topo.objects[Object.keys(topo.objects)[0]]);
  const withGeom = (shipped.features ?? []).filter((f) => f.geometry);

  const rawGeo = await readJSON(srcPath);
  const rawNames = namesOf(rawGeo, false);
  const outNames = namesOf(shipped, true);
  const degenerate = degenerateInSource(rawGeo);
  const missing = [...rawNames].filter((n) => !outNames.has(n));
  const lost = missing.filter((n) => !degenerate.has(n));
  const knownGaps = missing.filter((n) => degenerate.has(n)).sort();
  let named = 0, dependencies = 0, precSum = 0;
  for (const f of withGeom) {
    const p = f.properties ?? {};
    if (p.NAME) named++;
    if (isDependency(p.NAME, p.SUBJECTO)) dependencies++;
    precSum += typeof p.BORDERPRECISION === 'number' ? p.BORDERPRECISION : 1;
  }

  const json = JSON.stringify(topo);
  await writeFile(join(OUT_YEARS, outputFileFor(year)), json);
  const gzipKb = Math.round(gzipSync(Buffer.from(json), { level: 9 }).length / 1024);

  // --- detail tier -----------------------------------------------------
  const detailCmd = cmd
    .replace(`-simplify visvalingam keep-shapes ${SIMPLIFY}`,
             `-simplify visvalingam keep-shapes ${DETAIL_SIMPLIFY}`)
    .replace(`precision=${PRECISION}`, `precision=${DETAIL_PRECISION}`);
  const detailTopo = await runMapshaper(detailCmd, srcName, buf, 'out.json');
  const dKey = Object.keys(detailTopo.objects)[0];
  const dCol = detailTopo.objects[dKey];
  if (Array.isArray(dCol?.geometries)) {
    dCol.geometries = dCol.geometries.filter((g) => g && g.type);
  }
  const detailJson = JSON.stringify(detailTopo);
  await writeFile(join(OUT_DETAIL, outputFileFor(year)), detailJson);
  const detailGzipKb = Math.round(gzipSync(Buffer.from(detailJson), { level: 9 }).length / 1024);

  return {
    year,
    era: eraFor(year),
    features: withGeom.length,
    named,
    dependencies,
    avgPrecision: withGeom.length ? +(precSum / withGeom.length).toFixed(2) : 1,
    kb: Math.round(json.length / 1024),
    gzipKb,
    detailGzipKb,
    source: isModern ? 'naturalearth' : 'historical-basemaps',
    lost,
    knownGaps,
  };
}

async function buildBase() {
  /**
   * Present-day political borders, kept as a reference layer under the
   * historical map: recognising where you are is most of reading a history map,
   * and modern outlines are the shape everyone already knows.
   */
  {
    const file = NE_LAYERS.countries;
    const buf = await readFile(join(RAW, file));
    const cmd = `-i ${file} -filter-fields NAME -simplify visvalingam keep-shapes 30% ` +
                `-o out.json format=topojson precision=0.002`;
    const topo = await runMapshaper(cmd, file, buf, 'out.json');
    const json = JSON.stringify(topo);
    await writeFile(join(OUT_BASE, 'countries.json'), json);
    console.log(`  base/countries.json  ${Math.round(json.length / 1024)} KB`);
  }

  /**
   * States and provinces, present-day, drawn only when zoomed past a country.
   *
   * Two decisions worth keeping:
   *
   * Simplified far harder than anything else here — 5% against the coastline's
   * 35% — because there are 4,596 of them and they are never the subject. They
   * exist so that a zoomed view of France has departments in it rather than an
   * undivided shape, and at that job 5% of a 10m source still carries more
   * detail than the 110m country outlines drawn on top.
   *
   * `-innerlines` rather than the polygons: what is wanted is the divisions,
   * not the shapes. The mesh drops every coastline (the land layer already
   * draws those, better) and emits each shared border once instead of twice.
   * 181 KB gzip against 336 for the polygons, for strictly more useful ink.
   * It also discards the names, which is the right trade for a layer nothing
   * clicks — if these ever want labelling, that is a second, smaller file of
   * centroids rather than a reason to ship all the geometry twice.
   */
  {
    const file = NE_LAYERS.admin1;
    const buf = await readFile(join(RAW, file));
    const cmd = `-i ${file} -simplify visvalingam keep-shapes 5% -innerlines ` +
                `-o out.json format=topojson precision=0.006`;
    const topo = await runMapshaper(cmd, file, buf, 'out.json');
    const json = JSON.stringify(topo);
    await writeFile(join(OUT_BASE, 'admin1.json'), json);
    console.log(`  base/admin1.json  ${Math.round(json.length / 1024)} KB`);
  }

  for (const [key, file] of Object.entries({ land: NE_LAYERS.land, ocean: NE_LAYERS.ocean })) {
    const buf = await readFile(join(RAW, file));
    /**
     * The coastline carries more retention than the borders do. At 10% the
     * small islands survived (keep-shapes) but were distorted into visible
     * triangular shards scattered across the oceans. Coastlines are also the
     * one layer drawn sharp at every era, so their shape has to hold up.
     * 35% costs a few tens of KB and removes the debris.
     */
    const cmd = `-i ${file} -filter-fields -simplify visvalingam keep-shapes 35% ` +
                `-o out.json format=topojson precision=0.005`;
    const topo = await runMapshaper(cmd, file, buf, 'out.json');
    const json = JSON.stringify(topo);
    await writeFile(join(OUT_BASE, `${key}.json`), json);
    console.log(`  base/${key}.json  ${Math.round(json.length / 1024)} KB`);
  }
}

async function main() {
  await mkdir(OUT_YEARS, { recursive: true });
  await mkdir(OUT_DETAIL, { recursive: true });
  await mkdir(OUT_BASE, { recursive: true });

  console.log('building base layers');
  await buildBase();

  console.log(`building ${ALL_YEARS.length} year snapshots`);
  const entries = [];
  const failures = [];
  const oversize = [];

  for (const year of ALL_YEARS) {
    const isModern = year === MODERN_YEAR;
    const r = await buildYear(year, isModern);
    entries.push(r);
    if (r.lost.length) failures.push(r);
    if (r.gzipKb > GZIP_BUDGET_KB) oversize.push(r);
    const flag = r.lost.length
      ? `LOST ${r.lost.length}`
      : r.knownGaps.length ? `ok (${r.knownGaps.length} undrawable in source)` : 'ok';
    console.log(
      `  ${String(year).padStart(7)}  ${String(r.features).padStart(5)} feat  ` +
      `${String(r.named).padStart(5)} named  ${String(r.gzipKb).padStart(4)} KB gz  ` +
      `+${String(r.detailGzipKb).padStart(4)} detail  ${flag}`,
    );
  }

  const manifest = {
    generated: null, // stamped by the caller if wanted; kept null for reproducible builds
    years: entries.map(({ lost, knownGaps, ...rest }) => ({
      ...rest,
      // Named in the source but undrawable there; surfaced in the app, not hidden.
      undrawable: knownGaps,
    })),
    counts: {
      snapshots: entries.length,
      historical: HISTORICAL_YEARS.length,
      modern: 1,
    },
    sources: {
      borders: {
        name: 'aourednik/historical-basemaps',
        url: 'https://github.com/aourednik/historical-basemaps',
        license: 'GPL-3.0',
        coverage: '123,000 BCE - 2010 CE',
      },
      modern: {
        name: 'Natural Earth admin_0_countries',
        url: 'https://www.naturalearthdata.com/',
        license: 'public domain',
        coverage: 'present day, used for the 2026 stop',
      },
    },
  };
  await writeFile(join(OUT_DATA, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const totalGz = entries.reduce((a, e) => a + e.gzipKb, 0);
  const sorted = entries.slice().sort((a, b) => b.gzipKb - a.gzipKb);
  const median = entries.slice().sort((a, b) => a.gzipKb - b.gzipKb)[Math.floor(entries.length / 2)];
  console.log(`\n  manifest.json written — ${entries.length} snapshots`);
  const dSorted = entries.slice().sort((a, b) => b.detailGzipKb - a.detailGzipKb);
  const dMedian = entries.slice().sort((a, b) => a.detailGzipKb - b.detailGzipKb)[Math.floor(entries.length / 2)];
  console.log(`  overview: ${median.gzipKb} KB gzip median, ${sorted[0].gzipKb} KB worst (${sorted[0].year})`);
  console.log(`  detail  : ${dMedian.detailGzipKb} KB gzip median, ${dSorted[0].detailGzipKb} KB worst (${dSorted[0].year}) — fetched only on deep zoom`);

  if (oversize.length) {
    console.warn(`\n  WARNING: ${oversize.length} file(s) over the ${GZIP_BUDGET_KB} KB gzip budget:`);
    for (const o of oversize) console.warn(`    ${o.year}: ${o.gzipKb} KB gzip`);
  }

  if (failures.length) {
    console.error('\nFAIL: the pipeline dropped named polities.');
    for (const f of failures) {
      console.error(`  ${f.year}: lost ${f.lost.length} — ${f.lost.slice(0, 8).join(', ')}`);
    }
    process.exit(1);
  }
  const gapYears = entries.filter((e) => e.knownGaps.length);
  if (gapYears.length) {
    const totalGaps = gapYears.reduce((a, e) => a + e.knownGaps.length, 0);
    console.log(`\n  ${totalGaps} polities across ${gapYears.length} years are named in the source ` +
                `but have no drawable geometry there:`);
    for (const g of gapYears) console.log(`    ${g.year}: ${g.knownGaps.join(', ')}`);
    console.log('  These are upstream defects; they are recorded in the manifest and shown in the app.');
  }
  console.log('\n  no polity lost to the pipeline.');
}

main().catch((e) => { console.error(e); process.exit(1); });
