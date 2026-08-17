#!/usr/bin/env node
/**
 * Download every source file into data/raw/. Idempotent: files already present
 * are skipped, so re-running after a partial failure is cheap.
 */
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BORDERS_BASE, NE_BASE, HISTORICAL_YEARS, NE_LAYERS, sourceFileFor,
} from './sources.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'data', 'raw');

const CONCURRENCY = 6;

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function download(url, dest, label) {
  if (await exists(dest)) return { label, status: 'cached' };
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} from ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
  return { label, status: 'fetched', kb: Math.round(buf.length / 1024) };
}

/** Simple bounded-concurrency pool — 53 parallel requests is rude. */
async function pool(items, limit, worker) {
  const out = [];
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx]);
    }
  });
  await Promise.all(runners);
  return out;
}

async function main() {
  await mkdir(RAW, { recursive: true });

  const jobs = [
    ...HISTORICAL_YEARS.map((year) => ({
      url: `${BORDERS_BASE}/${sourceFileFor(year)}`,
      dest: join(RAW, sourceFileFor(year)),
      label: String(year),
    })),
    ...Object.entries(NE_LAYERS).map(([key, file]) => ({
      url: `${NE_BASE}/${file}`,
      dest: join(RAW, file),
      label: `ne:${key}`,
    })),
  ];

  console.log(`fetching ${jobs.length} source files -> data/raw/`);
  const results = await pool(jobs, CONCURRENCY, (j) =>
    download(j.url, j.dest, j.label).catch((err) => ({ label: j.label, status: 'FAILED', err })),
  );

  const failed = results.filter((r) => r.status === 'FAILED');
  const fetched = results.filter((r) => r.status === 'fetched');
  const cached = results.filter((r) => r.status === 'cached');

  console.log(`  fetched ${fetched.length}, cached ${cached.length}, failed ${failed.length}`);
  if (failed.length) {
    for (const f of failed) console.error(`  FAILED ${f.label}: ${f.err.message}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
