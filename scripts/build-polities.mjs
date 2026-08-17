#!/usr/bin/env node
/**
 * Join Wikidata polity metadata onto the names in our snapshots.
 *
 * Matching by name alone would be wrong often: Wikidata holds many entities
 * called "Georgia", "Egypt" or "Macedonia" separated by centuries. We know which
 * years each name is actually drawn in, so a candidate is scored on whether its
 * existence window overlaps those years — a string match that disagrees with the
 * timeline loses to one that agrees with it.
 *
 * Anything unmatched simply carries no metadata; the UI says so rather than
 * inventing a capital.
 *
 * Output: public/data/polities.json
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { feature as topoFeature } from 'topojson-client';
import { ALL_YEARS, outputFileFor } from './sources.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IN = join(ROOT, 'data', 'raw', 'wikidata-polities.json');
const RULERS = join(ROOT, 'data', 'raw', 'wikidata-rulers.json');
const YEARS_DIR = join(ROOT, 'public', 'data', 'years');
const OUT = join(ROOT, 'public', 'data', 'polities.json');

/**
 * Fold accents before stripping punctuation.
 *
 * Without this, `[^a-z0-9]+` deletes the macron in "Jōmon" and leaves "j mon" —
 * a name split into two words that can never match Wikidata's "Jōmon". Decompose
 * to NFD, drop the combining marks, and the letter underneath survives.
 */
function fold(raw) {
  return raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Trim the decoration a name carries in one source but not the other. */
function normalise(raw) {
  return fold(raw)
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')          // "Madagascar (France)" -> "Madagascar"
    .replace(/\b(the|of|de|el|la)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Also try the bare stem, so "Kingdom of Hungary" can meet "Hungary".
 *
 * The second group matters for the prehistoric map specifically: our source
 * writes "Jōmon", "Ainu" and "Minoan" where Wikidata titles the same things
 * "Jōmon period", "Ainu people" and "Minoan civilization". Without stripping
 * those nouns the three most recognisable Stone Age cultures on the map match
 * nothing at all.
 */
function stem(raw) {
  return normalise(raw)
    .replace(/\b(kingdom|empire|republic|state|states|duchy|principality|khanate|caliphate|dynasty|confederation|federation|union|province|colony|territory)\b/g, ' ')
    .replace(/\b(people|peoples|culture|cultures|period|civilization|civilisation|tribe|nation|language|languages)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function main() {
  let wiki;
  try {
    wiki = JSON.parse(await readFile(IN, 'utf8'));
  } catch {
    console.error('No wikidata-polities.json — run `npm run data:polities:fetch` first.');
    process.exit(1);
  }

  // --- where and when each name appears in our own data ----------------
  const appears = new Map(); // name -> { years:Set, society, partof, abbrev }
  for (const year of ALL_YEARS) {
    let topo;
    try {
      topo = JSON.parse(await readFile(join(YEARS_DIR, outputFileFor(year)), 'utf8'));
    } catch { continue; }
    const fc = topoFeature(topo, topo.objects[Object.keys(topo.objects)[0]]);
    for (const f of fc.features) {
      const p = f.properties ?? {};
      const n = p.NAME;
      if (!n) continue;
      let rec = appears.get(n);
      if (!rec) { rec = { years: new Set(), society: '', partof: '', abbrev: '' }; appears.set(n, rec); }
      rec.years.add(year);
      if (!rec.society && p.SOCIETY) rec.society = p.SOCIETY;
      if (!rec.partof && p.PARTOF && p.PARTOF !== n) rec.partof = p.PARTOF;
      if (!rec.abbrev && p.ABBREVN && p.ABBREVN !== n) rec.abbrev = p.ABBREVN;
    }
  }

  // --- index the Wikidata rows by both keys ----------------------------
  const byNorm = new Map();
  const byStem = new Map();
  for (const row of wiki) {
    for (const [map, key] of [[byNorm, normalise(row.name)], [byStem, stem(row.name)]]) {
      if (!key) continue;
      let arr = map.get(key);
      if (!arr) { arr = []; map.set(key, arr); }
      arr.push(row);
    }
  }

  /** How well a candidate's lifespan agrees with the years we draw the name. */
  function overlapScore(row, years) {
    if (row.from === undefined && row.to === undefined) return 0.25; // unknown, mild credit
    const from = row.from ?? -1e6;
    const to = row.to ?? 3000;
    let hit = 0;
    for (const y of years) if (y >= from && y <= to) hit++;
    return hit / years.size;
  }

  /** Reigns, keyed by the same qid the metadata join resolves. */
  let rulers = {};
  try { rulers = JSON.parse(await readFile(RULERS, 'utf8')); } catch { /* optional */ }

  const out = {};
  const stats = { exact: 0, stemmed: 0, unmatched: 0, withCapital: 0, withGov: 0, withPop: 0, withHomeland: 0, peoples: 0, withRulers: 0 };

  for (const [name, rec] of appears) {
    const years = rec.years;
    let candidates = byNorm.get(normalise(name)) ?? [];
    let how = 'exact';
    if (!candidates.length) { candidates = byStem.get(stem(name)) ?? []; how = 'stemmed'; }

    let best = null;
    let bestScore = -1;
    for (const c of candidates) {
      // Richer entries break ties, but time agreement dominates.
      const richness = (c.capital ? 1 : 0) + (c.government ? 1 : 0) + (c.population ? 1 : 0);
      const score = overlapScore(c, years) * 10 + richness * 0.4;
      if (score > bestScore) { bestScore = score; best = c; }
    }

    const entry = {};
    if (rec.society) entry.society = rec.society;
    if (rec.partof) entry.partOf = rec.partof;
    if (rec.abbrev) entry.abbrev = rec.abbrev;

    // A candidate that agrees with the timeline nowhere is worse than nothing.
    if (best && bestScore > 0.5) {
      if (best.kind) entry.kind = best.kind;
      if (best.region) { entry.homeland = best.region; stats.withHomeland++; }
      if (best.language) entry.language = best.language;
      if (best.capital) { entry.capital = best.capital; stats.withCapital++; }
      if (best.government) { entry.government = best.government; stats.withGov++; }
      if (best.population) { entry.population = best.population; stats.withPop++; }
      if (best.from !== undefined) entry.from = best.from;
      if (best.to !== undefined) entry.to = best.to;
      if (best.article) entry.article = best.article;
      if (best.qid) entry.qid = best.qid;
      // Reigns travel with the polity so the inspector can name whoever held it
      // in the year on screen.
      const reigns = best.qid ? rulers[best.qid] : undefined;
      if (reigns?.length) { entry.rulers = reigns; stats.withRulers++; }
      if (best.kind === 'people') stats.peoples++;
      stats[how]++;
    } else {
      stats.unmatched++;
    }

    if (Object.keys(entry).length) out[name] = entry;
  }

  await mkdir(dirname(OUT), { recursive: true });
  const json = JSON.stringify(out);
  await writeFile(OUT, json);

  const total = appears.size;
  console.log(`  ${total} distinct polity names in the snapshots`);
  console.log(`  matched: ${stats.exact} exact, ${stats.stemmed} by stem · unmatched ${stats.unmatched}`);
  console.log(`  states  : capital ${stats.withCapital} · government ${stats.withGov} · population ${stats.withPop}`);
  console.log(`  peoples : ${stats.peoples} matched as a people or culture · homeland ${stats.withHomeland}`);
  console.log(`  rulers  : ${stats.withRulers} polities carry a list of reigns`);
  console.log(`  wrote polities.json (${Math.round(json.length / 1024)} KB)`);

  // The coverage skew is a real property of the join; state it rather than
  // letting a mostly-empty inspector read as a bug.
  const matched = stats.exact + stats.stemmed;
  const pct = Math.round((matched / total) * 100);
  console.log(`\n  ${pct}% of names carry some external metadata. The rest are chiefly small`);
  console.log('  Indigenous nations and local cultures, which Wikidata records thinly or not');
  console.log('  at all — the inspector says "not recorded" rather than inventing a fact.');
}

main().catch((e) => { console.error(e); process.exit(1); });
