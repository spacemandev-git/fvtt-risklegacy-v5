# Bots: AI players driven by Jev (design and area contract)

AI opponents for Risk Legacy, at three difficulty levels. Their judgments come from **Jev**, TypeSafe's "System One"
decision model, which answers typed questions (Noul = probability a statement is true, Choice = one of named options,
Score = a level on a described scale) about a JSON `state` we send, with calibrated probabilities. Code enumerates the
legal moves, does all the arithmetic, and makes the final call from Jev's judgments: **judgments from Jev, decisions in
code**.

This document extends ARCHITECTURE.md (read that first: ground rules §2, layout §3, APIs §5, hooks §8, testing §9).
The second kind of bot, driven by chat LLMs with personalities, is in `BOTS-LLM.md`: it shares this driver, the hook
points and the candidate/odds code.

---

## 1. Player experience

- The GM opens **Bot Manager** (Settings → Bot players, the War Room, or the game-setup wizard) and adds bot players:
  **Recruit** (easy), **Commander** (normal) or **Warlord** (hard). Each bot is a Foundry User that never logs in.
- In **Set up the next game** the bots are seated like people. They pick a faction and a starting territory themselves.
- On a bot's turn it plays the five steps at a readable pace. Battles appear as normal battle cards. People get a
  reaction window to play scar cards or fire missiles. Bots also defend, fire missiles and answer event choices on
  other players' turns.
- Short **narration** lines in chat say what a bot did and why ("Jev Warlord attacks Ukraine from the Middle East:
  Balkania's HQ, 74% to take it"). The **Bot Log** shows every decision with the exact Jev requests and answers.
- If Jev can't be reached, the bot pauses and the GM chooses *Retry*, *Use built-in judgment* or *Pause bots*. A failed
  call is never treated as an answer.
- **Requirement:** the GM runs the Jev relay on their machine (`tools/jev-proxy/start-jev-relay.command`). It uses the
  Foundry desktop app's bundled Node runtime and keeps the TypeSafe API key out of Foundry. The relay is needed because
  the TypeSafe API refuses browser (CORS) requests, and Foundry's server can't run system code.

## 2. Architecture

```
GM browser (active GM only)                                   GM machine            TypeSafe
┌───────────────────────────────────────────────────────┐
│ driver/  hooks: turnStarted, updateCombat, battle msgs │
│   ├─ gathers BotContext (snapshot + public view)       │
│   ├─ calls brain/ decide functions ──► jev/client ─────┼──► relay :30777 ──────► api.typesafe.ai
│   ├─ acts via RL.actions.run("turn.*"), RL.battle.*    │    (tools/jev-proxy)     /v1/systemone
│   └─ answer(kind, ctx) ◄── hook points in campaign/    │
│        cards/battle (prompts addressed to bot users)    │
│ ui/  Bot Manager, Bot Log, narration                   │
└───────────────────────────────────────────────────────┘
```

- Everything runs on `game.user.isActiveGM`. Other clients load the area but stay idle.
- **The brain is pure.** It has no Foundry globals, so it can be tested with `node --test` and probed live from Node.
- Bots act through the same GM actions people use, so the rules enforcement, logging, hooks and UI all stay as they are.

## 3. Ownership (in addition to ARCHITECTURE.md §3)

| Path | Owner | Notes |
|---|---|---|
| `module/bots/brain/**`, `module/bots/jev/questions.mjs`, `tools/qa/jev-probe.mjs`, `tools/fixtures/bots/**` | **bots-brain** | Pure. Tests in `module/bots/brain/tests/` |
| `module/bots/_module.mjs`, `module/bots/driver/**`, `module/bots/jev/client.mjs`, `module/bots/log.mjs`, `lang/en-bots-driver.json` (`RL.Bots.Driver.*`), `tools/qa/e2e-bots-game.eval` | **bots-driver** | Also makes the hook-point edits in §6.4 (only those lines) |
| `module/bots/ui/**`, `module/bots/users.mjs`, `module/bots/settings.mjs`, `templates/bots/**`, `styles/bots.css`, `lang/en-bots.json` (`RL.Bots.*` except `Driver`) | **bots-ui** | Also makes the small badge/button edits in §7.4 |
| `tools/jev-proxy/**`, `BOTS.md`, `module/risklegacy.mjs`, `system.json` | integrator | Relay done and tested |

CSS prefix `rl-bot-`. Don't edit files you don't own. If you need a change in someone else's file, put it in your
report under "Contract changes requested". The placeholders in `driver/_module.mjs`, `ui/_module.mjs`, `jev/client.mjs`
and `brain/index.mjs` exist so the system boots. Replace them while keeping the exported names.

## 4. Jev integration rules (all builders)

Read the TypeSafe docs (https://docs.typesafe.ai: API, primitives, models, jaggedness, advanced). Key points:

### 4.1 Request and model
- `POST {relay}/v1/systemone` with body `{model, state, questions}`. `model` comes from the setting (default
  `jev-latest`). The response is `{model, answers:{name:{type, noul | choice+probabilities | score+probabilities+legend}}, usage}`.
- Limits: 64k tokens per request and 32k per question. A Choice can have up to 255 options; a Score up to 10 levels.
  Requests take about 0.1–0.2 s, and cost $0.042 per million input tokens (output tokens are free).
- Questions in one request can't see each other. **Bundle all questions that share a state into one request**
  ("speculative fan-out"). A typical bot turn should need about 3–10 requests.

### 4.2 Question design (bots-brain)
- **Keep all wording in `module/bots/jev/questions.mjs`**: instructions, criteria, Score levels and the thresholds that
  read the answers. Builders there are pure functions that return `{name: question}`.
- **Code computes every number and exact fact.** Jev is weak at arithmetic, counting, comparing numbers and multi-hop
  reasoning. Our probe showed this: given "Balkania holds 3 Red Stars of 4", Jev wasn't sure Balkania was one star
  from winning (0.48). So the state says facts outright: `"one Red Star from winning"`,
  `"chance_to_conquer": "likely (74%)"`, `"if conquered": "Balkania drops to 2 Red Stars and you rise to 3"`.
  Use verbal bands with the percentage. Never send raw ids, and use names rather than keys inside text.
- **The state passes the human test.** A smart player shown only this state could answer at a glance. Every field must
  be relevant to the questions in that request, since irrelevant detail lowers accuracy. Key candidates by stable,
  descriptive names (territory ids such as `ukraine` are fine as keys), and refer to them by path in backticks:
  ``"How much would conquering `targets.ukraine` improve Khan Industries' chance of winning the war?"``.
- **One judgment per question; beware "or".** Describe Score levels as situations. Give a Noul's `false` criterion as a
  concrete situation. When options can overlap, ask a Noul per option instead of one Choice. Option names are
  descriptive slugs, never `A`/`option_1`. Jev leans slightly toward the first Choice option: the hard bot asks
  order-sensitive Choices twice in reversed order and averages.
- **Ask judgments, not decisions.** "How much would X help me win?", "Is an opponent likely to attack X next turn?",
  "How much is at stake in this battle?" are judgments. Code turns them into the move: utility = weights ×
  judgments + exact odds − costs, with the thresholds in the difficulty profile. Write the truth table for each
  decision and cover the band between Noul thresholds (0.7 yes, 0.3 no, between = unsettled).
- **Don't use Jev where code can decide reliably**, e.g. recruit totals, the legality of a move, drawing the card worth
  most when nothing else differs, or always completing a mission that gives a Red Star. Say so in comments.
- No prompt gymnastics: no criteria that name test cases, no clause per failing case, no thresholds fitted to one
  example. Check every wording change on situations you didn't tune on.
- **Use public information only.** Use the snapshot, the bot's own hand and scar cards, the revealed row, mission and
  events, and everyone's hand counts and coin totals (cards enter hands face up). Never use the deck order, event or
  mission deck order, or other players' scar cards.

### 4.3 Transport and errors (bots-driver: `jev/client.mjs`)
- `askJev(request, {purpose, signal})` adds `model`, POSTs to `${relayUrl}/v1/systemone` with header
  `X-RL-Bot-Token` when a token is set, and uses a 20 s timeout. It retries twice on 429, 5xx and network errors,
  backing off and honouring `Retry-After`. It checks that every question name came back, and returns the response.
  Anything else throws `JevError {status, detail, retryable}`.
- `checkRelay()` → `{ok, latencyMs, model, error}`: `GET /health`, then a one-question request.
- **A failed call is an error, never an answer.** The brain doesn't catch `JevError`. The driver applies the
  `bots.onError` policy (§6.6).
- **Log the exact payload.** Each exchange `{purpose, request, response, ms, error}` is attached to the decision's
  record in `log.mjs`.

## 5. Brain API (contract; `module/bots/brain/index.mjs`)

The JSDoc in `brain/index.mjs` is the authoritative signature list. In short, every function is
`async (ctx: BotContext, args) → decision`, and every decision carries `why: {reason, ...data}`:

| Function | Called by the driver when | Returns |
|---|---|---|
| `assessSituation(ctx)` | each bot turn starts; reactive decisions if `ctx.situation` is missing | `{leader, leaderP, leaderProbs, threats:{fid:p}, hqDanger, hqDangerLevel, hq, hqWorst, hqNeed, threatsJudged, cards, stars}`; cache the whole object in `ctx.situation` |
| `planStartOfTurn(ctx)` | step 1; called again while it returns cards | `{buyRedStars: cardIds[4] \| null}` |
| `planScars(ctx, {cards, targets})` | step 1, start-of-turn scar cards in hand | `{plays:[{cardId, territory} \| {cardId, faction}]}` (weakness scars target a faction) |
| `planRecruit(ctx, {mustJoin, legalJoin})` | step 2 | `{join: territory}` or `{recruit: true, tradeForTroops: cardIds\|null}` |
| `planPlacement(ctx, {reserve})` | reserve > 0 | `{placements:[{territory, count}]}` (sum ≤ reserve) |
| `nextMove(ctx)` | step 3, repeatedly | `{type:"attack", from, to, dice}` \| `{type:"expand", from, to, count}` \| `{type:"stop"}` |
| `moveIn(ctx, {from, to, min, max})` | after a conquest or expansion | `{count}` with `min ≤ count ≤ max` |
| `planManeuver(ctx)` | step 4 | `{from, to, count}` \| `null` |
| `planEndOfTurn(ctx, {drawOptions, missionStatus})` | step 5 | `{draw: {cardId}\|{coin:true}\|null, completeMission, powers}` |
| `chooseDefenseDice(ctx, {battle, max})` | a bot defends | `{dice}` |
| `preRollScar(ctx, {battle, cards})` | battle pre-roll, the bot holds Bunker/Ammo Shortage | `{cardId, why}` \| `null` |
| `missileDecision(ctx, {battle})` | a battle is rolled and the bot holds missiles (attacker, defender or bystander) | `{fire:false}` \| `{fire:true, side, index}` |
| `chooseStartingTerritory(ctx, {legal, joining})` | setup or Join the War | `{territory}` |
| `chooseOption(ctx, {kind, title, text, options})` | any multiple-choice prompt (faction pick, event steps, rewards, power options) | `{value}` |
| `pickName(ctx, {kind, used})` | city, signature, world or continent names (sync, code lists, no Jev) | `{name}` |

`BotContext` = `{me, difficulty, state, view, lookup, ask, random, situation?, excluded?}`, and `view` is the public
data the snapshot lacks (see the JSDoc). Notes:
- `ctx.me` is `null` for the faction and draft picks, which happen before the bot has a faction.
- The brain keeps per-turn memory keyed by `view.game`, `view.round` and `state.turn`, so the driver must fill
  `view.round`.
- The `battle` argument carries `id`, `attacker`, `defender`, `from`, `to`, `attackDice`, the rolled dice and, when
  known, `troops`, `sources` and `rules`. `ask(purpose, {state, questions})` is the driver's wrapper around `askJev`.
It records the exchange on the current decision. **`ask === null` means heuristic mode**: every function must still
return a sensible legal decision from code-only judgments (neutral values from the code pre-scores), so the game can
continue when the GM chooses to play on without Jev.

### 5.1 The decision pattern (composite scoring)
1. **Enumerate** legal candidates with `rules.*` (attack/expand/placement/maneuver targets, legal starts). Pre-score
   them in code, and keep the top N for the difficulty level (hard also builds 2–3-step chains toward enemy HQs and
   continents).
2. **Compute facts** per candidate in code:
   - exact conquest odds from `brain/odds.mjs`: a Markov chain over the system's own dice rules, including modifiers,
     ties, clamping, fortification wear and missiles;
   - expected losses, and Red Star changes;
   - continent completion or breakage, the enemy troops that would border it, and whether it hits the leader.
3. **Ask Jev** the judgments for all candidates in one request (per-candidate Scores and Nouls, plus situation-level
   Choices).
4. **Combine in code** with the profile's weights, then pick: argmax, or sampling for the easy bot. Apply hard rules
   from the truth table first; for example, a move that wins the war now with good odds is always taken.

### 5.2 Difficulty profiles (`brain/profiles.mjs`)

| | Recruit (easy) | Commander (normal) | Warlord (hard) |
|---|---|---|---|
| Context sent to Jev | itself + candidates | + standings and threats | + hand counts, forecast recruits, missions, power text |
| Candidates per decision | 4 | 6 | 8, plus 2–3-step attack chains toward HQs and continents |
| How it picks | samples Jev's distributions (temperature 1.6): plausible mistakes | argmax of utility | argmax; order-sensitive Choices asked twice, reversed, and averaged |
| Attack odds floor | 75%, at most 3 targets, stops after its first conquest half the time | 55% | 55% (40% for "a big swing"); 25% for a move that wins the war now |
| HQ floor (troops always left home) | none | 3 | 4 |
| Resource card from the turn's first conquest | not counted | worth 2.5 troops | worth 3 troops |
| One-troop expansions next to enemy stacks | yes | only when worth more than the conquest they gift | same |
| Placement | one pile on a top-2 front | the planned attack's staging territory, + HQ when in danger | same |
| Maneuver | never | consolidates interior troops to the front | consolidates, and reinforces HQ or cities |
| Cards | buys a Red Star whenever it can | buys; trades for troops only when the trade covers a real HQ threat | same |
| Missiles | only if losing would hand someone the win | stakes ≥ "a lot" and swing ≥ 25 points | expected-value threshold; also as a bystander to stop the leader winning |
| Scar cards | never plays | Bunker/Ammo Shortage to defend its HQ | also Bio-hazard and the like on the leader's routes |
| Prompts and events | Jev Choice, sampled | Jev Choice, argmax | Jev Choice, argmax, with richer context |

"Decisive" is code's call, not Jev's (`questions.mjs` `DECISIVE`). A take is decisive when it wins the war now, or
takes the HQ of a rival on 3 Red Stars. Jev rates every other take on four levels, from "nothing that matters" to "a
big swing".

### 5.3 `why` vocabulary (narration and log)
The UI builds narration from `why`. These reasons exist up front; the brain may add more and must list them. The UI
shows a generic line for any reason it doesn't know.
`situation`, `buyStar`, `buyStarWin`, `holdCards`, `tradeTroops`, `holdScars`, `playScar`, `recruit`, `stageAttack`,
`defendHq`, `defendBorder`, `winNow`, `hqCapture`, `breakContinent`, `completeContinent`, `knockOut`, `cardConquest`,
`weakenLeader`, `missionProgress`, `opportunity`, `expand`, `stopEnough`, `stopOddsPoor`, `stopDefend`, `holdBack`,
`pressOn`, `consolidate`, `reinforceHq`, `completeMission`, `drawCard`, `drawCoin`, `noDraw`, `defendMax`,
`missileSaveHq`, `missileWin`, `missileStopLeader`, `missileHold`, `startPosition`, `choiceBest`, `name`, `heuristic`,
`missileSwing`, `defendFewer`. Decisions made without Jev also carry `why.heuristic: true`.
Common data fields: `territory`, `from`, `to`, `count`, `dice`, `chance` (0..1), `value` (Score level label),
`faction` (an opponent id), `label`.

### 5.4 Tuning results (2026-10-27; `tools/qa/bots-tournament.eval`, original board, three bots per game)

Each test is six games, one per seat for the bot under test, played twice. "Equal strength" means winning 2 of 6.

| Test | Wins | Notes |
|---|---|---|
| Commander vs 2 Recruits | 4/6 | wins from all three seats |
| Warlord vs 2 Recruits | 2/6, 3/6, then 1/6 with the final profile | 6/18 pooled: equal strength |
| Warlord vs 2 Commanders | 1/6, 1/6 (final profile), 2/6 (without chains) | 4/18 pooled |

- **Seat and faction dominate on this board.** Seat 1 as Balkania (a North America start) won about three games in
  four, so six-game samples can't separate the Commander from the Warlord. Compare levels over more games, with
  seats and factions rotated.
- **What the tuning fixed:**
  - Jev rated every HQ capture "decisive", so "decisive" became code's call.
  - The hard bot emptied its HQ for attack chains (it lost its HQ in 4 of 6 games); HQ floors fixed that.
  - It attacked at 15–30% odds; the odds floors fixed that.
  - It spent every hand on 2–4 troops instead of Red Stars; trades now have to be worth at least 4 troops.
  - The normal bot turtled without conquests; the first conquest's card now counts in the score.
- **What didn't help:** every way the Warlord took more risk than the Commander lost more. The Warlord is therefore
  the Commander's risk discipline plus more information and tactics. It had the best Red Star totals against
  Commanders (17 against 12–13), but **it hasn't yet shown a measurable edge in wins**.
- **Open item: a statistically meaningful ladder.** Telling a 33% win rate from 50% needs about 60 games per
  comparison. Candidates to test first: the attack chains, the full context (more state can lower Jev's accuracy),
  and maneuver "reinforce".

## 6. Driver (bots-driver)

### 6.1 Turn loop
- **Triggers:**
  - `risklegacy.turnStarted(war, faction)`: start the turn from `setTimeout(…, 0)`; don't await inside the hook;
  - `updateCombat`: GM rewinds don't fire `turnStarted`;
  - `ready`: resume a bot turn interrupted by a reload.
  Act only when `war.combatant?.actorId === fid && war.system.turn.faction === fid` and the stage is `playing`. Run one
  turn at a time, keyed by round, turn and faction.
- **Steps:** `assessSituation` → `planStartOfTurn` loop (`turn.buyRedStars`) → `planScars` → `planRecruit`
  (`turn.joinWar`, or `turn.tradeForTroops` + `turn.recruit`) → `planPlacement` (`turn.placeReserve` per entry) →
  `nextMove` loop (attack → §6.2; expand → `turn.expand` then `moveIn` → `turn.advance`) → `planManeuver`
  (`turn.maneuver`) → `planEndOfTurn` → `RL.actions.run("turn.end", {faction, draw, completeMission, powers})`.
- **Call shape:**
  - Always call `RL.actions.run("turn.<verb>", payload)`; it throws on refusal. Never use `RL.turn.endTurn()`,
    `combat.nextTurn()` or the `RL.turn.*` wrappers, which open dialogs or toast on the GM.
  - On a refusal, add the move to `ctx.excluded` and ask again.
  - Guard each turn: at most 60 actions and 5 refusals, then end the turn.
  - After each action, wait until the snapshot reflects it (poll a predicate for up to about 3 s), then wait `pace` ms.
- **Pause:** check the `bots.paused` setting before every action.

### 6.2 Battles
- **Bot attacker:**
  1. `turn.attack` returns the battle message id.
  2. If `preRoll`, give each bot holding Bunker/Ammo Shortage `preRollScar` (`battle.playScarBeforeRoll`). Wait
     `reactionWindow` seconds if a person could react, then `battle.rollBattle`.
  3. Once rolled, run missile decisions (attacker, then defender, then bystander bots). Wait `reactionWindow` if a
     person holds a missile, wait for `hold` to clear, then `battle.resolve`.
  4. On a conquest, `moveIn` → `battle.moveIn`. Then `battle.stopBattle`.
- **Person attacker:** a bot defender's dice come from the `requestDefense` hook point (§6.4). Watch
  `createChatMessage`/`updateChatMessage` for type `battle`:
  - on `declared` + `preRoll`: bot scar decisions;
  - on `rolled`: missile decisions for every bot holding missiles, once per bot per round.
  Decide quickly: the attacker may resolve at any time.
- **Rules:** missiles can't be fired at an unmodifiable side (`rules.unmodifiable`). The third missile on a roll opens
  the package prompt for the GM, and the battle stays on `hold` until it is handled. Wait for it rather than
  resolving.

### 6.3 Answer dispatcher
`answer(kind, ctx)` returns `undefined` **synchronously** when `ctx.user` (or the faction's player) isn't a bot, and
otherwise a Promise of the value that person would have given. The `askOrHere` and `requestDefense` hook points are
not async, so a Promise for non-bots would break them for every player. It maps each prompt kind to a brain function:
- faction pick, events, rewards and power options → `chooseOption`;
- starting territory → `chooseStartingTerritory`;
- signature, world name and city names → `pickName`.

Board-geometry picks (sea line, Alien Island point, Fallout Zone) use code-only heuristics: sample candidates and
validate them with the existing helpers (`board.isOpenWater`, the placement validators).

The payload shapes for each kind are in decisions.md §1–6. During the setup wizard, answer the wizard's `territory`
ask and **don't** call `placeStartingForces` yourself; the wizard does that after the answer.
`placeStart(factionId)` exists for scripted setups (e2e).

### 6.4 Hook-point edits (bots-driver; minimal, guarded, commented "Bot players answer here (module/bots)")
| File | Function | Edit |
|---|---|---|
| `module/campaign/ask.mjs` (~122) | `ask(userOrId, kind, data)` | After resolving `user`: `const bot = await game.risklegacy.bots?.answer?.(kind, {user, data}); if ( bot !== undefined ) return bot;` |
| `module/campaign/placements.mjs` (~638) | `askOrHere(user, kind, data, local)` | same |
| `module/cards/event-effects.mjs` (~232) | `Chooser.ask(request)` | before the remote branch; on a bot answer set `this.answeredBy` to the bot user |
| `module/battle/defense.mjs` (~38) | `requestDefense(message, max, data)` | before `if (!user?.active)` |

Keep each edit to a few lines. Match the answer shape that function already returns for a person.

### 6.5 Context gathering
`buildContext(factionId)` collects:
- `state`: `RL.turn.snapshot()`;
- `view`: per the JSDoc, from `RL.cards.*` (`getResourceCards`, `getScarCards`, `getRow`, `coinCount`,
  `currentMission`, `missionStatus`, `drawOptions`) and the power Items;
- `war.system.{activeEvents, protections}` and the faction names;
- `lookup`: `RL.state.findEntry`;
- `random`: `Math.random`;
- `ask`: a recording wrapper around `askJev`, or `null` in heuristic mode;
- `difficulty`: from `users.mjs`.

Include only public information (§4.2).

### 6.6 Errors, recovery and narration
- **On a `JevError`:**
  - with `bots.onError = heuristic`, rerun that decision with `ask = null` and set `record.heuristic = true`;
  - with `ask`, pause the bot and show the GM a DialogV2 offering *Retry*, *Use built-in judgment* (this decision, or
    for the rest of the session) and *Pause bots*.
- **Recovery:** a GM reload drops in-memory state. Re-derive everything from documents: the turn log says what has
  been done (recruited, maneuver.done, attacks…).
- **Records:** every decision becomes a log record (`addRecord`). The driver then calls `ui.narrate(record)`.

### 6.7 Public API (`game.risklegacy.bots`, see `_module.mjs`)
- `answer`, `pause`, `resume`, `isPaused`;
- `playTurn(fid)`: manual trigger or retry;
- `placeStart(fid)`;
- `status()` → `{running, paused, lastError}`;
- from `users.mjs`: bot users;
- from `log.mjs`: the log;
- `checkRelay`;
- `brain`: the brain namespace.

## 7. UI (bots-ui)

### 7.1 Bot Manager (ApplicationV2 + Handlebars, design system)
- **Bot list:** name, difficulty selector, the faction it plays in the current war, and a remove button (refused
  while it's seated in a war that hasn't ended).
- **Adding bots:** "Add Recruit / Commander / Warlord" buttons.
- **Relay status:** `checkRelay()`, with latency and model, and a *Test* button. When it isn't reachable, show how to
  start it (`tools/jev-proxy/start-jev-relay.command`; on Windows/Linux `node tools/jev-proxy/jev-proxy.mjs`) and the
  relay URL setting.
- **Controls:** Pause/Resume all bots; *Open Bot Log*.
- **Access:** GM only. Open it from a `game.settings.registerMenu` entry ("Bot players"), a War Room button for GMs, and
  an "Add a bot player" link in the game-setup players step.

### 7.2 Bot Log
- Records newest first, filterable by faction and kind. The headline uses the narration text.
- Expanding a record shows the decision, `why`, each Jev exchange (request state/questions, answers with
  probabilities, model, tokens, ms) and a *Copy JSON* button.
- Shows `logStats()` (requests, tokens, average latency, errors, heuristic decisions).
- Re-renders on `risklegacy.botDecision`.

### 7.3 Narration
`narrate(record)` posts a compact chat card (`flags[SYSTEM_ID].card = true`, styled with `.rl-chat-card`), spoken by
the bot user's name, according to `bots.narration` (`all`, `gm` = whisper to GMs, or `off`).
- **What to narrate:** attacks, placements, end of turn, missiles fired, scar cards played, event choices, and
  heuristic decisions.
- **What to skip:** `situation` and `stop` decisions. Several placements in one turn become a single line.
- Text comes from `RL.Bots.Why.<reason>` with the `why` data. Unknown reasons get a generic line.

### 7.4 Small edits elsewhere (bots-ui)
- **War Room scoreboard** (`module/apps/war-room.mjs` + `templates/apps/war-room.hbs`): a "BOT · Warlord" tag next
  to factions played by bots, and the GM's Bots button.
- **Game-setup players step** (`module/campaign/apps/game-setup.mjs` + its template): an "Add a bot player" control
  that opens the Bot Manager. It must then re-render so the new User appears.
- Keep these edits minimal and isolated, and match those files' style.

## 8. Testing (ports and sandboxes; never port 30000 or the real data path)

| Who | Foundry port / sandbox | Relay port |
|---|---|---|
| bots-brain | none (Node only) | none: `tools/qa/jev-probe.mjs` calls the API directly from Node |
| bots-driver | 30017 / `$SB/sandbox-bots` | 30787 |
| bots-ui | 30018 / `$SB/sandbox-bots-ui` | 30788 |
| integrator | 30019 / `$SB/sandbox-bots-int` | 30789 |

- Relay for a sandbox:
  `node tools/jev-proxy/jev-proxy.mjs --key-file ~/.config/risklegacy/typesafe-key --port 30787 --allow-origin http://localhost:30017 --allow-origin http://127.0.0.1:30017`.
  Write every port number literally, and never build the args in a loop. Set the world's `bots.relayUrl` to match,
  and `bots.pace` to 0 for speed.
- **Unit tests:** `node --test module/bots/brain/tests/` (fake `ask`, seeded `random`), plus the existing
  `module/rules/tests/` and `module/battle/tests/`.
- **Live probes:** these send game states only, never player names. Budget: keep the whole project under $2. A full
  test game should cost under $0.05. Log token usage.
- **End-to-end:** `tools/qa/e2e-bots-game.eval`. On a fresh world: create a campaign, add three bots (easy, normal,
  hard), create the war with them, `placeStart` each, then let the driver play until someone wins or the budget runs
  out. Assert there are no stalls, no unhandled errors and no heuristic fallbacks, and report the decision and token
  stats.
- Lint with `node $S/fvtt-lint.mjs .` (ARCHITECTURE.md §9). Check i18n with
  `node tools/qa/check-i18n.mjs`.
