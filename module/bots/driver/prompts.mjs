/**
 * Pure mapping between the prompts addressed to a bot and the brain's generic shapes (no Foundry globals, so it runs
 * under `node --test`). Each prompt kind becomes `chooseOption`'s `{kind, title, text, options}` (options may name a
 * `territory` or `faction` so the brain can describe them), and the brain's `{value}` goes back through `validValue`
 * so the answer is always one the prompt would accept.
 */

/** Options the prompt would accept (not disabled). */
export const enabledOptions = options => (options ?? []).filter(o => o && !o.disabled);

/**
 * The brain's value if it names an enabled option, else the first enabled option's value, else null.
 * Values compare loosely by string (prompt values may be numbers or ids).
 */
export function validValue(options, value) {
  const ok = enabledOptions(options);
  const hit = ok.find(o => String(o.value) === String(value));
  if ( hit ) return hit.value;
  return ok[0]?.value ?? null;
}

/** Strip HTML from prompt text sent to the brain. */
export function textOf(html) {
  return String(html ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/** Territory ids → options naming the territory. */
export function territoryOptions(ids, nameOf = id => id) {
  return [...new Set(ids ?? [])].map(id => ({ value: id, label: nameOf(id), territory: id }));
}

/** min..max → options (at most 30). */
export function numberOptions(min, max, label = "") {
  const lo = Math.max(0, Math.trunc(Number(min) || 0));
  const hi = Math.max(lo, Math.min(lo + 29, Math.trunc(Number(max) || lo)));
  const out = [];
  for ( let n = lo; n <= hi; n++ ) out.push({ value: n, label: label ? `${n} ${label}` : String(n) });
  return out;
}

/**
 * An event step (module/cards/event-effects.mjs `Chooser.ask`) → chooseOption args.
 * @param {object} request  {type: option|territory|number, prompt, detail, options, allowed, min, max, label, event}
 * @param {(id: string) => string} [nameOf]
 */
export function eventChoice(request, nameOf = id => id) {
  const text = [request.prompt, request.detail].filter(Boolean).map(textOf).join(" ");
  const base = { kind: `event.${request.type}`, title: request.event ?? "", text };
  switch ( request.type ) {
    case "option":
      return { ...base, options: (request.options ?? []).map(o => ({
        value: o.value, label: textOf(o.label), hint: textOf(o.hint), disabled: !!o.disabled
      })) };
    case "territory":
      return { ...base, options: territoryOptions(request.allowed ?? [], nameOf) };
    case "number":
      return { ...base, options: numberOptions(request.min ?? 1, request.max ?? 1, textOf(request.label)) };
    default:
      return { ...base, options: [] };
  }
}

/** The value an event step expects from the brain's decision (number steps want a number). */
export function eventAnswer(request, args, value) {
  const v = validValue(args.options, value);
  if ( request.type === "number" ) {
    if ( v === null ) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return v;
}

/**
 * Draft prompt (`ask(user, "draft", {factions, cards, heldTypes, hasFaction})`) → options. Values are
 * "faction:<id>" / "draft:<id>", as the DraftPrompt uses.
 * @param {object} data
 * @param {(id: string) => {name: string}|null} factionOf
 * @param {(id: string) => {name: string, type: string, value: number, text: string}|null} draftEntry
 */
export function draftOptions(data, factionOf = () => null, draftEntry = () => null) {
  const held = new Set(data.heldTypes ?? []);
  const out = [];
  for ( const id of data.factions ?? [] ) {
    out.push({ value: `faction:${id}`, label: factionOf(id)?.name ?? id, faction: id, disabled: !!data.hasFaction });
  }
  for ( const id of data.cards ?? [] ) {
    const c = draftEntry(id);
    if ( !c ) continue;
    out.push({
      value: `draft:${id}`, label: `${c.type}: ${c.name}${Number.isFinite(c.value) ? ` (${c.value})` : ""}`,
      hint: textOf(c.text), disabled: held.has(c.type)
    });
  }
  return out;
}

/** "faction:<id>" → {type: "faction", id}; "draft:<id>" → {type: <card type>, id}. */
export function draftAnswer(value, draftEntry = () => null) {
  if ( typeof value !== "string" ) return null;
  const [kind, id] = value.split(":");
  if ( !id ) return null;
  if ( kind === "faction" ) return { type: "faction", id };
  return { type: draftEntry(id)?.type ?? "draft", id };
}

/** Rewards that are available (`available[k].ok`) → options in the given order. */
export function rewardOptions(available, labels = {}) {
  return Object.keys(available ?? {}).filter(k => available[k]?.ok)
    .map(k => ({ value: k, label: labels[k]?.label ?? k, hint: labels[k]?.hint ?? "" }));
}

/** Used names on the board, so a new name doesn't repeat one. */
export function usedNames(campaignSystem) {
  const out = new Set();
  for ( const t of Object.values(campaignSystem?.territories ?? {}) ) if ( t?.city?.name ) out.add(t.city.name);
  for ( const c of Object.values(campaignSystem?.continents ?? {}) ) if ( c?.name ) out.add(c.name);
  for ( const g of campaignSystem?.victors ?? campaignSystem?.games ?? [] ) {
    const p = g?.winner?.player;
    if ( p ) out.add(p);
  }
  if ( campaignSystem?.worldName ) out.add(campaignSystem.worldName);
  return [...out];
}

/** A non-empty name, or the fallback. */
export const nameOr = (name, fallback) => (String(name ?? "").trim() || String(fallback ?? "").trim() || "Jev");

/**
 * Fallout Zone (code only): of the allowed territories, the one that costs this faction least and its enemies most.
 * @param {object} state      BoardState
 * @param {string|null} fid
 * @param {string[]} allowed
 */
export function falloutPick(state, fid, allowed) {
  let best = allowed?.[0] ?? null;
  let bestScore = -Infinity;
  for ( const id of allowed ?? [] ) {
    const t = state?.territories?.[id];
    if ( !t ) continue;
    let mine = 0;
    let enemy = 0;
    for ( const [f, p] of Object.entries(t.pieces ?? {}) ) {
      if ( f === fid ) mine += p.troops ?? 0;
      else enemy += p.troops ?? 0;
    }
    const score = enemy - (2 * mine) - ((t.hq === fid) ? 6 : 0) + ((t.hq && (t.hq !== fid)) ? 2 : 0);
    if ( score > bestScore ) {
      bestScore = score;
      best = id;
    }
  }
  return best;
}

/**
 * Sea-line candidates (code only), best first: pairs of coastal territories that aren't adjacent, scored for this
 * faction (one end its own, the other an enemy or an HQ to reach). `b` fixes the far end (Alien Island).
 * @param {object} state       BoardState
 * @param {string|null} fid
 * @param {string[]} coastal   eligible ends
 * @param {(a: string, b: string) => boolean} adjacent
 * @param {{b?: string|null, exclude?: string[], limit?: number}} [options]
 */
export function seaLineCandidates(state, fid, coastal, adjacent, { b = null, exclude = [], limit = 25 } = {}) {
  const ends = (coastal ?? []).filter(id => !exclude.includes(id));
  const value = id => {
    const t = state?.territories?.[id];
    if ( !t ) return 0;
    let v = 0;
    if ( t.owner === fid ) v += 3;
    else if ( t.owner ) v += 2;
    else v += 1;
    if ( t.hq && (t.hq !== fid) ) v += 2;
    if ( t.city ) v += 1;
    return v;
  };
  const pairs = [];
  if ( b ) {
    for ( const a of ends ) if ( (a !== b) && !adjacent(a, b) ) pairs.push({ a, b, score: value(a) });
  }
  else {
    for ( let i = 0; i < ends.length; i++ ) {
      for ( let j = i + 1; j < ends.length; j++ ) {
        const x = ends[i];
        const y = ends[j];
        if ( adjacent(x, y) ) continue;
        const own = id => state?.territories?.[id]?.owner === fid;
        const [a, c] = own(y) && !own(x) ? [y, x] : [x, y];
        const bothOwn = own(a) && own(c);
        pairs.push({ a, b: c, score: value(a) + value(c) - (bothOwn ? 3 : 0) });
      }
    }
  }
  pairs.sort((p, q) => (q.score - p.score) || p.a.localeCompare(q.a) || p.b.localeCompare(q.b));
  return pairs.slice(0, limit);
}
