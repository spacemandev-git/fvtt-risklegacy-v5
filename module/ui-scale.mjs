/**
 * UI scale for the system's own windows.
 *
 * The stylesheets are written at UI_SCALE (×1.3), so every app's default size has to grow with them. Rather than
 * editing every DEFAULT_OPTIONS and DialogV2 call, the numeric `position.width/height` of any ApplicationV2 whose
 * classes include `risklegacy` is multiplied by UI_SCALE once, when its options are initialized. Core apps are left
 * alone, and Foundry still clamps the result to the viewport.
 */
import { uiScaled } from "./config.mjs";

let installed = false;

export function installUIScale() {
  if ( installed ) return;
  installed = true;
  const AppV2 = foundry.applications.api.ApplicationV2;
  const original = AppV2.prototype._initializeApplicationOptions;
  AppV2.prototype._initializeApplicationOptions = function(options) {
    const result = original.call(this, options);
    if ( result.classes?.includes("risklegacy") && result.position ) {
      const position = result.position = { ...result.position };
      for ( const key of ["width", "height"] ) {
        if ( Number.isFinite(position[key]) ) position[key] = uiScaled(position[key]);
      }
    }
    return result;
  };
}
