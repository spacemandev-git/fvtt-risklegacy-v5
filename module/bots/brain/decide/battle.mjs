/**
 * Battle reactions: defence dice, pre-roll scar cards (Bunker / Ammo Shortage) and missiles. Code computes the exact
 * swing (odds.mjs); Jev judges how much the battle matters to the bot, and only when the code already sees a material
 * swing on a battle with something at stake (trivial battles never cost a request).
 */
import * as rules from "../../../rules/_module.mjs";
import { READ, STAKES_LEVELS, battleQuestions } from "../../jev/questions.mjs";
import { PRIMER, battleFacts } from "../context.mjs";
import { codeLeader, standings, takeEffects } from "../features.mjs";
import { battleOdds, battleSetup, defenceChoices, missileOptions } from "../odds.mjs";
import { ask, readScore, scoreOf } from "../judge.mjs";
import { gainOf, profileOf } from "../profiles.mjs";
import { round, turnMemo, why } from "../util.mjs";

const STAKES = new Map();

/** Code estimate of how much a battle matters to the bot (STAKES_LEVELS scale). */
export function codeStakes(ctx, battle, fx) {
  const { me } = ctx;
  const mine = battle.attacker === me || battle.defender === me;
  if ( fx.winNow ) return 4;
  let v = mine ? 0.7 : 0.2;
  if ( fx.earnsCard && battle.attacker === me ) v = Math.max(v, 1);
  if ( fx.completes.length || fx.breaks.length ) v = Math.max(v, 2 + (fx.breaks.some(b => b.faction === me) ? 0.5 : 0));
  if ( fx.hq || fx.knockOut ) v = Math.max(v, 3 + ((battle.defender === me) ? 0.5 : 0));
  if ( fx.hq && fx.starsAfter >= 3 && battle.attacker !== me ) v = Math.max(v, 3.5);
  return Math.min(4, v);
}

/** Who leads (from the turn's situation when available, else the code ranking; no request). */
function leaderOf(ctx) {
  const sit = ctx.situation ?? turnMemo(ctx).situation ?? null;
  if ( sit?.leader ) return sit.leader;
  return codeLeader(standings(ctx)).leader;
}

/** How much the battle matters to the bot: Jev's Score (cached per battle), or the code level. */
async function stakesOf(ctx, profile, battle, fx) {
  const key = [ctx.me, battle.id ?? "", battle.attacker, battle.from, battle.to, ctx.view?.game ?? "", ctx.view?.round ?? "", ctx.state.turn?.faction ?? ""].join("|");
  const hit = STAKES.get(key);
  if ( hit ) return hit;
  const code = codeStakes(ctx, battle, fx);
  const list = standings(ctx);
  const answers = await ask(ctx, "battle stakes", {
    how_to_win: PRIMER.stars,
    battle: battleFacts(ctx, battle, fx, list)
  }, battleQuestions({ me: ctx.view?.factionNames?.[ctx.me] ?? ctx.state.factions[ctx.me]?.name ?? "the faction" }));
  const s = scoreOf(answers, "stakes", STAKES_LEVELS.length, code);
  const out = { level: readScore(s, profile, ctx.random), code, fromJev: s.fromJev };
  STAKES.set(key, out);
  if ( STAKES.size > 200 ) STAKES.delete(STAKES.keys().next().value);
  return out;
}

const stakesLabel = lv => STAKES_LEVELS[Math.max(0, Math.min(4, Math.round(lv)))].label;

/* -------------------------------------------- */
/*  Defence dice                                */
/* -------------------------------------------- */

/** Defender dice for a bot defender: the number that minimises the attacker's chance to conquer (code, exact). */
export async function chooseDefenseDice(ctx, { battle, max = 2 } = {}) {
  if ( !battle || max <= 1 ) return { dice: Math.max(1, max), why: why("defendMax", { dice: Math.max(1, max) }) };
  const choices = defenceChoices(ctx.state, battle, max, ctx.lookup);
  let best = choices.at(-1);
  for ( const c of choices ) if ( c.pConquer < best.pConquer - 0.003 ) best = c;
  return {
    dice: best.dice,
    why: why(best.dice === max ? "defendMax" : "defendFewer", { dice: best.dice, chance: round(best.pConquer, 2), territory: battle.to })
  };
}

/* -------------------------------------------- */
/*  Pre-roll scar cards                         */
/* -------------------------------------------- */

/**
 * Before the roll: play a Bunker (+1 to the defender's highest die) or an Ammo Shortage (−1) on the defending
 * territory? Normal: Bunker to defend its own HQ. Hard: also against the leader's attacks, and Ammo Shortage on its
 * own important attacks or attacks on the leader. Easy: never.
 * @returns {{cardId:string, why}|null}
 */
export async function preRollScar(ctx, { battle, cards = [] } = {}) {
  const profile = profileOf(ctx);
  if ( profile.scars === "never" || !battle || !cards.length ) return null;
  const { state, me } = ctx;
  const t = state.territories[battle.to];
  if ( !t || t.scar ) return null;
  const bunker = cards.find(c => String(c.scar).toLowerCase() === "bunker");
  const ammo = cards.find(c => String(c.scar).toLowerCase() === "ammo_shortage");
  const setup = battleSetup(state, battle, ctx.lookup);
  if ( (setup.rules.unmodifiable ?? []).includes("defend") ) return null;
  const A = state.territories[battle.from]?.troops ?? 0;
  const D = t.troops;
  const odds = extra => battleOdds({ A, D, ...setup, sources: extra ? [...setup.sources, extra] : setup.sources }).pConquer;
  const base = odds(null);
  const fx = takeEffects(ctx, battle.from, battle.to, { who: battle.attacker });
  const leader = leaderOf(ctx);
  const defenderMe = battle.defender === me;
  const attackerMe = battle.attacker === me;

  let card = null;
  let p = base;
  if ( bunker ) {
    const helpDefender = defenderMe
      ? (t.hq && t.owner === me) || profile.scars === "strategic"
      : profile.scars === "strategic" && battle.attacker !== me
        && (battle.attacker === leader || fx.winNow || (fx.hq && fx.starsAfter >= 3));
    if ( helpDefender ) {
      p = odds({ source: "bunker", side: "defend", die: "highest", delta: 1 });
      if ( base - p >= 0.05 ) card = bunker;
    }
  }
  if ( !card && ammo && profile.scars === "strategic" ) {
    const helpAttacker = attackerMe ? true
      : (battle.defender === leader && battle.defender !== me && (fx.hq || fx.breaks.some(b => b.faction === leader)));
    if ( helpAttacker ) {
      p = odds({ source: "ammo_shortage", side: "defend", die: "highest", delta: -1 });
      if ( p - base >= 0.05 ) card = ammo;
    }
  }
  if ( !card ) return null;
  // A scar is permanent: the hard bot plays it only when the battle matters (Jev stakes); normal only on its HQ.
  if ( profile.scars === "strategic" && !(defenderMe && t.hq && t.owner === me) ) {
    const stakes = await stakesOf(ctx, profile, battle, fx);
    if ( stakes.level < READ.stakesHigh - 0.5 ) return null;
  }
  return { cardId: card.id, why: why("playScar", { territory: battle.to, label: card.name, chance: round(p, 2), faction: defenderMe ? battle.attacker : battle.defender }) };
}

/* -------------------------------------------- */
/*  Missiles                                    */
/* -------------------------------------------- */

/** After the roll: fire one missile, or not. Called again after each missile while the battle is open. */
export async function missileDecision(ctx, { battle } = {}) {
  const profile = profileOf(ctx);
  const { state, me } = ctx;
  const missiles = state.factions[me]?.missiles ?? 0;
  if ( !battle || missiles <= 0 ) return { fire: false, why: why("missileHold") };
  const mo = missileOptions(state, battle, { lookup: ctx.lookup, activeEvents: ctx.view?.activeEvents?.map(e => e.id) });
  if ( !mo.options.length ) return { fire: false, why: why("missileHold") };
  const fx = takeEffects(ctx, battle.from, battle.to, { who: battle.attacker });
  const leader = leaderOf(ctx);
  const role = battle.attacker === me ? "attacker" : (battle.defender === me ? "defender" : "bystander");
  const t = state.territories[battle.to];

  // Which way the bot wants this battle to go (+1: attacker conquers; −1: defender holds).
  let want = 0;
  if ( role === "attacker" ) want = 1;
  else if ( role === "defender" ) want = -1;
  else if ( fx.winNow || battle.attacker === leader || (fx.hq && fx.starsAfter >= 3) ) want = -1;
  else if ( battle.defender === leader && rules.redStarTotal(state, leader) >= 3 && (fx.hq || fx.breaks.some(b => b.faction === leader)) ) want = 1;
  if ( !want ) return { fire: false, why: why("missileHold") };

  const side = want > 0 ? "attack" : "defend";
  const options = mo.options.filter(o => o.side === side);
  if ( !options.length ) return { fire: false, why: why("missileHold") };
  let best = options[0];
  for ( const o of options ) if ( want * (o.pConquer - best.pConquer) > 0 ) best = o;
  const swing = want * (best.pConquer - mo.base.pConquer);
  const hold = { fire: false, why: why("missileHold", { chance: round(mo.base.pConquer, 2), territory: battle.to }) };
  if ( swing <= 0.01 ) return hold;

  const code = codeStakes(ctx, battle, fx);
  let fire = false;
  let stakes = code;
  if ( profile.missiles === "winOnly" ) {
    // Easy: only when losing this battle would hand someone else the win.
    fire = want < 0 && fx.winNow && battle.attacker !== me && swing >= 0.05;
  }
  else if ( profile.missiles.minStakes !== undefined ) {
    // Normal: its own battles, stakes ≥ "a lot", swing ≥ 0.25. Jev is asked only when the swing already qualifies.
    if ( role !== "bystander" && swing >= profile.missiles.minSwing && code >= 1.5 ) {
      stakes = (await stakesOf(ctx, profile, battle, fx)).level;
      fire = stakes >= READ.stakesHigh - 0.25;
    }
  }
  else {
    // Hard: expected value in troop-equivalents against the value of keeping the missile.
    if ( (role !== "bystander" || profile.missiles.bystander) && swing >= 0.08 && code >= 1.5 ) {
      stakes = (await stakesOf(ctx, profile, battle, fx)).level;
      const ev = gainOf(profile, stakes) * swing;
      const cost = 2 + (missiles <= 1 ? 1 : 0);
      fire = ev >= cost;
    }
  }
  if ( !fire ) return { ...hold, why: { ...hold.why, value: stakesLabel(stakes) } };
  let reason = "missileSwing";
  if ( role === "attacker" && (fx.winNow || fx.hq) ) reason = "missileWin";
  else if ( role === "defender" && t?.hq && t.owner === me ) reason = "missileSaveHq";
  else if ( role === "bystander" ) reason = "missileStopLeader";
  return {
    fire: true, side: best.side, index: best.index,
    why: why(reason, {
      chance: round(best.pConquer, 2), territory: battle.to, value: stakesLabel(stakes),
      faction: role === "attacker" ? battle.defender : battle.attacker, label: `swing ${Math.round(swing * 100)} points`
    })
  };
}

/** Forget cached battle stakes (tests). */
export function clearStakes() {
  STAKES.clear();
}
