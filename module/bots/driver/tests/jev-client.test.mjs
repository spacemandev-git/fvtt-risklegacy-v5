// node --test module/bots/driver/tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createJevClient, isJevError, parseRetryAfter } from "../../jev/client.mjs";

const CFG = { relayUrl: "http://relay.test:30787/", token: "", model: "jev-latest" };
const REQUEST = {
  state: { me: "Balkania" },
  questions: { attack: { type: "noul", instructions: "Is attacking good?" }, risk: { type: "score", instructions: "How risky?", criteria: ["low", "high"] } }
};
const OK_BODY = {
  model: "jev-1.14.0",
  answers: { attack: { type: "noul", noul: 0.8 }, risk: { type: "score", score: 0.4, probabilities: { 0: 0.6, 1: 0.4 } } },
  usage: { input_tokens: 120, output_tokens: 4 }
};

/** A fake fetch that replays scripted responses and records calls. */
function fakeFetch(script) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const step = script[Math.min(calls.length - 1, script.length - 1)];
    if ( typeof step === "function" ) return step(url, init);
    if ( step instanceof Error ) throw step;
    const { status = 200, body = OK_BODY, headers = {} } = step;
    return {
      ok: (status >= 200) && (status < 300), status, statusText: "",
      headers: { get: k => headers[k.toLowerCase()] ?? null },
      text: async () => (typeof body === "string" ? body : JSON.stringify(body))
    };
  };
  fn.calls = calls;
  return fn;
}

const client = (fetch, extra = {}) => {
  const sleeps = [];
  const c = createJevClient({ fetch, config: () => ({ ...CFG, ...(extra.cfg ?? {}) }), sleep: async ms => { sleeps.push(ms); }, ...extra.opts });
  c.sleeps = sleeps;
  return c;
};

test("askJev adds the model, posts to the relay and returns the response", async () => {
  const fetch = fakeFetch([{ status: 200 }]);
  const exchanges = [];
  const res = await client(fetch).askJev(REQUEST, { purpose: "attack.targets", exchanges });
  assert.equal(res.model, "jev-1.14.0");
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, "http://relay.test:30787/v1/systemone");
  assert.equal(fetch.calls[0].init.method, "POST");
  assert.deepEqual(fetch.calls[0].body, { model: "jev-latest", state: REQUEST.state, questions: REQUEST.questions });
  assert.equal(fetch.calls[0].init.headers["X-RL-Bot-Token"], undefined);
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0].purpose, "attack.targets");
  assert.deepEqual(exchanges[0].request, fetch.calls[0].body);
  assert.equal(exchanges[0].response.usage.input_tokens, 120);
  assert.equal(exchanges[0].error, undefined);
});

test("askJev sends the relay token header when set", async () => {
  const fetch = fakeFetch([{ status: 200 }]);
  await client(fetch, { cfg: { token: "s3cret" } }).askJev(REQUEST);
  assert.equal(fetch.calls[0].init.headers["X-RL-Bot-Token"], "s3cret");
});

test("askJev retries 429 honouring Retry-After, then succeeds", async () => {
  const fetch = fakeFetch([{ status: 429, body: { detail: "slow down" }, headers: { "retry-after": "2" } }, { status: 200 }]);
  const c = client(fetch);
  const exchanges = [];
  const res = await c.askJev(REQUEST, { exchanges });
  assert.equal(res.answers.attack.noul, 0.8);
  assert.equal(fetch.calls.length, 2);
  assert.deepEqual(c.sleeps, [2000]);
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0].attempts, 2);
});

test("askJev retries 5xx and network errors twice, then throws a retryable JevError", async () => {
  const fetch = fakeFetch([{ status: 502, body: { detail: "Upstream error" } }, new TypeError("Failed to fetch"), { status: 503, body: "down" }]);
  const c = client(fetch);
  const exchanges = [];
  await assert.rejects(c.askJev(REQUEST, { purpose: "p", exchanges }), err => {
    assert.ok(isJevError(err));
    assert.equal(err.status, 503);
    assert.equal(err.retryable, true);
    assert.equal(err.attempts, 3);
    assert.equal(err.purpose, "p");
    return true;
  });
  assert.equal(fetch.calls.length, 3);
  assert.equal(c.sleeps.length, 2);
  assert.equal(exchanges.length, 1);
  assert.match(exchanges[0].error, /503/);
  assert.equal(exchanges[0].response, null);
});

test("askJev does not retry a 400/422 and reports the detail", async () => {
  const fetch = fakeFetch([{ status: 422, body: { detail: [{ loc: ["body", "questions", "risk"], msg: "Field required" }] } }]);
  await assert.rejects(client(fetch).askJev(REQUEST), err => {
    assert.equal(err.status, 422);
    assert.equal(err.retryable, false);
    assert.match(err.message, /body\.questions\.risk: Field required/);
    return true;
  });
  assert.equal(fetch.calls.length, 1);
});

test("askJev treats a missing answer as an error, never as an answer", async () => {
  const fetch = fakeFetch([{ status: 200, body: { ...OK_BODY, answers: { attack: OK_BODY.answers.attack } } }]);
  await assert.rejects(client(fetch).askJev(REQUEST), err => {
    assert.ok(isJevError(err));
    assert.match(err.message, /did not answer: risk/);
    return true;
  });
});

test("askJev times out (retryable) and refuses an empty question set", async () => {
  const hang = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("aborted")));
  });
  const fetch = fakeFetch([hang]);
  const c = client(fetch, { opts: { timeoutMs: 20, retries: 0 } });
  await assert.rejects(c.askJev(REQUEST), err => /timed out/.test(err.message) && err.retryable === true);
  await assert.rejects(c.askJev({ state: {}, questions: {} }), err => /no questions/.test(err.message));
});

test("an aborted call is a non-retryable JevError", async () => {
  const controller = new AbortController();
  const hang = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("aborted")));
  });
  const c = client(fakeFetch([hang]));
  const p = c.askJev(REQUEST, { signal: controller.signal });
  controller.abort();
  await assert.rejects(p, err => isJevError(err) && (err.retryable === false));
});

test("checkRelay: health, then one question", async () => {
  const fetch = fakeFetch([{ status: 200, body: { ok: true } }, { status: 200, body: { model: "jev-1.14.0", answers: { connected: { type: "noul", noul: 0.99 } }, usage: { input_tokens: 30 } } }]);
  const res = await client(fetch).checkRelay();
  assert.equal(res.ok, true);
  assert.equal(res.model, "jev-1.14.0");
  assert.equal(fetch.calls[0].url, "http://relay.test:30787/health");
  assert.equal(typeof res.latencyMs, "number");

  const down = await client(fakeFetch([new TypeError("ECONNREFUSED")])).checkRelay();
  assert.equal(down.ok, false);
  assert.match(down.error, /unreachable/);
});

test("parseRetryAfter reads seconds and HTTP dates", () => {
  assert.equal(parseRetryAfter("3"), 3000);
  assert.equal(parseRetryAfter(null), null);
  const now = Date.parse("2026-10-27T00:00:00Z");
  assert.equal(parseRetryAfter("Tue, 27 Oct 2026 00:00:05 GMT", now), 5000);
});
