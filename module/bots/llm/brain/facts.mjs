/**
 * Board, campaign and memory facts for the prompts, limited by the level (BOTS-LLM.md §6.3):
 *  - easy ("self"): its own territories that touch others and their neighbours, its HQ, everyone's Red Star count;
 *  - normal ("standings"): + every faction's stars, troops, territories, continents and HQs; threats to its HQ; a
 *    one-line campaign standing; its grudges;
 *  - hard ("full"): + hand counts and coins, recruits, missiles, powers, the mission, events, `view.recent` and the
 *    campaign facts (`view.campaign`).
 * Every number is computed here; prompts.mjs words it. No player names: seats come from `view.seats` (bots by their
 * personality name, people as "a human player").
 */
import * as rules from "../../../rules/_module.mjs";
import { hqDanger, standings } from "../../brain/features.mjs";
import { continentName, factionName, territoryName } from "../../brain/util.mjs";
import { playerLabel } from "../prompts.mjs";
import { knobsOf } from "../profiles.mjs";
import { gameOf } from "./call.mjs";

const CAP_ITEM = 140;
const clip = (s, n = CAP_ITEM) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trim()}…` : t;
};

/** A readable line from a string or a small object ({text|label|name|...}). */
export function textOf(x) {
  if ( x === null || x === undefined ) return "";
  if ( typeof x === "string" || typeof x === "number" ) return clip(x);
  if ( Array.isArray(x) ) return clip(x.map(textOf).filter(Boolean).join(", "));
  if ( typeof x === "object" ) {
    for ( const k of ["text", "summary", "label", "name"] ) if ( typeof x[k] === "string" && x[k] ) return clip(x[k]);
    const prims = Object.entries(x).filter(([k, v]) => !/user|player|id$/i.test(k) && ["string", "number", "boolean"].includes(typeof v));
    return clip(prims.map(([k, v]) => `${k} ${v}`).join(", "));
  }
  return "";
}

/** The seat behind a faction (view.seats), or null. */
export const seatOf = (ctx, fid) => ctx.view?.seats?.[fid] ?? null;

/** Faction id from an id or a display name (view.recent uses names). */
export function factionIdOf(ctx, ref) {
  if ( !ref ) return null;
  if ( ctx.state?.factions?.[ref] ) return ref;
  const names = ctx.view?.factionNames ?? {};
  for ( const [id, name] of Object.entries(names) ) if ( name === ref ) return id;
  for ( const f of Object.values(ctx.state?.factions ?? {}) ) if ( f.name === ref ) return f.id;
  return null;
}

/** Public events since this faction's last turn (view.recent), as text lines (at most 8). */
export function recentLines(ctx) {
  const r = ctx.view?.recent;
  if ( !Array.isArray(r) ) return [];
  return r.slice(-8).map(e => textOf(e)).filter(Boolean);
}

/** Factions that attacked this bot (or fired a missile at it, took its land or HQ) since its last turn. */
export function attackersOfMe(ctx) {
  const out = new Set();
  for ( const e of Array.isArray(ctx.view?.recent) ? ctx.view.recent : [] ) {
    if ( !e || typeof e !== "object" ) continue;
    if ( !/battle|attack|conquer|lost|hq|missile|knock/i.test(String(e.type ?? "")) ) continue;
    if ( e.toMe === false ) continue;  // the driver marks events against this faction (driver/recent.mjs)
    const fid = factionIdOf(ctx, e.by);
    if ( fid && fid !== ctx.me ) out.add(fid);
  }
  return out;
}

/** Whether something big hit the bot since its last turn (an HQ lost, a knock-out): a key moment for table talk. */
export function bigHitSinceLastTurn(ctx) {
  return (Array.isArray(ctx.view?.recent) ? ctx.view.recent : [])
    .some(e => (e?.toMe !== false) && /hq|knock/i.test(String(e?.type ?? "")));
}

/* -------------------------------------------- */
/*  Campaign                                    */
/* -------------------------------------------- */

/** "the player of Khan Industries" / "you" / a bot's name, for a user id in this war. */
function userLabel(ctx, userId) {
  if ( !userId ) return null;
  if ( userId === ctx.bot?.userId ) return "you";
  for ( const [fid, seat] of Object.entries(ctx.view?.seats ?? {}) ) {
    if ( seat?.user === userId ) return fid === ctx.me ? "you" : playerLabel(factionName(ctx, fid), seat);
  }
  return null;
}

/**
 * Campaign facts for the prompts. "short" (normal): one line with the game number and the win counts; "full" (hard):
 * past winners, wins per seat, this faction's history and powers, scars, cities, named continents, packs and what
 * the end of this game hands out. Degrades to nothing when `view.campaign` is absent.
 */
export function campaignFacts(ctx, depth) {
  const c = ctx.view?.campaign;
  if ( !depth ) return null;
  const game = c?.game ?? gameOf(ctx) ?? null;
  const total = c?.totalGames ?? null;
  const winsList = [];
  if ( c?.wins && typeof c.wins === "object" ) {
    for ( const [user, n] of Object.entries(c.wins) ) {
      const label = userLabel(ctx, user);
      if ( label && Number(n) > 0 ) winsList.push({ label, n: Number(n) });
    }
  }
  winsList.sort((a, b) => b.n - a.n);
  if ( depth === "short" ) {
    if ( !c && !game ) return null;
    const mine = winsList.find(w => w.label === "you")?.n ?? 0;
    const others = winsList.filter(w => w.label !== "you").slice(0, 3).map(w => `${w.label} ${w.n}`);
    const bits = [game ? `game ${game}${total ? ` of ${total}` : ""}` : null, c?.wins ? `you have won ${mine} ${mine === 1 ? "game" : "games"}` : null];
    if ( others.length ) bits.push(`others: ${others.join(", ")}`);
    const line = bits.filter(Boolean).join("; ");
    return line ? { short: `${line}.` } : null;
  }
  if ( !c ) return game ? { game, totalGames: total } : null;
  const arr = (x, n = 8) => (Array.isArray(x) ? x.slice(0, n).map(textOf).filter(Boolean) : []);
  const victors = Array.isArray(c.victors) ? c.victors.slice(-8).map(v => {
    const name = v.factionName ?? (ctx.view?.factionNames?.[v.faction] ?? v.faction ?? "?");
    return `game ${v.game}: ${name}${v.wasMe ? " (you)" : ""}`;
  }) : [];
  return {
    game, totalGames: total, victors,
    wins: winsList.map(w => `${w.label} ${w.n}`),
    history: arr(c.history ?? c.factionHistory),
    powers: arr(c.powers),
    scars: arr(c.scars, 10),
    cities: arr(c.cities, 10),
    continents: arr(c.namedContinents ?? c.continents),
    packs: arr(c.packs ?? c.openedPacks),
    rewards: arr(c.rewards ?? c.endOfGame ?? c.stakes, 4)
  };
}

/** Grudges from memory about players seated in this war (normal and hard), unless the personality shrugs them off. */
export function grudgeFacts(ctx, profile) {
  if ( profile.memory === "none" || knobsOf(ctx).vengeance < 0.2 ) return [];
  const g = ctx.bot?.memory?.grudges;
  if ( !Array.isArray(g) || !g.length ) return [];
  const out = [];
  for ( const x of g ) {
    if ( !x?.user || !x.text ) continue;
    for ( const [fid, seat] of Object.entries(ctx.view?.seats ?? {}) ) {
      if ( fid === ctx.me || seat?.user !== x.user ) continue;
      out.push({ who: playerLabel(factionName(ctx, fid), seat), text: clip(x.text, 120) });
    }
  }
  return out.slice(0, 4);
}

/* -------------------------------------------- */
/*  The board                                   */
/* -------------------------------------------- */

const poss = n => (/s$/i.test(n) ? `${n}'` : `${n}'s`);

/**
 * Board facts for a turn message, per level.
 * @param {object} ctx
 * @param {object} profile            LLM profile
 * @param {object} [opts]
 * @param {"turn"|"attack"|"end"|"option"} [opts.detail]
 * @returns {object} see prompts.boardText
 */
export function boardFacts(ctx, profile, { detail = "turn" } = {}) {
  const { state, me } = ctx;
  const list = standings(ctx);
  const mine = list.find(s => s.id === me);
  const b = {
    odds: profile.odds,
    game: gameOf(ctx) || null,
    round: ctx.view?.round ?? null,
    me: { name: factionName(ctx, me), stars: mine?.stars ?? rules.redStarTotal(state, me) },
    stars: list.map(s => ({ name: s.name, stars: s.stars, me: s.id === me, seat: s.id === me ? null : seatOf(ctx, s.id) }))
  };
  const full = profile.context === "full";

  // HQs the bot holds (own and captured); threats from normal up.
  const dangers = detail === "final" ? [] : hqDanger(ctx, me, { withCards: full, depth: full ? 2 : 1 });
  if ( detail !== "final" ) b.hqs = dangers.map(d => ({
    name: territoryName(state, d.territory), troops: d.defenders, own: d.own, fortified: d.fortified, reach: full ? 2 : 1,
    ...(profile.context === "self" ? {} : {
      threats: d.threats.filter(t => t.p >= 0.05).slice(0, 2).map(t => ({
        faction: factionName(ctx, t.faction), from: territoryName(state, t.from), via: t.via ? territoryName(state, t.via) : null,
        attackers: t.attackers, p: t.p
      }))
    })
  }));

  if ( profile.context === "self" ) {
    if ( detail === "turn" ) {
      const owned = state.factions?.[me]?.territories ?? [];
      const rows = [];
      for ( const id of owned ) {
        const t = state.territories[id];
        const neighbours = (t.neighbors ?? []).map(n => state.territories[n]).filter(n => n && n.owner !== me)
          .map(n => ({ name: n.name, owner: n.owner ? factionName(ctx, n.owner) : null, troops: n.troops }));
        if ( !neighbours.length ) continue;
        rows.push({ name: t.name, troops: t.troops, hq: !!t.hq && t.owner === me, neighbours, weight: neighbours.reduce((s, n) => s + (n.owner ? 2 : 1), 0) + (t.hq ? 5 : 0) });
      }
      rows.sort((a, b2) => b2.weight - a.weight);
      b.borders = rows.slice(0, 8);
      b.bordersMore = Math.max(0, rows.length - 8);
    }
  }
  else {
    b.factions = list.map(s => {
      const f = {
        name: s.name, me: s.id === me, seat: s.id === me ? null : seatOf(ctx, s.id), stars: s.stars, troops: s.troops,
        territories: s.territories, status: s.status,
        continents: s.continents.map(c => ({ name: continentName(state, c), value: state.continents[c]?.value ?? 0 })),
        hqs: s.hqs.map(id => {
          const owner = state.territories[id]?.hq;
          return owner === s.id ? `own in ${territoryName(state, id)}` : `${poss(factionName(ctx, owner))} in ${territoryName(state, id)}`;
        })
      };
      if ( full && detail !== "final" ) {
        const buyable = Math.min(s.buyableNext, s.toWin);
        // The bot's own cards have their own line (and the card menu); "next turn" is about rivals.
        if ( s.id !== me ) {
          f.hand = {
            count: s.hand.count, coins: s.hand.coins,
            canBuy: buyable > 0 ? (s.stars + buyable >= 4 ? "can buy enough Red Stars next turn to win" : "can buy a Red Star next turn") : ""
          };
        }
        if ( s.id !== me ) {
          f.recruit = s.recruit;
          if ( s.hqCapture && s.hqCapture.p >= 0.1 ) {
            f.hqAttack = { target: `${poss(factionName(ctx, s.hqCapture.owner))} HQ in ${territoryName(state, s.hqCapture.territory)}`, p: s.hqCapture.p };
          }
        }
        if ( s.missiles ) f.missiles = s.missiles;
        const powers = ctx.view?.powers?.[s.id];
        if ( detail === "turn" && powers?.length ) f.powers = powers.slice(0, 4).map(p => clip(p.text || p.name, 110)).filter(Boolean);
      }
      return f;
    });
  }

  if ( detail === "turn" || detail === "end" ) {
    const hand = ctx.view?.hand ?? [];
    b.cards = { count: hand.length, coins: hand.reduce((n, c) => n + (c.coins ?? 1), 0) };
  }
  if ( full && (detail === "turn" || detail === "attack") ) {
    const m = ctx.view?.mission;
    if ( m?.name ) {
      const st = ctx.view?.missionStatus;
      b.mission = {
        name: m.name, text: clip(m.text, 200), reward: m.reward ? `${m.reward} Red Star${String(m.reward) === "1" ? "" : "s"}` : "a Red Star",
        status: st?.status === "complete" ? "you meet it now" : (st?.status === "incomplete" ? "you don't meet it yet" : "")
      };
    }
    const ev = ctx.view?.activeEvents ?? [];
    if ( ev.length ) b.events = ev.slice(0, 4).map(e => ({ name: e.name, text: clip(e.text, 140) }));
    if ( detail === "turn" ) b.recent = recentLines(ctx);
  }
  if ( detail === "turn" ) {
    b.grudges = grudgeFacts(ctx, profile);
    b.campaign = campaignFacts(ctx, profile.campaign);
  }
  return b;
}
