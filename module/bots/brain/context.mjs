/**
 * Builders for the Jev `state` of each request (BOTS.md §4.2): names rather than ids, every number computed in code
 * and stated as a plain fact or a verbal band with its percentage, and only what that request's questions need.
 * The question wording lives in module/bots/jev/questions.mjs; the paths it refers to are built here.
 */
import { band, continentName, factionName, listText, plural, starsText, territoryName, uniqueSlugs } from "./util.mjs";

const poss = name => (/s$/i.test(name) ? `${name}'` : `${name}'s`);

/** Short rules notes, only where they help the judgment. */
export const PRIMER = {
  stars: "A faction wins the moment it holds 4 Red Stars. Each HQ a faction controls is one Red Star (captured HQs count for the captor); Red Star tokens are permanent. 4 resource cards buy a Red Star token at the start of the owner's turn.",
  cards: "A faction earns one resource card at the end of a turn in which it conquered at least one territory. Knocking a faction out (taking its last territory) takes all its resource cards.",
  start: "Each faction starts with its HQ and 8 troops in one territory. Holding a whole continent pays its bonus in troops every turn."
};

/** Stable keys for the factions in the war: fid → slug. */
export function factionKeys(ctx, list) {
  const keys = uniqueSlugs(list.map(s => s.name ?? factionName(ctx, s.id)), "faction");
  return Object.fromEntries(list.map((s, i) => [s.id, keys[i]]));
}

/** Continents a faction holds, as text. */
function continentsText(ctx, ids) {
  if ( !ids?.length ) return "none";
  return listText(ids.map(c => `${continentName(ctx.state, c)} (+${ctx.state.continents[c]?.value ?? 0} troops per turn)`));
}

/** HQs a faction controls, as text. */
function hqsText(ctx, s) {
  if ( !s.hqs.length ) return "none";
  return listText(s.hqs.map(id => {
    const owner = ctx.state.territories[id]?.hq;
    const where = territoryName(ctx.state, id);
    return owner === s.id ? `its own HQ in ${where}` : `${poss(factionName(ctx, owner))} HQ in ${where}`;
  }));
}

/**
 * Facts about one faction for the standings, by depth: "self" (stars only), "standings", "full" (hand, recruit,
 * HQ attack, missiles, mission progress, powers).
 */
export function factionFacts(ctx, s, depth = "standings") {
  const out = { name: s.name, red_stars: starsText(s.stars) };
  if ( ctx.state.turn?.faction === s.id && ctx.state.turn?.stage === "playing" ) out.turn = "it is this faction's turn now";
  if ( depth === "self" ) return out;
  out.hqs_held = hqsText(ctx, s);
  if ( s.status === "knockedOut" ) out.status = "knocked out: must rejoin the war with 4 troops";
  out.troops = s.troops;
  out.territories = s.territories;
  out.continents = continentsText(ctx, s.continents);
  if ( depth !== "full" ) return out;
  const buy = s.buyableNext > 0
    ? (s.stars + Math.min(s.buyableNext, s.toWin) >= 4 ? "can buy enough Red Stars at the start of its next turn to win" : "can buy a Red Star at the start of its next turn")
    : "cannot buy a Red Star yet";
  out.resource_cards = `${plural(s.hand.count, "card")} worth ${plural(s.hand.coins, "coin")}: ${buy}`;
  out.next_recruit = `about ${plural(s.recruit, "troop")} next turn (before cards)`;
  if ( s.hqCapture && s.hqCapture.p >= 0.05 ) {
    const when = ctx.state.turn?.faction === s.id ? "this turn" : "its next turn";
    const target = `${poss(factionName(ctx, s.hqCapture.owner))} HQ in ${territoryName(ctx.state, s.hqCapture.territory)}`;
    out[`best_hq_attack_${when === "this turn" ? "this_turn" : "next_turn"}`] = `${target}: ${band(s.hqCapture.p)}`;
    if ( s.toWin === 1 ) out.can_win = `${when}, by capturing ${target}: ${band(s.hqCapture.p)}`;
  }
  if ( s.missiles ) out.missiles = s.missiles;
  const powers = ctx.view?.powers?.[s.id];
  if ( powers?.length ) out.powers = powers.slice(0, 4).map(p => p.text ?? p.name).filter(Boolean);
  return out;
}

/** The `factions` block: {slug: facts}. */
export function factionsBlock(ctx, standings, keys, depth) {
  return Object.fromEntries(standings.map(s => [keys[s.id], factionFacts(ctx, s, depth)]));
}

/** `your_hq`: the bot's most endangered HQ and who can reach it. */
export function hqBlock(ctx, danger) {
  if ( !danger ) return null;
  const t = ctx.state.territories[danger.territory];
  const out = {
    territory: territoryName(ctx.state, danger.territory),
    whose: danger.own ? "the faction's own HQ" : `${poss(factionName(ctx, t.hq))} HQ, captured`,
    defenders: danger.defenders,
    fortified: danger.fortified ? "yes: +1 on both defence dice" : "no"
  };
  const threats = danger.threats.filter(x => x.p >= 0.02).slice(0, 4);
  out.threats = threats.length ? threats.map(x => ({
    faction: factionName(ctx, x.faction),
    troops_it_could_attack_with: x.attackers,
    from: territoryName(ctx.state, x.from) + (x.via ? ` through ${territoryName(ctx.state, x.via)}` : ""),
    chance_to_capture_next_turn: band(x.p)
  })) : "no opponent can reach it with enough troops next turn";
  return out;
}

/* -------------------------------------------- */
/*  What taking a territory changes             */
/* -------------------------------------------- */

/** Plain-language consequences of `who` taking a territory (takeEffects facts). */
export function takeFacts(ctx, fx, who = ctx.me) {
  const me = factionName(ctx, who);
  const def = fx.defender ? factionName(ctx, fx.defender) : null;
  const lines = [];
  if ( fx.winNow ) lines.push(`${me} reaches ${fx.starsAfter} Red Stars and wins the war`);
  if ( fx.hq ) {
    if ( fx.retakesOwnHq ) lines.push(`${me} retakes its own HQ: ${me} rises to ${fx.starsAfter} Red Stars`);
    else {
      const owner = factionName(ctx, fx.hq);
      const lost = def ? ` and ${def} drops to ${fx.defenderStarsAfter}` : "";
      lines.push(`captures ${poss(owner)} HQ${def ? "" : " (undefended)"}: ${me} rises to ${fx.starsAfter} Red Stars${lost}`);
    }
  }
  if ( fx.knockOut ) lines.push(`knocks ${def} out of the war${fx.cardsGained ? `: ${me} takes its ${plural(fx.cardsGained, "resource card")}` : ""}`);
  for ( const c of fx.completes ) lines.push(`completes ${continentName(ctx.state, c)}: ${me} gains +${ctx.state.continents[c]?.value ?? 0} troops every turn`);
  for ( const b of fx.breaks ) {
    lines.push(`breaks ${poss(factionName(ctx, b.faction))} hold on ${continentName(ctx.state, b.continent)} (it loses +${ctx.state.continents[b.continent]?.value ?? 0} troops per turn)`);
  }
  const mission = ctx.view?.mission?.name;
  if ( fx.completesMission ) lines.push(`completes the mission${mission ? ` "${mission}"` : ""}, worth a permanent Red Star`);
  else if ( fx.missionProgress ) lines.push(`counts toward the mission${mission ? ` "${mission}"` : ""}`);
  if ( fx.earnsCard ) lines.push("first conquest this turn: earns a resource card at the end of the turn");
  if ( fx.population ) lines.push(`a city: +${fx.population} population for recruiting`);
  if ( (fx.recruitDelta > 0) && !fx.completes.length ) lines.push(`+${plural(fx.recruitDelta, "troop")} per turn`);
  if ( !lines.length ) lines.push("only the territory changes hands: no HQ, continent bonus, resource card or knock-out depends on it");
  return lines;
}

/** The `targets` block entry for a plan. */
export function targetFacts(ctx, plan, standings = null) {
  const { state } = ctx;
  const t = state.territories[plan.end];
  const from = territoryName(state, plan.from);
  const out = { territory: territoryName(state, plan.end) };
  const owner = t.owner && t.owner !== ctx.me ? t.owner : null;
  if ( owner ) {
    const s = standings?.find(x => x.id === owner);
    out.held_by = s ? `${factionName(ctx, owner)} (${starsText(s.stars)})` : factionName(ctx, owner);
    out.defenders = t.troops;
  }
  else out.held_by = t.hq ? `nobody: only ${poss(factionName(ctx, t.hq))} HQ piece stands there` : "nobody (unoccupied)";
  // The odds are left out on purpose: the question is what taking it is worth; code multiplies by the exact odds
  // (probe: stating them dragged the value of long shots down).
  if ( plan.chain ) {
    const via = plan.path.slice(1, -1).map(id => territoryName(state, id));
    out.route = `from ${from} (${plural(state.territories[plan.from].troops, "troop")}) through ${listText(via)}, then ${out.territory}`;
  }
  else if ( plan.kind === "attack" ) {
    out.attack_from = `${from} (${plural(state.territories[plan.from].troops, "troop")})`;
  }
  else {
    out.expand_from = from;
    out.cost = plan.cost ? `${plural(plan.cost, "troop")} lost entering` : "no troops lost";
  }
  out.if_taken = takeFacts(ctx, plan.endFx);
  out.afterwards = plan.endFx.exposure ? `it would border ${plural(plan.endFx.exposure, "enemy troop")} in the strongest neighbouring stack` : "no enemy troops next to it";
  return out;
}

/** The `fronts` block entry. */
export function frontFacts(ctx, front, planned = null) {
  const { state, me } = ctx;
  const t = state.territories[front.id];
  const out = { territory: territoryName(state, front.id), troops: t.troops };
  if ( t.hq ) out.holds = t.hq === me ? `${poss(factionName(ctx, me))} own HQ` : `${poss(factionName(ctx, t.hq))} captured HQ`;
  const byFaction = {};
  for ( const e of front.enemies ) (byFaction[e.owner] ??= []).push(`${e.troops} in ${territoryName(state, e.id)}`);
  out.enemy_neighbours = Object.keys(byFaction).length
    ? Object.entries(byFaction).map(([f, xs]) => `${factionName(ctx, f)}: ${listText(xs)}`) : "none (only unoccupied land)";
  out.strongest_attack_next_turn = front.threat.p >= 0.02
    ? `${factionName(ctx, front.threat.faction)} with about ${plural(front.threat.attackers, "troop")}: ${band(front.threat.p)} to take it`
    : "no opponent can take it next turn";
  const loses = [];
  if ( front.loses.hq ) loses.push(t.hq === me ? `${factionName(ctx, me)} loses its HQ (a Red Star)` : "a captured HQ (a Red Star)");
  for ( const c of front.loses.continents ) loses.push(`breaks ${poss(factionName(ctx, me))} hold on ${continentName(state, c)} (+${state.continents[c]?.value ?? 0})`);
  if ( t.population ) loses.push(`a city (population ${t.population})`);
  out.if_lost = loses.length ? loses : "only the territory";
  if ( planned ) out.planned = planned;
  return out;
}

/** The `battle` block (missiles, scar cards). Odds are left out: the question is how much the outcome matters. */
export function battleFacts(ctx, battle, fx, standings) {
  const { state, me } = ctx;
  const role = battle.attacker === me ? "is the attacker" : (battle.defender === me ? "is the defender" : "is not fighting in this battle");
  // What the outcome means for the asking faction, stated outright (probe: a bystander couldn't tell that "the
  // attacker wins the war" means "you lose it" and called the battle unimportant).
  const name = factionName(ctx, me);
  const meaning = [];
  if ( fx.winNow ) meaning.push(battle.attacker === me ? `${name} wins the war if it takes the territory` : `${name} loses the war if the attacker takes the territory`);
  else if ( fx.hq ) {
    if ( battle.attacker === me ) meaning.push(`${name} captures an HQ (a Red Star) if it takes the territory`);
    else if ( battle.defender === me ) meaning.push(`${name} loses ${fx.hq === me ? "its HQ" : "a captured HQ"} (a Red Star) if the attacker takes the territory`);
  }
  if ( fx.breaks.some(b => b.faction === me) ) meaning.push(`${name} loses a continent bonus if the attacker takes the territory`);
  return {
    attacker: factionName(ctx, battle.attacker),
    defender: factionName(ctx, battle.defender),
    territory: territoryName(state, battle.to),
    involvement: `${factionName(ctx, me)} ${role}`,
    troops: `${plural(state.territories[battle.from]?.troops ?? 0, "troop")} attacking ${plural(state.territories[battle.to]?.troops ?? 0, "defender")}`,
    if_attacker_takes_it: takeFacts(ctx, fx, battle.attacker),
    ...(meaning.length ? { [`what_it_means_for_${uniqueSlugs([name])[0]}`]: meaning } : {}),
    red_stars: Object.fromEntries(standings.map(s => [s.name, starsText(s.stars)]))
  };
}

/** The `candidates` block entry for a starting / Join-the-War territory. */
export function startFacts(ctx, cand, joining) {
  const { state } = ctx;
  const t = state.territories[cand.id];
  const c = state.continents[t.continent];
  const f = cand.facts;
  const borders = c ? c.territories.filter(id => (state.territories[id]?.neighbors ?? []).some(n => state.territories[n]?.continent !== c.id)).length : 0;
  const out = {
    territory: t.name,
    continent: c ? `${continentName(state, c.id)}: +${c.value} troops per turn to whoever holds all ${c.territories.length} territories; ${borders} of them border other continents` : "none",
    other_continents_it_touches: f.foreign?.length
      ? `${f.foreign.length}: ${f.foreign.map(id => continentName(state, id)).join(", ")}`
      : `none: only territories of ${c ? continentName(state, c.id) : "its continent"} border it`,
    unoccupied_neighbours: f.emptyAdj,
    unoccupied_within_2_steps: f.room,
    nearest_enemy_hq: f.hqDist === null ? "no enemy HQ on the board yet" : `${plural(f.hqDist, "step")} away`
  };
  if ( !joining ) out.enemy_troops_within_2_steps = f.enemyNear;
  if ( f.cityNear ) out.city_population_nearby = f.cityNear;
  if ( joining ) {
    // Computed facts, not raw troop counts (probe: "4 enemy troops nearby" next to "rejoins with 4 troops" read as a knock-out).
    const adj = (t.neighbors ?? []).map(n => state.territories[n]).filter(n => n?.owner && n.owner !== ctx.me);
    out.enemy_neighbours = adj.length ? adj.map(n => `${factionName(ctx, n.owner)} in ${n.name}`) : "none";
    out.chance_an_enemy_takes_it_next_turn = f.danger?.p >= 0.02
      ? `${band(f.danger.p)}, by ${factionName(ctx, f.danger.faction)}` : "almost none: no enemy can reach it with enough troops";
    if ( f.weakHq ) {
      const h = state.territories[f.weakHq];
      out.enemy_hq_next_to_it = `${poss(factionName(ctx, h.hq))} HQ in ${h.name}: chance to capture it next turn ${band(f.hqChance)}`;
    }
  }
  return out;
}

/** The `options` block entry for a multiple-choice prompt option. */
export function optionFacts(ctx, option) {
  const { state } = ctx;
  const out = { option: option.label };
  if ( option.hint ) out.details = option.hint;
  if ( option.territory && state.territories[option.territory] ) {
    const t = state.territories[option.territory];
    out.territory = {
      name: t.name,
      held_by: t.owner ? factionName(ctx, t.owner) : "nobody",
      troops: t.troops,
      ...(t.hq ? { hq: `${poss(factionName(ctx, t.hq))} HQ` } : {}),
      ...(t.city ? { city: `${t.city.type} city, population ${t.population}` } : {})
    };
  }
  if ( option.faction ) {
    out.faction = { name: factionName(ctx, option.faction) };
    const powers = ctx.view?.powers?.[option.faction];
    if ( powers?.length ) out.faction.powers = powers.map(p => p.text ?? p.name).filter(Boolean);
  }
  return out;
}
