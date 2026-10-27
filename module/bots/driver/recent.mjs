/**
 * What happened in this war, for the chat-model bots (BOTS-LLM.md §7): `view.recent` (public events since a faction's
 * last turn started) and the war's account for the end-of-war debrief.
 *
 * Recorded on the GM client from the system's hooks (`turnStarted`, `battleResolved`, `conquered`,
 * `factionKnockedOut`, `missileFired`, `redStarTokenGained`) and the scar-played chat card, kept in memory, and
 * rebuilt from the chat messages after a reload (battles, missiles, conquests, HQ captures, knock-outs and scars can be
 * read back from their cards; Red Star purchases can't). Everything here is public: what any player at the table saw.
 * Events are stored by faction id; text uses faction names ("you" for the faction asking), never player names.
 */
import { SYSTEM_ID } from "../../config.mjs";
import { RL, getWar, snapshot, territoryName } from "./util.mjs";

const LIMIT = 800;
/** @type {{seq:number, round:number, type:string, by:string|null, against:string|null, territory?:string, from?:string, data?:object}[]} */
let events = [];
let seq = 0;
let warKey = null;
/** Faction id → the event seq at each of its turn starts (last two). */
const turnStarts = new Map();
/** Battle messages already recorded (battleResolved can fire again for the same card). */
const seen = new Set();
/** Territory id → scar id, to find where a newly played scar went. */
let knownScars = null;

const scarMap = () => {
  const out = {};
  for ( const [id, t] of Object.entries(RL()?.state?.getCampaign?.()?.system.territories ?? {}) ) if ( t?.scar ) out[id] = t.scar;
  return out;
};

/** Start over when the war changes. */
function ensureWar(war = getWar()) {
  const id = war?.id ?? "";
  if ( id === warKey ) return id;
  warKey = id;
  events = [];
  seen.clear();
  turnStarts.clear();
  try {
    knownScars = scarMap();
  } catch(err) {
    knownScars = {};
  }
  return id;
}

function push(event) {
  ensureWar();
  events.push({ seq: ++seq, round: getWar()?.round ?? 0, by: null, against: null, ...event });
  if ( events.length > LIMIT ) events.splice(0, events.length - LIMIT);
}

function markTurn(fid) {
  if ( !fid ) return;
  ensureWar();
  const list = turnStarts.get(fid) ?? [];
  list.push(seq);
  turnStarts.set(fid, list.slice(-2));
}

const starsOf = fid => {
  try {
    return snapshot()?.factions?.[fid]?.redStars?.total ?? null;
  } catch(err) {
    return null;
  }
};

/* -------------------------------------------- */
/*  Recording                                   */
/* -------------------------------------------- */

/** One resolved battle card → a battle event (+ its missiles). */
function recordBattle(message, { withMissiles = false } = {}) {
  if ( (message?.type !== "battle") || seen.has(message.id) ) return;
  const sys = message.system;
  if ( sys.status !== "resolved" ) return;
  seen.add(message.id);
  const rounds = sys.blitz?.active ? (sys.blitz.rounds ?? []) : [];
  const attackerLosses = rounds.length ? rounds.reduce((s, r) => s + (r.attackerLosses ?? 0), 0) : (sys.result?.attackerLosses ?? 0);
  const defenderLosses = rounds.length ? rounds.reduce((s, r) => s + (r.defenderLosses ?? 0), 0) : (sys.result?.defenderLosses ?? 0);
  if ( withMissiles ) for ( const m of sys.missiles ?? [] ) recordMissile(sys, m);
  push({
    type: "battle", by: sys.attacker || null, against: sys.defender || null, from: sys.from, territory: sys.to,
    data: { attackerLosses, defenderLosses, rolls: Math.max(1, rounds.length), conquered: !!sys.result?.conquered, message: message.id }
  });
}

function recordMissile(sys, m) {
  if ( !m ) return;
  const against = m.side === "attack" ? sys.defender : sys.attacker;
  push({ type: "missile", by: m.by || null, against: against || null, from: sys.from, territory: sys.to, data: { side: m.side } });
}

function recordScarCard(message) {
  const by = message.speaker?.actor ?? null;
  let territory = null;
  let scar = null;
  try {
    const now = scarMap();
    for ( const [id, s] of Object.entries(now) ) {
      if ( knownScars?.[id] !== s ) {
        territory = id;
        scar = s;
        break;
      }
    }
    knownScars = now;
  } catch(err) { /* keep the text only */ }
  push({ type: "scar", by, against: null, territory, data: { scar, text: cardResultText(message) } });
}

/** The result line of a card chat message, as plain text ("Khan Industries played Bunker on Ukraine"). */
function cardResultText(message) {
  const div = globalThis.document?.createElement?.("div");
  if ( !div ) return "";
  div.innerHTML = message.content ?? "";
  const el = div.querySelector(".rl-chat-card__result") ?? div;
  return (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Hooks (GM client). */
export function registerRecentHooks() {
  const gm = () => !!game.user?.isGM;
  Hooks.on("risklegacy.turnStarted", (war, actor) => {
    if ( gm() ) markTurn(actor?.id ?? war?.system?.turn?.faction ?? null);
  });
  Hooks.on("risklegacy.battleResolved", message => {
    if ( gm() ) recordBattle(message);
  });
  Hooks.on("risklegacy.missileFired", (message, count, actor) => {
    if ( !gm() || (message?.type !== "battle") ) return;
    const list = message.system.missiles ?? [];
    const m = list[Math.max(0, (Number(count) || list.length) - 1)] ?? list.at(-1);
    recordMissile(message.system, m ? { ...m, by: m.by || actor?.id } : { by: actor?.id, side: "attack" });
  });
  Hooks.on("risklegacy.conquered", (actor, to, loser) => {
    if ( !gm() ) return;
    const hq = snapshot()?.territories?.[to]?.hq ?? null;
    push({ type: "conquest", by: actor?.id ?? null, against: loser?.id ?? null, territory: to });
    if ( hq && (hq !== actor?.id) ) push({ type: "hqCaptured", by: actor?.id ?? null, against: hq, territory: to, data: { stars: starsOf(actor?.id) } });
  });
  Hooks.on("risklegacy.factionKnockedOut", (loser, by) => {
    if ( gm() ) push({ type: "knockedOut", by: by?.id ?? null, against: loser?.id ?? null });
  });
  Hooks.on("risklegacy.redStarTokenGained", (actor, stars, source) => {
    if ( gm() ) push({ type: "redStar", by: actor?.id ?? null, data: { source: String(source ?? ""), count: Number(stars) || 1, stars: starsOf(actor?.id) } });
  });
  Hooks.on("risklegacy.warCreated", war => {
    if ( gm() ) ensureWar(war);
  });
  Hooks.on("createChatMessage", message => {
    if ( gm() && (message?.flags?.[SYSTEM_ID]?.cards?.kind === "scarPlayed") ) recordScarCard(message);
  });
}

/** After a reload: rebuild this war's events from its chat cards. */
export function rebuildRecent() {
  const war = getWar();
  if ( !war ) return 0;
  warKey = null;
  ensureWar(war);
  const since = war._stats?.createdTime ?? 0;
  const messages = game.messages.contents.filter(m => (m.timestamp ?? 0) >= since).sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  const starts = Object.fromEntries((war.turns ?? []).map(c => [c.actor?.id, c.actor?.system.war?.startingTerritory]).filter(([k]) => k));
  const lastConqueror = {};
  for ( const m of messages ) {
    const f = m.flags?.[SYSTEM_ID] ?? {};
    if ( (f.turn === "turnStarted") && f.faction ) markTurn(f.faction);
    else if ( m.type === "battle" ) {
      if ( m.system.status !== "resolved" ) continue;
      recordBattle(m, { withMissiles: true });
      if ( m.system.result?.conquered ) {
        const { attacker, defender, to } = m.system;
        push({ type: "conquest", by: attacker, against: defender, territory: to });
        lastConqueror[defender] = attacker;
        if ( defender && (starts[defender] === to) ) push({ type: "hqCaptured", by: attacker, against: defender, territory: to });
      }
    }
    else if ( (f.turn === "knockedOut") && f.faction ) push({ type: "knockedOut", by: lastConqueror[f.faction] ?? null, against: f.faction });
    else if ( f.cards?.kind === "scarPlayed" ) push({ type: "scar", by: m.speaker?.actor ?? null, data: { text: cardResultText(m) } });
  }
  try {
    knownScars = scarMap();
  } catch(err) { /* ignore */ }
  return events.length;
}

/* -------------------------------------------- */
/*  Reading                                     */
/* -------------------------------------------- */

const SOURCES = { purchase: "bought with cards", event: "from an event", mission: "from a mission" };

/**
 * Turn one faction's relevant events into lines, newest last. The rolls of one attack (same attacker, route and round,
 * with no other battle in between) become one line.
 * @param {string} fid
 * @param {object[]} list
 * @param {object} state  snapshot (names, adjacency)
 * @param {{own?: boolean}} [options]  own = also the faction's own notable acts (debrief)
 */
function lines(fid, list, state, { own = false } = {}) {
  const name = id => (id === fid ? "you" : (state?.factions?.[id]?.name ?? game.actors.get(id)?.name ?? "someone"));
  const Name = id => {
    const n = name(id);
    return n.charAt(0).toUpperCase() + n.slice(1);
  };
  const tn = id => (id ? territoryName(id) : "");
  const mine = new Set(state?.factions?.[fid]?.territories ?? []);
  const near = id => !!id && (mine.has(id) || (state?.territories?.[id]?.neighbors ?? []).some(n => mine.has(n)));
  const out = [];
  let open = null; // the battle line being merged
  for ( const e of list ) {
    if ( e.type === "battle" ) {
      const against = e.against === fid;
      const by = e.by === fid;
      if ( !against && !(own && by) ) continue;
      const key = `${e.by}|${e.from}|${e.territory}|${e.round}`;
      if ( open?.key === key ) {
        open.a += e.data.attackerLosses;
        open.d += e.data.defenderLosses;
        open.rolls += e.data.rolls;
        open.fell ||= e.data.conquered;
        continue;
      }
      open = { key, line: { type: "battle", by: e.by, against: e.against, territory: e.territory, from: e.from, round: e.round }, a: e.data.attackerLosses, d: e.data.defenderLosses, rolls: e.data.rolls, fell: e.data.conquered };
      out.push(open);
      continue;
    }
    if ( e.type === "conquest" ) {
      // A conquest after the battle that took it is already in that battle's line.
      const b = open && (open.line.by === e.by) && (open.line.territory === e.territory);
      if ( b ) {
        open.fell = true;
        continue;
      }
      if ( (e.against === fid) && e.against ) out.push({ text: `${Name(e.by)} took ${tn(e.territory)} from you.`, e });
      continue;
    }
    // Other events (a missile on a roll, a Red Star...) don't end an attack: its next rolls still merge into its line.
    switch ( e.type ) {
      case "hqCaptured":
        if ( e.by === fid ) {
          if ( own ) out.push({ text: `You captured ${name(e.against)}'s HQ in ${tn(e.territory)}.`, e });
        }
        else out.push({ text: e.against === fid ? `${Name(e.by)} captured your HQ in ${tn(e.territory)}.` : `${Name(e.by)} captured ${name(e.against)}'s HQ in ${tn(e.territory)}.`, e });
        break;
      case "knockedOut":
        if ( e.by === fid ) {
          if ( own ) out.push({ text: `You knocked out ${name(e.against)}.`, e });
        }
        else out.push({ text: e.against === fid ? `${e.by ? Name(e.by) : "Someone"} knocked you out.` : `${e.by ? Name(e.by) : "Someone"} knocked out ${name(e.against)}.`, e });
        break;
      case "missile":
        if ( e.against === fid ) out.push({ text: `${Name(e.by)} fired a missile against you (the battle for ${tn(e.territory)}).`, e });
        else if ( own && (e.by === fid) ) out.push({ text: `You fired a missile against ${name(e.against)} (the battle for ${tn(e.territory)}).`, e });
        break;
      case "scar": {
        if ( e.by === fid ) {
          if ( own ) out.push({ text: e.territory ? `You played the ${scarName(e.data?.scar)} scar on ${tn(e.territory)}.` : (e.data?.text || "You played a scar card."), e });
          break;
        }
        if ( e.territory ) {
          if ( near(e.territory) ) out.push({ text: `${Name(e.by)} played the ${scarName(e.data?.scar)} scar on ${tn(e.territory)} (${mine.has(e.territory) ? "your territory" : "next to you"}).`, e });
        }
        else if ( e.data?.text ) out.push({ text: e.data.text, e });
        break;
      }
      case "redStar":
        if ( e.by !== fid ) out.push({ text: `${Name(e.by)} gained a Red Star (${SOURCES[e.data?.source] ?? e.data?.source ?? "token"})${e.data?.stars ? `: now ${e.data.stars} of 4` : ""}.`, e });
        break;
      default:
        break;
    }
  }
  const TYPES = { conquest: "conquered" };
  return out.map(x => {
    if ( x.text ) {
      const e = x.e;
      return {
        type: TYPES[e.type] ?? e.type, by: e.by ? name(e.by) : null, against: e.against ? name(e.against) : null,
        toMe: e.against === fid, text: x.text, round: e.round
      };
    }
    const l = x.line;
    const text = l.against === fid
      ? `${Name(l.by)} attacked your ${tn(l.territory)} from ${tn(l.from)}${x.rolls > 1 ? ` (${x.rolls} rolls)` : ""}: you lost ${x.d}, they lost ${x.a}; ${x.fell ? `${tn(l.territory)} fell` : `you held ${tn(l.territory)}`}.`
      : `You attacked ${name(l.against)}'s ${tn(l.territory)} from ${tn(l.from)}${x.rolls > 1 ? ` (${x.rolls} rolls)` : ""}: you lost ${x.a}, they lost ${x.d}${x.fell ? `; you took ${tn(l.territory)}` : ""}.`;
    return { type: "battle", by: name(l.by), against: name(l.against), toMe: l.against === fid, text, round: l.round };
  });
}

const scarName = id => (id ? (RL()?.state?.findEntry?.("scars", id)?.name ?? id) : "a");

/**
 * Public events since this faction's last turn started (during its own turn: since the turn before), newest last.
 * @param {string|null} fid
 * @param {object} state    snapshot
 * @param {{limit?: number}} [options]
 * @returns {{type:string, by:string|null, against:string|null, toMe:boolean, text:string, round:number}[]}  `by` and
 *   `against` are faction names ("you" for this faction); `toMe` = the event was against this faction
 */
export function recentFor(fid, state, { limit = 12 } = {}) {
  if ( !fid ) return [];
  const war = getWar();
  if ( !war || (warKey !== (war.id ?? "")) ) return [];
  const starts = turnStarts.get(fid) ?? [];
  const ownTurn = state?.turn?.faction === fid;
  const since = ownTurn ? (starts.length >= 2 ? starts[starts.length - 2] : 0) : (starts.at(-1) ?? 0);
  return lines(fid, events.filter(e => e.seq > since), state).slice(-limit);
}

/**
 * The whole war from one faction's side, for its debrief: lines against it and its own notable acts, plus counts.
 * @param {string} fid
 * @param {object} state
 */
export function warAccount(fid, state) {
  const all = lines(fid, events, state, { own: true });
  const count = (type, test) => events.filter(e => (e.type === type) && test(e)).length;
  return {
    against: all.filter(l => !/^You /.test(l.text)).slice(-10).map(l => l.text),
    by: all.filter(l => /^You /.test(l.text) && !/^You attacked/.test(l.text)).slice(-8).map(l => l.text),
    counts: {
      battlesFought: count("battle", e => e.by === fid),
      timesAttacked: count("battle", e => e.against === fid),
      conquests: count("conquest", e => e.by === fid),
      territoriesLost: count("conquest", e => e.against === fid),
      hqsCaptured: count("hqCaptured", e => e.by === fid),
      ownHqLost: count("hqCaptured", e => e.against === fid),
      knockouts: count("knockedOut", e => e.by === fid),
      knockedOut: count("knockedOut", e => e.against === fid),
      missilesFired: count("missile", e => e.by === fid),
      missilesAgainst: count("missile", e => e.against === fid)
    },
    /** Faction id → times it attacked this faction (who hit it hardest). */
    attackers: events.filter(e => (e.type === "battle") && (e.against === fid) && e.by).reduce((m, e) => ({ ...m, [e.by]: (m[e.by] ?? 0) + 1 }), {})
  };
}

/** Test/debug view of the raw events. */
export const recentEvents = () => events.map(e => ({ ...e }));
