import { sharedSession } from "./shared-session.js";

const DECK_IDS = ["a", "b"];
const TONE_KEYS = ["low", "mid", "high", "filter"];

export function installCollaborativeMixer() {
  if (typeof document === "undefined") {
    return null;
  }
  const controller = new CollaborativeMixerControls();
  void controller.install();
  return controller;
}

export class CollaborativeMixerControls {
  constructor({ coordinator = sharedSession } = {}) {
    this.coordinator = coordinator;
    this.controls = null;
    this.unregisterMixer = null;
    this.abortController = new AbortController();
    this.suppressLocal = false;
    this.status = null;
  }

  async install() {
    this.installStatus();
    this.controls = await waitForMixerControls(this.abortController.signal);
    if (!this.controls) {
      return this;
    }
    this.bindLocalChanges();
    this.unregisterMixer = this.coordinator.registerMixer({
      captureState: () => this.captureState(),
      applyCommand: (command) => this.applyCommand(command),
      applySnapshot: (snapshot) => this.applySnapshot(snapshot),
    });
    this.coordinator.addEventListener("change", (event) => this.renderStatus(event.detail), {
      signal: this.abortController.signal,
    });
    this.renderStatus(this.coordinator.snapshot());
    return this;
  }

  captureState() {
    if (!this.controls) {
      return null;
    }
    return {
      crossfader: Number(this.controls.crossfader.value) / 100,
      decks: {
        a: this.captureDeck("a"),
        b: this.captureDeck("b"),
      },
    };
  }

  applyCommand(command) {
    if (!this.controls || !command) {
      return;
    }
    this.withSuppressedLocal(() => {
      switch (command.kind) {
        case "crossfader":
          setRange(this.controls.crossfader, command.position * 100);
          break;
        case "deck-level":
          setRange(this.controls.decks[command.deck].level, command.level * 100);
          break;
        case "tempo":
          setRange(this.controls.decks[command.deck].tempo, command.percent);
          break;
        case "key-lock":
          setCheckbox(this.controls.decks[command.deck].keyLock, command.enabled);
          break;
        case "tone":
          this.applyTone(command.deck, command.tone);
          break;
        default:
          break;
      }
    });
  }

  applySnapshot(snapshot) {
    if (!this.controls || !snapshot) {
      return;
    }
    this.withSuppressedLocal(() => {
      setRange(this.controls.crossfader, snapshot.crossfader * 100);
      for (const deckId of DECK_IDS) {
        const deck = snapshot.decks[deckId];
        setRange(this.controls.decks[deckId].level, deck.level * 100);
        setRange(this.controls.decks[deckId].tempo, deck.tempoPercent);
        setCheckbox(this.controls.decks[deckId].keyLock, deck.keyLock);
        this.applyTone(deckId, deck.tone);
      }
    });
  }

  destroy() {
    this.abortController.abort();
    this.unregisterMixer?.();
    this.unregisterMixer = null;
  }

  captureDeck(deckId) {
    const deck = this.controls.decks[deckId];
    return {
      level: Number(deck.level.value) / 100,
      tempoPercent: Number(deck.tempo.value),
      keyLock: deck.keyLock.checked,
      tone: Object.fromEntries(TONE_KEYS.map((key) => [key, Number(deck.tone[key].value)])),
    };
  }

  bindLocalChanges() {
    const signal = this.abortController.signal;
    this.controls.crossfader.addEventListener(
      "input",
      () => this.submit({ kind: "crossfader", position: Number(this.controls.crossfader.value) / 100 }),
      { signal },
    );

    for (const deckId of DECK_IDS) {
      const deck = this.controls.decks[deckId];
      deck.level.addEventListener(
        "input",
        () => this.submit({ kind: "deck-level", deck: deckId, level: Number(deck.level.value) / 100 }),
        { signal },
      );
      deck.tempo.addEventListener("input", () => this.submitTempo(deckId), { signal });
      deck.keyLock.addEventListener(
        "change",
        () => this.submit({ kind: "key-lock", deck: deckId, enabled: deck.keyLock.checked }),
        { signal },
      );
      for (const key of TONE_KEYS) {
        deck.tone[key].addEventListener("input", () => this.submitTone(deckId), { signal });
      }

      for (const button of [deck.syncButton, deck.phaseSyncButton]) {
        button.addEventListener("click", () => this.submitTempo(deckId), { signal });
      }
      deck.fileInput.addEventListener("change", () => this.submitTempo(deckId), { signal });
      deck.toneResetButton.addEventListener("click", () => this.submitTone(deckId), { signal });
    }
  }

  submitTempo(deckId) {
    this.submit({ kind: "tempo", deck: deckId, percent: Number(this.controls.decks[deckId].tempo.value) });
  }

  submitTone(deckId) {
    this.submit({ kind: "tone", deck: deckId, tone: this.captureDeck(deckId).tone });
  }

  submit(command) {
    if (!this.suppressLocal) {
      this.coordinator.submitLocalCommand(command);
    }
  }

  applyTone(deckId, tone) {
    const controls = this.controls.decks[deckId].tone;
    for (const key of TONE_KEYS) {
      controls[key].value = String(tone[key]);
    }
    controls.filter.dispatchEvent(new Event("input", { bubbles: true }));
  }

  withSuppressedLocal(callback) {
    this.suppressLocal = true;
    try {
      callback();
    } finally {
      this.suppressLocal = false;
    }
  }

  installStatus() {
    const live = document.querySelector(".multiplayer-live");
    if (!live || document.querySelector("#shared-mixer-status")) {
      this.status = document.querySelector("#shared-mixer-status");
      return;
    }
    const output = document.createElement("output");
    output.id = "shared-mixer-status";
    output.className = "multiplayer-peer-status";
    output.setAttribute("aria-live", "polite");
    output.textContent = "Shared mixer inactive";
    live.append(output);
    this.status = output;
  }

  renderStatus(snapshot) {
    if (!this.status) {
      return;
    }
    if (!snapshot?.active) {
      this.status.textContent = "Shared mixer inactive";
      return;
    }
    if (snapshot.role === "host") {
      this.status.textContent = `Shared mixer host · sequence ${snapshot.canonicalSequence}`;
      return;
    }
    this.status.textContent = snapshot.ready
      ? `Shared mixer synced · sequence ${snapshot.canonicalSequence}`
      : "Shared mixer waiting for host state";
  }
}

async function waitForMixerControls(signal) {
  while (!signal.aborted) {
    const controls = findMixerControls();
    if (controls) {
      return controls;
    }
    await nextFrame();
  }
  return null;
}

function findMixerControls() {
  const crossfader = document.querySelector("#crossfader");
  if (!crossfader) {
    return null;
  }
  const decks = {};
  for (const deckId of DECK_IDS) {
    const tone = Object.fromEntries(
      TONE_KEYS.map((key) => [key, document.querySelector(`#deck-${deckId}-${key}`)]),
    );
    const deck = {
      level: document.querySelector(`#deck-${deckId}-level`),
      tempo: document.querySelector(`#deck-${deckId}-tempo`),
      keyLock: document.querySelector(`#deck-${deckId}-key-lock`),
      syncButton: document.querySelector(`#deck-${deckId}-sync`),
      phaseSyncButton: document.querySelector(`#deck-${deckId}-phase-sync`),
      fileInput: document.querySelector(`#deck-${deckId}-file`),
      toneResetButton: document.querySelector(`#deck-${deckId}-effects-reset`),
      tone,
    };
    if (
      !deck.level ||
      !deck.tempo ||
      !deck.keyLock ||
      !deck.syncButton ||
      !deck.phaseSyncButton ||
      !deck.fileInput ||
      !deck.toneResetButton ||
      Object.values(tone).some((control) => !control)
    ) {
      return null;
    }
    decks[deckId] = deck;
  }
  return { crossfader, decks };
}

function setRange(control, value) {
  control.value = String(value);
  control.dispatchEvent(new Event("input", { bubbles: true }));
}

function setCheckbox(control, value) {
  control.checked = Boolean(value);
  control.dispatchEvent(new Event("change", { bubbles: true }));
}

function nextFrame() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}
