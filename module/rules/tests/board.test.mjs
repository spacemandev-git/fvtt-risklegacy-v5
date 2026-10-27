import { test } from "node:test";
import assert from "node:assert/strict";
import { TERRITORY_IDS } from "../../config.mjs";
import { connectedThroughOwned } from "../_module.mjs";
import { loadBoard, makeState } from "./helpers.mjs";

test(`board graph (${loadBoard().source}): 42 territories, symmetric adjacency, continents cover all`, () => {
  const { board } = loadBoard();
  const ids = Object.keys(board.territories);
  assert.deepEqual([...ids].sort(), [...TERRITORY_IDS].sort());
  for ( const [id, t] of Object.entries(board.territories) ) {
    assert.ok(t.neighbors.length > 0, `${id} has neighbours`);
    for ( const n of t.neighbors ) assert.ok(board.territories[n]?.neighbors.includes(id), `${id} ↔ ${n}`);
  }
  const inContinents = Object.values(board.continents).flatMap(c => c.territories).sort();
  assert.deepEqual(inContinents, [...TERRITORY_IDS].sort());
  for ( const [id, t] of Object.entries(board.territories) ) {
    assert.ok(board.continents[t.continent]?.territories.includes(id), `${id} in ${t.continent}`);
  }
});

test("board graph: well-known crossings", () => {
  const { board } = loadBoard();
  const adj = (a, b) => board.territories[a].neighbors.includes(b);
  assert.ok(adj("alaska", "kamchatka"));
  assert.ok(adj("brazil", "north_africa"));
  assert.ok(adj("greenland", "iceland"));
  assert.ok(adj("southeast_asia", "indonesia"));
  assert.ok(adj("east_africa", "middle_east"));
  assert.ok(!adj("alaska", "greenland"));
  // whole-world connectivity for one faction holding everything
  const pieces = Object.fromEntries(Object.keys(board.territories).map(id => [id, { a: 1 }]));
  const s = makeState({ factions: { a: {} }, pieces });
  assert.ok(connectedThroughOwned(s, "a", "argentina", "eastern_australia"));
});
