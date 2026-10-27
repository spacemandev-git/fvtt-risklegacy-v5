/**
 * Text for bot decisions: one short line per DecisionRecord ("Jev Warlord attacks Ukraine from Middle East: going for
 * Imperial Balkania's HQ, 74% to take it."), used by the chat narration and as the Bot Log headline.
 *
 * A line is the action (from the decision's shape, `RL.Bots.Act.*`), then the reason (`RL.Bots.Why.<reason>` with the
 * `why` data, BOTS.md §5.3), then the odds when `why.chance` is given. Templates use `{field}` placeholders; a part in
 * square brackets ("[ on {to}]") is dropped when one of its fields is missing, so a line never shows a raw placeholder.
 */
import { SYSTEM_PATH } from "../../config.mjs";
import { personalityById } from "../llm/personalities.mjs";
import { botInfo, botOfFaction, botPersonality, difficultyLabel } from "../users.mjs";

export const tpl = path => `${SYSTEM_PATH}/templates/${path}`;

/** Rank insignia: one chevron per difficulty step. */
export const RANKS = Object.freeze({ easy: 1, normal: 2, hard: 3 });

/** The avatar every bot user starts with (module/bots/users.mjs). */
export const DEFAULT_AVATAR = "icons/svg/clockwork.svg";

/**
 * A bot's picture: its user avatar if the GM set one, else its personality's portrait, else the default.
 * @param {User|null} user
 * @param {object|null} [personality]
 */
export function portraitOf(user, personality = null) {
  const avatar = user?.avatar;
  if ( avatar && (avatar !== DEFAULT_AVATAR) ) return avatar;
  return personality?.portrait || avatar || DEFAULT_AVATAR;
}

/** Localize (with optional format data, through our safe formatter). */
export const t = (key, data) => (data ? fill(game.i18n.localize(key), data) : game.i18n.localize(key));

/** Escape text for HTML built in code. */
export const esc = s => foundry.utils.escapeHTML(String(s ?? ""));

/** "northwest_territory" → "Northwest Territory". */
export const humanize = id => String(id ?? "").split(/[_\s-]+/).filter(Boolean)
  .map(w => w[0].toUpperCase() + w.slice(1)).join(" ");

/**
 * Format a template: `{x}` → data.x; `[…]` keeps its content only if every field inside it has a value. Fields still
 * missing outside brackets get a neutral word from `RL.Bots.Missing.<field>` (or "?").
 */
export function fill(template, data = {}) {
  const has = k => (data[k] !== undefined) && (data[k] !== null) && (data[k] !== "");
  let out = String(template ?? "").replace(/\[([^\]]*)\]/g, (m, inner) => {
    const keys = [...inner.matchAll(/\{(\w+)\}/g)].map(x => x[1]);
    return keys.every(has) ? inner : "";
  });
  out = out.replace(/\{(\w+)\}/g, (m, k) => {
    if ( has(k) ) return String(data[k]);
    const key = `RL.Bots.Missing.${k}`;
    return game.i18n.has(key) ? game.i18n.localize(key) : "?";
  });
  return out;
}

/** 0.74 → "74%" (never "100%" or "0%" for an uncertain chance). */
export function percent(p) {
  const n = Number(p);
  if ( !Number.isFinite(n) ) return "";
  const v = Math.round(n * 100);
  if ( (v >= 100) && (n < 1) ) return ">99%";
  if ( (v <= 0) && (n > 0) ) return "<1%";
  return `${Math.max(0, Math.min(100, v))}%`;
}

/** Display name of a territory in this campaign. */
export function territoryName(id) {
  if ( !id ) return "";
  try {
    const name = game.risklegacy?.state?.getCampaignBoard?.()?.territories?.[id]?.name;
    if ( name ) return name;
  } catch(err) { /* board not loaded */ }
  return humanize(id);
}

/** Display name of a faction (actor id), falling back to the record's own names. */
export function factionName(id, record) {
  if ( !id ) return "";
  return game.actors.get(id)?.name ?? record?.factionNames?.[id] ?? ((record?.faction === id) ? record.factionName : null) ?? humanize(id);
}

/** A card's name (searching every card stack), for draws and scar plays. */
export function cardName(id) {
  if ( !id ) return "";
  for ( const stack of game.cards ?? [] ) {
    const card = stack.cards.get(id);
    if ( card ) return card.name;
  }
  return "";
}

/** "1 troop" / "4 troops". */
export const troops = n => t(Number(n) === 1 ? "RL.Bots.Count.troop" : "RL.Bots.Count.troops", { count: n });

/** "1 die" / "3 dice". */
export const dice = n => t(Number(n) === 1 ? "RL.Bots.Count.die" : "RL.Bots.Count.dice", { count: n });

/** "a, b and c" in the world's language. */
export const list = items => game.i18n.getListFormatter().format(items.filter(Boolean).map(String));

/**
 * The bot user behind a record: its name, difficulty, engine ("jev" | "llm") and, for chat bots, its personality,
 * title and portrait.
 */
export function recordBot(record) {
  const byId = record?.user ? game.users.get(record.user) : null;
  const user = byId ?? botOfFaction(record?.faction)?.user ?? null;
  const info = botInfo(user);
  const difficulty = record?.difficulty ?? info?.difficulty ?? "normal";
  const engine = record?.engine ?? info?.engine ?? "jev";
  const personality = (engine === "llm") ? (personalityById(record?.personality) ?? botPersonality(user) ?? null) : null;
  return {
    user,
    name: user?.name ?? record?.userName ?? record?.factionName ?? t("RL.Bots.Missing.name"),
    difficulty, difficultyLabel: difficultyLabel(difficulty),
    engine, personality, title: personality?.title ?? "", portrait: portraitOf(user, personality)
  };
}

/** The Jev and chat-model exchanges of a record (either list may be missing). */
export const jevOf = record => (Array.isArray(record?.jev) ? record.jev : []);
export const llmOf = record => (Array.isArray(record?.llm) ? record.llm : []);

/** A record's table-talk line (BOTS-LLM.md §5.4): on the record, else on its decision; "" when there is none. */
export function sayOf(record) {
  const say = record?.say ?? record?.decision?.say;
  if ( typeof say !== "string" ) return "";
  const s = say.replace(/\s+/g, " ").trim();
  // The brain caps lines at 160 characters; this only guards the chat against a runaway string
  return s.length > 240 ? `${s.slice(0, 239).replace(/\s+\S*$/, "")}…` : s;
}

/* -------------------------------------------- */
/*  Categories                                  */
/* -------------------------------------------- */

/** Prompt kinds whose decisions have their own wording (board picks made for a bot). */
const KIND_CATEGORIES = { fallout: "fallout", seaLine: "seaLine", alienIsland: "alienIsland" };

/** Record kinds the driver may use, when the decision's shape doesn't settle the category. */
const KIND_HINTS = [
  [/situation|assess/i, "situation"], [/place/i, "placement"], [/maneuver/i, "maneuver"], [/move.?in|advance/i, "moveIn"],
  [/missile/i, "missile"], [/scar/i, "scar"], [/defen[cs]e|dice/i, "defend"], [/end|draw/i, "endTurn"],
  [/start|territory|join/i, "start"], [/stars?|buy/i, "buyStars"], [/recruit/i, "recruit"],
  [/option|choice|event|faction|reward|power/i, "choice"], [/name/i, "name"], [/attack|move/i, "attack"]
];

/**
 * What a decision did, from its shape (BOTS.md §5 return values), then the record kind.
 * @returns {string} situation | attack | expand | stop | placement | maneuver | moveIn | missile | missileHold | scar |
 *   scarHold | buyStars | holdCards | join | recruit | endTurn | defend | start | choice | name | debrief | none | other
 */
export function categoryOf(record) {
  const d = record?.decision;
  const reason = d?.why?.reason;
  const kind = record?.kind ?? "";
  if ( (reason === "situation") || /situation|assess/i.test(kind) ) return "situation";
  if ( (kind === "debrief") || (reason === "debrief") ) return "debrief";
  if ( d === null || d === undefined ) return "none";
  if ( KIND_CATEGORIES[kind] ) return KIND_CATEGORIES[kind];
  if ( kind.startsWith("name.") ) return "name";
  if ( d.type === "attack" ) return "attack";
  if ( d.type === "expand" ) return "expand";
  if ( (d.type === "stop") || /^stop/.test(reason ?? "") ) return "stop";
  if ( Array.isArray(d.placements) ) return "placement";
  if ( "fire" in d ) return d.fire ? "missile" : "missileHold";
  if ( Array.isArray(d.plays) ) return d.plays.length ? "scar" : "scarHold";
  if ( "buyRedStars" in d ) return d.buyRedStars?.length ? "buyStars" : "holdCards";
  if ( "join" in d ) return "join";
  if ( "recruit" in d ) return "recruit";
  if ( ("completeMission" in d) || ("draw" in d) ) return "endTurn";
  if ( d.cardId ) return "scar";
  if ( d.from && d.to && ("count" in d) ) return "maneuver";
  if ( "dice" in d ) return "defend";
  if ( "territory" in d ) return "start";
  if ( "value" in d ) return "choice";
  if ( "name" in d ) return "name";
  if ( "count" in d ) return "moveIn";
  for ( const [re, cat] of KIND_HINTS ) if ( re.test(record?.kind ?? "") ) return cat;
  return "other";
}

/** Categories posted to chat (BOTS.md §7.3). Others only appear in the Bot Log (a heuristic one gets a turn notice). */
export const NARRATED = new Set(["attack", "expand", "placement", "endTurn", "missile", "scar", "choice", "fallout", "seaLine",
  "alienIsland"]);

/* -------------------------------------------- */
/*  Lines                                       */
/* -------------------------------------------- */

/** Merge placements by territory: [{territory, count}] in first-seen order. */
export function mergePlacements(...lists) {
  const map = new Map();
  for ( const p of lists.flat() ) {
    if ( !p?.territory ) continue;
    map.set(p.territory, (map.get(p.territory) ?? 0) + (Number(p.count) || 0));
  }
  return [...map].map(([territory, count]) => ({ territory, count }));
}

/** The placeholder data for a record: names resolved, counts worded, plus what the decision itself says. */
function lineData(record, category, bot, extra = {}) {
  const d = record.decision ?? {};
  const why = d.why ?? {};
  const placements = extra.placements ?? d.placements ?? [];
  const plays = d.plays ?? [];
  const territory = why.territory ?? d.territory ?? d.join ?? placements[0]?.territory ?? plays[0]?.territory ?? d.to;
  const count = why.count ?? d.count ?? (placements.length ? placements.reduce((s, p) => s + (Number(p.count) || 0), 0) : undefined);
  const opponent = (category === "situation") ? (why.faction ?? d.leader) : why.faction;
  const data = {
    name: bot.name,
    territory: territoryName(territory),
    from: territoryName(why.from ?? d.from),
    to: territoryName(why.to ?? d.to),
    count: count ?? "",
    troops: (count !== undefined) && (count !== "") ? troops(count) : "",
    dice: (why.dice ?? d.dice) ? dice(why.dice ?? d.dice) : "",
    faction: factionName(opponent, record),
    value: why.value ?? "",
    label: why.label ?? d.label ?? "",
    kind: why.kind ?? "",
    places: placements.length ? list(placements.map(p => t("RL.Bots.Count.placeIn", {
      troops: troops(p.count), territory: territoryName(p.territory)
    }))) : "",
    scars: list(plays.map(p => t("RL.Bots.Count.scarOn", {
      scar: cardName(p.cardId) || t("RL.Bots.Missing.scar"), territory: territoryName(p.territory)
    }))),
    scar: cardName(d.cardId),
    card: cardName(d.draw?.cardId) ? t("RL.Bots.Count.card", { card: cardName(d.draw.cardId) }) : "",
    cards: d.tradeForTroops?.length ?? "",
    side: d.side ? t(`RL.Bots.Side.${d.side === "attacker" ? "attack" : (d.side === "defender" ? "defence" : d.side)}`) : "",
    written: d.name ?? "",
    a: territoryName(d.a ?? why.from),
    b: territoryName(d.b ?? why.to),
    targets: extra.expansions?.length ? list([...new Set(extra.expansions.map(m => m.to))].map(id => territoryName(id))) : ""
  };
  if ( (category === "situation") && (why.chance === undefined) && Number.isFinite(d.leaderP) && d.leader ) data.chance = d.leaderP;
  return data;
}

/** The action key for a record's category and decision. */
function actionKey(category, d, { expansions } = {}) {
  switch ( category ) {
    case "expand": return (expansions?.length > 1) ? "expandMany" : "expand";
    case "recruit": return d.tradeForTroops?.length ? "recruitTrade" : "recruit";
    case "endTurn":
      if ( d.completeMission ) return "completeMission";
      if ( d.draw?.coin ) return "drawCoin";
      if ( d.draw?.cardId ) return "drawCard";
      return "endTurn";
    case "moveIn": return Number(d.count) > 0 ? "moveIn" : "moveInNone";
    case "scar": return d.cardId ? "scarCard" : "scar";
    case "situation": return d.leader ? "situation" : "situationEven";
    default: return category;
  }
}

/**
 * The narration line for a decision record (plain text).
 * @param {object} record              a DecisionRecord (module/bots/log.mjs)
 * @param {object} [options]
 * @param {object[]} [options.placements]  merged placements, when several placement decisions become one line
 * @param {object[]} [options.expansions]  merged expansions [{from, to, count}], likewise
 * @returns {string}
 */
export function narrationLine(record, { placements, expansions } = {}) {
  const category = categoryOf(record);
  const bot = recordBot(record);
  const d = record.decision ?? {};
  const reason = d.why?.reason;
  const data = lineData(record, category, bot, { placements, expansions });
  const actKey = `RL.Bots.Act.${actionKey(category, d, { expansions })}`;
  let line = fill(game.i18n.has(actKey) ? game.i18n.localize(actKey) : game.i18n.localize("RL.Bots.Act.other"), data);

  // Reason clause. An unknown reason adds nothing to a known action (the Bot Log shows the raw reason); a decision
  // we can't read at all gets the generic clause.
  const whyKey = reason ? `RL.Bots.Why.${reason}` : null;
  if ( whyKey && game.i18n.has(whyKey) ) {
    const clause = fill(game.i18n.localize(whyKey), data).trim();
    if ( clause ) line += t("RL.Bots.Narration.because", { clause });
  }
  else if ( category === "other" ) line += t("RL.Bots.Narration.because", { clause: t("RL.Bots.Why._generic") });

  // Odds (an expansion can't fail: no odds)
  const chance = (category === "expand") ? null : (d.why?.chance ?? data.chance);
  if ( (chance !== null) && (chance !== undefined) && (chance !== "") && Number.isFinite(Number(chance)) ) {
    const key = game.i18n.has(`RL.Bots.Narration.chance_${category}`) ? `RL.Bots.Narration.chance_${category}` : "RL.Bots.Narration.chance";
    line += t(key, { chance: percent(chance) });
  }
  return t("RL.Bots.Narration.end", { line });
}

/** Short label of a record's category ("Attack", "Placement", ...). */
export function categoryLabel(category) {
  const key = `RL.Bots.Category.${category}`;
  return game.i18n.has(key) ? game.i18n.localize(key) : game.i18n.localize("RL.Bots.Category.other");
}

/** The "why" data as display rows (names resolved, chance as a percentage). */
export function whyRows(record) {
  const why = record?.decision?.why ?? {};
  return Object.entries(why).filter(([k]) => k !== "reason").map(([k, v]) => {
    let value = v;
    if ( k === "chance" ) value = percent(v);
    else if ( ["territory", "from", "to"].includes(k) && (typeof v === "string") ) value = `${territoryName(v)} (${v})`;
    else if ( (k === "faction") && (typeof v === "string") ) value = factionName(v, record);
    else if ( (v !== null) && (typeof v === "object") ) value = JSON.stringify(v);
    return { key: k, value: String(value ?? "") };
  });
}
