/**
 * Jev relay status for the Bot Manager: the last `checkRelay()` result (cached per client), and the command that
 * starts a relay this browser can reach (tools/jev-proxy).
 */
import { SYSTEM_ID } from "../../config.mjs";
import { checkRelay } from "../jev/client.mjs";
import { SETTINGS, getSetting } from "../settings.mjs";

const DEFAULT_PORT = 30777;
const DEFAULT_ORIGINS = ["http://localhost:30000", "http://127.0.0.1:30000"];
const TIMEOUT_MS = 30_000;
const FRESH_MS = 60_000;

/** @type {{state: "unknown"|"checking"|"ok"|"error", ok?: boolean, latencyMs?: number, model?: string, error?: string, url?: string, at?: number}} */
let status = { state: "unknown" };
let pending = null;
let pendingKey = "";
const listeners = new Set();

/** The last known relay status (a result for another URL counts as unknown). */
export function relayStatus() {
  if ( (status.state !== "unknown") && status.url && (status.url !== getSetting(SETTINGS.relayUrl)) ) return { state: "unknown" };
  return status;
}

/** Call `fn()` whenever the status changes. @returns {Function} unsubscribe */
export function onRelayStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function set(next) {
  status = next;
  for ( const fn of listeners ) {
    try {
      fn(status);
    } catch(err) {
      console.error(err);
    }
  }
}

/**
 * Check the relay (once at a time). A thrown error or a hang counts as unreachable.
 * @param {{force?: boolean}} [options]  force = check even if the last result is recent
 */
export async function testRelay({ force = true } = {}) {
  const url = getSetting(SETTINGS.relayUrl);
  const key = `${url}|${getSetting(SETTINGS.relayToken)}`;
  if ( pending ) {
    // A check of the same relay is already running; a check of an old URL or token finishes first, then we re-check
    if ( pendingKey === key ) return pending;
    await pending.catch(() => {});
    return testRelay({ force: true });
  }
  if ( !force && (status.state !== "unknown") && (status.url === url) && (Date.now() - (status.at ?? 0) < FRESH_MS) ) return status;
  set({ ...status, state: "checking", url });
  pendingKey = key;
  const check = pending = (async () => {
    let result;
    try {
      result = await Promise.race([
        checkRelay(),
        new Promise((_, reject) => setTimeout(() => reject(new Error(game.i18n.localize("RL.Bots.Relay.timeout"))), TIMEOUT_MS))
      ]);
    } catch(err) {
      result = { ok: false, error: err?.message ?? String(err) };
    }
    result ??= { ok: false, error: game.i18n.localize("RL.Bots.Relay.noAnswer") };
    set({
      state: result.ok ? "ok" : "error", ok: !!result.ok, url, at: Date.now(),
      latencyMs: Number.isFinite(result.latencyMs) ? Math.round(result.latencyMs) : null,
      model: result.model ?? null,
      error: result.ok ? null : (result.error ? String(result.error) : game.i18n.localize("RL.Bots.Relay.unknownError"))
    });
    return status;
  })();
  try {
    return await check;
  } finally {
    if ( pending === check ) pending = null;
  }
}

/** Forget the last result (the URL or token changed). */
export function resetRelayStatus() {
  set({ state: "unknown" });
}

/**
 * The extra jev-proxy arguments this world needs: a non-default port, this page's origin, a token.
 * @returns {string[]}
 */
export function relayArgs() {
  const args = [];
  let url = null;
  try {
    url = new URL(getSetting(SETTINGS.relayUrl));
  } catch(err) { /* invalid URL: the field shows it */ }
  const port = Number(url?.port || 0);
  if ( port && (port !== DEFAULT_PORT) ) args.push("--port", String(port));
  const origin = window.location.origin;
  if ( !DEFAULT_ORIGINS.includes(origin) ) args.push("--allow-origin", origin);
  if ( getSetting(SETTINGS.relayToken) ) args.push("--token", game.i18n.localize("RL.Bots.Relay.tokenPlaceholder"));
  return args;
}

/** Shell commands that start the relay (macOS script, and plain Node for Windows/Linux). */
export function relayCommands() {
  const extra = relayArgs().map(a => (/\s|[<>]/.test(a) ? `"${a}"` : a)).join(" ");
  const keyFile = game.i18n.localize("RL.Bots.Relay.keyFilePlaceholder");
  return {
    folder: `Data/systems/${SYSTEM_ID}/tools/jev-proxy`,
    mac: ["./start-jev-relay.command", extra].filter(Boolean).join(" "),
    node: ["node tools/jev-proxy/jev-proxy.mjs", "--key-file", `"${keyFile}"`, extra].filter(Boolean).join(" "),
    extra
  };
}

/** Is a relay URL usable (http/https, has a host)? */
export function validRelayUrl(value) {
  try {
    const url = new URL(String(value ?? "").trim());
    return ["http:", "https:"].includes(url.protocol) && !!url.hostname;
  } catch(err) {
    return false;
  }
}
