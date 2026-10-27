import { ENFORCEMENT, SYSTEM_ID } from "./config.mjs";

/**
 * Core settings. Areas register their own settings in their init() (keys prefixed by area, e.g. "canvas.showCounts").
 */
export function registerSettings() {
  game.settings.register(SYSTEM_ID, "campaignActorId", {
    scope: "world", config: false, type: String, default: ""
  });

  game.settings.register(SYSTEM_ID, "enforcement", {
    name: "RL.Settings.enforcement.name",
    hint: "RL.Settings.enforcement.hint",
    scope: "world", config: true, type: String, default: "strict",
    choices: ENFORCEMENT
  });

  game.settings.register(SYSTEM_ID, "defenderChoice", {
    name: "RL.Settings.defenderChoice.name",
    hint: "RL.Settings.defenderChoice.hint",
    scope: "world", config: true, type: String, default: "auto",
    choices: { auto: "RL.Settings.defenderChoice.auto", prompt: "RL.Settings.defenderChoice.prompt" }
  });

  /** Schema version of world data, for future migrations. */
  game.settings.register(SYSTEM_ID, "worldSchemaVersion", {
    scope: "world", config: false, type: Number, default: 1
  });
}
