import assert from "node:assert/strict";
import test from "node:test";

import {
  DJ_PARTY_SETTING_DEFINITIONS,
  DJ_PARTY_SETTING_PRESENTATION,
  SETTINGS_BROWSER_COMMIT,
  SETTINGS_BROWSER_MODULE_URL,
  SETTINGS_SOURCE_COMMIT,
  resolveColorScheme,
} from "./settings.js";

test("settings browser dependency is pinned to the reviewed browser distribution commit", () => {
  assert.match(SETTINGS_BROWSER_COMMIT, /^[0-9a-f]{40}$/);
  assert.match(SETTINGS_SOURCE_COMMIT, /^[0-9a-f]{40}$/);
  assert.equal(SETTINGS_BROWSER_MODULE_URL.includes(SETTINGS_BROWSER_COMMIT), true);
  assert.equal(SETTINGS_BROWSER_MODULE_URL.includes("/settings-browser.js"), true);
  assert.equal(SETTINGS_BROWSER_MODULE_URL.includes("@main"), false);
  assert.equal(SETTINGS_BROWSER_MODULE_URL.includes("@browser-dist"), false);
});

test("DJ Party uses canonical appearance ids and keeps them immediate user preferences", () => {
  const byId = new Map(DJ_PARTY_SETTING_DEFINITIONS.map((definition) => [definition.id, definition]));
  for (const id of [
    "appearance.color_scheme",
    "appearance.contrast",
    "appearance.color_vision",
    "appearance.night_mode",
    "accessibility.reduce_motion",
  ]) {
    assert.equal(byId.has(id), true);
    assert.equal(byId.get(id).scope, "user");
    assert.equal(byId.get(id).apply_mode, "immediate");
  }

  assert.deepEqual(byId.get("appearance.color_scheme").kind.options, ["system", "light", "dark"]);
  assert.deepEqual(byId.get("appearance.contrast").kind.options, ["system", "normal", "high", "low"]);
  assert.deepEqual(byId.get("appearance.color_vision").kind.options, [
    "off",
    "protanopia",
    "deuteranopia",
    "tritanopia",
    "achromatopsia",
  ]);
});

test("settings presentation is complete and deterministic for every DJ Party setting", () => {
  const definitionIds = DJ_PARTY_SETTING_DEFINITIONS.map((definition) => definition.id).sort();
  const presentationIds = DJ_PARTY_SETTING_PRESENTATION.map((entry) => entry.id).sort();
  assert.deepEqual(presentationIds, definitionIds);
  assert.equal(new Set(presentationIds).size, presentationIds.length);
});

test("system color scheme resolves only from the supplied browser fact", () => {
  assert.equal(resolveColorScheme("system", true), "dark");
  assert.equal(resolveColorScheme("system", false), "light");
  assert.equal(resolveColorScheme("dark", false), "dark");
  assert.equal(resolveColorScheme("light", true), "light");
});
