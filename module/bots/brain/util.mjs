/**
 * Small pure helpers shared by the brain: `why` records, names, verbal probability bands, seeded sampling and the
 * per-turn memo. No Foundry globals.
 */

/** A `why` record (BOTS.md §5.3). */
export const why = (reason, data = {}) => ({ reason, ...data });

/** Clamp to [lo, hi]. */
export const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));

/** Round to n decimals (for `why.chance` and log data). */
export const round = (x, n = 2) => Math.round((Number(x) || 0) * 10 ** n) / 10 ** n;

/** Active factions still in the war (snapshot `factions` includes inactive actors). */
export function aliveFactions(state) {
  return Object.values(state?.factions ?? {}).filter(f => f.active && (f.status !== "eliminated"));
}

/** Opponents of `me` still in the war. */
export const opponents = (state, me) => aliveFactions(state).filter(f => f.id !== me);

/** A faction's display name (view names first, then the snapshot). */
export function factionName(ctx, fid) {
  if ( !fid ) return "nobody";
  return ctx?.view?.factionNames?.[fid] ?? ctx?.state?.factions?.[fid]?.name ?? "another faction";
}

/** A territory's display name. */
export const territoryName = (state, id) => state?.territories?.[id]?.name ?? String(id ?? "");

/** A continent's display name (the winner-given name, with the printed label when they differ). */
export function continentName(state, id) {
  const c = state?.continents?.[id];
  if ( !c ) return String(id ?? "");
  return c.name && (c.name !== c.label) ? `${c.name} (${c.label})` : (c.label ?? id);
}

/** A stable, descriptive key for Jev (faction or option names → `imperial_balkania`). */
export function slug(text, fallback = "option") {
  const s = String(text ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
  return s || fallback;
}

/** Unique slugs for a list of labels (suffixes `_2`, `_3` on clashes). */
export function uniqueSlugs(labels, fallback = "option") {
  const seen = new Map();
  return labels.map(l => {
    const base = slug(l, fallback);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}_${n}`;
  });
}

/** Verbal probability band with the percentage: "likely (74%)". */
export function band(p) {
  const x = clamp(Number(p) || 0);
  const pct = Math.round(x * 100);
  let word;
  if ( x < 0.03 ) word = "almost impossible";
  else if ( x < 0.15 ) word = "very unlikely";
  else if ( x < 0.35 ) word = "unlikely";
  else if ( x < 0.5 ) word = "a bit worse than even";
  else if ( x < 0.65 ) word = "a bit better than even";
  else if ( x < 0.85 ) word = "likely";
  else if ( x < 0.97 ) word = "very likely";
  else word = "almost certain";
  return `${word} (${pct}%)`;
}

/** "1 troop" / "3 troops". */
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Join names: "A", "A and B", "A, B and C". */
export function listText(items) {
  const xs = items.filter(Boolean);
  if ( xs.length <= 1 ) return xs[0] ?? "";
  return `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
}

/** Plain Red Star fact for one faction: "3 Red Stars: one Red Star from winning". */
export function starsText(total) {
  const need = Math.max(0, 4 - total);
  if ( need <= 0 ) return `${total} Red Stars: has won`;
  if ( need === 1 ) return `${total} Red Stars: one Red Star from winning`;
  return `${plural(total, "Red Star")}: needs ${need} more to win`;
}

/* -------------------------------------------- */
/*  Randomness                                  */
/* -------------------------------------------- */

/** Seeded RNG for tests and probes (mulberry32). */
export function seededRandom(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Sample an index from weights after tempering: w^(1/T). T = 1 samples the distribution as given, T > 1 flattens it
 * (plausible mistakes), T → 0 is argmax.
 */
export function sampleIndex(weights, temperature = 1, random = Math.random) {
  if ( !weights.length ) return -1;
  if ( temperature <= 0.01 ) return argmax(weights);
  const w = weights.map(x => Math.max(0, Number(x) || 0) ** (1 / temperature));
  const total = w.reduce((a, b) => a + b, 0);
  if ( total <= 0 ) return Math.floor(random() * weights.length);
  let r = random() * total;
  for ( let i = 0; i < w.length; i++ ) {
    r -= w[i];
    if ( r <= 0 ) return i;
  }
  return w.length - 1;
}

/** Softmax sampling over utilities (scale = how many utility points make a factor e). */
export function softmaxPick(utilities, temperature, random, scale = 1) {
  if ( !utilities.length ) return -1;
  if ( temperature <= 0.01 ) return argmax(utilities);
  const m = Math.max(...utilities);
  const w = utilities.map(u => Math.exp((u - m) / (scale * temperature)));
  return sampleIndex(w, 1, random);
}

export function argmax(xs) {
  let best = -1;
  let bv = -Infinity;
  xs.forEach((x, i) => { if ( x > bv ) { bv = x; best = i; } });
  return best;
}

/* -------------------------------------------- */
/*  Per-turn memo                               */
/* -------------------------------------------- */

const TURN_MEMOS = new Map();

/**
 * A scratch object that lives for one bot turn (judgments already asked, targets attacked). Keyed by game, round,
 * whose turn and phase-independent turn data, so a new turn gets a fresh memo. Bounded.
 */
export function turnMemo(ctx) {
  const t = ctx.state?.turn ?? {};
  const key = [ctx.me, t.warId ?? "", ctx.view?.game ?? t.game ?? "", ctx.view?.round ?? "", t.faction ?? ""].join("|");
  let memo = TURN_MEMOS.get(key);
  if ( !memo ) {
    memo = { key, values: {}, valueAsks: 0, attacked: new Set(), conquests: 0, battles: {}, exposure: {} };
    TURN_MEMOS.set(key, memo);
    if ( TURN_MEMOS.size > 64 ) TURN_MEMOS.delete(TURN_MEMOS.keys().next().value);
  }
  return memo;
}

/** Forget every turn memo (tests). */
export function clearTurnMemos() {
  TURN_MEMOS.clear();
}
