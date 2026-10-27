# Risk Legacy for Foundry VTT v14: architecture and area contracts

System id `fvtt-risklegacy-v5`. Foundry **v14** (build 369 is installed). Targets v14 only (`compatibility.minimum: 14`).

This document is the contract between the people (and agents) building the system in parallel. Read it all before
you write code. If something here is wrong or missing, don't silently diverge: work around it inside your own area and
list it under **"Contract changes requested"** in your final report.

---

## 1. What we're building (player experience)

A whole Risk Legacy campaign, played remotely in Foundry:

- **The world board** is a Scene ("The World"): the printed board image (original or the JediPearce *Advanced* board),
  one Foundry **Region** per territory, and an overlay that draws the legacy stickers (cities with hand-written names,
  scars, fortifications, continent names, +1/−1 marks, signatures in the victors' section).
- **Pieces are tokens.** Each faction's 1-troop, 3-troop and HQ pieces are *linked tokens of the faction actor*.
  Players drag their own pieces like on the table. The system works out which territory each piece stands in, and:
  - dragging troops into an **empty** adjacent territory = *expand* (validated; city/fortification costs are taken
    automatically),
  - dragging onto an **enemy** territory = *attack*: the move is cancelled and a battle starts in chat,
  - dragging between **own** territories = *maneuver* (connectivity and one-per-turn checked).
  The mundane parts are automated: recruit totals, spawning recruited troops, making change (splitting a 3-troop
  piece), removing casualties, moving the conquerors in, tidying pieces onto placement spots.
- **Faction cards** are Actors with an ActorSheetV2 in the rulebook's visual style: art, name plate, six coloured
  power-sticker slots (embedded `power` Items), and the back of the card (game history).
- **Cards are Foundry Cards**: the territory deck (each card has 6 faces = resource value 1–6), coin cards, the
  sideboard row (slots 1–4), discard, scar/mission/event/draft decks, and one hand per faction. A **Sideboard** app
  shows them like the physical sideboard and enforces the drawing rules.
- **Turns** run on a Combat document of type `war` (combatants = factions in seat order). The **War Room** HUD walks
  the active player through the five turn steps with the right buttons, and shows everyone's Red Stars.
- **Battles** are interactive chat cards (ChatMessage type `battle`): black attack dice and red defence dice, every
  modifier written on the die "in marker", missile buttons for *any* player holding missiles, and Resolve.
- **The campaign** (Actor type `campaign`) is the persistent board state: cities, scars, fortifications, continent
  names and modifiers, destroyed cards, the victors' section, sticker inventory, opened packages, rulebook stickers,
  and a chronicle. Wizards cover *new campaign*, *before your first game*, *setup before every game*, *end of game*
  (results, winner's reward, held-on rewards, naming the world), and *opening packages*. Unlock conditions are
  detected automatically and prompt "Open Package N!".
- **The rulebook** is a JournalEntry: the original PDF (core PDF page) plus searchable text pages from `rules/*.md`.
  Rule stickers (additions A–N) appear in the brackets when their package is opened.
- **Rules enforcement**: world setting `enforcement` = strict | advisory | off. GMs can always fix the board by hand.

Design language: `design/DESIGN.md` (read §1, §4, §6, §7) and `design/preview.html`. The CSS is already shipped as
`styles/risklegacy.css` (a copy of `design/tokens.css`, assets in `styles/assets/`). Every app/sheet must use
`classes: ["risklegacy", …]` and the `.rl-*` component classes. Red is the only accent, everything is condensed and
square, player-authored text is in the marker font, empty unlockable slots are legacy brackets, and printed objects
(cards, panels, chat cards) look the same in light and dark themes.

---

## 2. Ground rules for every contributor

1. **Use the `foundry-vtt-dev` skill** (its `SKILL.md`). Read it and the references for
   your area. Write v14 code only: ApplicationV2/HandlebarsApplicationMixin, DialogV2, DataModels, `foundry.*`
   namespaces, HTMLElement (no jQuery), `messageMode` (not rollMode), v14 context-menu keys. Look APIs up in the
   installed source with `scripts/fvtt-api.mjs`. Don't guess.
2. **Stay in your own files.** The ownership table (§3) lists them. Don't edit files you don't own. Several people
   are editing this tree at the same time with no version control, and concurrent edits to the same file get lost.
   You may create new files inside your own folders. Need something changed in a shared file? Put it in your report.
3. **Import other areas only through their `_module.mjs`** (e.g. `import * as cards from "../cards/_module.mjs"`), or
   at runtime through `game.risklegacy.<area>`. Shared state comes from `module/state/_module.mjs`, constants from
   `module/config.mjs`. The rules engine (`module/rules/`) must not import Foundry runtime state. It takes a snapshot.
4. **Mutations of shared state go through the GM action bus** (`module/gm/actions.mjs`): register handlers in your
   `init()` with `registerAction("<area>.<verb>", handler)` and call them with `runAction(name, payload)`. Handlers
   run on the active GM, receive `(payload, {user})`, **must re-check permissions** (`canActFor(user, factionId)`) and
   rules (`enforce(result)`), and return JSON-serializable data. A player may move their *own* tokens directly
   (core drag); everything else goes through actions.
5. **Localize everything.** Use only your own language file (§3) and your key prefix. Use `{{localize}}` in templates
   and `game.i18n` in code.
6. **CSS class names** you invent carry your area prefix so areas don't collide: apps `rl-ui-`/`rl-fs-`/`rl-cs-`/`rl-wr-`, cards `rl-cards-`, canvas `rl-cv-`, campaign `rl-cp-`, battle `rl-bt-`, turn `rl-turn-`. The shared `rl-*` components in `styles/risklegacy.css` are unprefixed.
7. **Templates** live in `templates/<area>/`, and are referenced with the full path
   `systems/fvtt-risklegacy-v5/templates/<area>/x.hbs`. **CSS** goes in your `styles/<area>.css`, scoped under
   `.risklegacy`, reusing the tokens and components from `styles/risklegacy.css`. Don't restyle core UI.
8. **Asset paths** in data are relative to the system root. Turn them into URLs with `systemPath()` from `config.mjs`.
9. **Testing.** Each area has its own sandbox and port (§9). Never use the default sandbox or port 30001 (the
   integrator uses it), and never touch the user's real Foundry data or worlds. Lint with
   `node $S/fvtt-lint.mjs .` (§9). Ignore the findings under `assets/unlocks/**`:
   those are the old 0.6 importer scripts, which are never loaded. Before you report, your area must boot with no
   errors from your code, and you must have exercised your main flows with `fvtt-browser.mjs eval` and looked at
   screenshots of your UI.
10. Two data producers are running in parallel: `data/boards/*.json` (board geometry) and `data/content/*.json` (card
   catalog). Build against the schemas in §6–7. If a file isn't there yet, work on something else and check again
   later, or make a small fixture of your own under `tools/fixtures/<area>/`. Don't write into `data/`.

---

## 3. Layout and ownership

| Path | Owner | Notes |
|---|---|---|
| `system.json`, `module/risklegacy.mjs`, `module/config.mjs`, `module/settings.mjs` | integrator | entry, constants, core settings |
| `module/state/*` | integrator | accessors, board/content loaders, **snapshot**, enforcement |
| `module/gm/actions.mjs` | integrator | GM action bus |
| `module/documents/actor.mjs`, `item.mjs`, `module/dev/*`, `lang/en.json`, `styles/risklegacy.css`, `styles/assets/` | integrator | |
| `module/data/actor-faction.mjs`, `module/data/item-power.mjs` | **apps** | sheets drive these schemas |
| `module/data/actor-campaign.mjs` | **campaign** | |
| `module/data/combat-war.mjs`, `module/documents/combat.mjs`, `module/rules/**`, `module/turn/**` | **turn** (game logic) | `lang/en-turn.json`, prefix `RL.Turn.*`, `RL.Rules.*`; templates `templates/turn/`; styles: none (use apps') |
| `module/data/chat-battle.mjs`, `module/documents/chat-message.mjs`, `module/battle/**` | **battle** | `lang/en-battle.json`, `RL.Battle.*`; `templates/battle/`; `styles/battle.css` |
| `module/documents/token.mjs`, `module/canvas/**` | **canvas** | `lang/en-canvas.json`, `RL.Canvas.*`; `templates/canvas/`; `styles/canvas.css` |
| `module/data/cards.mjs`, `module/documents/cards.mjs`, `module/cards/**` | **cards** | `lang/en-cards.json` (`RL.Sideboard.*`, `RL.CardsUI.*`), `lang/en-events.json` (`RL.Events.*`); `templates/cards/`; `styles/cards.css` |
| `module/apps/**` | **apps** (sheets, War Room, shared dialogs) | `lang/en-apps.json`, `RL.UI.*`, `RL.Sheet.*`; `templates/apps/`, `templates/dialogs/`; `styles/apps.css` |
| `module/campaign/**` | **campaign** (lifecycle, wizards, packages, rulebook) | `lang/en-campaign.json`, `RL.Wizard.*`, `RL.Legacy.*`, `RL.Rulebook.*`; `templates/campaign/`; `styles/campaign.css` |
| `data/boards/**`, `tools/board/**`, `assets/board/original.webp` | board-geometry producer | |
| `data/content/**`, `tools/content/**` | content producer | |
| `assets/**` (everything else), `rules/**`, `design/**` | the user | read-only |

Each area's `_module.mjs` exports `init()` (called in the system `init` hook) and `ready()` (called after the
board definitions and content catalog are loaded), plus its public API (§5). `game.risklegacy` exposes
`{config, state, actions: {run, register, has}, dev, rules, turn, battle, board /* canvas area */, cards, apps, campaign}`.

---

## 4. Shared contracts already in place (read the code)

- `module/config.mjs`: every id and constant (board variants, the 42 territory ids, factions, pieces, stages, phases,
  statuses, results, enforcement, trade chart, city types, fortification, scars, power slots, stickers, rewards,
  packs, card stack roles).
- Data models in `module/data/` (registered in `module/risklegacy.mjs`):
  - **Actor `faction`**: `key, pack, color, pieces{troop,triple,hq}, history[], war{active, playerId, playerName, seat,
    redStarTokens, missiles, reserve, startingTerritory, status, knockedOut[]}, notes`. Powers are embedded `power` Items.
  - **Actor `campaign`**: `boardVariant, worldName, founding, firstGameReady, games[], territories{<id>: {city{type,
    name, founder, founderId, game}, fortification{active, used}, scar, scarGame, cardDestroyed, marks[]}},
    continents{<id>: {name, namedBy, namedById, modifier, game}}, stickers{<id>: n}, packs{<id>: {opened, game, date}},
    rulesAdditions{<letter>: ruleId}, documents{<role>: id}, log[], notes`.
  - **Item `power`**: `slot, text, faction, pack, key, timing, used`.
  - **Card** `territory{territory, continent, value, slot}`, `coin`, `scar{scar, target, stickerImg, effect}`,
    `mission{reward, check}`, `event{afterResolve, effect}`, `draft{draftType, players, value}`. Every card has
    `catalogId, pack, text`.
  - **Combat `war`**: `game, stage, phase, placement{order[], index}, turn{faction, recruited, recruitTotal, joinedWar,
    starsBought, tradedForTroops, conquered, expanded, expandedIntoCity, attacks, firstAttackTarget, protected[],
    maneuver{done, from, to}, cardDrawn, missionCompleted, events, flags}, coinPileDepleted, eliminated[], battle,
    winner, activeEvents[]`. Fresh turn data: `WarData.freshTurn(factionId)`.
  - **ChatMessage `battle`**: see `module/data/chat-battle.mjs`.
- `module/state/` (import from `module/state/_module.mjs`):
  - Loaders: `getBoard(variant)` (the *printed* board), `getPack(id)`, `allPacks()`, `findEntry(category, id)`. They're loaded before `ready()`.
  - **`getCampaignBoard()`**: the board as it is in this campaign, i.e. the printed board plus `campaign.system.customTerritories` (Alien Island: a round territory with polygons, spots and a Region) and the pen `campaign.system.seaLines` (added to `neighbors` and `board.seaLines` with `custom: true`). Use it, not `getBoard()`, for anything about the world in play; the snapshot, rules, canvas Regions and piece spots all do. Territories carry `coastal` and `coastPoints` (`tools/board/add_coastal.py`). `seaLineEndpoints(board, a, b)` returns pen-line ends.
  - Accessors: `getCampaign()`, `getBoardVariant()`, `getCampaignBoard()`, `getCampaignDocument(role)`,
    `getBoardScene()`, `getCardStack(role)`, `getHand(faction)`, `getFactions({active})`, `getFactionByKey(key)`,
    `getWar()`, `currentFaction()`, `factionOfUser(user)`, `canActFor(user, faction)`, `isMyTurn(user)`,
    `pieceKind(tokenDoc)`.
  - **Snapshot**: `buildSnapshot()` → `BoardState` (full JSDoc in `snapshot.mjs`): per territory owner/troops/pieces/
    hq/city/population/fortified/scar/marks/neighbors; per faction territories/population/troops/hqs/continents/
    redStars/hand; continents with effective values; the turn. Also `territoryAtPoint(point)`,
    `territoryOfToken(tokenDoc)` and `tokenCenter(tokenDoc)`. Territory lookup prefers the scene's territory Regions
    (`region.flags[SYSTEM_ID].territory`) and falls back to the JSON polygons.
  - Enforcement: `ok(data)`, `fail(reasonKey, data)`, `enforce(result)` → boolean, `reasonText(result)`.
- `module/gm/actions.mjs`: `registerAction`, `runAction`, `hasAction`.
- `module/dev/fixtures.mjs`: `game.risklegacy.dev.createTestCampaign({variant})` creates a campaign actor and the five
  base faction actors (no scene, decks or war), so you can test before the campaign wizard exists.

---

## 5. Area APIs (what each area must export from its `_module.mjs`)

Signatures marked **[GM]** run through a GM action. You can call them from any client: implement the exported
function as a thin `runAction(...)` wrapper and register the handler in `init()`. Everything is async unless noted.
Factions and territories are passed as **ids** (faction actor id, territory id).

### 5.1 rules (owner: turn): pure functions of a `BoardState`, no Foundry runtime access, unit tests in `module/rules/tests/` (`node --test`)
- `recruitBreakdown(state, factionId)` → `{territories, population, base, roundedUp, continents:[{id, value, namerBonus}], continentTotal, total}`. `base = max(3, floor((territories+population)/3))`; Balkania `balkania_1` rounds up; the continent namer gets +1.
- `troopsForCoins(coins)` → troops (0 if < 2; 2..10 per `TROOP_TRADE`; more than 10 isn't allowed).
- `legalStartingTerritories(state, factionId, {joining})` → `string[]`: unoccupied and unmarked, or holding a Major City this faction's *player* founded. At game start an HQ can't be adjacent to another HQ.
- `checkPlacement(state, factionId, territoryId, count)`, `checkExpand(state, factionId, from, to, count)` (data: `cost` = city population + fortification 2, `remaining`), `checkAttack(state, factionId, from, to, dice)`, `checkManeuver(state, factionId, from, to, count)`, `checkStartingTerritory(state, factionId, territoryId)` → `RuleResult`.
- `connectedThroughOwned(state, factionId, from, to)`, `defenderMaxDice(state, territoryId)`, `maxAttackDice(state, from)`.
- `redStarTotal(state, factionId)`, `victoryCheck(state)` → `{winner, reason}|null`.
- `resourceDrawEligibility(state, factionId)` → `RuleResult` (conquered ≥ 1; `balkania_2` expanded ≥ 4; `resourceful` expanded into a city…).
- `resourceDrawChoices(state, factionId, row)` → `{territoryCardIds, coinAllowed}` from the row `[{cardId, territory, slot}]`.
- `packTriggers(state, event)` → pack ids whose unlock condition the event satisfies (events: `{type: "cityFounded"|"factionEliminated"|"victorSigned"|"worldCapitalPlaced"|"missilesInRoll"|"recruit", …}`).
- `hasPower(state, factionId, key)`.

### 5.2 turn (owner: turn), `game.risklegacy.turn`
- `getTurnInfo()` (sync) → `{war, stage, phase, faction /*Actor*/, isMyTurn, log, snapshot}`.
- **[GM]** `createWar({participants:[{faction, userId, seat}]})` → creates the Combat (`type: "war"`, stage `setup`, combatants without tokens, sorted by seat), sets each faction's `system.war` (Red Star token *or* missiles from `campaign.signaturesOf(...)`, status playing, reserve 0), clears one-shot `used` powers, and records `campaign.system.documents.war`.
- **[GM]** `beginPlacement({order})`, `placeStartingForces({faction, territory})` (HQ + 8 troops; legal-start check; advances the placement index; calls `beginPlay()` once everyone is placed), `beginPlay()`.
- **[GM]** `setPhase({phase})`, `advancePhase()`, `buyRedStars({faction, cardIds})`, `tradeForTroops({faction, cardIds})`, `recruit({faction})` (adds to reserve once per turn and fires the *30 troops + missile* pocket check), `joinWar({faction, territory})`, `placeReserve({faction, territory, count})`, `expand({faction, from, to, count, moved})`, `maneuver({faction, from, to, count, moved})`. `moved: true` means the player already dragged the tokens: just validate, record and apply costs.
- `attack({faction, from, to, dice})` → GM action; records `firstAttackTarget`, then delegates to `battle.startBattle`.
- **[GM]** `advance({faction, from, to, count, moved})`: more troops into a territory just expanded into or conquered (not a maneuver). **[GM]** `moveHQ({faction, from, to, moved})` (Mobile power). `usePower`, `powerOptions`, `snapshot()`, `prompt*` helpers.
- Client wrappers return `null` when an action is refused (the reason is already shown as a notification); they don't throw.
- **[GM]** `recordConquest({faction, from, to, defender})`, called by battle after a conquest: log, HQ capture, knock-out (the defender's resource cards go to the attacker via `cards.transferHand`), victory check.
- `endTurn({faction})`. On the **player's client** it first collects the choices: "complete the mission *or* draw a card" when both are possible, then `cards.promptResourceDraw(faction)` for which card. Then it runs the **[GM]** action `turn.end` with `{faction, draw: {cardId}|{coin: true}|null, completeMission}`: end-of-turn scars → mission or resource draw (`cards.completeMission` / `cards.drawResourceCard`) → events → victory check → `combat.nextTurn()`. Start-of-turn automation runs in `RLCombat._onStartTurn`: reset `turn`, the Join-the-War/elimination check, start-of-turn powers (e.g. `khan_1`).
- **[GM]** `endWar({winner})`: stage `ended`, then `campaign.openEndGame()`. **[GM]** `eliminate({faction})`.

### 5.3 battle (owner: battle), `game.risklegacy.battle`
- **[GM]** `startBattle({attacker, from, to, dice})` → message id. Validates with `rules.checkAttack`, gets the defender's dice (setting `defenderChoice`: auto max, or ask the defending user with a query), rolls (`Roll` + Dice So Nice if active, black attack / red defence), applies modifiers, posts the card.
- **[GM]** `fireMissile({message, faction, side, index})` (die becomes an unmodifiable 6; the *third* missile on one roll triggers `campaign.triggerPack("threemissiles")` **before** resolving), `resolve({message})` (removes casualties via `board.removeTroops`, wears a fortification by 1 when the attack used 3 dice, and on conquest moves the attacking dice survivors in via `board.moveTroops` and calls `turn.recordConquest`), `moveIn({message, count})` (extra troops after a conquest), `attackAgain({message})`.
- Pure `computeModifiers(state, battle)` in `module/battle/modifiers.mjs`: scars, fortification, faction powers (`mechaniker_1`, `mechaniker_2`, `enclave_1`, `enclave_2`, `well-armed`, `well-supplied`…), catalog `effect`s. Rulebook die rules: clamp to 1..6, one die per source when dice tie, re-sort after modifying.

### 5.4 canvas (owner: canvas), `game.risklegacy.board`
- **[GM]** `buildBoardScene({variant, activate})` → scene **id**: 6000×4000, **padding 0** (board coordinates = canvas coordinates), gridless (grid size 100), background from the board definition, one non-interactive Region per territory (flag `territory`, polygons from the board def, GM-visible), scene flag `board = variant`, recorded in `campaign.system.documents.scene`.
- **[GM]** `spawnPieces({faction, territory, troops, hq})` → token ids (uses 3-troop pieces where it can; arranged on the territory's `spots`), `removeTroops({faction, territory, count})` (makes change), `moveTroops({faction, from, to, count})` (makes change; HQs never move), `setTroops({faction, territory, count})`, `clearPieces({faction?})`, `arrangeTerritory({territory})`.
- Client: `pickPoint({prompt, hint, radius, img, validate, faction})` → `Promise<{x,y}|null>` (place a sticker anywhere: ghost follows the cursor), `isOpenWater({x,y}, radius, {ignore})` → `{ok, reason}`, `syncTerritoryRegions()` (Regions also follow `customTerritories` automatically).
- Client: `pickTerritory({prompt, allowed, faction})` → `Promise<string|null>` (highlights the allowed territories, resolves on click, null on Esc/right-click), `highlightTerritories(ids, options)`, `clearHighlights()`, `startPlacement({faction, mode})` / `stopPlacement()` (click-to-place reserve/starting/join troops through the turn API).
- Movement interception for piece tokens (`preMoveToken` and friends): classify drags as expand/attack/maneuver/rearrange, validate synchronously with `rules.*` on `buildSnapshot()`, block illegal ones (per `enforce`), turn attacks into `turn.attack(...)`, and report expand/maneuver to `turn.expand/maneuver({moved: true})`.
- Overlay layer: the legacy marks from the campaign actor (city/scar/fortification stickers at each territory's `mark`, hand-written city names, continent names on the `namePlate`s, ±1 marks, victors' signatures, world name, destroyed-card x), live troop totals per territory, hover info, highlights. Redraw on campaign/token/scene changes.
- Token HUD extras for pieces (split a 3-troop piece, merge three 1-troop pieces) and scene controls for the board tools.

### 5.5 cards (owner: cards), `game.risklegacy.cards`
- **[GM]** `buildDecks({variant})` → `{role: id}` (face-down decks are LIMITED so the core Cards sheet can't reveal the draw order; face-up piles OBSERVER): creates every `CARD_STACKS` stack with `flags[SYSTEM_ID].role` and fills them from the *opened* packs (territory cards: 6 faces for the campaign's variant, `face = value-1`, back = resource card), recorded in `campaign.system.documents`. `addPackCards({pack})`, `ensureHand({faction})`.
- **[GM]** `setupSideboard()`: recall everything, shuffle the territory deck, refill the coin pile, deal four cards to row slots 1–4 (this does **not** trigger events), reveal a mission if the mission deck exists, shuffle the events.
- Sync: `getRow()` → `Card[]` (index 0 = slot 1), `getResourceCards(faction)`.
- `drawOptions(faction)`; **[GM]** `drawResourceCard({faction, cardId /* null = coin */})` → `{cardId, eventCardId}`: enforces the rule, slides the row right, refills slot 1 (reshuffles the discard pile when the deck is empty), discards slot 4 when a coin is taken, awards the coin-pile Red Star the first time the coin pile runs out (tie: nobody), and reveals an event when the new slot-1 card has an even value (only if events exist). `promptResourceDraw(faction)`: a client dialog that only **chooses** (shows the row and coin pile, with the legal choices enabled) and returns `{cardId}|{coin: true}|null`. It does not draw.
- **[GM]** `discardResources({faction, cardIds})` → `{count, coins}` (territory → discard, coin → coin pile), `transferHand({from, to})`.
- **[GM]** `dealScars({factions})`, `playScar({faction, cardId, territory})` (writes the scar into `campaign.system.territories`, logs it, deletes the card permanently), `upgradeTerritoryCard({territory, amount})`, `destroyTerritoryCard({territory})`, `revealMission()`, `completeMission({faction})`, `revealEvent()`.
- `chooseResourceCards({faction, purpose: "redStar"|"troops", title})` → `cardIds|null`: client picker over the faction's hand that shows card faces, the coin total and what it buys (4 cards = 1 Red Star; 2–10 coins → troops), and enforces the legal selection.
- Events: with the world setting `eventAutomation` (default on) every catalog event's effect is executed (`module/cards/event-effects.mjs`); choices are asked of the controlling player on their own client (query `fvtt-risklegacy-v5.events.choose`, GM fallback after 60 s); ties/absent factions → the event doesn't occur. `runEvent({catalogId|cardId, faction?, dryRun?})` [GM]. Events of packages opened mid-game (Pocket 1/2) are put aside and join the event deck at the next `setupSideboard`.
- `scarTargets()` (sync): territories a territory scar may go on (unscarred, not a Fallout Zone, printed territories only).
- Apps: `openSideboard()` (the physical sideboard look: DRAW count, coin pile with its printed star note, MISSION, EVENT, DISCARD, slots 1–4 with arrows), plus a hand viewer that the faction sheet can embed (`renderHand(faction)` → HTML string, or a reusable part).

### 5.6 apps (owner: apps), `game.risklegacy.apps`
- Sheets (registered in `init`): `FactionSheet` (faction card front/back, powers by slot, this-war stats from the snapshot, hand), `CampaignSheet` (the world: territories and marks, continents, victors, stickers, packages, chronicle), `PowerSheet`.
- `openWarRoom()`: the turn HUD (ApplicationV2, compact, docked). It shows the current faction and the five numbered red step discs (current one highlighted), with step-specific controls wired to `turn.*`: buy Red Stars, trade cards, recruit breakdown, reserve counter + "place troops" (`board.startPlacement`), Join the War, attack/expand/maneuver hints and buttons (`board.pickTerritory`), Draw card / End turn. Also a scoreboard (each faction's Red Stars, troops, territories, cards, missiles). It opens for everyone during a war and re-renders on combat/actor/token/cards changes.
- Shared dialogs (`module/apps/dialogs.mjs`, exported): `chooseNumber({title, label, min, max, value})`, `confirmAction({title, content, destructive})`, `chooseOption({title, content, options:[{value,label,hint,img,disabled}]})`, `promptText({title, label, value, hand})`: DialogV2 in the design style, returning the value or `null` if cancelled. Other areas use these. (Picking resource cards is the cards area's `chooseResourceCards`, below.)
- `openReference()`: a compact player-aid window (turn overview with the numbered steps, troops chart, coin trade chart, 4 cards = 1 Red Star, the active scars and marks).
- Chat helper: `renderChatMessageHTML` adds the `risklegacy` class to messages flagged `flags[SYSTEM_ID].card = true`.

### 5.7 campaign (owner: campaign), `game.risklegacy.campaign`
- **[GM]** `createCampaign({variant, date, signatures})`: creates the campaign actor (setting `campaignActorId`), faction actors from the catalog (prototype token = linked 1-troop piece), base power Items, decks (`cards.buildDecks`), the scene (`board.buildBoardScene`) and the rulebook; sets the sticker inventory; marks `base` opened.
- Wizards (ApplicationV2): `openNewCampaign()`, `openFirstGame()` (choose one starting power per faction and destroy the other; place the 12 pre-game coins, max 3 per card, or random), `openGameSetup()` (players ↔ factions, the pick-order roll, Red Stars/missiles, deal scars, `cards.setupSideboard`, `turn.createWar`, then starting placement in pick order with `board.pickTerritory` + `turn.placeStartingForces`, and record the back of the faction cards), `openEndGame()` (results; winner signs and picks a reward; held-on rewards clockwise; pack triggers; world naming after game 15).
- **[GM]** legacy operations: `foundCity`, `fortifyCity`, `placeScar`, `cancelScar`, `nameContinent`, `modifyContinent`, `recordGame`, `nameWorld`, `addLog`.
- Packages: `triggerPack(packId, {reason})` (prompts to open if not opened yet), **[GM]** `openPack(packId)` (powers, factions, cards via `cards.addPackCards`, stickers, marks, rule stickers into the rulebook, a "War Progresses" reading in chat). It listens to the `risklegacy.*` hooks (§8) and `rules.packTriggers` to detect unlocks.
- Map changes: `placeSeaLine({faction, by, sticker, a, b, force})` (client flow: two coastal, non-adjacent territories; pen line routed around other land/panels), `offerSeaLine({faction, sticker, reason})` [GM → asks that player], `placeAlienIsland({faction, by, force})` (pickPoint on open water + its two sea lines; Pocket 2 mid-game also lands the collaborator's troops), `ruinCity({territory, by, force})`.
- `openStickerSheet()`: the sticker sheet: every sticker with its remaining count and a validated **Place…** flow (cities, fortification, cancel scar, ±1 continent, coins, sea lines, Alien Island, ruins, fallout; GM "place a scar" correction). The end-of-game reward prompts use the same placement helpers (`module/campaign/placements.mjs`).
- Rulebook: `buildRulebook()`, `applyRuleAddition({letter, ruleId})`.
- Landing: when the GM opens a world without a campaign, offer "Begin a Campaign". Between games, offer "Set up the next game".

---

## 6. Board definition (`data/boards/<variant>.json`)
Scene px coordinates (6000×4000). Polygons are flat arrays `[x0,y0,x1,y1,…]` (one per landmass), which is the
format Region polygon shapes use.
```json
{ "id": "original", "label": "…", "credits": "…",
  "scene": { "width": 6000, "height": 4000, "background": "assets/board/original.webp" },
  "source": { "path": "assets/board/original.jpg", "width": 8917, "height": 5945 },
  "pieceSize": 90,
  "continents": { "<id>": { "label", "bonus", "color", "territories": [], "plate": {x,y,width,height}, "namePlate": {x,y,width,height}, "bonusBadge": {x,y,r} } },
  "territories": { "<id>": { "name", "continent", "polygons": [[…]], "center": [x,y], "label": [x,y], "mark": [x,y], "spots": [[x,y]…], "neighbors": [] } },
  "seaLines": [ { "a", "b", "points": [[x,y],[x,y]] } ],
  "furniture": { "referenceStickers": [{x,y,width,height,printed}], "victors": {x,y,width,height, "lines": [{n,x,y,width}]}, "worldName": {…}, "troopChart": {…}, "tradeChart": {…}, "starTrade": {…} } }
```
Continent ids differ between boards (original: `north_america, south_america, europe, africa, asia, australia`).
Territory ids are the same on both.

## 7. Content catalog (`data/content/<pack>.json` + `index.json`)
Pack ids: `base, minorcities, eliminated, secondwin, worldcapital, threemissiles, thirtytroops`. Per pack:
`id, label, order, kind, trigger{key, text}, warProgresses[], factions[], powers[], territoryCards[], coinCards,
scars[], stickers[], events[], missions[], draft[], rules[], marks[], secretPowers[], notes[]`. Entry shapes:
- faction `{id, name, img, color, pieces{troop, triple, hq}}`
- power `{id, faction, slot, name, text, img, timing, automation}`
- territoryCard `{id, name, continent, value, faces{original:[6 paths], advanced:[6 paths]}, back}`
- scar `{id, name, qty, target, cardImg, stickerImg, text, effect}` (effect e.g. `{type:"dieMod", side, die, delta}`)
- sticker `{id, name, qty, img, group, text}`; event `{id, name, qty, img, text, afterResolve, effect}`;
  mission `{id, name, qty, img, text, reward, check}`; draft `{id, name, img, type, players, value, text}`;
  rule `{id, img, kind: addition|evolution|rulesCard|mark, addition, page, title, text, replaces}`; mark `{id, name, img, text}`.
`data/content/README.md` documents the effect/check vocabularies.

---

## 8. Custom hooks
Fired with `Hooks.callAll` **on the client that executed the GM action** (the active GM), after the documents are
updated. Faction/war arguments are **documents** (Actor, Combat), not ids. Also: `risklegacy.redStarTokenGained(faction, n, source)` (turn). UI should re-render from document hooks (`updateCombat`, `updateActor`, `createToken`, `updateCard`, …), not
from these.

| Hook | Args | Fired by |
|---|---|---|
| `risklegacy.warCreated` | `(war)` | turn |
| `risklegacy.turnStarted` | `(war, faction)` | turn |
| `risklegacy.phaseChanged` | `(war, phase)` | turn |
| `risklegacy.recruited` | `(faction, total, breakdown)` | turn |
| `risklegacy.conquered` | `(faction, territory, defender)` | turn |
| `risklegacy.factionKnockedOut` | `(faction, by)` | turn |
| `risklegacy.factionEliminated` | `(faction)` | turn |
| `risklegacy.missileFired` | `(message, countOnThisRoll, faction)` | battle |
| `risklegacy.battleResolved` | `(message)` | battle |
| `risklegacy.cardDrawn` | `(faction, card)` | cards |
| `risklegacy.cityFounded` | `(territory, type)` | campaign |
| `risklegacy.victorSigned` | `(game, playerId, signatureCount)` | campaign |
| `risklegacy.warEnded` | `(war, winner)` | turn |
| `risklegacy.packOpened` | `(packId)` | campaign |

---

## 9. Testing

```bash
S=<the foundry-vtt-dev skill>/scripts
ROOT=<this checkout>
SB=<a folder for test sandboxes>
node $S/fvtt-lint.mjs "$ROOT"
node $S/fvtt-server.mjs start --link "$ROOT" --fresh-world --port <PORT> --sandbox "$SB/sandbox-<area>"
node $S/fvtt-browser.mjs eval  --port <PORT> --sandbox "$SB/sandbox-<area>" --code "…"
node $S/fvtt-browser.mjs smoke --port <PORT> --sandbox "$SB/sandbox-<area>" --shots "$SB/shots-<area>"
node $S/fvtt-server.mjs stop --sandbox "$SB/sandbox-<area>"
```
| Area | Port | Sandbox |
|---|---|---|
| turn (rules + game flow) | 30011 | `$SB/sandbox-turn` |
| canvas | 30012 | `$SB/sandbox-canvas` |
| cards | 30013 | `$SB/sandbox-cards` |
| apps | 30014 | `$SB/sandbox-apps` |
| campaign | 30015 | `$SB/sandbox-campaign` |
| battle | 30016 | `$SB/sandbox-battle` |

The tree is symlinked into each sandbox, so other areas' work-in-progress loads too. If another area's half-finished
code throws during your test, note it and keep going (each area's init/ready is wrapped in try/catch). Don't fix
their code. To test multi-user flows, create extra users with `User.create({name, role: 1})` in eval and log in with
`--user <name>`. Use `--no-canvas` for data-only checks. Screenshots: `--shots` or
`fvtt-browser.mjs screenshot --selector …`. Look at them.
