// node --test module/bots/driver/tests/   (the relay in tools/jev-proxy: routes, keys, origins, streaming)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createProxy, parseArgs, readKeys, NOUS_UPSTREAM, DEFAULT_NOUS_KEY_FILE } from "../../../../tools/jev-proxy/jev-proxy.mjs";

const ORIGIN = "http://localhost:30021";

/** Start a proxy on a free port with a fake upstream fetch; returns {url, calls, close}. */
async function start(keys, upstream, extraArgs = []) {
  const opts = parseArgs(["--port", "1", "--allow-origin", ORIGIN, "--quiet", ...extraArgs]);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return upstream(url, init);
  };
  const server = createProxy(opts, keys, { fetchImpl, log: () => {} });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, calls, close: () => new Promise(resolve => server.close(resolve)) };
}

const jsonResponse = (status, body, headers = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), {
  status, headers: { "content-type": "application/json", ...headers }
});

test("parseArgs knows the Nous options; readKeys finds the Nous key and needs at least one key", () => {
  const o = parseArgs(["--nous-key-file", "~/k", "--nous-upstream", "https://x.test/v1/"]);
  assert.match(o.nousKeyFile, /\/k$/);
  assert.ok(!o.nousKeyFile.startsWith("~"));
  assert.equal(o.nousUpstream, "https://x.test/v1");
  assert.equal(parseArgs([]).nousUpstream, NOUS_UPSTREAM);
  const files = { "/jev": "ts_key\n", "/nous": "nous_key\n", [DEFAULT_NOUS_KEY_FILE]: "default_nous\n" };
  const io = has => ({ exists: p => has && (p in files), read: p => files[p] });
  assert.deepEqual(readKeys({ keyFile: "/jev", nousKeyFile: "/nous" }, {}, io(true)), { jev: "ts_key", nous: "nous_key" });
  assert.deepEqual(readKeys({ keyFile: null, nousKeyFile: null }, { TYPESAFE_API_KEY: "env" }, io(true)), { jev: "env", nous: "default_nous" });
  assert.deepEqual(readKeys({ keyFile: null, nousKeyFile: null }, { TYPESAFE_API_KEY: "env" }, io(false)), { jev: "env", nous: null });
  assert.deepEqual(readKeys({ keyFile: null, nousKeyFile: null }, { NOUS_API_KEY: "n" }, io(false)), { jev: null, nous: "n" });
  assert.throws(() => readKeys({ keyFile: null, nousKeyFile: null }, {}, io(false)), /No API key/);
});

test("POST /nous/v1/chat/completions is forwarded with the relay's Nous key and streamed back as is", async () => {
  const body = { choices: [{ message: { content: "{\"ok\":true}" }, finish_reason: "stop" }], usage: { cost: 0.0001 } };
  const p = await start({ jev: "ts", nous: "nous-secret" }, () => jsonResponse(200, body));
  try {
    const res = await fetch(`${p.url}/nous/v1/chat/completions`, {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify({ model: "m", messages: [] })
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), ORIGIN);
    assert.deepEqual(await res.json(), body);
    assert.equal(p.calls.length, 1);
    assert.equal(p.calls[0].url, `${NOUS_UPSTREAM}/chat/completions`);
    assert.equal(p.calls[0].init.method, "POST");
    assert.equal(p.calls[0].init.headers.Authorization, "Bearer nous-secret");
    assert.deepEqual(JSON.parse(p.calls[0].init.body), { model: "m", messages: [] });
  } finally {
    await p.close();
  }
});

test("GET /nous/v1/models, upstream errors and Retry-After pass through; /health reports both APIs", async () => {
  let n = 0;
  const p = await start({ jev: null, nous: "k" }, () => {
    n += 1;
    if ( n === 1 ) return jsonResponse(200, { data: [{ id: "z-ai/glm-5.3" }] });
    return jsonResponse(429, { status: 429, message: "slow down" }, { "retry-after": "4" });
  });
  try {
    const models = await fetch(`${p.url}/nous/v1/models`, { headers: { Origin: ORIGIN } });
    assert.equal(models.status, 200);
    assert.equal((await models.json()).data[0].id, "z-ai/glm-5.3");
    assert.equal(p.calls[0].url, `${NOUS_UPSTREAM}/models`);
    const limited = await fetch(`${p.url}/nous/v1/chat/completions`, { method: "POST", headers: { Origin: ORIGIN }, body: "{}" });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "4");
    assert.equal((await limited.json()).message, "slow down");
    const health = await (await fetch(`${p.url}/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.jev, false);
    assert.equal(health.nous, true);
    // Jev routes are off without a TypeSafe key
    const jev = await fetch(`${p.url}/v1/systemone`, { method: "POST", body: "{}" });
    assert.equal(jev.status, 503);
  } finally {
    await p.close();
  }
});

test("without a Nous key the route answers 503, unless the browser brings its own key", async () => {
  const p = await start({ jev: "ts", nous: null }, () => jsonResponse(200, { choices: [] }));
  try {
    const none = await fetch(`${p.url}/nous/v1/chat/completions`, { method: "POST", headers: { Origin: ORIGIN }, body: "{}" });
    assert.equal(none.status, 503);
    assert.equal((await none.json()).code, "relay_no_key");
    assert.equal(p.calls.length, 0);
    const own = await fetch(`${p.url}/nous/v1/chat/completions`, { method: "POST", headers: { Origin: ORIGIN, Authorization: "Bearer browser-key" }, body: "{}" });
    assert.equal(own.status, 200);
    assert.equal(p.calls[0].init.headers.Authorization, "Bearer browser-key");
  } finally {
    await p.close();
  }
});

test("origin and token checks apply to the Nous routes; the preflight allows Authorization", async () => {
  const p = await start({ jev: "ts", nous: "k" }, () => jsonResponse(200, {}), ["--token", "t0k"]);
  try {
    const evil = await fetch(`${p.url}/nous/v1/models`, { headers: { Origin: "https://evil.test" } });
    assert.equal(evil.status, 403);
    const noToken = await fetch(`${p.url}/nous/v1/models`, { headers: { Origin: ORIGIN } });
    assert.equal(noToken.status, 401);
    const ok = await fetch(`${p.url}/nous/v1/models`, { headers: { Origin: ORIGIN, "X-RL-Bot-Token": "t0k" } });
    assert.equal(ok.status, 200);
    const pre = await fetch(`${p.url}/nous/v1/chat/completions`, { method: "OPTIONS", headers: { Origin: ORIGIN } });
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get("access-control-allow-headers"), /Authorization/);
    assert.equal(p.calls.length, 1);
  } finally {
    await p.close();
  }
});

test("Jev routes still use the TypeSafe key", async () => {
  const p = await start("ts-only", () => jsonResponse(200, { answers: {} }));
  try {
    const res = await fetch(`${p.url}/v1/systemone`, { method: "POST", headers: { Origin: ORIGIN }, body: "{}" });
    assert.equal(res.status, 200);
    assert.equal(p.calls[0].init.headers.Authorization, "Bearer ts-only");
    assert.equal(p.calls[0].url, "https://api.typesafe.ai/v1/systemone");
    const nous = await fetch(`${p.url}/nous/v1/models`, { headers: { Origin: ORIGIN } });
    assert.equal(nous.status, 503);
  } finally {
    await p.close();
  }
});
