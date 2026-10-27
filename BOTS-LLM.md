# Chat-model bots: AI players with personalities (design and area contract)

A second kind of bot player, next to the Jev bots of `BOTS.md`. These bots are driven by a **chat LLM** through an
OpenAI-compatible API (Nous Portal by default: `z-ai/glm-5.3`, `z-ai/glm-5.3-flash:US`, DeepSeek). Each has one of
ten **personalities** that changes both how it plays and how it talks, a **difficulty** that limits what it knows,
and at higher levels it thinks about the **campaign** and keeps **notes across games**.

Read `BOTS.md` first (and `ARCHITECTURE.md` for the system). Everything there still holds unless this file says
otherwise: the driver, the GM action bus, the hook points, the public-information rule, the testing rules.

**User decisions (2026-10-27):**
- The LLM **picks from menus**: code lists the legal moves with exact odds and facts, and the LLM chooses, in
  character. It can never make an illegal move.
- Personalities give a **play style plus table talk**: short in-character chat lines at key moments. People don't
  talk back to the bots (not in scope).
- **Notes across games**: normal and hard bots write a short memo after each game, which they read in later games.
- The testing budget on Nous Portal is **$30 in total**. Each builder's share is in §9.

---

## 1. Player experience

- **Adding a bot:** in the Bot Manager the GM clicks **Add chat bot** and picks a personality (or *Random*), a level
  and a model.
  - Each personality has a name, an epithet, a portrait and a one-line blurb, such as "Marshal Ada Kestrel, *The Iron
    Wall*". The bot's user is named after its personality.
  - **Randomize personalities** gives every chat bot a different personality.
- **Connecting:**
  - The GM pastes a Nous Portal API key into the Bot Manager. It is stored **in that browser only** (client
    setting) and never in the world.
  - *Test* shows the latency and whether the chosen model is allowed for the key's organisation.
  - The model list comes live from the API (`GET /models`) and shows prices.
- **During play:**
  - Chat bots play like Jev bots: the same narration lines and the same battle cards.
  - They also post **table talk**: short in-character lines spoken by the bot ("You call that a fortress? I've seen
    sturdier sandcastles."), for example on a big attack, losing or taking an HQ, a missile, the end of a game, or
    sometimes the start of a turn.
  - The setting `bots.tableTalk` controls where these go: everyone, GM only, or off.
- **After a war:** each normal or hard chat bot writes a short debrief into its memory: notes, grudges, lessons, and
  one line about the game. The GM can read or clear it from the Bot Manager.
- **Bot Log:** shows every chat exchange: the model, the messages, the parsed answer, the reasoning (collapsed),
  tokens, **cost** and time. The Bot Manager shows the spend for this war.
- **Spend cap (`bots.llmSpendLimit`, $ per war, default 5):** reaching it pauses the bots, and the GM can raise the
  cap or switch to built-in judgment.
- **Errors:** handled like Jev's (`BOTS.md` §6.6). A failed call is an error, never an answer, and the GM gets
  *Retry / Use built-in judgment / Pause*.

## 2. Architecture

```
GM browser (active GM only)
 driver/ ── decide({fn}) ──► engine dispatch:  ctx.bot.engine === "llm" ? llm/brain : brain (Jev)
                                   │
                    llm/brain ── ctx.chat(purpose, request) ──► llm/client askLLM ──► {bots.llmBaseUrl}/chat/completions
                       │  menus, odds, facts from brain/candidates|odds|features (shared, pure)      (Nous Portal, CORS *)
                       │  wording: llm/prompts.mjs + llm/lore.mjs + llm/personalities.mjs        or relay :30777/nous/v1
                       └─ heuristic mode (ctx.chat === null): the Jev brain's built-in judgment (ask = null)
 ui/ ── narrate(record) posts narration + record.say (table talk); Bot Manager; Bot Log
```

- The LLM brain is **pure** like the Jev brain: no Foundry globals. It is tested in Node with a fake `chat` and
  probed live from Node with the key file.
- **Same Brain API** (`BOTS.md` §5) plus `debrief`. The driver's turn loop, battles and answer dispatcher are
  unchanged. Only the dispatch in `decide()` and the context gathering learn about engines.

## 3. Bot users (done; `module/bots/users.mjs`)

`flags[SYSTEM_ID].bot = {difficulty, engine: "jev"|"llm", model: string|null, personality: string|null, memory}`.
Bots without `engine` are Jev bots. The exports:
- `ENGINES`;
- `botInfo(u)` → `{difficulty, engine, model, personality, memory}`, where `model: null` means the setting
  `bots.llmModel`;
- `botEngine`, `botPersonality(u)` → the Personality object;
- `createBot({difficulty, name, engine, model, personality})`, where `personality` is an id, `"random"` or `null`;
  the latter two pick a random unused one;
- `setBotConfig(u, {difficulty?, engine?, model?, personality?}, {rename=true})`; changing a personality also renames
  the bot and changes its avatar while those are still the personality defaults;
- `setBotDifficulty` (kept), `setBotMemory(u, memory)`, `clearBotMemory(u)`;
- `usedPersonalities()`, `randomPersonality({except, exclude, random})`.

`BotMemory` = `{notes, grudges:[{user, text, game}], lessons:[], games:[{game, faction, result, summary}], updated}`.
Grudges are keyed by the other player's **User id**, never a name (§7).

## 4. Transport (bots-llm-core: `module/bots/llm/client.mjs`)

### 4.1 Settings (done; `module/bots/settings.mjs`)
| Key | Scope | Default | Use |
|---|---|---|---|
| `bots.llmBaseUrl` | world | `https://inference-api.nousresearch.com/v1` | or the relay's `http://127.0.0.1:30777/nous/v1` |
| `bots.llmApiKey` | **client**, config:false | `""` | Bearer key, set in the Bot Manager; empty when using the relay |
| `bots.llmModel` | world | `z-ai/glm-5.3-flash:US` (was `z-ai/glm-5.3` until §10.2) | default model for chat bots without their own |
| `bots.llmTimeout` | world | 90 s | per call |
| `bots.llmSpendLimit` | world | $5 | per war, 0 = none |
| `bots.llmSpent` | world, config:false | `{war, usd, calls}` | kept by the driver |
| `bots.tableTalk` | world | `all` | `all` / `gm` / `off` |

### 4.2 `askLLM(request, {purpose, exchanges, signal})`

**Request:** `{model, messages, schema: {name, schema}, reasoning: {effort} | null, maxTokens, temperature, seed?}`.
The call POSTs `${baseUrl}/chat/completions` with:
- the body `{model, messages, max_tokens, temperature, response_format: {type: "json_schema", json_schema: {name,
  strict: true, schema}}, reasoning}`;
- `Authorization: Bearer <key>` only when a key is set, plus `Content-Type`. No other custom headers (CORS).

**Response:** `{parsed, content, reasoning, model, usage, cost, ms}`.
- `cost` is `usage.cost` in USD, which Nous reports on every response.
- `reasoning` is `message.reasoning ?? message.reasoning_content ?? message.provider_specific_fields?.reasoning`.

**Failures** throw `LLMError {status, code, detail, retryable}`:
- **Retries:** two, with backoff that honours `Retry-After`, on 429, 5xx, network errors and timeouts
  (`bots.llmTimeout`).
- **`model_blocked_by_org_policy` (403)** is not retryable. Its message says the model isn't allowed for the key's
  organisation.
- **Bad output gets one corrective retry, then `LLMError {code: "bad_output"}`.** Bad output means any of:
  - `finish_reason === "length"`;
  - content that isn't valid JSON after trimming (and after stripping a code fence);
  - a required key missing;
  - a value outside an `enum`.

  The retry appends the assistant's text and a user message: "That wasn't valid JSON for the schema: <reason>. Answer
  again with only the JSON."
- **Known model quirk (probe, 2026-10-27):** `z-ai/glm-5.3` with `reasoning: {enabled: false}` filled `max_tokens`
  with whitespace. Never send `enabled:false`; use `{effort: "low"}` instead.
- **Empty answers aren't format errors** (as built, from the probes):
  - With empty content, a schema-valid JSON object found in the reasoning is accepted (`response.salvaged`).
  - With empty content and `finish_reason: "stop"` (the provider dropped the reply), the same request is resent,
    counted as a transport retry.
  - With empty content and `finish_reason: "length"` (the reasoning used up `max_tokens`), the request is resent
    with the reasoning effort one step lower, at most twice.
  - With `finish_reason: "length"` after a complete, schema-valid JSON object (GLM 5.3 sometimes runs on), that
    object is accepted (`response.truncatedTail`).

**Logging:** push each exchange `{engine: "llm", purpose, request: {model, messages, schema, reasoning, max_tokens,
temperature}, response: {content, parsed, reasoning (first 4000 chars), usage, cost, finish}, ms, error}` onto
`exchanges`. Push failed attempts too.

### 4.3 The other client functions
- `checkLLM({model})` → `{ok, latencyMs, model, keySet, error}`: `GET /models`, then a one-line structured call to
  `model`.
- `listModels({refresh})` → `[{id, name, inPerM, outPerM, context, structured, reasoning}]`.
  - It comes from `GET ${baseUrl}/models` **with** the key, which returns only the models the organisation allows.
  - Keep models with text output whose `supported_parameters` include `response_format` or `structured_outputs`.
  - Cache the list for 10 minutes. Prices are per million tokens.

### 4.4 Relay route (bots-llm-core: `tools/jev-proxy/**`)

The relay is **optional**: Nous allows browser origins, and the main path is direct. It also gives tests and
cautious GMs a way to keep the key out of the browser:
- `--nous-key-file`, defaulting to `~/.config/risklegacy/nous-key` when that file exists, and `--nous-upstream`
  (`https://inference-api.nousresearch.com/v1`).
- It routes `POST /nous/v1/chat/completions` and `GET /nous/v1/models` with the same origin and token checks, a 150 s
  timeout, and the response streamed back as is.
- `/health` reports `nous: true|false`.
- The start script passes the Nous key file when it exists, and never prompts for it.

### 4.5 Facts from the probe (2026-10-27)

- **Allowed models.** The user's organisation allows `z-ai/glm-5.3` ($0.91 in / $2.86 out per million tokens),
  `z-ai/glm-5.3-flash:US` ($0.25 / $0.83), `deepseek/deepseek-v4-flash` ($0.04 / $0.45), and
  `deepseek/deepseek-v4.1-flash:US` and `deepseek/deepseek-v4-flash-0731:US` ($0.36 / $1.09). The Flash model
  without `:US`, and the `~…-latest` aliases, return 403.
- **Structured output** (`json_schema`, strict) worked on all four models tried.
- **Latency on a small prompt:**

  | Model and reasoning | Latency |
  |---|---|
  | GLM 5.3, default reasoning | 2.9 s |
  | GLM 5.3, effort low | 4.4 s |
  | GLM 5.3 Flash (US), default reasoning (632 reasoning tokens) | 6.5 s |
  | DeepSeek V4.1 Flash (US), default reasoning (1075 reasoning tokens) | 6.9 s |
  | DeepSeek V4 Flash | 1.3 s |

- **`say` lines run long:** GLM 5.3 wrote about 60 words. Code caps them (§5.4).

## 5. Personalities, lore and wording (bots-llm-content: `llm/personalities.mjs`, `llm/lore.mjs`)

### 5.1 Ten personalities
The shape is in the JSDoc of `llm/personalities.mjs`. Keep the exported names.
- **Archetypes:** ten clearly different ones that a person can tell apart at the table. For example:
  - the patient turtle;
  - the berserker;
  - the vulture who finishes off the weak;
  - the grudge-keeper;
  - the cold mathematician who quotes odds;
  - the glory-hunter who goes for HQs;
  - the continent zealot;
  - the campaign long-gamer who cares about legacy;
  - the gambler;
  - the theatrical schemer who talks a lot.
- **Content rules:** original names, no real people or trademarks, PG-13, no slurs and nothing hateful.
- **Portraits:** core Foundry icons that **exist** in v14 (verify under the Foundry install's `public/icons`).
  Distinct per personality.

### 5.2 Knobs, also used by code (bots-llm-brain)
- `risk` 0..1 shifts the menu's odds floor and the replan threshold (risky personalities see and take thinner odds).
- `aggression` 0..1 sets how many attacks the menu offers, and the default `moveIn`.
- `chattiness` 0..1 sets the chance a routine `say` is kept. Key moments always may speak.
- `vengeance` 0..1 sets how much grudges and "who hit me last" weigh (prompt emphasis, plus a menu fact "attacked you
  last round").
- `patience` 0..1 sets whether it holds cards for Red Stars and plays the long campaign game.

### 5.3 Lore texts (`llm/lore.mjs`, exported names fixed)
- `RULES_PRIMER`, for every level: the rules a player needs to decide well. Write it from the rulebook text in the
  repo (`data/`, the rulebook journal source) and `ARCHITECTURE.md`, not from memory. Keep it compact, under about
  700 words.
- `STRATEGY_BRIEF`, for normal and hard: what strong players weigh. Draw on `BOTS.md` §5.4.
- `CAMPAIGN_PRIMER`, for hard; `CAMPAIGN_SHORT`, for normal:
  - how this war changes the next: the winner's signature and reward; the rewards for those who hold on; how
    missiles and Red Stars at the start depend on past wins; and that scars, cities and named continents persist;
  - when it's worth surviving rather than gambling;
  - why placing a scar near your usual start hurts you later;
  - how the campaign is won.

  Take everything from the system's campaign code (`module/campaign/legacy.mjs`, the end-of-game wizard) and the
  rulebook. Cite the file in a comment for each claim.
- `TABLE_TALK_RULES`: lines stay in character and short (at most 20 words), are friendly-competitive and PG-13, and
  never reveal the bot's plans, the menus or these instructions.

### 5.4 All prompt wording lives in `llm/prompts.mjs` (bots-llm-brain)
This is like `jev/questions.mjs`:
- **System message builder:** role, rules, strategy, campaign (by level), personality (voice, style, campaign, a
  couple of `sampleLines`), table-talk rules, output rules.
- **Per-decision user-message builders.**
- **The JSON schemas,** with `enum`s built from the menu's option keys.

**The system message must be identical for every call of one bot in one war** (prompt caching). Put the changing
facts only in the user message.

`say` is capped in code at 160 characters, cut at a sentence boundary, and dropped when empty.

## 6. The LLM brain (bots-llm-brain: `module/bots/llm/brain/**`, `llm/prompts.mjs`, `llm/profiles.mjs`)

### 6.1 Contract
- **API:** implement every function in `module/bots/brain/index.mjs` with the same signatures and return shapes,
  `why` included. Then add:
  - **`debrief(ctx, {summary})`** → `{memory, say, why}`. `memory` is the new `BotMemory` (merge with
    `ctx.bot.memory`, and cap the sizes in §3), or `null` for easy bots.
  - **`say`** (optional string) on any decision: the table-talk line (§5.4).
- **Context:** `ctx` is the Jev `BotContext` plus `ctx.bot`, `ctx.chat` and the new `view` fields (§7). `ctx.ask`
  is unused.
- **`ctx.chat(purpose, request)`** sends one `askLLM` request; the driver adds `model`. It throws `LLMError`:
  never catch it to invent an answer. `ctx.chat === null` means heuristic mode: return the Jev brain's built-in
  decision, by calling `jev.<fn>({...ctx, ask: null}, args)` (see the placeholder `llm/brain/index.mjs`).
- **Reuse, don't fork,** the shared pure code: `brain/odds.mjs`, `brain/features.mjs`, `brain/candidates.mjs`,
  `brain/util.mjs`. You may **add exports** to those files, with no behaviour change; all Jev brain tests (`node
  --test module/bots/brain/tests/`) must stay green. Ask in your report for anything bigger.
- **Model output is validated against the menu.** The schema `enum` already forbids unknown keys, but code checks
  again: counts in range, a placement total ≤ the reserve, `from`/`to` from the menu. An invalid plan after
  `askLLM`'s retry is treated as an `LLMError {code: "bad_output"}` (thrown), never silently replaced.

### 6.2 Calls per turn (target 2–5; the latency budget is about 30 s of model time per hard-bot turn)
Design the calls; this is the intended shape:
1. **Turn plan, at the first `planStartOfTurn` of a turn.** One call covers the start of the turn up to the
   placement:
   - cards: buy a Red Star / trade for N troops / hold;
   - start-of-turn scar plays (the code-made menu of card × top targets);
   - Join the War, when knocked out (a menu of legal territories with facts);
   - placement, as a menu of fronts. Code states facts such as "with all N placed here, your best attack from here
     is 74% to take Ukraine".

   The plan is cached for the turn, and `planScars`, `planRecruit` and `planPlacement` read it. Recruit totals,
   trade values and legality are code's (rules).
2. **The attack plan, at the first `nextMove` after placement:**
   - **Menu:** the code-made candidates (attacks with exact odds, expected losses and what a take changes;
     expansions), trimmed by the profile and the personality's `risk`.
   - **Output:** an ordered list of `{option, keepAtLeast?}` plus `stopWhen`, chosen from a small enum such as
     "after first conquest" / "when odds drop below X" / "never".
   - **Execution:** code runs the plan step by step, recomputing the odds before each attack.
   - **Replans:** at most the profile's count, when a planned attack's odds fall below its floor, a battle is lost,
     or the plan runs out while good options remain.
3. **End of turn, at `planManeuver`:** one call for the maneuver (a menu of code-made consolidations) and the
   end-of-turn draw / mission completion (`planEndOfTurn` reads the cached answer). Completing a mission that's
   `complete` and `canComplete` is code's call, as in the Jev brain.

- **Code-only decisions** (no call):
  - `moveIn`, from the plan's `keepAtLeast` and the HQ floor, with the personality's `aggression` setting the
    default;
  - `chooseDefenseDice` (the Jev brain's exact odds);
  - `pickName`, which is synchronous: pick from `personality.names[kind]`, avoiding `used`, else the Jev brain's
    `pickName`.
- **Reactive calls, only when code finds a real choice:**
  - `missileDecision` and `preRollScar`. Use the Jev brain's heuristic as the pre-filter: no call when it says
    "obviously no". These are short prompts.
  - `chooseOption` (events, rewards, the faction pick), `chooseStartingTerritory` (top candidates with facts) and
    `debrief`. For end-of-game rewards and choices with campaign effect, hard bots get the campaign context.

### 6.3 Difficulty profiles (`llm/profiles.mjs`): what each level is allowed to know

| | Recruit (easy) | Commander (normal) | Warlord (hard) |
|---|---|---|---|
| Board context | own territories + neighbours, its HQ, Red Star counts | + every faction's stars, troops, territories, continents; threats to its HQ | + hand counts and coins, mission, events, powers, `view.recent` (what happened since its last turn) |
| Odds in menus | verbal bands only ("good chance") | exact % with bands | exact % + expected losses + what the take changes |
| Menu | 5 options, lightly pre-scored (may include poor ones) | 6, without options under 25% (unless code says decisive) | 8, plus 2–3-step chains; HQ floor enforced by code |
| Replans per turn | 0 | 1 | 2 |
| Rules / strategy / campaign | rules only | + strategy + `CAMPAIGN_SHORT` | + `CAMPAIGN_PRIMER` + `view.campaign` facts |
| Memory | none, no debrief | reads `notes` + grudges; writes debrief | reads everything; writes debrief |
| Reasoning, temperature | `{effort: "low"}`, 0.9 | `{effort: "low"}`, 0.6 | `{effort: "medium"}` for attack plans, replans, choices and the debrief; `low` for the turn plan, end of turn, missiles and scars (GLM 5.3 took 14–31 s on a medium turn plan); 0.3 |
| max_tokens | 1500 | 2500 | 5000 |

The personality changes the style within a level; the level changes the knowledge and the guardrails. The model is
the GM's choice per bot. Code must not assume a particular model.

### 6.4 Prompt rules
- **Facts stated outright, computed by code:** odds, counts, "one Red Star from winning", "this take breaks
  Balkania's continent bonus". Chat models are better at this than Jev but still slip.
- **Short.** Every field must matter for this decision. Options are keyed by descriptive slugs (`attack_ukraine_from_
  middle_east`), never `A`/`1`.
- **`thinking` comes before the choice in the schema,** limited to 1–3 sentences. The Bot Log shows it, and narration
  may use it for `why.label`.
  - **Keep the key `thinking`** (`prompts.mjs` `RATIONALE`), measured on DeepSeek V4 Flash with the same 20
    decisions (2026-10-27):
    - With `thinking`, 18 of 28 replies came back with empty content. The client recovered 10 from the reasoning
      and resent the rest; all 20 decisions succeeded, at a median of 3.7 s per call.
    - With `rationale`, there were almost no empty replies, but the reasoning grew to a median of 1,372 tokens
      and 16 s per call.
  - GLM 5.3 is fine either way.
- **Attack plan shape:** `steps` is a list of option keys, or `["stop_now"]`, plus one `keep_at_least` and
  `stop_when`. With a list of objects, GLM 5.3 returned `steps: []` in 4 of 28 plans while its own thinking listed
  the attacks.
  - An empty list gets the corrective retry. Empty again on the retry means stop.
- **Scar cards in the turn plan:** one choice field per card (a target, or keep).
- **Public information only** (`BOTS.md` §4.2). **No player names, ever:** factions by faction name, other bots by
  their personality name (from `view.seats`), and people as "the player of Khan Industries".
- **Tests:** `module/bots/llm/brain/tests/` with a fake `chat`, scripted JSON, seeded random and the fixtures in
  `tools/fixtures/bots/`. They cover every API function, bad output → `LLMError`, heuristic mode, and context limits
  per level (easy prompts must not contain other factions' troop totals, and so on).
- **Live probe:** `tools/qa/llm-probe.mjs` runs fixtures through `askLLM`-equivalent Node code with the key file
  `~/.config/risklegacy/nous-key` (never printed). It takes `--model`, `--level` and `--personality`, and prints each
  decision, its `say`, tokens, cost and ms.

## 7. Driver changes (bots-llm-core: `module/bots/driver/**`, `module/bots/_module.mjs`, `module/bots/log.mjs`)

**Dispatch** (`driver/decide.mjs`): `brain(name)` becomes engine-aware.
- For `ctx.bot?.engine === "llm"`, use `llm/brain/index.mjs`. Set `ctx.chat = (purpose, request) => askLLM({...request,
  model}, {purpose, exchanges: record.llm})`, with the model from `ctx.bot.model ?? setting`, or `null` in heuristic
  mode. Keep `ctx.ask` as it is for Jev.
- `LLMError` is handled exactly like `JevError` (policy, GM dialog, session heuristic). Name the engine in the dialog.
- Records gain `engine`, `model`, `personality`, `llm: []`, `say`, `cost` (the sum of the exchanges).

**Context** (`driver/context.mjs`, `buildContext(fid, {difficulty, bot})`):
- `ctx.bot = {engine, model, personality: <Personality object>, memory, userId}`, from `users.mjs`.
- `view.seats = {factionId: {user: userId, bot: bool, botName: string|null, personality: id|null}}`. `botName` is
  set only for bots; never a person's name.
- `view.campaign`: public campaign facts, from what the system really stores (explore `module/campaign`, the Campaign
  actor/data and the faction cards). At least:
  - `game`, `totalGames`, `board`;
  - victors per past game as `{game, faction, wasMe}`, plus the wins for each user id (the bot's own included);
  - its faction's history and current powers; scars on the board; cities; named continents; opened packs;
  - what the winner and the survivors get at the end of this game.
- `view.recent`: public events since this faction's last turn started: battles against it, territories it lost, HQ
  captures, knock-outs, missiles fired at it, scars placed near it, Red Stars gained. Each is `{type, by, text}`
  with faction names. Record them from the existing hooks (`conquered`, `factionKnockedOut`, `missileFired`,
  `battleResolved`, `redStarTokenGained`), keep them in memory, and rebuild from chat messages after a reload when
  you can.

**Debrief:** on `risklegacy.warEnded(war, winner)`, for each seated chat bot with difficulty ≥ normal:
1. build `summary` (winner, the bot's result, final stars, its HQ fate, the main events against it and by it, scars
   and cities this game, each opponent's user id and faction);
2. call `decide({kind: "debrief", fn: "debrief", args: {summary}})`;
3. `setBotMemory`.

Do this after the end-of-game prompts that the bots answer, and not twice for the same war.

**Spend:**
- Add each response's `cost` to `bots.llmSpent` for the current war (reset when the war id changes).
- Before a chat call, if `llmSpendLimit > 0` and the spend is at or over it, throw `LLMError {code: "spend_limit"}`.
  The normal error dialog then lets the GM pause, use built-in judgment, or raise the cap and *Retry*.

**Logging** (`log.mjs` totals): add `cost` and `llmRequests`, and count `llm` exchanges in `requests` and the
tokens (`usage.prompt_tokens` / `completion_tokens`).

**Pace:** skip the `pace` wait when the decision itself took longer than `pace` ms (chat calls are slow).

**Exports** (`_module.mjs`, as built): `askLLM`, `checkLLM`, `listModels`, `lastListError`, `LLMError`,
`isLLMError`, `PERSONALITIES`, `personalityById`, `llmBrain` (namespace), `llmSpend()` → `{usd, calls, limit}`,
`debriefNow` (manual or test trigger), and the new `users.mjs` exports.
- The driver's signature is `buildContext(fid, {difficulty, bot})`.
- The relay also starts with only a Nous key; the Jev routes then answer 503.

**E2E** (`tools/qa/e2e-llm-bots-game.eval`, new) plays one game on a fresh world:
- three chat bots: hard on `z-ai/glm-5.3`, normal on `z-ai/glm-5.3-flash:US`, easy on `deepseek/deepseek-v4-flash`
  (DeepSeek V4 Flash relies on the client's empty-reply handling, §4.2);
- through the relay's `/nous/v1` route, so no key is in the browser;
- plus one Jev-free check of heuristic mode.

It asserts no stalls, no unhandled errors, and that table talk was posted. It reports decisions, calls, tokens, cost,
average ms per call and per bot turn, and the memory written by the debriefs.

Extend `tools/qa/bots-tournament.eval` with `RL_T.bots = [{engine, difficulty, model, personality}]` (per seat; the
current `seats` keep working).

## 8. UI (bots-llm-ui: `module/bots/ui/**`, `templates/bots/**`, `styles/bots.css`, `lang/en-bots.json`)

- **Bot Manager:**
  - **Chat models panel:**
    - the base URL (`bots.llmBaseUrl`);
    - the API key: a password field saved to the client setting, with the note "Saved in this browser only" and
      *Clear*;
    - *Test* (`checkLLM`);
    - the default model (`bots.llmModel`) as a select from `listModels()`, with $ in/out per million;
    - the spend for this war and the cap.
  - **Bot rows:**
    - an engine badge (Jev / the chat model's short name);
    - level;
    - for chat bots: a model select (with "Default (…)") and a personality select (portrait + name + title);
    - *Notes*: view or clear the memory;
    - remove.
  - **Add chat bot:** a personality gallery (ten cards: portrait, name, title, blurb, small knob bars), or Random,
    plus the level and the model. Keep *Add Jev Recruit/Commander/Warlord*.
  - **Randomize personalities** (all chat bots, all different; disabled for seated bots? No: allowed between games
    only, so refuse while seated in an unfinished war, like remove).
- **Bot Log:** render `record.llm` exchanges:
  - shown: model, purpose, ms, tokens, cost, the parsed answer, `thinking`, and `say`;
  - collapsed: the messages (system message collapsed by default) and the reasoning;
  - *Copy JSON*.

  Show `cost` and `llmRequests` in the stats. Jev records render as now.
- **Table talk:** `narrate(record)` also posts `record.say`, when present and `bots.tableTalk` allows it:
  - a speech card spoken by the bot (its avatar or portrait, its name, the personality's title, the quote);
  - at most one per decision, and merged into the turn's narration card when that reads better;
  - `gm` whispers to GMs.
- **Tags:** the War Room tag "BOT · Warlord" adds the personality title for chat bots: "BOT · Warlord · The Iron Wall".
- **i18n:** add every new key to `lang/en-bots.json` (`RL.Bots.*`), including `RL.Bots.Settings.<key>.name/hint` for
  the settings in §4.1 and `RL.Bots.Why.debrief`. `node tools/qa/check-i18n.mjs` must report 0 missing.
- **Design:** follow `design/DESIGN.md` (spacing §5). Take screenshots with
  `tools/qa/shoot.mjs`, in both themes.

## 9. Ownership, testing, budget

| Builder | Owns | Foundry port / sandbox | Relay port | Nous budget |
|---|---|---|---|---|
| **bots-llm-core** | `llm/client.mjs`, `driver/**`, `_module.mjs`, `log.mjs`, `tools/jev-proxy/**`, `lang/en-bots-driver.json`, `tools/qa/e2e-llm-bots-game.eval`, `tools/qa/bots-tournament.eval` | 30021 / `$SB/sandbox-llm` | 30791 | $4 |
| **bots-llm-brain** | `llm/brain/**`, `llm/prompts.mjs`, `llm/profiles.mjs`, `tools/qa/llm-probe.mjs`, `tools/fixtures/bots/llm/**`; may add exports to `brain/*.mjs` (no behaviour change) | none (Node) | none | $5 |
| **bots-llm-content** | `llm/personalities.mjs`, `llm/lore.mjs` | none | none | $1 (voice checks) |
| **bots-llm-ui** | `ui/**`, `templates/bots/**`, `styles/bots.css`, `lang/en-bots.json`, the War Room tag edit | 30022 / `$SB/sandbox-llm-ui` | 30792 | $0.50 |
| integrator (me) | `users.mjs`, `settings.mjs`, `BOTS-LLM.md`, `BOTS.md`, `README.md`, `system.json`, `module/risklegacy.mjs` | 30023 / `$SB/sandbox-llm-int` | 30793 | the rest |

- **Don't edit files you don't own.** Put needed changes under "Contract changes requested" in your report. The
  placeholders (`llm/client.mjs`, `llm/brain/index.mjs`, `llm/personalities.mjs`, `llm/lore.mjs`) exist so everything
  boots; replace them and keep the exported names.
- **The key** is at `~/.config/risklegacy/nous-key` (mode 600). **Never print it, copy it elsewhere or put it in a
  file under the repo or `/tmp`.** Read it inside the command that uses it. Track spend from `usage.cost` and stay
  within your budget line.
- **Sandboxes:** never port 30000 or 30001, never the real data path. Write `--port` values literally, never in a
  shell loop.
  - Use the foundry-vtt-dev harness's `$S/fvtt-server.mjs` and `fvtt-browser.mjs` (ARCHITECTURE.md §9).
  - Stop your servers and relays when done.
- **Relay for a sandbox:** `node tools/jev-proxy/jev-proxy.mjs --key-file ~/.config/risklegacy/typesafe-key --port
  30791 --allow-origin http://localhost:30021 --allow-origin http://127.0.0.1:30021`. Once core adds the route, the
  Nous route uses `~/.config/risklegacy/nous-key` by default. Set `bots.llmBaseUrl` to
  `http://127.0.0.1:30791/nous/v1` and `bots.pace` to 0.
- **Checks:** `node --test module/rules/tests/ module/battle/tests/ module/bots/brain/tests/ module/bots/driver/tests/
  module/bots/llm/brain/tests/`, `node tools/qa/check-i18n.mjs`, and `node $S/fvtt-lint.mjs .`.

## 10. Results (2026-10-27)

### 10.1 End-to-end game (`tools/qa/e2e-llm-bots-game.eval`)
- **Bots:** Warlord on GLM 5.3 (glory), Commander on GLM 5.3 Flash (vulture), Recruit on DeepSeek V4 Flash (berserker).
- **Game:** 8 rounds in 318 s; 285 decisions; 94 calls; $0.065 in total.
- **What worked:** every end-of-game prompt was answered, 38 table-talk lines were posted, and the two debriefs wrote
  memory. Grudges were keyed by user id and shown in prompts only by faction.
- **Speed and cost per bot:**

  | Bot | Per call | Per turn | Cost |
  |---|---|---|---|
  | GLM 5.3 (Warlord) | 7.6 s | 18 s | $0.046 |
  | GLM 5.3 Flash (Commander) | 1.9 s | 5 s | $0.013 |
  | DeepSeek V4 Flash (Recruit) | 3.4 s | 17 s | $0.006 |

- **One failure:** DeepSeek gave no usable answer for one decision after all its retries (an error dialog). It had
  written the answer as `key: value` lines in its reasoning. The client now reads those (`salvageLoose`, §4.2).
  - Re-probed afterwards: 48 of 48 DeepSeek decisions came back, at all three levels.

### 10.2 Model comparison (`tools/qa/bots-tournament.eval`)
**Setup:** three Warlord chat bots with the same personality (`mathematician`) and only the model varying. The
factions were fixed by seat (Khan, Balkania, Enclave), and the six games covered every order of the three models, so
each model played each seat twice. `onError: "heuristic"`.

| Model | Wins / 6 | Red Stars | Calls | Failed attempts (recovered) | Built-in-judgment decisions | Cost (6 games) | Avg per call |
|---|---|---|---|---|---|---|---|
| `z-ai/glm-5.3-flash:US` | 3 | 19 | 153 | 0 | 0 | $0.114 | 2.8 s |
| `deepseek/deepseek-v4-flash` | 2 | 14 | 169 | 12 (47 replies recovered from its reasoning) | 0 | $0.032 | 4.2 s |
| `z-ai/glm-5.3` | 1 | 13 | 161 | 9 | 1 | $0.423 | 5.2 s |

- All six games ended normally in 4–9 minutes (8–12 rounds), with no stalls and no error dialogs.
- **Seat 1 (Balkania) won 4 of 6 games again**, so six games can't rank the models' strength (`BOTS.md` §5.4: about
  60 games per comparison).
- **What the data does show:**
  - GLM 5.3 Flash is the most reliable, with zero failed attempts, and the fastest.
  - DeepSeek V4 Flash is by far the cheapest, at about $0.005 per seat-game.
  - GLM 5.3 costs about 4× the Flash model without playing visibly better.
- **Suggested defaults:** GLM 5.3 Flash (US) for every level. GLM 5.3 is for flavour (richer table talk) rather than
  strength.
