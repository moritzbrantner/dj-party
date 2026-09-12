import assert from "node:assert/strict";
import test from "node:test";

import { CollaborativeMixerControls } from "./collaborative-mixer.js";

if (typeof globalThis.CustomEvent !== "function") {
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, { detail } = {}) {
      super(type);
      this.detail = detail;
    }
  };
}

test("local mixer inputs submit bounded shared commands", () => {
  const coordinator = new FakeCoordinator();
  const mixer = new CollaborativeMixerControls({ coordinator });
  mixer.controls = fakeControls();
  mixer.bindLocalChanges();

  mixer.controls.crossfader.value = "25";
  mixer.controls.crossfader.dispatchEvent(new Event("input"));
  mixer.controls.decks.a.level.value = "60";
  mixer.controls.decks.a.level.dispatchEvent(new Event("input"));
  mixer.controls.decks.b.tempo.value = "-3.5";
  mixer.controls.decks.b.tempo.dispatchEvent(new Event("input"));
  mixer.controls.decks.a.keyLock.checked = false;
  mixer.controls.decks.a.keyLock.dispatchEvent(new Event("change"));
  mixer.controls.decks.b.tone.low.value = "40";
  mixer.controls.decks.b.tone.low.dispatchEvent(new Event("input"));

  assert.deepEqual(coordinator.commands, [
    { kind: "crossfader", position: 0.25 },
    { kind: "deck-level", deck: "a", level: 0.6 },
    { kind: "tempo", deck: "b", percent: -3.5 },
    { kind: "key-lock", deck: "a", enabled: false },
    { kind: "tone", deck: "b", tone: { low: 40, mid: 0, high: 0, filter: 0 } },
  ]);
});

test("programmatic sync, phase-sync, track load, and EQ reset changes are submitted", () => {
  const coordinator = new FakeCoordinator();
  const mixer = new CollaborativeMixerControls({ coordinator });
  mixer.controls = fakeControls();
  const deck = mixer.controls.decks.a;

  deck.syncButton.addEventListener("click", () => {
    deck.tempo.value = "4.5";
  });
  deck.phaseSyncButton.addEventListener("click", () => {
    deck.tempo.value = "-2.0";
  });
  deck.fileInput.addEventListener("change", () => {
    deck.tempo.value = "0.0";
  });
  deck.toneResetButton.addEventListener("click", () => {
    for (const control of Object.values(deck.tone)) {
      control.value = "0";
    }
  });

  mixer.bindLocalChanges();

  deck.syncButton.dispatchEvent(new Event("click"));
  deck.phaseSyncButton.dispatchEvent(new Event("click"));
  deck.fileInput.dispatchEvent(new Event("change"));
  deck.tone.low.value = "42";
  deck.toneResetButton.dispatchEvent(new Event("click"));

  assert.deepEqual(coordinator.commands, [
    { kind: "tempo", deck: "a", percent: 4.5 },
    { kind: "tempo", deck: "a", percent: -2 },
    { kind: "tempo", deck: "a", percent: 0 },
    { kind: "tone", deck: "a", tone: { low: 0, mid: 0, high: 0, filter: 0 } },
  ]);
});

test("remote canonical mixer commands reuse local handlers without feedback", () => {
  const coordinator = new FakeCoordinator();
  const mixer = new CollaborativeMixerControls({ coordinator });
  mixer.controls = fakeControls();
  mixer.bindLocalChanges();

  let crossfaderInputs = 0;
  mixer.controls.crossfader.addEventListener("input", () => {
    crossfaderInputs += 1;
  });

  mixer.applyCommand({ kind: "crossfader", position: -0.4 });
  mixer.applyCommand({ kind: "tone", deck: "a", tone: { low: 10, mid: -20, high: 30, filter: -40 } });

  assert.equal(mixer.controls.crossfader.value, "-40");
  assert.equal(crossfaderInputs, 1, "the existing mixer input path is exercised exactly once");
  assert.deepEqual(coordinator.commands, [], "remote application must not be re-submitted to the session");
  assert.deepEqual(mixer.captureState().decks.a.tone, { low: 10, mid: -20, high: 30, filter: -40 });
});

test("host snapshots replace the complete synchronized control surface", () => {
  const coordinator = new FakeCoordinator();
  const mixer = new CollaborativeMixerControls({ coordinator });
  mixer.controls = fakeControls();
  mixer.bindLocalChanges();

  mixer.applySnapshot({
    crossfader: 0.75,
    decks: {
      a: {
        level: 0.4,
        tempoPercent: 2.5,
        keyLock: false,
        tone: { low: -10, mid: 0, high: 20, filter: -30 },
      },
      b: {
        level: 0.9,
        tempoPercent: -6,
        keyLock: true,
        tone: { low: 5, mid: 10, high: 15, filter: 25 },
      },
    },
  });

  assert.deepEqual(mixer.captureState(), {
    crossfader: 0.75,
    decks: {
      a: {
        level: 0.4,
        tempoPercent: 2.5,
        keyLock: false,
        tone: { low: -10, mid: 0, high: 20, filter: -30 },
      },
      b: {
        level: 0.9,
        tempoPercent: -6,
        keyLock: true,
        tone: { low: 5, mid: 10, high: 15, filter: 25 },
      },
    },
  });
  assert.deepEqual(coordinator.commands, []);
});

class FakeCoordinator extends EventTarget {
  constructor() {
    super();
    this.commands = [];
  }

  submitLocalCommand(command) {
    this.commands.push(command);
    return true;
  }

  registerMixer() {
    return () => {};
  }

  snapshot() {
    return { active: false, ready: false, role: null, canonicalSequence: 0 };
  }
}

class FakeControl extends EventTarget {
  constructor(value = "0") {
    super();
    this.value = value;
    this.checked = true;
  }
}

function fakeControls() {
  return {
    crossfader: new FakeControl("0"),
    decks: {
      a: fakeDeck(),
      b: fakeDeck(),
    },
  };
}

function fakeDeck() {
  return {
    level: new FakeControl("100"),
    tempo: new FakeControl("0"),
    keyLock: new FakeControl("1"),
    syncButton: new FakeControl(),
    phaseSyncButton: new FakeControl(),
    fileInput: new FakeControl(),
    toneResetButton: new FakeControl(),
    tone: {
      low: new FakeControl("0"),
      mid: new FakeControl("0"),
      high: new FakeControl("0"),
      filter: new FakeControl("0"),
    },
  };
}
