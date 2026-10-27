/**
 * Reactive decisions (BOTS-LLM.md §6.2): calls only when code finds a real choice.
 *  - missileDecision / preRollScar: the Jev brain's maths as the pre-filter (no call when the swing is small, the
 *    battle trivial or the bot doesn't care which way it goes); a battle that decides the war is code's call.
 *  - chooseOption, chooseStartingTerritory: a call whenever there are two or more options; hard bots get the campaign
 *    context for choices with campaign effect.
 *  - chooseDefenseDice and pickName: code only.
 */
import * as rules from "../../../rules/_module.mjs";
import * as jev from "../../brain/index.mjs";
import { optionFacts } from "../../brain/context.mjs";
import { codeStakes } from "../../brain/decide/battle.mjs";
import { codeLeader, standings, takeEffects } from "../../brain/features.mjs";
import { battleOdds, battleSetup, missileOptions } from "../../brain/odds.mjs";
import { takeFacts } from "../../brain/context.mjs";
import { factionName, round, slug, territoryName, uniqueSlugs, why } from "../../brain/util.mjs";
import {
  FACTS, choiceSchema, missileMessage, optionMessage, preRollScarMessage, startMessage
} from "../prompts.mjs";
import { llmProfileOf } from "../profiles.mjs";
import { askModel, gameOf, gateSay, invalid, isHeuristic, memoOf, personalityOf, withPending } from "./call.mjs";
import { boardFacts, campaignFacts } from "./facts.mjs";
import { startMenu } from "./menus.mjs";

const H = ctx => ({ ...ctx, ask: null });
const pick = (keys, value, what = "choice") => (keys.includes(value) ? value : invalid(`"${what}" must be one of ${keys.join(", ")}`));

/** Defender dice: the Jev brain's exact odds (code only). */
export async function chooseDefenseDice(ctx, args = {}) {
  return jev.chooseDefenseDice(ctx, args);
}

/** Who leads (the turn's situation, else the code ranking). */
function leaderOf(ctx) {
  const sit = ctx.situation ?? memoOf(ctx).situation ?? null;
  return sit?.leader ?? codeLeader(standings(ctx)).leader;
}

const roleText = role => (role === "attacker" ? FACTS.rolesAttacker : (role === "defender" ? FACTS.rolesDefender : FACTS.rolesBystander));

/** Battle facts shared by the missile and scar prompts. */
function battleText(ctx, battle, fx) {
  const { state } = ctx;
  const dieValues = dice => (dice ?? []).map(d => d.value ?? d.natural);
  return {
    attacker: factionName(ctx, battle.attacker), defender: factionName(ctx, battle.defender),
    fromName: territoryName(state, battle.from), toName: territoryName(state, battle.to),
    attackers: battle.troops?.attacker ?? state.territories[battle.from]?.troops ?? 0,
    defenders: battle.troops?.defender ?? state.territories[battle.to]?.troops ?? 0,
    attack: dieValues(battle.attack), defend: dieValues(battle.defend),
    consequences: takeFacts(ctx, fx, battle.attacker)
  };
}

/* -------------------------------------------- */
/*  Missiles                                    */
/* -------------------------------------------- */

/** After the roll: fire one missile, or not. Called again after each missile while the battle is open. */
export async function missileDecision(ctx, { battle } = {}) {
  if ( isHeuristic(ctx) ) return jev.missileDecision(H(ctx), { battle });
  const { state, me } = ctx;
  const missiles = state.factions[me]?.missiles ?? 0;
  const hold = (data = {}) => ({ fire: false, why: why("missileHold", data) });
  if ( !battle || missiles <= 0 ) return hold();
  const mo = missileOptions(state, battle, { lookup: ctx.lookup, activeEvents: ctx.view?.activeEvents?.map(e => e.id) });
  if ( !mo.options.length ) return hold();
  const fx = takeEffects(ctx, battle.from, battle.to, { who: battle.attacker });
  const leader = leaderOf(ctx);
  const role = battle.attacker === me ? "attacker" : (battle.defender === me ? "defender" : "bystander");

  // Which way the bot wants the battle to go (+1: the attacker takes it; −1: the defender holds): the Jev brain's rule.
  let want = 0;
  if ( role === "attacker" ) want = 1;
  else if ( role === "defender" ) want = -1;
  else if ( fx.winNow || battle.attacker === leader || (fx.hq && fx.starsAfter >= 3) ) want = -1;
  else if ( battle.defender === leader && rules.redStarTotal(state, leader) >= 3 && (fx.hq || fx.breaks.some(b => b.faction === leader)) ) want = 1;
  if ( !want ) return hold();
  const side = want > 0 ? "attack" : "defend";
  const sideOpts = mo.options.filter(o => o.side === side).sort((a, b) => want * (b.pConquer - a.pConquer));
  if ( !sideOpts.length ) return hold();
  const best = sideOpts[0];
  const swing = want * (best.pConquer - mo.base.pConquer);
  const base = { chance: round(mo.base.pConquer, 2), territory: battle.to };
  if ( swing <= 0.05 ) return hold(base);
  const t = state.territories[battle.to];
  const fireDecision = (o, extra = {}) => {
    let reason = "missileSwing";
    if ( role === "attacker" && (fx.winNow || fx.hq) ) reason = "missileWin";
    else if ( role === "defender" && t?.hq && t.owner === me ) reason = "missileSaveHq";
    else if ( role === "bystander" ) reason = "missileStopLeader";
    return {
      fire: true, side: o.side, index: o.index,
      why: why(reason, { chance: round(o.pConquer, 2), territory: battle.to, faction: role === "attacker" ? battle.defender : battle.attacker, label: `swing ${Math.round(swing * 100)} points`, ...extra })
    };
  };
  // Code rule: a battle that decides the war (the bot wins it, or someone else would) is always fought with missiles.
  if ( fx.winNow && ((want > 0 && battle.attacker === me) || (want < 0 && battle.attacker !== me)) ) return fireDecision(best);
  if ( codeStakes(ctx, battle, fx) < 1.5 ) return hold(base);

  const memo = memoOf(ctx);
  const dice = [...(battle.attack ?? []), ...(battle.defend ?? [])].map(d => `${d.natural}${d.missile ? "m" : ""}`).join(",");
  const cacheKey = `missile|${battle.id ?? `${battle.from}>${battle.to}`}|${dice}|${missiles}`;
  if ( memo.reactive.has(cacheKey) ) return memo.reactive.get(cacheKey);

  const seen = new Set();
  const dieOf = o => (side === "attack" ? battle.attack : battle.defend).find(d => d.slot === o.index);
  const fires = sideOpts.slice(0, 2).filter(o => {
    const v = dieOf(o)?.value ?? dieOf(o)?.natural;
    if ( seen.has(v) ) return false;
    seen.add(v);
    return true;
  }).map(o => ({ key: `fire_${side === "attack" ? "attack" : "defence"}_die_${o.index + 1}`, o, p: o.pConquer, text: FACTS.missileFire(side, dieOf(o)?.value ?? dieOf(o)?.natural) }));
  const options = [{ key: "hold", p: mo.base.pConquer, text: FACTS.missileHold }, ...fires];
  const keys = options.map(o => o.key);
  const res = await askModel(ctx, {
    purpose: "missile",
    user: missileMessage({ battle: battleText(ctx, battle, fx), me: factionName(ctx, me), role: roleText(role), missiles, options, odds: llmProfileOf(ctx).odds, key: true }),
    schema: choiceSchema("missile", keys),
    validate: p => pick(keys, p.choice)
  });
  const chosen = options.find(o => o.key === res.value);
  const out = chosen.o ? fireDecision(chosen.o, { thinking: res.thinking }) : hold({ ...base, thinking: res.thinking });
  const say = gateSay(ctx, res.say, { key: !!chosen.o });
  if ( say ) out.say = say;
  memo.reactive.set(cacheKey, out);
  return out;
}

/* -------------------------------------------- */
/*  Pre-roll scar cards                         */
/* -------------------------------------------- */

/** Before the roll: play a Bunker or an Ammo Shortage on the defending territory? Null to keep the cards. */
export async function preRollScar(ctx, { battle, cards = [] } = {}) {
  if ( isHeuristic(ctx) ) return jev.preRollScar(H(ctx), { battle, cards });
  if ( !battle || !cards.length ) return null;
  const { state, me } = ctx;
  const t = state.territories[battle.to];
  if ( !t || t.scar ) return null;
  const setup = battleSetup(state, battle, ctx.lookup);
  if ( (setup.rules.unmodifiable ?? []).includes("defend") ) return null;
  const A = state.territories[battle.from]?.troops ?? 0;
  const odds = extra => battleOdds({ A, D: t.troops, ...setup, sources: extra ? [...setup.sources, extra] : setup.sources }).pConquer;
  const base = odds(null);
  const fx = takeEffects(ctx, battle.from, battle.to, { who: battle.attacker });
  const leader = leaderOf(ctx);
  const role = battle.attacker === me ? "attacker" : (battle.defender === me ? "defender" : "bystander");
  const bunker = cards.find(c => String(c.scar).toLowerCase() === "bunker");
  const ammo = cards.find(c => String(c.scar).toLowerCase() === "ammo_shortage");

  // Pre-filter (the Jev brain's rules): the card must help the side the bot wants, by at least 5 points.
  let card = null;
  let p = base;
  if ( bunker && (role === "defender" || (role === "bystander" && (battle.attacker === leader || fx.winNow || (fx.hq && fx.starsAfter >= 3)))) ) {
    p = odds({ source: "bunker", side: "defend", die: "highest", delta: 1 });
    if ( base - p >= 0.05 ) card = bunker;
  }
  if ( !card && ammo && (role === "attacker" || (role === "bystander" && battle.defender === leader && (fx.hq || fx.breaks.some(b => b.faction === leader)))) ) {
    p = odds({ source: "ammo_shortage", side: "defend", die: "highest", delta: -1 });
    if ( p - base >= 0.05 ) card = ammo;
  }
  if ( !card ) return null;
  if ( codeStakes(ctx, battle, fx) < 1.5 && !(role === "defender" && t.hq && t.owner === me) ) return null;

  const memo = memoOf(ctx);
  const cacheKey = `scar|${battle.id ?? `${battle.from}>${battle.to}`}|${card.id}`;
  if ( memo.reactive.has(cacheKey) ) return memo.reactive.get(cacheKey);
  const playKey = slug(`play_${card.name || card.scar}_on_${battle.to}`);
  const options = [
    { key: "keep_card", p: base, text: FACTS.scarHold },
    { key: playKey, p, text: FACTS.scarPlay(card.name || card.scar, t.name) }
  ];
  const keys = options.map(o => o.key);
  const res = await askModel(ctx, {
    purpose: "scar card",
    user: preRollScarMessage({ battle: battleText(ctx, battle, fx), me: factionName(ctx, me), role: roleText(role), card: { name: card.name || card.scar, text: card.text ?? "" }, options, odds: llmProfileOf(ctx).odds }),
    schema: choiceSchema("scar_card", keys),
    validate: x => pick(keys, x.choice)
  });
  let out = null;
  if ( res.value === playKey ) {
    out = { cardId: card.id, why: why("playScar", { territory: battle.to, label: card.name, chance: round(p, 2), faction: role === "defender" ? battle.attacker : battle.defender, thinking: res.thinking }) };
    const say = gateSay(ctx, res.say);
    if ( say ) out.say = say;
  }
  memo.reactive.set(cacheKey, out);
  return out;
}

/* -------------------------------------------- */
/*  Prompts                                     */
/* -------------------------------------------- */

const CAMPAIGN_KINDS = /^(winnerReward|heldOnReward|faction|draft|option)/;
const KEY_KINDS = /^(winnerReward|heldOnReward|faction)/;

function kindText(kind) {
  const k = String(kind);
  if ( k.startsWith("winnerReward") ) return FACTS.kind.winnerReward;
  if ( k.startsWith("heldOnReward") ) return FACTS.kind.heldOnReward;
  if ( k.startsWith("event") ) return FACTS.kind.event;
  return FACTS.kind[k] ?? FACTS.kind.other;
}

/** One option as a line of facts (the shared optionFacts, flattened). */
function optionText(ctx, o) {
  const f = optionFacts(ctx, o);
  const bits = [f.option];
  if ( f.details ) bits.push(f.details);
  if ( f.territory ) {
    const t = f.territory;
    bits.push(`${t.name}: held by ${t.held_by}, ${t.troops} troops${t.hq ? `, ${t.hq}` : ""}${t.city ? `, ${t.city}` : ""}`);
  }
  if ( f.faction?.powers?.length ) bits.push(`powers: ${f.faction.powers.join(" | ")}`);
  return bits.filter(Boolean).join(". ").replace(/\.\./g, ".");
}

/** Any multiple-choice prompt (faction pick, event steps, rewards, power options...). */
export async function chooseOption(ctx, args = {}) {
  const { kind = "option", title = "", text = "", options = [] } = args;
  const enabled = options.filter(o => !o.disabled);
  if ( enabled.length <= 1 ) return jev.chooseOption(H(ctx), args);
  if ( isHeuristic(ctx) ) return jev.chooseOption(H(ctx), args);
  const profile = llmProfileOf(ctx);
  const shown = enabled.slice(0, 40);
  const keys = uniqueSlugs(shown.map(o => o.label));
  const hasWar = !!ctx.me && !!ctx.state?.territories && Object.values(ctx.state.factions ?? {}).some(f => f.active) && !!ctx.state.factions?.[ctx.me];
  const campaignKind = CAMPAIGN_KINDS.test(String(kind));
  const ended = ctx.state?.turn?.stage === "ended";
  const board = hasWar ? boardFacts(ctx, profile, { detail: ended ? "final" : "option" }) : null;
  const campaign = campaignKind ? campaignFacts(ctx, profile.campaign) : null;
  if ( board && campaign ) board.campaign = campaign;
  const res = await askModel(ctx, {
    purpose: `choice: ${kind}`,
    user: optionMessage({
      kindText: kindText(kind), title, text: String(text ?? "").slice(0, 600), board, campaign: board ? null : campaign,
      options: shown.map((o, i) => ({ key: keys[i], text: optionText(ctx, o) })), key: KEY_KINDS.test(String(kind))
    }),
    schema: choiceSchema("choice", keys),
    validate: p => pick(keys, p.choice)
  });
  const k = keys.indexOf(res.value);
  const out = { value: shown[k].value, why: why("choiceBest", { label: shown[k].label, thinking: res.thinking }) };
  const say = gateSay(ctx, res.say, { key: KEY_KINDS.test(String(kind)) });
  if ( say ) out.say = say;
  return withPending(ctx, out);
}

/** Starting territory (setup) or a Join-the-War territory outside the turn plan. */
export async function chooseStartingTerritory(ctx, { legal = [], joining = false } = {}) {
  if ( legal.length <= 1 || isHeuristic(ctx) ) return jev.chooseStartingTerritory(H(ctx), { legal, joining });
  const profile = llmProfileOf(ctx);
  const cands = startMenu(ctx, profile, legal);
  if ( cands.length <= 1 ) return jev.chooseStartingTerritory(H(ctx), { legal, joining });
  const keys = cands.map(c => c.key);
  const enemyHqs = profile.context === "self" ? null
    : Object.values(ctx.state.territories).filter(t => t.hq && t.hq !== ctx.me).map(t => `${factionName(ctx, t.hq)} in ${t.name}`);
  const res = await askModel(ctx, {
    purpose: joining ? "join the war" : "starting territory",
    user: startMessage({ me: factionName(ctx, ctx.me), game: gameOf(ctx) || null, enemyHqs, candidates: cands, odds: profile.odds, campaign: profile.campaign === "full" ? campaignFacts(ctx, "full") : null }),
    schema: choiceSchema("starting_territory", keys),
    validate: p => pick(keys, p.choice)
  });
  const out = { territory: res.value, why: why("startPosition", { territory: res.value, thinking: res.thinking }) };
  const say = gateSay(ctx, res.say, { key: true });
  if ( say ) out.say = say;
  return out;
}

/** A name for the board: the personality's own names (unused first), else the Jev brain's lists. Sync, no call. */
export function pickName(ctx, { kind = "city", used = [] } = {}) {
  const k = String(kind).toLowerCase();
  const group = k.includes("world") ? "world" : k.includes("continent") ? "continent"
    : (k.includes("signature") || k.includes("player") || k.includes("motto")) ? "signature" : "city";
  const pool = personalityOf(ctx)?.names?.[group] ?? [];
  const taken = new Set((used ?? []).map(u => String(u).trim().toLowerCase()));
  const free = pool.filter(n => n && !taken.has(String(n).trim().toLowerCase()));
  if ( !free.length ) return jev.pickName(ctx, { kind, used });
  const random = typeof ctx?.random === "function" ? ctx.random : Math.random;
  const name = free[Math.floor(random() * free.length)];
  return { name, why: why("name", { kind, label: name }) };
}
