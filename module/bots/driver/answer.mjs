/**
 * The answer dispatcher (BOTS.md §6.3): the hook points in campaign/ask.mjs, campaign/placements.mjs (askOrHere),
 * cards/event-effects.mjs (Chooser.ask) and battle/defense.mjs (requestDefense) call
 * `game.risklegacy.bots.answer(kind, {user, data})`.
 *
 * Returns `undefined` **synchronously** when the user isn't a bot (or the kind is one the GM keeps), so the caller
 * carries on unchanged; otherwise a Promise of exactly the value that kind's prompt returns for a person. A bot never
 * waits on a GM-local dialog and never falls back to the GM: a failing brain gets a legal fallback answer.
 */
import { HELDON_REWARDS, WINNER_REWARDS } from "../../config.mjs";
import { botDifficulty, isBotUser } from "../users.mjs";
import { battleData, buildContext } from "./context.mjs";
import { brain, decide, engineOf, record } from "./decide.mjs";
import { chooseAlienIslandPoint, chooseSeaLine } from "./geometry.mjs";
import {
  draftAnswer, draftOptions, eventAnswer, eventChoice, falloutPick, nameOr, rewardOptions, territoryOptions, textOf,
  usedNames, validValue
} from "./prompts.mjs";
import { RL, factionOfBot, status, territoryName, waitIfPaused } from "./util.mjs";

const loc = key => game.i18n.localize(key);
const today = () => new Date().toISOString().slice(0, 10);
const usedOnBoard = () => usedNames(RL().state.getCampaign()?.system);
const continentName = id => {
  const c = RL().state.getCampaign()?.system.continents?.[id];
  return c?.name || RL().state.getCampaignBoard()?.continents?.[id]?.label || id;
};
const rewardLabels = table => Object.fromEntries(Object.entries(table).map(([k, r]) => [k, { label: loc(r.label), hint: loc(r.hint) }]));

/** Context for a bot user: its faction (from the prompt data, else the one it plays), difficulty and bot info. */
function contextFor(user, fid) {
  const faction = fid ?? factionOfBot(user)?.id ?? null;
  return buildContext(faction, { difficulty: botDifficulty(user) ?? "normal", bot: user });
}

/** chooseOption through the decision runner; the answer is always an enabled option's value (or null). */
async function choose(user, ctx, kind, args) {
  const d = await decide({
    kind, ctx, user, fn: "chooseOption", args: { kind: args.kind ?? kind, title: args.title ?? "", text: args.text ?? "", options: args.options },
    fallback: () => ({ value: validValue(args.options, null), why: { reason: "heuristic" } })
  });
  return validValue(args.options, d?.value);
}

/** pickName (sync, no Jev), recorded. */
function name(user, ctx, kind, fallback) {
  let decision = null;
  try {
    decision = brain("pickName", engineOf(ctx))(ctx, { kind, used: usedOnBoard() });
  } catch(err) {
    console.error("risklegacy | bots: pickName failed", err);
  }
  const value = nameOr(decision?.name, fallback);
  record({ kind: `name.${kind}`, ctx, user, decision: { ...(decision ?? {}), name: value, why: decision?.why ?? { reason: "name", kind } } });
  return value;
}

/* -------------------------------------------- */
/*  Handlers: (user, data) → answer             */
/* -------------------------------------------- */

const HANDLERS = {};

/** S3: faction pick in the setup wizard → actor id. */
HANDLERS.faction = {
  async run(user, data) {
    const options = (data.factions ?? []).map(id => {
      const a = game.actors.get(id);
      const powers = (a?.items ?? []).filter(i => i.type === "power").map(i => `${i.name}: ${textOf(i.system.text)}`);
      return { value: id, label: a?.name ?? id, hint: powers.join(" | "), faction: id };
    });
    return choose(user, contextFor(user, null), "faction", { title: textOf(data.title), options });
  },
  fallback: data => data.factions?.[0] ?? null
};

/** S4: snake draft → {type, id}. */
HANDLERS.draft = {
  async run(user, data) {
    const entry = id => RL().state.findEntry("draft", id);
    const options = draftOptions(data, id => game.actors.get(id), entry);
    const value = await choose(user, contextFor(user, null), "draft", { title: textOf(data.title), options });
    return draftAnswer(value, entry);
  },
  fallback: data => draftAnswer(validValue(draftOptions(data, id => game.actors.get(id), id => RL().state.findEntry("draft", id)), null),
    id => RL().state.findEntry("draft", id))
};

/** S8 starting territory (data.faction) → chooseStartingTerritory; P7 Fallout Zone (no faction) → code heuristic. */
HANDLERS.territory = {
  async run(user, data) {
    const allowed = data.allowed ?? [];
    if ( !allowed.length ) return null;
    if ( data.faction ) {
      const ctx = contextFor(user, data.faction);
      const d = await decide({
        kind: "startingTerritory", ctx, user, fn: "chooseStartingTerritory", args: { legal: allowed, joining: false },
        fallback: () => ({ territory: allowed[0], why: { reason: "heuristic" } })
      });
      return allowed.includes(d?.territory) ? d.territory : allowed[0];
    }
    const ctx = contextFor(user, null);
    const territory = falloutPick(ctx.state, ctx.me, allowed);
    record({ kind: "fallout", ctx, user, decision: { territory, why: { reason: "choiceBest", territory, label: territoryName(territory) } } });
    return territory;
  },
  fallback: data => data.allowed?.[0] ?? null
};

/** P3/P4 power stickers and any generic option prompt → option value. */
HANDLERS.option = {
  async run(user, data) {
    const options = (data.options ?? []).map(o => ({ value: o.value, label: textOf(o.label), hint: textOf(o.hint), disabled: !!o.disabled }));
    return choose(user, contextFor(user, null), "option", { title: textOf(data.title), text: textOf(data.content), options });
  },
  fallback: data => validValue(data.options, null)
};

/** G2: sign the victors' section → {player, date, motto}. */
HANDLERS.signature = {
  async run(user, data) {
    const ctx = contextFor(user, null);
    return { player: name(user, ctx, "signature", data.player || user.name), date: data.date || today(), motto: "" };
  },
  fallback: (data, user) => ({ player: data.player || user?.name || "Jev", date: data.date || today(), motto: "" })
};

/** G3: the winner's reward → {reward, continent|territory, name|delta}. */
HANDLERS.winnerReward = {
  async run(user, data) {
    const ctx = contextFor(user, null);
    const a = data.available ?? {};
    const title = textOf(data.title);
    const reward = await choose(user, ctx, "winnerReward", { title, options: rewardOptions(a, rewardLabels(WINNER_REWARDS)) });
    if ( !reward ) return null;
    const pickTerritory = ids => choose(user, ctx, `winnerReward.${reward}`, { title, options: territoryOptions(ids, territoryName) });
    const pickContinent = ids => choose(user, ctx, `winnerReward.${reward}`, {
      title, options: (ids ?? []).map(id => ({ value: id, label: continentName(id) }))
    });
    switch ( reward ) {
      case "nameContinent": {
        const continent = await pickContinent(a.nameContinent?.continents);
        return continent ? { reward, continent, name: name(user, ctx, "continent", continentName(continent)) } : null;
      }
      case "foundMajorCity": {
        const territory = await pickTerritory(a.foundMajorCity?.territories);
        return territory ? { reward, territory, name: name(user, ctx, "city", territoryName(territory)) } : null;
      }
      case "changeContinentBonus": {
        const continent = await pickContinent(a.changeContinentBonus?.continents);
        const deltas = [
          { value: 1, label: "+1", disabled: !a.changeContinentBonus?.plus },
          { value: -1, label: "-1", disabled: !a.changeContinentBonus?.minus }
        ];
        const delta = await choose(user, ctx, "winnerReward.delta", { title: continentName(continent), options: deltas });
        return (continent && delta) ? { reward, continent, delta: Number(delta) } : null;
      }
      default: {
        const territory = await pickTerritory(a[reward]?.territories);
        return territory ? { reward, territory } : null;
      }
    }
  },
  fallback: data => {
    const a = data.available ?? {};
    for ( const reward of ["cancelScar", "fortifyCity", "destroyTerritoryCard"] ) {
      if ( a[reward]?.ok && a[reward].territories?.length ) return { reward, territory: a[reward].territories[0] };
    }
    return null;
  }
};

/** G4: a held-on reward → {reward, territory, name}. */
HANDLERS.heldOnReward = {
  async run(user, data) {
    const ctx = contextFor(user, null);
    const a = data.available ?? {};
    const title = textOf(data.title);
    const reward = await choose(user, ctx, "heldOnReward", { title, options: rewardOptions(a, rewardLabels(HELDON_REWARDS)) });
    if ( !reward ) return null;
    const territory = await choose(user, ctx, `heldOnReward.${reward}`, { title, options: territoryOptions(a[reward]?.territories, territoryName) });
    if ( !territory ) return null;
    if ( reward === "foundMinorCity" ) return { reward, territory, name: name(user, ctx, "city", territoryName(territory)) };
    return { reward, territory, name: "" };
  },
  fallback: data => {
    const t = data.available?.upgradeCard?.ok ? data.available.upgradeCard.territories?.[0] : null;
    return t ? { reward: "upgradeCard", territory: t, name: "" } : null;
  }
};

/** G6: name the world → {name}. */
HANDLERS.worldName = {
  async run(user, data) {
    return { name: name(user, contextFor(user, null), "world", RL().state.getCampaign()?.system.worldName || "Terra") };
  },
  fallback: () => ({ name: "Terra" })
};

/** P8/P9: a pen sea line → {a, b, points, clean} (code-only geometry). */
HANDLERS.seaLine = {
  async run(user, data) {
    const ctx = contextFor(user, data.faction || null);
    const line = chooseSeaLine(ctx, { a: data.a ?? null, b: data.b ?? null, exclude: data.exclude ?? [] });
    record({ kind: "seaLine", ctx, user, decision: { ...(line ?? {}), why: { reason: "choiceBest", from: line?.a, to: line?.b } } });
    return line;
  },
  fallback: () => null
};

/** P8: the Alien Island point → {x, y} (code-only geometry). */
HANDLERS.alienIslandPoint = {
  async run(user, data) {
    const ctx = contextFor(user, data.faction || null);
    const point = chooseAlienIslandPoint(ctx, { radius: data.radius });
    record({ kind: "alienIsland", ctx, user, decision: { ...(point ?? {}), why: { reason: "choiceBest" } } });
    return point;
  },
  fallback: () => null
};

/** B5: defender dice (defenderChoice = prompt) → 1..max. */
HANDLERS.defense = {
  async run(user, data) {
    const message = game.messages.get(data.messageId ?? "");
    const max = Math.max(1, Number(data.max) || 1);
    const fid = message?.system.defender ?? factionOfBot(user)?.id ?? null;
    const ctx = contextFor(user, fid);
    const d = await decide({
      kind: "defense", ctx, user, fn: "chooseDefenseDice", args: { battle: battleData(message), max },
      fallback: () => ({ dice: max, why: { reason: "defendMax" } })
    });
    const n = Math.trunc(Number(d?.dice));
    return (n >= 1) && (n <= max) ? n : max;
  },
  fallback: data => Math.max(1, Number(data.max) || 1),
  noPause: true
};

/** E1–E7: one step of an event choice ({type: option|territory|number}) → the step's value. */
const eventStep = {
  async run(user, data) {
    const ctx = contextFor(user, data.faction || null);
    const args = eventChoice(data, territoryName);
    if ( !args.options.length ) return null;
    const value = await choose(user, ctx, args.kind, args);
    return eventAnswer(data, args, value);
  },
  fallback: data => {
    const args = eventChoice(data, id => id);
    return eventAnswer(data, args, null);
  }
};
HANDLERS["event.option"] = eventStep;
HANDLERS["event.territory"] = eventStep;
HANDLERS["event.number"] = eventStep;

/** Prompt kinds the bots answer. */
export const ANSWERED_KINDS = Object.freeze(Object.keys(HANDLERS));

/**
 * @param {string} kind
 * @param {{user: User|string|null, data?: object}} ctx
 * @returns {undefined|Promise<*>}
 */
export function answer(kind, { user, data } = {}) {
  if ( !game.user?.isGM ) return undefined;
  const u = typeof user === "string" ? game.users.get(user) : user;
  if ( !u || !isBotUser(u) ) return undefined;
  const handler = HANDLERS[kind];
  if ( !handler ) {
    console.warn(`risklegacy | bots: no bot answer for prompt "${kind}"; the GM chooses for ${u.name}`);
    return undefined;
  }
  return run(kind, u, data ?? {}, handler);
}

async function run(kind, user, data, handler) {
  status.stats.answers += 1;
  if ( !handler.noPause ) await waitIfPaused();
  try {
    const value = await handler.run(user, data);
    if ( (value === undefined) || ((value === null) && handler.fallback) ) {
      const fb = handler.fallback?.(data, user);
      return fb === undefined ? null : fb;
    }
    return value;
  } catch(err) {
    console.error(`risklegacy | bots: answering "${kind}" for ${user.name} failed`, err);
    status.stats.errors += 1;
    try {
      const fb = handler.fallback?.(data, user);
      return fb === undefined ? null : fb;
    } catch(e) {
      return null;
    }
  }
}
