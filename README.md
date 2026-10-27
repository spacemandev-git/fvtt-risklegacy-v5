# Risk Legacy for Foundry VTT (v14)

An unofficial Foundry VTT game system for playing a full **Risk Legacy** campaign online. It covers the persistent
world board, faction cards that evolve, the sideboard and resource decks as Foundry Cards, piece tokens with turn and
rules enforcement, battles with missiles, the sealed packages, and the rulebook (PDF plus searchable text).

Risk Legacy is © Hasbro. This is an unofficial fan project, not affiliated with or endorsed by Hasbro. It includes
scans of the game's cards, board and rulebook so that people who own the game can play their campaign online.

## Requirements
- Foundry VTT **v14**.
- **A Gamemaster must be logged in during play.** Every game action runs on the GM's client. The GM can also play a
  faction (and can act for any faction, e.g. for hot-seat play).
- Optional: *Dice So Nice* (black attack dice, red defence dice).

## Getting started
1. Create a world with the **Risk Legacy** system and launch it as the GM.
2. **Begin a Campaign** (the welcome window): choose the *Original* or the *Advanced (JediPearce)* board, and have
   everyone sign the inside of the lid. This creates the world board scene, the faction cards, the decks, the
   rulebook journal and the sticker sheet.
3. **Before your first game**: pick one starting power per faction (the other is destroyed) and place the 12 coin
   stickers on territory cards (max 3 per card), or randomize both.
4. Create a **User** for each player. **Set up the next game**: choose who plays, roll for pick order, then each
   player picks a faction and a legal starting territory on their own screen. Red Stars or Missiles, Scar cards and
   the sideboard are handled for you.

## Playing a turn
The **War Room** (top-left) walks the current player through the five steps:
1. **Start of turn**: trade 4 resource cards for a Red Star; play start-of-turn scar cards.
2. **Join the War or Recruit**: the recruit total is computed (territories + population ÷ 3, continent bonuses, the
   namer's +1, card trades). Click **Place troops**, then click your territories (shift-click places 3).
3. **Expand & Attack**: drag your pieces. Dropping on an *empty* neighbour expands (city and fortification costs are
   taken automatically). Dropping on an *enemy* starts a battle in chat. Several selected pieces attack with up to 3 dice.
4. **Maneuver**: drag between your own connected territories (once per turn).
5. **End turn**: draw a resource card if you conquered something (the Sideboard shows your legal choices), or complete
   the mission; events trigger on even slot-1 cards.

**Battles** are interactive chat cards. Any player holding Missiles can fire one at any die before the attacker
resolves. Modifiers (bunker, ammo shortage, fortification, faction powers) are written on the dice. Casualties are
removed and the conquerors move in automatically; you can then *Move more in*, *Attack again* or *Blitz*.

When someone reaches 4 Red Stars, the **End of Game** wizard records results on the faction cards. It handles the
winner's signature and reward (name a continent, found a major city, cancel a scar, ±1 continent, fortify, destroy a
card), and the held-on rewards (minor city or card upgrade). Sealed packages prompt "OPEN WHEN …" automatically when
their condition is met.

Other windows: **Sideboard** (all decks and piles), **Reference** (charts and the turn overview), the faction
sheets (card front with power stickers, this war, the history on the back), the **Campaign** sheet (the world: cities,
scars, continents, victors, stickers, packages, chronicle), and the **Risk Legacy Rulebook** journal.

## Bot players (Jev)
Play against AI factions whose judgments come from **Jev**, TypeSafe's decision model. Code works out the legal moves
and the exact odds; Jev judges what matters ("how much would taking Ukraine help me win?", "is my HQ in danger?",
"how much is at stake in this battle?"); code then makes the move. Bots come at three levels:

| Level | Plays like |
|---|---|
| **Recruit** (easy) | A beginner: attacks only with big odds, often stops after one conquest, and sometimes misjudges the board. |
| **Commander** (normal) | A solid player: weighs each target's value against its odds, defends a threatened HQ, consolidates its troops. |
| **Warlord** (hard) | A shark: plans multi-step strikes at HQs, tracks the Red Star race and everyone's cards, fires missiles and plays scar cards where they hurt the leader. |

In bot-vs-bot testing, Commanders beat Recruits (4 of 6 games, against 2 expected at equal strength). The Warlord's
extra tactics haven't yet shown a measurable edge over the other two levels. On the original board your starting seat
and faction matter more than the level (see `BOTS.md` §5.4).

**Setup (GM, once per session):**
1. Get a TypeSafe API key at [console.typesafe.ai](https://console.typesafe.ai).
2. Start the relay on the GM's machine. On macOS, double-click `tools/jev-proxy/start-jev-relay.command`. It runs on
   the Foundry desktop app's bundled runtime, so there's nothing to install; the first run asks for the key and saves
   it to `~/.config/risklegacy/typesafe-key`. On Windows or Linux, run
   `node tools/jev-proxy/jev-proxy.mjs --key-file <path-to-key>`. If Foundry isn't at `http://localhost:30000`, add
   `--allow-origin <your Foundry URL>`.
   The relay exists because TypeSafe's API refuses calls from browser pages, and the key must not live in Foundry.
   It only accepts requests from your Foundry's address.
3. In Foundry, open **Bot players** (Game Settings, the War Room's Bots button, or *Add a bot player* in the game-setup
   wizard). Check that the relay shows as connected, then add bots. Each bot is a Foundry user that never logs in.
4. Seat the bots in **Set up the next game** like anyone else. They pick their faction and starting territory
   themselves.

During play, bots take their turns automatically on the GM's client (the GM must stay connected). They also defend,
fire missiles, play scar cards and answer event choices on other players' turns. When a bot attacks and a person could
still react, the bot waits a few seconds (the *reaction window*) before rolling and before resolving. Short chat lines
explain each bot's moves. The **Bot Log** (from Bot players) shows every decision with the exact questions sent to
Jev and its answers. If Jev can't be reached, the bots pause and the GM chooses to retry, carry on with the bots'
built-in judgment, or pause them.

Cost: Jev charges per input token. A bot turn is a few requests of 1–4k tokens, so a whole game costs about a cent.

## Bot players (chat models, with personalities)
A second kind of bot plays through a **chat LLM** on an OpenAI-compatible API: Nous Portal by default, for example
`z-ai/glm-5.3`, `z-ai/glm-5.3-flash:US` or `deepseek/deepseek-v4-flash`.
- **Picking moves:** code lists the legal moves with exact odds and facts. The model picks from that menu and
  explains itself, so it can never make an illegal move.
- **Personalities:** each chat bot has one of ten (the patient turtle, the berserker, the vulture, the
  grudge-keeper, the mathematician, the glory-hunter, the continent zealot, the archivist who plays for the
  campaign, the gambler, the schemer). The personality changes both how it plays and the short in-character lines
  it posts in chat.
- **Levels:**
  - **Recruit:** knows only its own borders, sees the odds as words, and gets a menu with some poor options in it.
  - **Commander:** sees the whole board's standings and the exact odds, and weighs the short campaign stakes.
  - **Warlord:** also sees hands, missions, events and what happened since its last turn. It reasons about how this
    war's outcome (win, hold on, knocked out, scars, cities) changes the next games.
- **Memory:** Commanders and Warlords keep notes across games, written after each war: grudges, lessons and how
  people play. The GM can read or clear them.

**Setup (GM):**
1. Get an API key at [portal.nousresearch.com](https://portal.nousresearch.com). Your organisation's model policy
   decides which models the key may use.
2. In **Bot players**, open the chat-models panel, paste the key and click *Test*. The key is saved **in this browser
   only**, never in the world, so other players never receive it. Bots run in the active GM's browser, so enter the
   key there.
   - To keep the key out of the browser entirely, run the relay (`tools/jev-proxy/start-jev-relay.command`). With the
     key in `~/.config/risklegacy/nous-key`, set the base URL to `http://127.0.0.1:30777/nous/v1` and leave the key
     empty.
3. Pick the default model, then **Add chat bot**: choose a personality (or Random), a level and a model.
   *Randomize personalities* deals everyone a different one between games.

During play, the chat bots behave like the Jev bots: same narration, battles, reaction windows and pause controls.
They also talk at key moments (setting *Chat bots: table talk*). The Bot Log shows each exchange with the model:
messages, answer, reasoning, tokens, cost and time.

**Cost and speed:** a call takes about 2–5 s, and a bot turn about 3 calls (7–16 s). In testing, a 10-round game of
three chat bots cost about $0.09 (GLM 5.3, GLM 5.3 Flash and DeepSeek V4 Flash). A spending cap per war
(*Chat bots: spending cap per war*, default $5) pauses the bots when reached.

**Privacy:** prompts carry the game state only. Players are named by their faction ("the player of Khan
Industries"), never by user name.

## Settings
| Setting | Scope | What it does |
|---|---|---|
| Rules Enforcement | world | **Strict** blocks illegal moves/actions; **Advisory** warns but allows; **Off** is free play |
| Defender Dice | world | Auto (max dice) or ask the defending player each battle |
| Battle auto-resolve | world | Resolve immediately when nobody holds missiles, or always wait for the attacker |
| Event automation | world | Carry out event cards' effects automatically (off: events are shown and resolved by hand) |
| Troop counts / board tooltip / auto-arrange | client | Board display aids |
| War Room auto-open, compact view | client | |
| Bots: relay URL / token / model | world | Where the GM's browser reaches the Jev relay, and which Jev model the bots ask |
| Bots: pace, reaction window | world | Pause between a bot's actions; how long a bot attacker waits for people to react |
| Bots: narration | world | Chat lines about the bots' moves: everyone, GM only, or off |
| Bots: when Jev can't be reached | world | Pause and ask the GM, or carry on with the built-in judgment |
| Chat bots: API base URL / default model / request timeout | world | Where chat bots send requests (Nous Portal, or the relay's `/nous/v1`), the model for bots without their own, and the timeout per call |
| Chat bots: API key | client (Bot Manager) | Stored in the GM's browser only |
| Chat bots: spending cap per war, table talk | world | US$ per war before the bots pause (0 = no cap); in-character lines for everyone, GM only, or off |
Keybindings (unbound by default): open the War Room, open the Reference, cancel a board prompt.

GMs can always fix the board by hand: drag any piece, use the token HUD (split/merge pieces), the Risk Legacy scene
controls (tidy pieces, set troops, rebuild the scene) and the campaign sheet's correction dialogs.

## Legacy changes to the map
- **Sticker Sheet** (campaign sheet → Stickers, the War Room, or the welcome window): every sticker with its remaining
  count and a **Place…** button that checks the rules and lets you pick on the board. Covers cities, fortifications,
  cancel scar, ±1 continent, coins, sea lines, Alien Island, ruins, Fallout Zone, plus a GM-only "place a scar"
  correction. The end-of-game rewards use the same placement rules.
- **New connections**: completing *Explore the World* lets that player draw a sea line in pen between two coastal
  territories. Pocket 2 has the Alien Collaborator place **Alien Island** on open water with its two sea lines. Both
  become real adjacency for attacks, expansions and maneuvers, and Alien Island becomes a territory (pieces, Region,
  troop badge).
- **Scars**: play a scar card from the War Room's *Scar cards in hand* section (or your hand) onto any territory without
  a scar. Bunker and Ammo Shortage are played from the battle card, onto the defending territory, before the roll.

## Events and missions
- An even card newly revealed in sideboard slot 1 triggers an event. With **Event automation** on (the default), every
  event's effect is carried out. If someone has to choose (e.g. "the largest population chooses"), that player is
  asked on their own screen, and the GM after 60 s. A tie, or an absent faction, means the event doesn't happen.
  Events from packages opened mid-game (Pockets 1 and 2) join the deck at the next game, as the cards say.
- Missions are checked automatically. At the end of your turn you choose to complete the mission *or* draw a card.

## Known limitations
- Missiles fired at the same moment are applied first-come-first-served (the rulebook's priority order isn't modelled).
- Manual steps: the *Interference* and *Purist* powers, and the dice-based troop loss around a new Fallout territory
  when Pocket 1 opens.
- Only card fronts were scanned. Rule stickers B–F map to rulebook brackets from their file names; A and G–N are
  inferred (see `data/content/README.md`).

## For developers
- `ARCHITECTURE.md`: areas, ownership, the public API of each area (`game.risklegacy.*`), hooks, data shapes.
- `BOTS.md`: the bot players' design: the Jev integration rules, the brain/driver/UI contract and the difficulty profiles.
  All Jev wording lives in `module/bots/jev/questions.mjs`.
- `BOTS-LLM.md`: the chat-model bots, covering transport, personalities, prompts, levels, memory and probe findings. All
  prompt wording is in `module/bots/llm/prompts.mjs`, the personalities in `llm/personalities.mjs`, and the
  rules/campaign texts in `llm/lore.mjs`. `node tools/qa/llm-probe.mjs` runs the brain on fixtures against the live
  API (needs `~/.config/risklegacy/nous-key`). `tools/qa/e2e-llm-bots-game.eval` plays a whole game of chat bots
  through the relay.
- `design/DESIGN.md`: the visual language. `styles/risklegacy.css` holds its tokens and components.
- Data: `data/boards/*.json` (generated by `tools/board/`), `data/content/*.json` (generated by `tools/content/`).
- Tests:
  - `node --test module/rules/tests/ module/battle/tests/ module/bots/brain/tests/ module/bots/driver/tests/
    module/bots/llm/brain/tests/` runs the unit tests. They need only Node 22+, no packages.
  - `node tools/qa/jev-probe.mjs` runs the bots' decisions on fixture situations (`tools/fixtures/bots/`) against the live
    Jev API and prints each question's answer (needs `~/.config/risklegacy/typesafe-key`).
  - `tools/qa/e2e-bots-game.eval` plays a game with three bots and a scripted person, and covers the prompt, error and pause
    paths. `tools/qa/bots-tournament.eval` plays one bots-only game with the seats you choose, for comparing the levels.
  - `node tools/qa/check-i18n.mjs` checks the i18n keys across every lang file.
  - `tools/qa/e2e-full-game.eval` plays a whole game with a simple AI. `tools/qa/e2e-packs-game.eval` first opens every
    package, draws sea lines and places Alien Island, then plays with constant events; an autopilot answers the real
    prompts. Run either with the `foundry-vtt-dev` skill's `fvtt-browser.mjs eval --file` against a fresh sandbox world.
  - `tools/qa/shoot.mjs` screenshots windows in both themes from a small scenario script, for visual checks (see its
    header). Check new UI against the spacing rules in `design/DESIGN.md` §5. It and `tools/fixtures/cards/e2e/*.mjs`
    need Playwright: `npm i playwright` in this folder, or set `PLAYWRIGHT_HOME` to a folder whose `node_modules` has it.
- The `init.js`/`macros/*.js` files under `assets/unlocks/` are the old 0.6 importer. They're never loaded (linters flag them).
