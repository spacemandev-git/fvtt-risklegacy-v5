// node --test module/bots/driver/tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LLMError, buildBody, createLLMClient, extractReasoning, isLLMError, leadingJSON, lowerEffort, modelEntry,
  parseJSONContent, salvageJSON, salvageLoose, sanitizeReasoning, schemaProblem
} from "../../llm/client.mjs";

const CFG = { baseUrl: "https://llm.test/v1/", apiKey: "", model: "z-ai/glm-5.3", timeoutMs: 90_000 };
const SCHEMA = {
  name: "move",
  schema: {
    type: "object", additionalProperties: false, required: ["thinking", "choice", "say"],
    properties: {
      thinking: { type: "string" },
      choice: { type: "string", enum: ["attack_ukraine", "attack_egypt", "stop"] },
      say: { type: "string" }
    }
  }
};
const REQUEST = {
  model: "deepseek/deepseek-v4-flash",
  messages: [{ role: "system", content: "You play Risk Legacy." }, { role: "user", content: "Pick one." }],
  schema: SCHEMA, reasoning: { effort: "low" }, maxTokens: 1500, temperature: 0.6
};
const completion = (content, { finish = "stop", cost = 0.0012, reasoning, usage = {} } = {}) => ({
  id: "gen-1", model: "deepseek/deepseek-v4-flash",
  choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", content, ...(reasoning ? { reasoning } : {}) } }],
  usage: { prompt_tokens: 400, completion_tokens: 60, total_tokens: 460, cost, ...usage }
});
const GOOD = JSON.stringify({ thinking: "Ukraine is the HQ.", choice: "attack_ukraine", say: "Your fortress is sand." });

/** A fake fetch that replays scripted responses and records calls. */
function fakeFetch(script) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const step = script[Math.min(calls.length - 1, script.length - 1)];
    if ( typeof step === "function" ) return step(url, init);
    if ( step instanceof Error ) throw step;
    const { status = 200, body = completion(GOOD), headers = {} } = step;
    return {
      ok: (status >= 200) && (status < 300), status, statusText: "",
      headers: { get: k => headers[k.toLowerCase()] ?? null },
      text: async () => (typeof body === "string" ? body : JSON.stringify(body))
    };
  };
  fn.calls = calls;
  return fn;
}

const client = (fetch, { cfg = {}, ...opts } = {}) => {
  const sleeps = [];
  let t = 0;
  const c = createLLMClient({
    fetch, config: () => ({ ...CFG, ...cfg }), sleep: async ms => { sleeps.push(ms); }, now: () => (t += 5), random: () => 0, ...opts
  });
  c.sleeps = sleeps;
  return c;
};

test("askLLM posts the OpenAI-compatible body and returns the parsed answer with its cost", async () => {
  const fetch = fakeFetch([{ body: completion(GOOD, { reasoning: "Thinking about Ukraine." }) }]);
  const exchanges = [];
  const res = await client(fetch).askLLM(REQUEST, { purpose: "attack.plan", exchanges });
  assert.equal(fetch.calls.length, 1);
  const call = fetch.calls[0];
  assert.equal(call.url, "https://llm.test/v1/chat/completions");
  assert.equal(call.init.method, "POST");
  assert.deepEqual(call.body, {
    model: "deepseek/deepseek-v4-flash", messages: REQUEST.messages, max_tokens: 1500, temperature: 0.6,
    response_format: { type: "json_schema", json_schema: { name: "move", strict: true, schema: SCHEMA.schema } },
    reasoning: { effort: "low" }
  });
  // No key set (relay): no Authorization header, and no custom headers beyond Content-Type/Accept (CORS).
  assert.deepEqual(Object.keys(call.init.headers).sort(), ["Accept", "Content-Type"]);
  assert.equal(res.parsed.choice, "attack_ukraine");
  assert.equal(res.cost, 0.0012);
  assert.equal(res.reasoning, "Thinking about Ukraine.");
  assert.equal(res.model, "deepseek/deepseek-v4-flash");
  assert.equal(res.usage.prompt_tokens, 400);
  assert.ok(res.ms > 0);
  assert.equal(exchanges.length, 1);
  const x = exchanges[0];
  assert.equal(x.engine, "llm");
  assert.equal(x.purpose, "attack.plan");
  assert.deepEqual(Object.keys(x.request).sort(), ["max_tokens", "messages", "model", "reasoning", "schema", "temperature"]);
  assert.equal(x.request.schema, SCHEMA);
  assert.equal(x.response.parsed.choice, "attack_ukraine");
  assert.equal(x.response.cost, 0.0012);
  assert.equal(x.response.finish, "stop");
  assert.equal(x.error, undefined);
});

test("askLLM sends the Bearer key when one is set, and uses the configured model when the request has none", async () => {
  const fetch = fakeFetch([{}]);
  await client(fetch, { cfg: { apiKey: "sk-test" } }).askLLM({ ...REQUEST, model: undefined });
  assert.equal(fetch.calls[0].init.headers.Authorization, "Bearer sk-test");
  assert.equal(fetch.calls[0].body.model, "z-ai/glm-5.3");
});

test("reasoning {enabled:false} is never sent (GLM quirk): it becomes {effort: low}", () => {
  assert.deepEqual(sanitizeReasoning({ enabled: false }), { effort: "low" });
  assert.deepEqual(sanitizeReasoning({ effort: "medium" }), { effort: "medium" });
  assert.equal(sanitizeReasoning(null), null);
  const body = buildBody({ ...REQUEST, reasoning: { enabled: false }, seed: 7 });
  assert.deepEqual(body.reasoning, { effort: "low" });
  assert.equal(body.seed, 7);
  assert.equal(buildBody({ ...REQUEST, reasoning: null }).reasoning, undefined);
});

test("askLLM retries 429 honouring Retry-After, then 5xx and network errors, then succeeds", async () => {
  const fetch = fakeFetch([
    { status: 429, body: { status: 429, message: "slow down" }, headers: { "retry-after": "3" } },
    { status: 503, body: "upstream down" },
    { status: 200 }
  ]);
  const c = client(fetch);
  const exchanges = [];
  const res = await c.askLLM(REQUEST, { exchanges });
  assert.equal(res.parsed.choice, "attack_ukraine");
  assert.equal(fetch.calls.length, 3);
  assert.equal(c.sleeps[0], 3000);
  assert.equal(c.sleeps.length, 2);
  assert.equal(exchanges.length, 3);
  assert.equal(exchanges[0].code, "rate_limited");
  assert.equal(exchanges[1].code, "server");
  assert.equal(exchanges[2].error, undefined);
});

test("askLLM gives up after two transport retries with a retryable LLMError", async () => {
  const fetch = fakeFetch([new TypeError("Failed to fetch"), { status: 502, body: "bad gateway" }, { status: 500, body: "boom" }]);
  const exchanges = [];
  await assert.rejects(client(fetch).askLLM(REQUEST, { exchanges }), err => {
    assert.ok(isLLMError(err));
    assert.equal(err.status, 500);
    assert.equal(err.retryable, true);
    assert.equal(err.attempts, 3);
    return true;
  });
  assert.equal(fetch.calls.length, 3);
  assert.deepEqual(exchanges.map(x => x.code), ["network", "server", "server"]);
});

test("a timeout is retryable and reported as such", async () => {
  const hang = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("aborted")));
  });
  const fetch = fakeFetch([hang]);
  await assert.rejects(client(fetch, { cfg: { timeoutMs: 20 }, retries: 1 }).askLLM(REQUEST), err => {
    assert.equal(err.code, "timeout");
    assert.equal(err.retryable, true);
    assert.match(err.message, /timed out/);
    return true;
  });
  assert.equal(fetch.calls.length, 2);
});

test("model_blocked_by_org_policy (403) is not retried and says the model isn't allowed", async () => {
  const fetch = fakeFetch([{ status: 403, body: { status: 403, message: "Model 'z-ai/glm-5.3-flash' is not permitted by your organization's model policy.", code: "model_blocked_by_org_policy" } }]);
  const exchanges = [];
  await assert.rejects(client(fetch).askLLM({ ...REQUEST, model: "z-ai/glm-5.3-flash" }, { exchanges }), err => {
    assert.equal(err.code, "model_blocked_by_org_policy");
    assert.equal(err.retryable, false);
    assert.equal(err.status, 403);
    assert.match(err.message, /isn't allowed for this API key's organisation/);
    assert.match(err.message, /z-ai\/glm-5\.3-flash/);
    return true;
  });
  assert.equal(fetch.calls.length, 1);
  assert.equal(exchanges.length, 1);
});

test("401 (bad key) is not retried", async () => {
  const fetch = fakeFetch([{ status: 401, body: { status: 401, message: "Your API key is invalid" } }]);
  await assert.rejects(client(fetch).askLLM(REQUEST), err => err.code === "auth" && !err.retryable && /invalid/.test(err.message));
  assert.equal(fetch.calls.length, 1);
});

test("an error body with HTTP 200 is an error, not an answer", async () => {
  const fetch = fakeFetch([{ body: { error: { message: "Provider returned error", code: 502 } } }, { status: 200 }]);
  const res = await client(fetch).askLLM(REQUEST);
  assert.equal(res.parsed.choice, "attack_ukraine");
  assert.equal(fetch.calls.length, 2);
});

test("bad output gets one corrective retry with the assistant text and the reason", async () => {
  const bad = JSON.stringify({ thinking: "Hmm", choice: "attack_mars", say: "" });
  const fetch = fakeFetch([{ body: completion(bad, { cost: 0.001 }) }, { body: completion(GOOD, { cost: 0.002 }) }]);
  const exchanges = [];
  const res = await client(fetch).askLLM(REQUEST, { exchanges });
  assert.equal(res.parsed.choice, "attack_ukraine");
  assert.equal(res.cost, 0.002);
  assert.ok(Math.abs(res.totalCost - 0.003) < 1e-9);
  assert.equal(fetch.calls.length, 2);
  const retry = fetch.calls[1].body.messages;
  assert.equal(retry.length, REQUEST.messages.length + 2);
  assert.deepEqual(retry[2], { role: "assistant", content: bad });
  assert.equal(retry[3].role, "user");
  assert.match(retry[3].content, /^That wasn't valid JSON for the schema: .*choice must be one of .*Answer again with only the JSON\.$/);
  // The original request is untouched, both attempts are logged, the failed one with its cost
  assert.equal(REQUEST.messages.length, 2);
  assert.equal(exchanges.length, 2);
  assert.equal(exchanges[0].code, "bad_output");
  assert.equal(exchanges[0].response.cost, 0.001);
  assert.equal(exchanges[1].request.messages.length, 4);
});

test("bad output twice throws LLMError bad_output", async () => {
  const fetch = fakeFetch([{ body: completion("Sure! I attack Ukraine.") }, { body: completion("{\"thinking\": \"x\"}") }]);
  await assert.rejects(client(fetch).askLLM(REQUEST), err => {
    assert.equal(err.code, "bad_output");
    assert.match(err.message, /required key "choice" is missing/);
    return true;
  });
  assert.equal(fetch.calls.length, 2);
});

test("finish_reason length counts as bad output", async () => {
  const fetch = fakeFetch([{ body: completion("{\"thinking\": \"I am thinking a lot", { finish: "length" }) }, { body: completion(GOOD) }]);
  const exchanges = [];
  const res = await client(fetch).askLLM(REQUEST, { exchanges });
  assert.equal(res.parsed.choice, "attack_ukraine");
  assert.match(exchanges[0].error, /cut off at max_tokens \(1500\)/);
});

test("a code fence and a <think> block around the JSON are accepted without a retry", async () => {
  const fetch = fakeFetch([{ body: completion(`<think>plan</think>\n\`\`\`json\n${GOOD}\n\`\`\`\n`) }]);
  const res = await client(fetch).askLLM(REQUEST);
  assert.equal(res.parsed.say, "Your fortress is sand.");
  assert.equal(fetch.calls.length, 1);
});

test("empty content with the answer filed under reasoning: a schema-valid JSON object there is accepted (salvaged)", async () => {
  const reasoning = `Khan has 9 in Ural. {"note": "draft"}\n{"thinking": "Hold {the} line", "choice": "stop", "say": "Not today."}`;
  const fetch = fakeFetch([{ body: completion(null, { reasoning }) }]);
  const exchanges = [];
  const res = await client(fetch).askLLM(REQUEST, { exchanges });
  assert.equal(fetch.calls.length, 1);
  assert.equal(res.parsed.choice, "stop");
  assert.equal(res.parsed.thinking, "Hold {the} line");
  assert.equal(exchanges[0].response.salvaged, "reasoning");
  assert.equal(exchanges[0].error, undefined);
});

test("empty content and no usable JSON in the reasoning is bad output, and says where the reply went", async () => {
  const reasoning = "I would probably stop here. Not today.";
  const fetch = fakeFetch([{ body: completion(null, { reasoning }) }, { body: completion(null, { reasoning: "{\"choice\": \"attack_mars\"}" }) }]);
  await assert.rejects(client(fetch).askLLM(REQUEST), err => {
    assert.equal(err.code, "bad_output");
    assert.match(err.message, /empty \(the model put its reply in its reasoning\)/);
    return true;
  });
  // Two unchanged resends (an empty reply is a dropped reply), then one corrective retry.
  assert.equal(fetch.calls.length, 4);
  assert.equal(fetch.calls[1].body.messages.length, REQUEST.messages.length);
  assert.equal(fetch.calls[3].body.messages.length, REQUEST.messages.length + 2);
});

test("an empty reply is resent unchanged and the next good answer is used", async () => {
  const fetch = fakeFetch([{ body: completion("") }, { body: completion(GOOD) }]);
  const res = await client(fetch).askLLM(REQUEST);
  assert.equal(res.parsed.choice, "attack_ukraine");
  assert.equal(fetch.calls.length, 2);
  assert.deepEqual(fetch.calls[1].body.messages, fetch.calls[0].body.messages);
});

test("reasoning that used up max_tokens is retried with less reasoning", async () => {
  const fetch = fakeFetch([{ body: completion("", { finish: "length" }) }, { body: completion(GOOD) }]);
  const res = await client(fetch).askLLM(REQUEST);
  assert.equal(res.parsed.choice, "attack_ukraine");
  assert.equal(fetch.calls[0].body.reasoning.effort, "low");
  assert.equal(fetch.calls[1].body.reasoning.effort, "minimal");
  assert.deepEqual(lowerEffort({ effort: "medium" }), { effort: "low" });
  assert.equal(lowerEffort({ effort: "minimal" }), null);
});

test("an answer cut off after a complete JSON object is accepted", async () => {
  const fetch = fakeFetch([{ body: completion(`${GOOD}\n\n   \n  `, { finish: "length" }) }]);
  const res = await client(fetch).askLLM(REQUEST);
  assert.equal(res.parsed.choice, "attack_ukraine");
  assert.equal(fetch.calls.length, 1);
  assert.equal(leadingJSON(`junk ${GOOD}`, SCHEMA.schema), null);
  assert.equal(leadingJSON('{"thinking":"a","choice":"nope","say":""}', SCHEMA.schema), null);
});

test("salvageJSON finds the last schema-valid object, nested braces and strings included", () => {
  const schema = SCHEMA.schema;
  assert.equal(salvageJSON("no json here", schema), null);
  assert.deepEqual(salvageJSON('x {"thinking":"a \\"q\\" }","choice":"stop","say":""} y', schema), { thinking: 'a "q" }', choice: "stop", say: "" });
  assert.equal(salvageJSON('{"thinking":"a","choice":"nope","say":""}', schema), null);
  assert.deepEqual(salvageJSON('{"outer": {"thinking":"a","choice":"stop","say":"b"}}', schema), { thinking: "a", choice: "stop", say: "b" });
});

test("parseJSONContent and schemaProblem", () => {
  assert.deepEqual(parseJSONContent("  {\"a\": 1}  "), { ok: true, value: { a: 1 } });
  assert.deepEqual(parseJSONContent("```\n[1,2]\n```"), { ok: true, value: [1, 2] });
  assert.equal(parseJSONContent("").ok, false);
  assert.match(parseJSONContent("{a: 1}").reason, /not valid JSON/);
  const schema = {
    type: "object", required: ["plan", "stopWhen"],
    properties: {
      plan: { type: "array", items: { $ref: "#/$defs/step" } },
      stopWhen: { type: "string", enum: ["after_first_conquest", "never"] },
      note: { type: ["string", "null"] }
    },
    $defs: { step: { type: "object", required: ["option"], properties: { option: { type: "string", enum: ["a", "b"] }, keepAtLeast: { type: "integer" } } } }
  };
  assert.equal(schemaProblem({ plan: [{ option: "a", keepAtLeast: 2 }], stopWhen: "never", note: null }, schema), null);
  assert.match(schemaProblem({ plan: [{ option: "c" }], stopWhen: "never" }, schema), /plan\[0\]\.option must be one of "a", "b"/);
  assert.match(schemaProblem({ plan: [{ option: "a", keepAtLeast: 1.5 }], stopWhen: "never" }, schema), /keepAtLeast must be of type integer/);
  assert.match(schemaProblem({ plan: [] }, schema), /required key "stopWhen"/);
  assert.match(schemaProblem("text", schema), /must be of type object/);
  assert.equal(schemaProblem({ x: 1 }, { anyOf: [{ type: "string" }, { type: "object" }] }), null);
});

test("extractReasoning reads reasoning, reasoning_content or provider_specific_fields", () => {
  assert.equal(extractReasoning({ reasoning: "a" }), "a");
  assert.equal(extractReasoning({ reasoning_content: "b" }), "b");
  assert.equal(extractReasoning({ provider_specific_fields: { reasoning: "c" } }), "c");
  assert.equal(extractReasoning({ content: "x" }), "");
});

test("long reasoning is kept whole in the result but cut to 4000 chars in the log", async () => {
  const long = "r".repeat(5000);
  const fetch = fakeFetch([{ body: completion(GOOD, { reasoning: long }) }]);
  const exchanges = [];
  const res = await client(fetch).askLLM(REQUEST, { exchanges });
  assert.equal(res.reasoning.length, 5000);
  assert.equal(exchanges[0].response.reasoning.length, 4000);
});

test("no model and no messages are errors before any call", async () => {
  const fetch = fakeFetch([{}]);
  const exchanges = [];
  await assert.rejects(client(fetch, { cfg: { model: "" } }).askLLM({ ...REQUEST, model: "" }, { exchanges }), err => err.code === "no_model");
  await assert.rejects(client(fetch).askLLM({ ...REQUEST, messages: [] }), err => err.code === "bad_request_shape");
  assert.equal(fetch.calls.length, 0);
  assert.equal(exchanges.length, 1);
});

test("an aborted signal stops without retries", async () => {
  const controller = new AbortController();
  controller.abort();
  const fetch = fakeFetch([(url, init) => Promise.reject(new Error("aborted"))]);
  await assert.rejects(client(fetch).askLLM(REQUEST, { signal: controller.signal }), err => err.code === "aborted");
  assert.equal(fetch.calls.length, 1);
});

const MODELS = {
  data: [
    {
      id: "z-ai/glm-5.3", name: "Z.ai: GLM 5.3", context_length: 200000,
      architecture: { modality: "text->text", output_modalities: ["text"] },
      pricing: { prompt: "0.0000009100", completion: "0.0000028600" },
      supported_parameters: ["reasoning", "reasoning_effort", "response_format", "structured_outputs"]
    },
    {
      id: "deepseek/deepseek-v4-flash", name: "DeepSeek: V4 Flash", context_length: 128000,
      architecture: { output_modalities: ["text"] }, pricing: { prompt: "0.0000000449", completion: "0.00000045" },
      supported_parameters: ["response_format"]
    },
    { id: "old/no-structured", name: "Old", architecture: { output_modalities: ["text"] }, pricing: { prompt: "0.000001", completion: "0.000002" }, supported_parameters: ["max_tokens"] },
    { id: "amazon/titan-embed", name: "Embed", architecture: { modality: "text+image->embeddings", output_modalities: ["embeddings"] }, supported_parameters: ["response_format"] }
  ]
};

test("listModels keeps structured text models, converts prices per million, and caches for 10 minutes", async () => {
  const fetch = fakeFetch([{ body: MODELS }]);
  const c = client(fetch, { cfg: { apiKey: "sk-test" } });
  const list = await c.listModels();
  assert.equal(fetch.calls[0].url, "https://llm.test/v1/models");
  assert.equal(fetch.calls[0].init.method, "GET");
  assert.equal(fetch.calls[0].init.headers.Authorization, "Bearer sk-test");
  assert.deepEqual(list.map(m => m.id), ["deepseek/deepseek-v4-flash", "z-ai/glm-5.3"]);
  const glm = list.find(m => m.id === "z-ai/glm-5.3");
  assert.deepEqual(glm, { id: "z-ai/glm-5.3", name: "Z.ai: GLM 5.3", inPerM: 0.91, outPerM: 2.86, context: 200000, structured: true, reasoning: true });
  assert.equal(list[0].inPerM, 0.0449);
  assert.equal(list[0].reasoning, false);
  await c.listModels();
  assert.equal(fetch.calls.length, 1);
  await c.listModels({ refresh: true });
  assert.equal(fetch.calls.length, 2);
});

test("listModels returns [] on failure (the error stays readable), or throws with throwOnError", async () => {
  const fetch = fakeFetch([{ status: 401, body: { status: 401, message: "bad key" } }]);
  const c = client(fetch);
  assert.deepEqual(await c.listModels(), []);
  assert.equal(c.lastListError().code, "auth");
  await assert.rejects(c.listModels({ throwOnError: true }), err => err.code === "auth");
});

test("modelEntry", () => {
  assert.equal(modelEntry({ id: "x", supported_parameters: [] }), null);
  assert.equal(modelEntry(null), null);
});

test("checkLLM: /models then a one-line structured call", async () => {
  const fetch = fakeFetch([{ body: MODELS }, { body: completion("{\"ok\": true}", { cost: 0.00001 }) }]);
  const r = await client(fetch, { cfg: { apiKey: "sk" } }).checkLLM({ model: "deepseek/deepseek-v4-flash" });
  assert.equal(r.ok, true);
  assert.equal(r.keySet, true);
  assert.equal(r.error, null);
  assert.ok(r.latencyMs > 0);
  assert.equal(fetch.calls[1].body.model, "deepseek/deepseek-v4-flash");
  assert.equal(fetch.calls[1].body.response_format.json_schema.strict, true);
  assert.deepEqual(fetch.calls[1].body.reasoning, { effort: "low" });
});

test("checkLLM reports an unreachable API and a blocked model", async () => {
  const down = await client(fakeFetch([new TypeError("Failed to fetch")])).checkLLM();
  assert.equal(down.ok, false);
  assert.match(down.error, /unreachable/);
  assert.equal(down.keySet, false);
  const blocked = await client(fakeFetch([{ body: MODELS }, { status: 403, body: { code: "model_blocked_by_org_policy", message: "no" } }])).checkLLM({ model: "z-ai/glm-5.3-flash" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "model_blocked_by_org_policy");
  assert.match(blocked.error, /isn't allowed/);
});

test("LLMError carries its data", () => {
  const e = new LLMError("x", { status: 429, code: "rate_limited", retryable: true });
  assert.equal(e.name, "LLMError");
  assert.ok(isLLMError(e));
  assert.ok(isLLMError({ name: "LLMError" }));
  assert.ok(!isLLMError(new Error("x")));
});

test("salvageLoose reads an answer written as key: value lines in the reasoning (DeepSeek V4 Flash, 2026-10-27)", async () => {
  const S = props => ({ type: "object", additionalProperties: false, required: Object.keys(props), properties: props });
  const choice = keys => S({ thinking: { type: "string" }, choice: { type: "string", enum: keys }, say: { type: "string" } });
  // Real replies from the probe and the e2e game (empty content, the answer under `reasoning`).
  assert.deepEqual(salvageLoose("Ontario offers the most.\n\nchoice:ontario\nsay:\"Six exits.\"", choice(["ontario", "peru"])),
    { thinking: "", choice: "ontario", say: "Six exits." });
  assert.deepEqual(salvageLoose("Six neighbours.\n\nchoiceontario\n\nsayOntario. Nine within reach.", choice(["ontario", "peru"])),
    { thinking: "", choice: "ontario", say: "" });
  assert.deepEqual(salvageLoose("say(\"Old line.\")\nthinking(\"One game away.\")\nsay(\"New line.\")\nchoice(\"found_a_major_city\")",
    choice(["found_a_major_city", "name_a_continent"])), { thinking: "One game away.", choice: "found_a_major_city", say: "New line." });
  const plan = S({
    thinking: { type: "string" }, steps: { type: "array", items: { type: "string", enum: ["attack_russia", "stop_now"] } },
    keep_at_least: { type: "integer" }, stop_when: { type: "string", enum: ["after_first_conquest", "keep_going"] }, say: { type: "string" }
  });
  assert.deepEqual(salvageLoose("say:\"The gate opens.\"\nsteps:[\"attack_russia\"]\nkeep_at_least:0\nstop_when:\"after_first_conquest\"",
    plan), { thinking: "", steps: ["attack_russia"], keep_at_least: 0, stop_when: "after_first_conquest", say: "The gate opens." });
  // Never a guess: an unknown option, a missing decision field or prose alone is not an answer.
  assert.equal(salvageLoose("choice: attack_the_moon", choice(["ontario"])), null);
  assert.equal(salvageLoose("I think Ontario is best.", choice(["ontario"])), null);
  assert.equal(salvageLoose("steps:[\"attack_russia\"]\nstop_when:keep_going", plan), null);
  // Through askLLM: an empty reply whose reasoning holds such lines is the answer, without a resend.
  const fetch = fakeFetch([{ body: completion("", { reasoning: "Ukraine is the HQ.\nchoice: attack_ukraine\nsay: Sand." }) }]);
  const res = await client(fetch).askLLM(REQUEST);
  assert.equal(res.parsed.choice, "attack_ukraine");
  assert.equal(fetch.calls.length, 1);
});
