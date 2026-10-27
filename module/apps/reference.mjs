import {
  CARDS_PER_RED_STAR, CITY_TYPES, FORTIFICATION_USES, MIN_RECRUIT, PHASE_ORDER, PHASES, RED_STARS_TO_WIN, TROOP_TRADE
} from "../config.mjs";
import * as state from "../state/_module.mjs";
import { board, CITY_ART, continentLabel, markInfo, scarInfo, t, territoryName, tpl } from "./helpers.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * The player aid: goal, turn overview with the numbered steps, the board's troop and coin-trade charts, 4 cards =
 * 1 Red Star, and what's currently written on this world (scars, cities, fortifications, continent values).
 */
export default class ReferenceApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "rl-reference",
    classes: ["risklegacy", "rl-reference"],
    window: { title: "RL.UI.Reference.Title", icon: "fa-solid fa-book-open", resizable: true },
    position: { width: 680, height: 720 }
  };

  static PARTS = {
    main: { template: tpl("apps/reference.hbs"), scrollable: [""] }
  };

  static async open() {
    const app = foundry.applications.instances.get(this.DEFAULT_OPTIONS.id) ?? new this();
    if ( app.rendered ) {
      app.bringToFront();
      return app;
    }
    return app.render({ force: true });
  }

  #unhook = null;

  /** @inheritDoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    context.goal = RED_STARS_TO_WIN;
    context.steps = PHASE_ORDER.map(id => ({
      id, label: t(PHASES[id].label), text: t(`RL.UI.Reference.StepText.${id}`)
    }));

    // Troops chart: (territories + population) ÷ 3, minimum 3, in bands of three
    const chart = [{ range: `0–${(MIN_RECRUIT * 3) + 2}`, troops: MIN_RECRUIT }];
    for ( let troops = MIN_RECRUIT + 1; troops <= 16; troops++ ) {
      chart.push({ range: `${troops * 3}–${(troops * 3) + 2}`, troops });
    }
    context.troopChart = chart;
    context.tradeChart = Object.entries(TROOP_TRADE).map(([coins, troops]) => ({ coins: Number(coins), troops }));
    context.cardsPerStar = CARDS_PER_RED_STAR;
    context.cardBacks = Array.from({ length: CARDS_PER_RED_STAR }, (_, i) => i);
    context.world = this.#world();
    return context;
  }

  /** What's on the board now. */
  #world() {
    const campaign = state.getCampaign();
    if ( !campaign ) return null;
    const b = board();
    const marks = campaign.system.territories ?? {};
    const scars = new Map();
    const cities = [];
    const fortified = [];
    const special = new Map();
    for ( const [id, m] of Object.entries(marks) ) {
      if ( m.scar ) {
        const info = scars.get(m.scar) ?? { ...scarInfo(m.scar), where: [] };
        info.where.push(territoryName(id, b));
        scars.set(m.scar, info);
      }
      if ( m.city?.type ) {
        cities.push({ territory: territoryName(id, b), name: m.city.name, type: m.city.type,
          label: t(CITY_TYPES[m.city.type]?.label ?? m.city.type), population: CITY_TYPES[m.city.type]?.population ?? 0,
          art: CITY_ART[m.city.type] });
        if ( m.fortification?.active && ((m.fortification.used ?? 0) < FORTIFICATION_USES) ) {
          fortified.push({ territory: territoryName(id, b), name: m.city.name,
            left: FORTIFICATION_USES - (m.fortification.used ?? 0) });
        }
      }
      for ( const mk of m.marks ?? [] ) {
        const info = special.get(mk) ?? { ...markInfo(mk), where: [] };
        info.where.push(territoryName(id, b));
        special.set(mk, info);
      }
    }
    cities.sort((a, c) => (c.population - a.population) || a.territory.localeCompare(c.territory));
    const continents = b ? Object.entries(b.continents).map(([id, def]) => {
      const c = campaign.system.continents?.[id] ?? {};
      return { id, label: continentLabel(id, b), name: c.name ?? "", value: (def.bonus ?? 0) + (c.modifier ?? 0),
        modifier: c.modifier ?? 0, namedBy: c.namedBy ?? "" };
    }) : [];
    return {
      scars: [...scars.values()].map(s => ({ ...s, where: s.where.join(", ") })),
      cities, fortified, continents,
      marks: [...special.values()].map(s => ({ ...s, where: s.where.join(", ") })),
      empty: !scars.size && !cities.length && !special.size
    };
  }

  /** @inheritDoc */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    const id = Hooks.on("updateActor", actor => {
      if ( (actor.type === "campaign") && this.rendered ) this.render();
    });
    this.#unhook = () => Hooks.off("updateActor", id);
  }

  /** @inheritDoc */
  _onClose(options) {
    this.#unhook?.();
    this.#unhook = null;
    super._onClose(options);
  }
}
