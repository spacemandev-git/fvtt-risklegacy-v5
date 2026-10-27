/**
 * Bot settings (keys prefixed "bots."). The bots run on the active GM's client, so only world settings matter.
 */
import { SYSTEM_ID } from "../config.mjs";

export const SETTINGS = Object.freeze({
  relayUrl: "bots.relayUrl",
  relayToken: "bots.relayToken",
  model: "bots.model",
  pace: "bots.pace",
  reactionWindow: "bots.reactionWindow",
  narration: "bots.narration",
  onError: "bots.onError",
  paused: "bots.paused",
  // Chat-model bots (BOTS-LLM.md): an OpenAI-compatible API, Nous Portal by default.
  llmBaseUrl: "bots.llmBaseUrl",
  llmApiKey: "bots.llmApiKey",
  llmModel: "bots.llmModel",
  llmTimeout: "bots.llmTimeout",
  llmSpendLimit: "bots.llmSpendLimit",
  llmSpent: "bots.llmSpent",
  tableTalk: "bots.tableTalk"
});

export function registerBotSettings() {
  const reg = (key, data) => game.settings.register(SYSTEM_ID, key, {
    name: `RL.Bots.Settings.${key.slice(5)}.name`,
    hint: `RL.Bots.Settings.${key.slice(5)}.hint`,
    scope: "world", config: true, ...data
  });
  // Where the GM's browser sends Jev requests: the local relay (tools/jev-proxy). Never the API key itself.
  reg(SETTINGS.relayUrl, { type: String, default: "http://127.0.0.1:30777" });
  // Optional shared secret the relay checks (jev-proxy --token). Stops other web pages using the relay.
  reg(SETTINGS.relayToken, { type: String, default: "" });
  reg(SETTINGS.model, { type: String, default: "jev-latest" });
  // Delay between a bot's visible actions, so people can follow along. 0 = as fast as possible.
  reg(SETTINGS.pace, { type: Number, default: 800, range: { min: 0, max: 5000, step: 100 } });
  // Seconds a bot attacker waits before rolling and before resolving, when a person could still play a scar or fire a
  // missile. 0 = don't wait.
  reg(SETTINGS.reactionWindow, { type: Number, default: 8, range: { min: 0, max: 30, step: 1 } });
  reg(SETTINGS.narration, {
    type: String, default: "all",
    choices: { all: "RL.Bots.Settings.narration.all", gm: "RL.Bots.Settings.narration.gm", off: "RL.Bots.Settings.narration.off" }
  });
  // When Jev can't be reached: pause and ask the GM, or carry on with the built-in judgments (always logged).
  reg(SETTINGS.onError, {
    type: String, default: "ask",
    choices: { ask: "RL.Bots.Settings.onError.ask", heuristic: "RL.Bots.Settings.onError.heuristic" }
  });
  reg(SETTINGS.paused, { type: Boolean, default: false, config: false });

  // Chat-model bots (BOTS-LLM.md §4). Nous Portal's API accepts browser calls, so the active GM's browser calls it
  // directly with the key below, or through the local relay's /nous route (then leave the key empty).
  reg(SETTINGS.llmBaseUrl, { type: String, default: "https://inference-api.nousresearch.com/v1" });
  // The API key lives in THIS browser only (client scope, localStorage), never in the world database, so other
  // players never receive it. Set from the Bot Manager (GM only), hence config: false.
  reg(SETTINGS.llmApiKey, { type: String, default: "", scope: "client", config: false });
  // The model new chat bots use (each bot can pick its own in the Bot Manager). GLM 5.3 Flash: in the 2026-10-27
  // comparison (BOTS-LLM.md §10.2) it won the most games (3 of 6, too few to rank), never failed and was the fastest.
  reg(SETTINGS.llmModel, { type: String, default: "z-ai/glm-5.3-flash:US" });
  // Seconds before a chat-model call counts as failed (reasoning models can take a while).
  reg(SETTINGS.llmTimeout, { type: Number, default: 90, range: { min: 15, max: 300, step: 5 } });
  // Spending cap per war in US dollars, from the API's reported cost (0 = no cap). Reaching it pauses the bots.
  reg(SETTINGS.llmSpendLimit, { type: Number, default: 5, range: { min: 0, max: 50, step: 0.5 } });
  // Spend so far: {war: warId, usd, calls}. Kept by the driver.
  reg(SETTINGS.llmSpent, { type: Object, default: { war: "", usd: 0, calls: 0 }, config: false });
  // In-character table talk from chat-model bots: everyone, GM only, or off.
  reg(SETTINGS.tableTalk, {
    type: String, default: "all",
    choices: { all: "RL.Bots.Settings.tableTalk.all", gm: "RL.Bots.Settings.tableTalk.gm", off: "RL.Bots.Settings.tableTalk.off" }
  });
}

export const getSetting = key => game.settings.get(SYSTEM_ID, key);
export const setSetting = (key, value) => game.settings.set(SYSTEM_ID, key, value);
