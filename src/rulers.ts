/**
 * The source's SUBJECTO field records who governs a territory, but it is not
 * normalised: the same empire appears under several spellings, so colouring by
 * ruler naively splits one empire into unrelated blocs.
 *
 * The table below was built by scanning the SUBJECTO values across all 54 built
 * snapshots (80 distinct ruling powers), not by guessing.
 *
 * It is deliberately CONSERVATIVE. Only unambiguous spelling variants of the
 * same state are merged. Pairs that merely look similar are left apart, because
 * collapsing them would be a historical error wearing the costume of a cleanup:
 *
 *   Russia / USSR              — different states, not a rename.
 *   England / United Kingdom   — England before the 1707 Union is not the UK.
 *   Austria / Austrian Empire  — Archduchy and post-1804 Empire differ.
 *   Spain / Spanish Habsburg   — arguably the same, but "arguably" is not
 *                                good enough to erase the distinction.
 *
 * If a merge is not obviously safe, it does not belong here.
 */
const ALIASES: Record<string, string> = {
  // The one unambiguous case: the same British state under four spellings.
  'United Kingdom of Great Britain and Ireland': 'United Kingdom',
  'United Kingdom of Great Britain and Northern Ireland': 'United Kingdom',
  'Great Britain': 'United Kingdom',
  UK: 'United Kingdom',

  USA: 'United States',
  'United States of America': 'United States',

  // Transcription errors in the source, not distinct polities.
  'Kingfom of Italy': 'Italy',
  'Kingdom of Italy': 'Italy',
  Persi: 'Persia',
  Suom: 'Suomi',
  'CochimÃ­': 'Cochimà',

  /**
   * Formal titles of a state alongside its short name. Without these the state
   * reads as a colony of itself — the Russian Empire showed up coloured as a
   * dependency of "Russia" — because the ruler string differs from the polity
   * name while naming the same government.
   *
   * These merge a title with its own short form only. Russia and the USSR stay
   * separate, as do England and the United Kingdom.
   */
  'Russian Empire': 'Russia',
  'Kingdom of France': 'France',
  'Kingdom of Hungary': 'Hungary',
};

/**
 * Values that appear in SUBJECTO but do not name a ruler. Treated as "no ruler
 * recorded" rather than being rendered as if they were a state.
 *   "3"  — a BORDERPRECISION value that leaked into the wrong column.
 *   "(Russian and Japanese claim)" — an annotation about a dispute.
 */
const NOT_A_RULER = new Set(['3', '2', '1', '(Russian and Japanese claim)']);

export function normalizeRuler(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || NOT_A_RULER.has(trimmed)) return null;
  return ALIASES[trimmed] ?? trimmed;
}

/**
 * True when a territory is governed by someone other than itself — i.e. it is a
 * colony, protectorate or dependency rather than a sovereign state.
 */
export function isDependency(name?: string, subjecto?: string): boolean {
  const ruler = normalizeRuler(subjecto);
  if (!ruler || !name) return false;
  return normalizeRuler(name) !== ruler;
}
