#!/usr/bin/env node
// Relay for the Risk Legacy bots: Jev (TypeSafe) and, optionally, the chat-model bots (Nous Portal).
//
// The TypeSafe API doesn't accept requests from browser pages (CORS), and the API key must not live in Foundry, so the
// GM's browser sends the Jev bots' questions here and this process forwards them with the key. The chat-model bots can
// call Nous Portal directly (it allows browser origins), or come through here (`/nous/v1`) to keep that key out of the
// browser too. Zero dependencies (Node 22+).
//
//   TYPESAFE_API_KEY=ts_... node tools/jev-proxy/jev-proxy.mjs
//   node tools/jev-proxy/jev-proxy.mjs --key-file ~/.typesafe-key --port 30777 --allow-origin https://my.foundry.host
//
// Options:
//   --key-file <path>       read the TypeSafe API key from a file instead of $TYPESAFE_API_KEY
//   --nous-key-file <path>  read the Nous Portal API key from a file (default ~/.config/risklegacy/nous-key when it
//                           exists, else $NOUS_API_KEY). Without one the /nous routes are off (or pass the browser's key on)
//   --nous-upstream <url>   Nous API base (default https://inference-api.nousresearch.com/v1)
//   --host <addr>           listen address (default 127.0.0.1: only this machine can reach it)
//   --port <n>              listen port (default 30777)
//   --allow-origin <url>    a Foundry origin allowed to call the proxy; repeatable. Default: http://localhost:30000 and
//                           http://127.0.0.1:30000. Pass "*" to allow any page (only sensible with --token).
//   --token <secret>        also require this value in the X-RL-Bot-Token header (set the same value in Foundry)
//   --upstream <url>        TypeSafe API base (default https://api.typesafe.ai)
//   --quiet                 don't log each request
// Forwarded: POST /v1/systemone and GET /v1/models (Jev); POST /nous/v1/chat/completions and GET /nous/v1/models (chat
// models; point the world setting bots.llmBaseUrl at http://127.0.0.1:<port>/nous/v1). GET /health answers
// {ok, jev, nous} without calling either API. At least one of the two keys is needed.
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

const MAX_BODY = 4 * 1024 * 1024; // the APIs' own limits are far below this for text-only requests
const UPSTREAM_TIMEOUT_MS = 30_000;
const NOUS_TIMEOUT_MS = 150_000;
export const NOUS_UPSTREAM = "https://inference-api.nousresearch.com/v1";
export const DEFAULT_NOUS_KEY_FILE = `${homedir()}/.config/risklegacy/nous-key`;

const expandHome = p => p.replace(/^~(?=\/)/, homedir());

export function parseArgs(argv) {
  const opts = {
    host: "127.0.0.1", port: 30777, origins: [], token: null, keyFile: null, upstream: "https://api.typesafe.ai",
    nousKeyFile: null, nousUpstream: NOUS_UPSTREAM, quiet: false
  };
  for ( let i = 0; i < argv.length; i++ ) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if ( (v === undefined) || v.startsWith("--") ) throw new Error(`${a} needs a value`);
      return v;
    };
    switch ( a ) {
      case "--host": opts.host = value(); break;
      case "--port": {
        const n = Number(value());
        if ( !Number.isInteger(n) || (n < 1) || (n > 65535) ) throw new Error("--port must be a number from 1 to 65535");
        opts.port = n;
        break;
      }
      case "--allow-origin": opts.origins.push(value().replace(/\/+$/, "")); break;
      case "--token": opts.token = value(); break;
      case "--key-file": opts.keyFile = expandHome(value()); break;
      case "--upstream": opts.upstream = value().replace(/\/+$/, ""); break;
      case "--nous-key-file": opts.nousKeyFile = expandHome(value()); break;
      case "--nous-upstream": opts.nousUpstream = value().replace(/\/+$/, ""); break;
      case "--quiet": opts.quiet = true; break;
      case "-h": case "--help": opts.help = true; break;
      default: throw new Error(`Unknown option ${a}`);
    }
  }
  if ( !opts.origins.length ) opts.origins = ["http://localhost:30000", "http://127.0.0.1:30000"];
  return opts;
}

/** The TypeSafe key (throws when there is none). */
export function readKey(opts, env = process.env) {
  const key = opts.keyFile ? readFileSync(opts.keyFile, "utf8").trim() : (env.TYPESAFE_API_KEY ?? "").trim();
  if ( !key ) throw new Error("No API key: set TYPESAFE_API_KEY or pass --key-file <path>");
  return key;
}

/**
 * Both keys: `jev` (TypeSafe) and `nous`, either may be null but not both. The Nous key comes from --nous-key-file,
 * else the default file when it exists, else $NOUS_API_KEY.
 * @returns {{jev: string|null, nous: string|null}}
 */
export function readKeys(opts, env = process.env, { exists = existsSync, read = p => readFileSync(p, "utf8") } = {}) {
  let jev = null;
  if ( opts.keyFile ) jev = read(opts.keyFile).trim() || null;
  else jev = (env.TYPESAFE_API_KEY ?? "").trim() || null;
  let nous = null;
  const nousFile = opts.nousKeyFile ?? (exists(DEFAULT_NOUS_KEY_FILE) ? DEFAULT_NOUS_KEY_FILE : null);
  if ( nousFile ) nous = read(nousFile).trim() || null;
  else nous = (env.NOUS_API_KEY ?? "").trim() || null;
  if ( !jev && !nous ) throw new Error("No API key: set TYPESAFE_API_KEY or pass --key-file <path> (Jev), and/or --nous-key-file <path> (chat models)");
  return { jev, nous };
}

/** The CORS origin to echo back, or null when the origin isn't allowed. */
export function allowedOrigin(origin, origins) {
  if ( !origin ) return null;
  if ( origins.includes("*") ) return origin;
  return origins.includes(origin.replace(/\/+$/, "")) ? origin : null;
}

/**
 * @param {object} opts         parseArgs() result
 * @param {string|{jev?: string|null, nous?: string|null}} keys   the TypeSafe key, or both keys
 * @param {{fetchImpl?: Function, log?: Function}} [deps]
 */
export function createProxy(opts, keys, { fetchImpl = fetch, log = console.log } = {}) {
  const { jev: jevKey = null, nous: nousKey = null } = typeof keys === "string" ? { jev: keys } : (keys ?? {});
  const nousUpstream = (opts.nousUpstream ?? NOUS_UPSTREAM).replace(/\/+$/, "");
  const routes = {
    "POST /v1/systemone": { api: "jev", url: () => `${opts.upstream}/v1/systemone`, timeout: UPSTREAM_TIMEOUT_MS },
    "GET /v1/models": { api: "jev", url: () => `${opts.upstream}/v1/models`, timeout: UPSTREAM_TIMEOUT_MS },
    "POST /nous/v1/chat/completions": { api: "nous", url: () => `${nousUpstream}/chat/completions`, timeout: NOUS_TIMEOUT_MS, stream: true },
    "GET /nous/v1/models": { api: "nous", url: () => `${nousUpstream}/models`, timeout: NOUS_TIMEOUT_MS, stream: true }
  };
  return createServer(async (req, res) => {
    const origin = allowedOrigin(req.headers.origin, opts.origins);
    const cors = () => (origin ? {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-RL-Bot-Token, TypeSafe-Danger-Zone-Long-Context",
      "Access-Control-Max-Age": "600"
    } : {});
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", Vary: "Origin", ...headers, ...cors() });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    const path = (req.url ?? "/").split("?")[0];

    // Browsers send an Origin on cross-origin requests; refuse pages that aren't the configured Foundry
    if ( req.headers.origin && !origin ) return send(403, { detail: `Origin ${req.headers.origin} is not allowed (start the proxy with --allow-origin ${req.headers.origin})` });
    if ( req.method === "OPTIONS" ) return send(204, "");
    if ( (req.method === "GET") && (path === "/health") ) {
      return send(200, { ok: true, upstream: opts.upstream, token: !!opts.token, jev: !!jevKey, nous: !!nousKey, nousUpstream });
    }
    if ( opts.token && (req.headers["x-rl-bot-token"] !== opts.token) ) return send(401, { detail: "Missing or wrong X-RL-Bot-Token" });
    const route = routes[`${req.method} ${path}`];
    if ( !route ) return send(404, { detail: `Not proxied: ${req.method} ${path}` });

    // The relay's key; a /nous call without one may bring its own (the browser's key), which is passed on as is.
    const ownKey = route.api === "jev" ? jevKey : nousKey;
    const passKey = (route.api === "nous") && !ownKey && /^Bearer\s+\S+/.test(req.headers.authorization ?? "") ? req.headers.authorization : null;
    if ( !ownKey && !passKey ) {
      const which = route.api === "jev" ? "TypeSafe key (--key-file or TYPESAFE_API_KEY)" : "Nous key (--nous-key-file or ~/.config/risklegacy/nous-key)";
      return send(503, { status: 503, code: "relay_no_key", detail: `The relay was started without a ${which}.`, message: `The relay was started without a ${which}.` });
    }

    let body;
    if ( req.method === "POST" ) {
      const chunks = [];
      let size = 0;
      for await ( const chunk of req ) {
        size += chunk.length;
        if ( size > MAX_BODY ) return send(413, { detail: "Request too large" });
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks).toString("utf8");
    }
    const headers = { Authorization: ownKey ? `Bearer ${ownKey}` : passKey, Accept: "application/json" };
    if ( body !== undefined ) headers["Content-Type"] = "application/json";
    if ( (route.api === "jev") && req.headers["typesafe-danger-zone-long-context"] ) headers["TypeSafe-Danger-Zone-Long-Context"] = "true";
    const target = route.url();
    const label = `${req.method} ${path}`;
    const t0 = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`upstream timed out after ${route.timeout / 1000} s`)), route.timeout);
    // The page went away (e.g. the browser's own timeout): stop the upstream call too.
    res.on("close", () => {
      if ( !res.writableFinished ) controller.abort(new Error("client closed the connection"));
    });
    try {
      const upstream = await fetchImpl(target, { method: req.method, headers, body, signal: controller.signal });
      const extra = {};
      const retryAfter = upstream.headers.get?.("retry-after");
      if ( retryAfter ) extra["Retry-After"] = retryAfter;
      if ( route.stream && upstream.body && (typeof upstream.body.getReader === "function") ) {
        // Streamed back as is (status, content type, body bytes).
        res.writeHead(upstream.status, {
          "Content-Type": upstream.headers.get?.("content-type") ?? "application/json", Vary: "Origin", ...extra, ...cors()
        });
        const stream = Readable.fromWeb(upstream.body);
        stream.on("error", err => {
          if ( !opts.quiet ) log(`${new Date().toISOString()} ${label} → stream error: ${err.message}`);
          res.destroy(err);
        });
        stream.on("end", () => {
          clearTimeout(timer);
          if ( !opts.quiet ) log(`${new Date().toISOString()} ${label} → ${upstream.status} ${Date.now() - t0}ms`);
        });
        stream.pipe(res);
        return;
      }
      const text = await upstream.text();
      clearTimeout(timer);
      if ( !opts.quiet ) log(`${new Date().toISOString()} ${label} → ${upstream.status} ${Date.now() - t0}ms`);
      return send(upstream.status, text, extra);
    } catch(err) {
      clearTimeout(timer);
      const reason = controller.signal.aborted ? (controller.signal.reason?.message ?? err.message) : err.message;
      if ( !opts.quiet ) log(`${new Date().toISOString()} ${label} → upstream error: ${reason}`);
      if ( res.headersSent || res.destroyed ) return;
      const status = /timed out/.test(reason) ? 504 : 502;
      return send(status, { status, detail: `Upstream error: ${reason}`, message: `Upstream error: ${reason}` });
    }
  });
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch(err) { console.error(err.message); process.exit(2); }
  if ( opts.help ) {
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter(l => l.startsWith("//")).map(l => l.slice(3)).join("\n"));
    return;
  }
  let keys;
  try { keys = readKeys(opts); }
  catch(err) { console.error(err.message); process.exit(2); }
  if ( opts.origins.includes("*") && !opts.token ) console.warn("Warning: --allow-origin * without --token lets any web page you open spend your API credit.");
  const server = createProxy(opts, keys);
  server.listen(opts.port, opts.host, () => {
    console.log(`Bots relay listening on http://${opts.host}:${opts.port}`);
    console.log(`  Jev:         ${keys.jev ? `/v1 → ${opts.upstream}` : "off (no TypeSafe key)"}`);
    console.log(`  Chat models: ${keys.nous ? `/nous/v1 → ${opts.nousUpstream}` : "off (no Nous key; set bots.llmBaseUrl to Nous directly)"}`);
    console.log(`Allowed Foundry origins: ${opts.origins.join(", ")}${opts.token ? " (token required)" : ""}`);
  });
}

if ( process.argv[1] && (import.meta.url === pathToFileURL(process.argv[1]).href) ) main();
