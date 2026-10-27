import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPhaseChange, checkTurnAction, nextPhase, step2Done } from "../_module.mjs";
import { makeState } from "./helpers.mjs";

const pieces = { peru: { a: 3 }, egypt: { b: 3 } };
const state = (turn, factions = { a: {}, b: {} }) => makeState({ factions, pieces, turn });

test("turn: whose turn, war stage", () => {
  assert.equal(checkTurnAction(makeState({ factions: { a: {} }, pieces }), "a", "recruit").reason, "RL.Rules.turn.noWar");
  assert.equal(checkTurnAction(state({ faction: "a", stage: "placement" }), "a", "recruit").reason, "RL.Rules.turn.notPlaying");
  assert.equal(checkTurnAction(state({ faction: "b" }), "a", "recruit").reason, "RL.Rules.turn.notYourTurn");
  assert.equal(checkTurnAction(state({ faction: "a" }, { a: { status: "eliminated" }, b: {} }), "a", "recruit").reason, "RL.Rules.turn.eliminated");
  assert.equal(checkTurnAction(state({ faction: "a" }), "a", "dance").reason, "RL.Rules.turn.unknownAction");
});

test("turn: step 1 (Red Stars) only at the start", () => {
  assert.equal(checkTurnAction(state({ faction: "a", phase: "start" }), "a", "buyRedStars").ok, true);
  for ( const phase of ["recruit", "attack", "maneuver", "end"] ) {
    assert.equal(checkTurnAction(state({ faction: "a", phase }), "a", "buyRedStars").ok, false, phase);
  }
});

test("turn: step 2 is Join the War OR Recruit, not both", () => {
  const recruited = state({ faction: "a", phase: "recruit", log: { recruited: true } });
  assert.equal(checkTurnAction(recruited, "a", "join").ok, false);
  assert.equal(checkTurnAction(recruited, "a", "recruit").ok, false);
  assert.equal(step2Done(recruited), true);
  const out = makeState({ factions: { a: { status: "knockedOut" }, b: {} }, pieces: { egypt: { b: 3 } }, turn: { faction: "a", phase: "start" } });
  assert.equal(checkTurnAction(out, "a", "join").ok, true);
  assert.equal(checkTurnAction(out, "a", "recruit").reason, "RL.Rules.recruit.mustJoin");
  assert.equal(checkTurnAction(out, "a", "trade").reason, "RL.Rules.trade.mustJoin");
  assert.equal(checkTurnAction(out, "a", "attack").reason, "RL.Rules.turn.joinFirst");
});

test("turn: ending the turn needs step 2 done and the reserve placed", () => {
  assert.equal(checkTurnAction(state({ faction: "a", phase: "start" }), "a", "endTurn").reason, "RL.Rules.turn.recruitFirst");
  const reserve = state({ faction: "a", phase: "recruit", log: { recruited: true } }, { a: { reserve: 2 }, b: {} });
  assert.equal(checkTurnAction(reserve, "a", "endTurn").reason, "RL.Rules.turn.placeReserveFirst");
  for ( const phase of ["recruit", "attack", "maneuver", "end"] ) {
    assert.equal(checkTurnAction(state({ faction: "a", phase, log: { recruited: true } }), "a", "endTurn").ok, true, phase);
  }
});

test("phase changes: forward only, never past step 2 with troops to place", () => {
  const s = state({ faction: "a", phase: "attack", log: { recruited: true } });
  assert.equal(checkPhaseChange(s, "a", "recruit").reason, "RL.Rules.phase.backwards");
  assert.equal(checkPhaseChange(s, "a", "maneuver").ok, true);
  assert.equal(checkPhaseChange(s, "a", "attack").data.unchanged, true);
  assert.equal(checkPhaseChange(s, "a", "warp").reason, "RL.Rules.phase.unknown");
  const reserve = state({ faction: "a", phase: "recruit", log: { recruited: true } }, { a: { reserve: 1 }, b: {} });
  assert.equal(checkPhaseChange(reserve, "a", "attack").reason, "RL.Rules.turn.placeReserveFirst");
  const start = state({ faction: "a", phase: "start" });
  assert.equal(checkPhaseChange(start, "a", "recruit").ok, true);
  assert.equal(checkPhaseChange(start, "a", "attack").reason, "RL.Rules.turn.recruitFirst");
  assert.equal(nextPhase("start"), "recruit");
  assert.equal(nextPhase("maneuver"), "end");
  assert.equal(nextPhase("end"), null);
});
