/**
 * Shared state layer (owned by the integrator; other areas import from here, never the reverse).
 */
import { preloadBoards } from "./boards.mjs";
import { preloadContent } from "./content.mjs";

export * from "./boards.mjs";
export * from "./content.mjs";
export * from "./accessors.mjs";
export * from "./snapshot.mjs";
export * from "./enforce.mjs";

let loading = null;
let loaded = false;

/**
 * Load board definitions and the content catalog. Started in the system's `init` hook and awaited before any
 * area's ready(). Foundry draws the canvas *before* `ready`, so canvas layers must `await preload()` in their async
 * `_draw` instead of assuming the data is there. Safe to call any number of times; returns the same promise.
 * @returns {Promise<void>}
 */
export function preload() {
  loading ??= Promise.all([preloadBoards(), preloadContent()]).then(() => { loaded = true; });
  return loading;
}

/** @returns {boolean} board definitions and the content catalog have finished loading */
export function isLoaded() {
  return loaded;
}
