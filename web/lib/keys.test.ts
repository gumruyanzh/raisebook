import assert from "node:assert/strict";
import { test } from "node:test";

import { comboKeys, isApple, isTypingTarget, matchStep, parseCombo } from "./keys";

// "mod" is ⌘ on Apple platforms and Ctrl elsewhere; the runner may be either.
const MOD = isApple() ? { metaKey: true } : { ctrlKey: true };

const ev = (key: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}, code = "") =>
  ({ key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods }) as unknown as KeyboardEvent;

test("parseCombo: modifiers, sequences and implied shift", () => {
  assert.deepEqual(parseCombo("mod+k")[0], { key: "k", mod: true, ctrl: false, meta: false, alt: false, shift: false });
  assert.equal(parseCombo("g p").length, 2);
  assert.equal(parseCombo("shift+?")[0]!.shift, false);
  assert.equal(parseCombo("esc")[0]!.key, "escape");
  assert.equal(parseCombo("mod++")[0]!.key, "+");
});

test("matchStep: mod follows the platform, letters ignore case, bare keys refuse modifiers", () => {
  const [modK] = parseCombo("mod+k");
  assert.equal(matchStep(modK!, ev("k", MOD)), true);
  assert.equal(matchStep(modK!, ev("k")), false);
  const [c] = parseCombo("c");
  assert.equal(matchStep(c!, ev("C", { shiftKey: true })), false);
  assert.equal(matchStep(c!, ev("c")), true);
  assert.equal(matchStep(c!, ev("c", { ctrlKey: true })), false);
  const [q] = parseCombo("?");
  assert.equal(matchStep(q!, ev("?", { shiftKey: true })), true);
  const [alt] = parseCombo("alt+arrowdown");
  assert.equal(matchStep(alt!, ev("ArrowDown", { altKey: true })), true);
});

test("comboKeys: readable caps", () => {
  assert.deepEqual(comboKeys("g p"), ["G", "then", "P"]);
  assert.deepEqual(comboKeys("mod+k"), [isApple() ? "⌘" : "Ctrl", "K"]);
});

test("isTypingTarget: non-elements are never typing targets", () => {
  assert.equal(isTypingTarget(null), false);
});
