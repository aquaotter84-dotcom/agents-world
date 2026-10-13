/**
 * Sound and haptics: the whole point of this module is that it can never break
 * the world. A phone with no WebAudio, a browser with no vibrate, a keeper who
 * never turned it on — every one of those has to be silence, not an error in the
 * middle of a tick.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { isSoundOn, setSoundOn, chime, buzz, sting, recipeSize, ready } from "../app/sound.js";

test("sound is off until the keeper asks for it", () => {
  assert.equal(isSoundOn({}), false);
  assert.equal(isSoundOn(null), false);
  assert.equal(isSoundOn({ sound: false }), false);
  assert.equal(isSoundOn({ sound: true }), true);
});

test("turning it on is remembered in the settings the app already saves", () => {
  const settings = /** @type {any} */ ({});
  setSoundOn(settings, true);
  assert.equal(settings.sound, true);
  assert.equal(isSoundOn(settings), true);
  setSoundOn(settings, false);
  assert.equal(isSoundOn(settings), false);
});

test("nothing throws on a device with no audio and no motor", () => {
  // This is the jsdom case, and the case of a browser that refuses WebAudio.
  assert.equal(ready(), false);
  const settings = { sound: true };
  for (const kind of /** @type {const} */ (["moment", "beat", "settle"])) {
    assert.doesNotThrow(() => chime(kind, { settings }));
    assert.doesNotThrow(() => buzz(kind, { settings }));
    assert.doesNotThrow(() => sting(kind, { settings }));
  }
  // With sound off, a buzz must not even reach for the vibrate API.
  const nav = /** @type {any} */ (globalThis).navigator;
  if (nav) nav.vibrate = () => { throw new Error("should not have been called"); };
  assert.equal(buzz("moment", { settings: { sound: false } }), false);
});

test("the chime is generated on the device, and shaped like a chime", () => {
  // The app ships as a phone app with no assets, so every sound is two sine
  // tones and an envelope. This stands in for a device's WebAudio and checks
  // that a moment really is a rising pair of notes that decay.
  /** @type {any[]} */
  const oscillators = [];
  let resumed = 0;
  class FakeCtx {
    constructor() { this.state = "suspended"; this.currentTime = 10; this.destination = {}; }
    resume() { resumed++; this.state = "running"; }
    createOscillator() {
      /** @type {any} */
      const osc = {
        type: "", frequency: { value: 0 }, connected: null,
        connect(/** @type {any} */ node) { osc.connected = node; },
        start(/** @type {number} */ at) { osc.startedAt = at; },
        stop(/** @type {number} */ at) { osc.stoppedAt = at; }
      };
      oscillators.push(osc);
      return osc;
    }
    createGain() {
      /** @type {any[][]} */
      const ramps = [];
      const gain = {
        gain: {
          setValueAtTime: (/** @type {number} */ v, /** @type {number} */ at) => ramps.push(["set", v, at]),
          linearRampToValueAtTime: (/** @type {number} */ v, /** @type {number} */ at) => ramps.push(["linear", v, at]),
          exponentialRampToValueAtTime: (/** @type {number} */ v, /** @type {number} */ at) => ramps.push(["exp", v, at])
        },
        ramps, connect: () => {}
      };
      return gain;
    }
  }
  const previous = /** @type {any} */ (globalThis).AudioContext;
  /** @type {any} */ (globalThis).AudioContext = FakeCtx;
  try {
    chime("moment", { settings: { sound: true }, force: true });
    assert.equal(resumed, 1, "a suspended context is resumed when the keeper asks for sound");
    assert.equal(oscillators.length, 2, "a moment is two notes");
    assert.ok(oscillators[1].frequency.value > oscillators[0].frequency.value, "and it rises");
    assert.ok(oscillators[0].startedAt >= 10, "the notes are scheduled on the audio clock");
    assert.ok(oscillators[0].stoppedAt > oscillators[0].startedAt, "and they end");

    oscillators.length = 0;
    // With sound off, a sting is silent even with the context open.
    sting("moment", { settings: { sound: false } });
    assert.equal(oscillators.length, 0, "off means off");
  } finally {
    if (previous === undefined) delete /** @type {any} */ (globalThis).AudioContext;
    else /** @type {any} */ (globalThis).AudioContext = previous;
  }
});

test("each kind of event has its own sound, and a moment is more than a beat", () => {
  assert.ok(recipeSize("moment") > recipeSize("beat"), "a moment is two notes; a beat is one");
  assert.ok(recipeSize("settle") >= 1);
  // An unknown kind still makes a sound rather than silence.
  assert.equal(recipeSize("nonsense"), recipeSize("beat"));
});
