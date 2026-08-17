#!/usr/bin/env node
/**
 * Pull metadata for historical polities from Wikidata.
 *
 * The border source carries almost nothing beyond a name: `TYPE` is populated on
 * 48 of 17,521 features, `wikipedia` on 21. The design's region inspector wants
 * form of government, seat and population, so that has to be joined from
 * elsewhere.
 *
 * Strategy: pull every state-like entity with its metadata in a handful of
 * class-scoped queries, then match locally against the 3,026 distinct polity
 * names in our snapshots. Matching locally rather than querying per name turns
 * 3,026 round trips into six.
 *
 * Run at BUILD time. Output: data/raw/wikidata-polities.json
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'raw', 'wikidata-polities.json');
const ENDPOINT = 'https://query.wikidata.org/sparql';
const UA = 'HistoryLayer/0.1 (personal history map; contact via repo)';

/**
 * Two families, because our map is not a map of states.
 *
 * Over 80% of the names in the snapshots are peoples, archaeological cultures
 * and hominin species — Neanderthal, Jōmon, Khoisan, Austronesians. Asking those
 * for a capital and a form of government is a category error, so they are
 * queried separately and described with facts that fit them.
 */
const STATE_CLASSES = [
  ['Q3024240', 'historical country'],
  ['Q6256', 'country'],
  ['Q48349', 'empire'],
  ['Q417175', 'kingdom'],
  ['Q7275', 'state'],
  ['Q164142', 'former administrative territorial entity'],
];

const PEOPLE_CLASSES = [
  ['Q41710', 'ethnic group'],
  ['Q465299', 'archaeological culture'],
  ['Q133311', 'tribe'],
  ['Q235352', 'hominin / human species'],
];

/** Peoples and cultures: where they lived and when, not who ruled them. */
function sparqlForPeople(qid) {
  return `
SELECT ?item ?itemLabel ?regionLabel ?langLabel ?inception ?dissolved ?article WHERE {
  ?item wdt:P31/wdt:P279* wd:${qid} .
  OPTIONAL { ?item wdt:P2341 ?region . }
  OPTIONAL { ?item wdt:P2936 ?lang . }
  OPTIONAL { ?item wdt:P571 ?inception . }
  OPTIONAL { ?item wdt:P576 ?dissolved . }
  OPTIONAL {
    ?article schema:about ?item ;
             schema:isPartOf <https://en.wikipedia.org/> .
  }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
LIMIT 12000`;
}

function sparqlFor(qid) {
  return `
SELECT ?item ?itemLabel ?capitalLabel ?govLabel ?pop ?inception ?dissolved ?article WHERE {
  ?item wdt:P31/wdt:P279* wd:${qid} .
  OPTIONAL { ?item wdt:P36 ?capital . }
  OPTIONAL { ?item wdt:P122 ?gov . }
  OPTIONAL { ?item wdt:P1082 ?pop . }
  OPTIONAL { ?item wdt:P571 ?inception . }
  OPTIONAL { ?item wdt:P576 ?dissolved . }
  OPTIONAL {
    ?article schema:about ?item ;
             schema:isPartOf <https://en.wikipedia.org/> .
  }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
LIMIT 12000`;
}

function year(iso) {
  if (!iso) return null;
  const m = /^(-?\d{1,7})-/.exec(iso);
  if (!m) return null;
  const y = Number(m[1]);
  return Number.isFinite(y) ? y : null;
}

async function runQuery(qid, label, people = false) {
  const query = people ? sparqlForPeople(qid) : sparqlFor(qid);
  const res = await fetch(`${ENDPOINT}?query=${encodeURIComponent(query)}`, {
    headers: { Accept: 'application/sparql-results+json', 'User-Agent': UA },
  });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  const json = await res.json();
  const out = [];
  for (const r of json.results?.bindings ?? []) {
    const name = r.itemLabel?.value;
    // Unlabelled items come back as bare Q-ids; they are noise.
    if (!name || /^Q\d+$/.test(name)) continue;
    const row = { name, qid: r.item?.value?.split('/').pop() };
    if (people) row.kind = 'people';
    const clean = (v) => (v && !/^Q\d+$/.test(v) ? v : undefined);
    if (clean(r.capitalLabel?.value)) row.capital = r.capitalLabel.value;
    if (clean(r.govLabel?.value)) row.government = r.govLabel.value;
    if (clean(r.regionLabel?.value)) row.region = r.regionLabel.value;
    if (clean(r.langLabel?.value)) row.language = r.langLabel.value;
    if (r.pop?.value) {
      const n = Number(r.pop.value);
      if (Number.isFinite(n) && n > 0) row.population = Math.round(n);
    }
    const from = year(r.inception?.value);
    const to = year(r.dissolved?.value);
    if (from !== null) row.from = from;
    if (to !== null) row.to = to;
    if (r.article?.value) row.article = r.article.value;
    out.push(row);
  }
  return out;
}

async function main() {
  await mkdir(dirname(OUT), { recursive: true });
  const all = [];
  const jobs = [
    ...STATE_CLASSES.map(([q, l]) => [q, l, false]),
    ...PEOPLE_CLASSES.map(([q, l]) => [q, l, true]),
  ];
  for (const [qid, label, people] of jobs) {
    process.stdout.write(`  ${qid} (${label})… `);
    try {
      const rows = await runQuery(qid, label, people);
      all.push(...rows);
      console.log(`${rows.length} rows`);
    } catch (err) {
      // A failed class is survivable; the others still carry the join.
      console.log(`FAILED (${err.message}) — continuing`);
    }
    await new Promise((r) => setTimeout(r, 1500)); // be polite to a free endpoint
  }

  // One row per entity, keeping the richest version of each.
  const byQid = new Map();
  for (const r of all) {
    const prev = byQid.get(r.qid);
    if (!prev) { byQid.set(r.qid, r); continue; }
    for (const k of ['capital', 'government', 'population', 'region', 'language', 'kind', 'from', 'to', 'article']) {
      if (prev[k] === undefined && r[k] !== undefined) prev[k] = r[k];
    }
  }

  const rows = [...byQid.values()];
  await writeFile(OUT, JSON.stringify(rows));
  const withCapital = rows.filter((r) => r.capital).length;
  const withGov = rows.filter((r) => r.government).length;
  const withPop = rows.filter((r) => r.population).length;
  const withRegion = rows.filter((r) => r.region).length;
  const peoples = rows.filter((r) => r.kind === 'people').length;
  console.log(`\n  ${rows.length} entities → data/raw/wikidata-polities.json`);
  console.log(`  states: capital ${withCapital} · government ${withGov} · population ${withPop}`);
  console.log(`  peoples & cultures: ${peoples} entities · homeland recorded for ${withRegion}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
