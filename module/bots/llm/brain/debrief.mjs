/**
 * After a war (BOTS-LLM.md §6.1, §3): normal and hard bots write a short memo into their BotMemory, merged with what
 * they remembered and capped (notes ≈120 words, 6 lessons, 8 grudges keyed by User id, 12 games). Easy bots keep no
 * memory. Grudges are chosen by the model from player keys; code maps them to User ids (never names).
 */
import { factionName, why } from "../../brain/util.mjs";
import { debriefMessage, debriefSchema, playerLabel } from "../prompts.mjs";
import { MEMORY_CAPS, llmProfileOf } from "../profiles.mjs";
import { askModel, gameOf, gateSay, invalid, isHeuristic } from "./call.mjs";
import { factionIdOf, textOf } from "./facts.mjs";

const clipWords = (s, n) => {
  const w = String(s ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  return w.length > n ? `${w.slice(0, n).join(" ")}…` : w.join(" ");
};
const clip = (s, n = MEMORY_CAPS.textChars) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trim()}…` : t;
};

/** A well-formed BotMemory from whatever is stored (missing fields filled, junk dropped). */
export function normalizeMemory(m) {
  const mem = m && typeof m === "object" ? m : {};
  return {
    notes: typeof mem.notes === "string" ? clipWords(mem.notes, MEMORY_CAPS.noteWords) : "",
    grudges: Array.isArray(mem.grudges) ? mem.grudges.filter(g => g && typeof g.user === "string" && g.user && g.text)
      .map(g => ({ user: g.user, text: clip(g.text), game: Number(g.game) || 0 })).slice(0, MEMORY_CAPS.grudges) : [],
    lessons: Array.isArray(mem.lessons) ? mem.lessons.filter(l => typeof l === "string" && l.trim()).map(l => clip(l)).slice(0, MEMORY_CAPS.lessons) : [],
    games: Array.isArray(mem.games) ? mem.games.filter(g => g && typeof g === "object")
      .map(g => ({ game: Number(g.game) || 0, faction: String(g.faction ?? ""), result: String(g.result ?? ""), summary: clip(g.summary ?? "") }))
      .slice(-MEMORY_CAPS.games) : [],
    updated: Number(mem.updated) || 0
  };
}

/**
 * Merge a debrief into a memory: new notes replace the old (the model saw them), new lessons go first, a new grudge
 * replaces an older one about the same User, this game's record replaces any earlier record of the same game.
 */
export function mergeMemory(base, { notes = null, lessons = [], grudges = [], game = 0, record = null } = {}) {
  const m = normalizeMemory(base);
  if ( typeof notes === "string" && notes.trim() ) m.notes = clipWords(notes, MEMORY_CAPS.noteWords);
  const seen = new Set();
  m.lessons = [...lessons.map(l => clip(l)), ...m.lessons].filter(l => {
    const k = l.toLowerCase();
    if ( !l || seen.has(k) ) return false;
    seen.add(k);
    return true;
  }).slice(0, MEMORY_CAPS.lessons);
  const fresh = grudges.filter(g => g.user && g.text).map(g => ({ user: g.user, text: clip(g.text), game }));
  const users = new Set(fresh.map(g => g.user));
  m.grudges = [...fresh, ...m.grudges.filter(g => !users.has(g.user))].slice(0, MEMORY_CAPS.grudges);
  if ( record ) m.games = [...m.games.filter(g => g.game !== record.game), { ...record, summary: clip(record.summary) }].slice(-MEMORY_CAPS.games);
  m.updated = game || m.updated;
  return m;
}

/** The other players of the war, keyed for the model: [{key, user, label, faction}]. */
function playersOf(ctx, summary) {
  const out = [];
  const seen = new Set();
  const add = (user, fid) => {
    if ( !user || user === ctx.bot?.userId || seen.has(user) ) return;
    seen.add(user);
    const name = factionName(ctx, fid);
    const seat = ctx.view?.seats?.[fid] ?? null;
    out.push({ user, faction: fid, label: playerLabel(name, seat), base: `player_of_${name}` });
  };
  for ( const o of Array.isArray(summary?.opponents) ? summary.opponents : [] ) add(o?.user, factionIdOf(ctx, o?.faction) ?? o?.faction);
  for ( const [fid, seat] of Object.entries(ctx.view?.seats ?? {}) ) if ( fid !== ctx.me ) add(seat?.user, fid);
  const keys = new Set();
  for ( const p of out ) {
    let k = p.base.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
    for ( let n = 2; keys.has(k); n++ ) k = `${k}_${n}`;
    keys.add(k);
    p.key = k;
  }
  return out;
}

/** The war's story for the prompt, from the driver's summary (tolerant of its exact shape; never user ids). */
function summaryLines(ctx, summary, players) {
  const s = summary && typeof summary === "object" ? summary : {};
  const lines = [];
  const me = factionName(ctx, ctx.me);
  const winner = s.winner ? (factionName(ctx, factionIdOf(ctx, s.winner) ?? s.winner) || textOf(s.winner)) : null;
  if ( winner ) lines.push(winner === me ? `You won the war as ${me}.` : `${winner} won the war. You played ${me}.`);
  else if ( ctx.me ) lines.push(`You played ${me}.`);
  if ( s.result ) lines.push(`Your result: ${textOf(s.result)}.`);
  if ( s.stars !== undefined ) lines.push(`Your final Red Stars: ${textOf(s.stars)}.`);
  const hq = s.hq ?? s.hqFate;
  if ( hq ) lines.push(`Your HQ: ${textOf(hq)}.`);
  const push = (label, xs, n = 6) => {
    const arr = (Array.isArray(xs) ? xs : (xs ? [xs] : [])).slice(0, n).map(textOf).filter(Boolean);
    if ( arr.length ) lines.push(`${label}: ${arr.join("; ")}`);
  };
  push("Against you", s.against ?? s.events?.against ?? s.eventsAgainst);
  push("By you", s.by ?? s.events?.by ?? s.eventsBy);
  push("Scars this game", s.scars);
  push("Cities this game", s.cities);
  if ( typeof s.text === "string" ) lines.push(textOf(s.text));
  if ( Array.isArray(s.lines) ) for ( const l of s.lines.slice(0, 8) ) lines.push(textOf(l));
  for ( const p of players ) if ( p.faction ) lines.push(`${p.label} played ${factionName(ctx, p.faction)}.`);
  return lines.filter(Boolean);
}

/** After a war: the bot's updated memory. @returns {Promise<{memory:object|null, say:string, why:object}>} */
export async function debrief(ctx, { summary = {} } = {}) {
  const profile = llmProfileOf(ctx);
  if ( profile.memory === "none" ) return { memory: null, say: "", why: why("debrief", { label: "no memory at this level" }) };
  const game = Number(summary?.game ?? gameOf(ctx)) || 0;
  const me = ctx.me ? factionName(ctx, ctx.me) : "";
  const winnerId = summary?.winner ? (factionIdOf(ctx, summary.winner) ?? summary.winner) : null;
  const result = textOf(summary?.result) || (winnerId ? (winnerId === ctx.me ? "won" : "lost") : "played");
  const record = { game, faction: me, result, summary: "" };
  const players = playersOf(ctx, summary);
  if ( isHeuristic(ctx) ) {
    return { memory: mergeMemory(ctx.bot?.memory, { game, record }), say: "", why: why("debrief", { heuristic: true, label: result }) };
  }
  const base = normalizeMemory(ctx.bot?.memory);
  const keys = players.map(p => p.key);
  const res = await askModel(ctx, {
    purpose: "debrief",
    user: debriefMessage({ summary: summaryLines(ctx, summary, players), memory: base, players }),
    schema: debriefSchema(keys),
    validate: p => {
      if ( typeof p.summary !== "string" || typeof p.notes !== "string" ) invalid("\"summary\" and \"notes\" must be text");
      if ( !Array.isArray(p.lessons) || p.lessons.some(l => typeof l !== "string") ) invalid("\"lessons\" must be a list of short texts");
      if ( p.lessons.length > 3 ) invalid("at most 3 new lessons");
      const grudges = keys.length ? (p.grudges ?? []) : [];
      if ( !Array.isArray(grudges) ) invalid("\"grudges\" must be a list");
      if ( grudges.length > 3 ) invalid("at most 3 grudges");
      return {
        summary: p.summary, notes: p.notes, lessons: p.lessons.filter(l => l.trim()),
        grudges: grudges.map(g => {
          const who = players.find(x => x.key === g?.player) ?? invalid(`unknown player "${g?.player}"`);
          return { user: who.user, text: String(g.text ?? "") };
        })
      };
    }
  });
  const v = res.value;
  const memory = mergeMemory(base, { notes: v.notes, lessons: v.lessons, grudges: v.grudges, game, record: { ...record, summary: v.summary } });
  return { memory, say: gateSay(ctx, res.say, { key: true }), why: why("debrief", { label: clip(v.summary, 120), thinking: res.thinking }) };
}
