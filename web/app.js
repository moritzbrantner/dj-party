import init, { Mixer } from "./pkg/dj_party.js";

const state = {
  audioContext: null,
  mixer: null,
  decks: new Map(),
};

class Deck {
  constructor(id, mixerLevelSetter, mixerGainGetter) {
    this.id = id;
    this.mixerLevelSetter = mixerLevelSetter;
    this.mixerGainGetter = mixerGainGetter;
    this.audio = new Audio();
    this.audio.preload = "metadata";
    this.sourceNode = null;
    this.gainNode = null;
    this.objectUrl = null;

    this.fileInput = document.querySelector(`#deck-${id}-file`);
    this.dropZone = document.querySelector(`#deck-${id}-drop-zone`);
    this.title = document.querySelector(`#deck-${id}-title`);
    this.current = document.querySelector(`#deck-${id}-current`);
    this.duration = document.querySelector(`#deck-${id}-duration`);
    this.seek = document.querySelector(`#deck-${id}-seek`);
    this.playButton = document.querySelector(`#deck-${id}-play`);
    this.restartButton = document.querySelector(`#deck-${id}-restart`);
    this.level = document.querySelector(`#deck-${id}-level`);
    this.levelValue = document.querySelector(`#deck-${id}-level-value`);
    this.deckState = document.querySelector(`#deck-${id}-state`);
    this.platter = document.querySelector(`#deck-${id}-platter`);

    this.bindEvents();
  }

  bindEvents() {
    this.fileInput.addEventListener("change", () => {
      const [file] = this.fileInput.files;
      if (file) {
        this.loadFile(file);
      }
    });

    for (const eventName of ["dragenter", "dragover"]) {
      this.dropZone.addEventListener(eventName, (event) => {
        event.preventDefault();
        this.dropZone.classList.add("is-dragging");
      });
    }

    for (const eventName of ["dragleave", "drop"]) {
      this.dropZone.addEventListener(eventName, (event) => {
        event.preventDefault();
        this.dropZone.classList.remove("is-dragging");
      });
    }

    this.dropZone.addEventListener("drop", (event) => {
      const [file] = event.dataTransfer?.files ?? [];
      if (file) {
        this.loadFile(file);
      }
    });

    this.playButton.addEventListener("click", async () => {
      if (this.audio.paused) {
        await this.play();
      } else {
        this.audio.pause();
      }
    });

    this.restartButton.addEventListener("click", () => {
      this.audio.currentTime = 0;
      this.updateProgress();
    });

    this.seek.addEventListener("input", () => {
      if (!Number.isFinite(this.audio.duration) || this.audio.duration <= 0) {
        return;
      }

      this.audio.currentTime = (Number(this.seek.value) / 1000) * this.audio.duration;
      this.updateProgress();
    });

    this.level.addEventListener("input", () => {
      const level = Number(this.level.value) / 100;
      this.mixerLevelSetter(level);
      this.levelValue.textContent = `${this.level.value}%`;
      applyMixerGains();
    });

    this.audio.addEventListener("loadedmetadata", () => {
      this.duration.textContent = formatTime(this.audio.duration);
      this.seek.disabled = false;
      this.deckState.textContent = "Ready";
    });

    this.audio.addEventListener("durationchange", () => {
      this.duration.textContent = formatTime(this.audio.duration);
    });

    this.audio.addEventListener("timeupdate", () => this.updateProgress());

    this.audio.addEventListener("play", () => {
      this.playButton.textContent = "Ⅱ Pause";
      this.deckState.textContent = "Playing";
      this.platter.classList.add("is-playing");
    });

    this.audio.addEventListener("pause", () => {
      this.playButton.textContent = "▶ Play";
      this.deckState.textContent = this.audio.ended ? "Ended" : "Paused";
      this.platter.classList.remove("is-playing");
    });

    this.audio.addEventListener("ended", () => {
      this.playButton.textContent = "▶ Play";
      this.deckState.textContent = "Ended";
      this.platter.classList.remove("is-playing");
      this.updateProgress();
    });

    this.audio.addEventListener("error", () => {
      this.deckState.textContent = "Audio error";
      this.playButton.disabled = true;
      this.restartButton.disabled = true;
    });
  }

  loadFile(file) {
    const looksLikeAudio = file.type.startsWith("audio/") || /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(file.name);
    if (!looksLikeAudio) {
      this.deckState.textContent = "Unsupported file";
      return;
    }

    this.audio.pause();
    this.audio.currentTime = 0;

    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
    }

    this.objectUrl = URL.createObjectURL(file);
    this.audio.src = this.objectUrl;
    this.audio.load();

    this.title.textContent = stripExtension(file.name);
    this.current.textContent = "0:00";
    this.duration.textContent = "0:00";
    this.seek.value = "0";
    this.seek.disabled = true;
    this.playButton.disabled = false;
    this.restartButton.disabled = false;
    this.deckState.textContent = "Loading";
    this.platter.classList.remove("is-playing");
  }

  async play() {
    await ensureAudioContext();
    this.ensureAudioGraph();
    applyMixerGains();

    try {
      await this.audio.play();
    } catch (error) {
      console.error(`Could not play deck ${this.id.toUpperCase()}`, error);
      this.deckState.textContent = "Playback blocked";
    }
  }

  ensureAudioGraph() {
    if (this.sourceNode || !state.audioContext) {
      return;
    }

    this.sourceNode = state.audioContext.createMediaElementSource(this.audio);
    this.gainNode = state.audioContext.createGain();
    this.sourceNode.connect(this.gainNode);
    this.gainNode.connect(state.audioContext.destination);
  }

  applyGain() {
    if (!this.gainNode || !state.audioContext) {
      return;
    }

    const gain = this.mixerGainGetter();
    this.gainNode.gain.setTargetAtTime(gain, state.audioContext.currentTime, 0.012);
  }

  updateProgress() {
    this.current.textContent = formatTime(this.audio.currentTime);

    if (!Number.isFinite(this.audio.duration) || this.audio.duration <= 0) {
      this.seek.value = "0";
      return;
    }

    const progress = Math.round((this.audio.currentTime / this.audio.duration) * 1000);
    this.seek.value = String(progress);
  }

  destroy() {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }
}

function stripExtension(fileName) {
  return fileName.replace(/\.[^.]+$/, "") || fileName;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0:00";
  }

  const wholeSeconds = Math.floor(seconds);
  const minutes = Math.floor(wholeSeconds / 60);
  const remainder = String(wholeSeconds % 60).padStart(2, "0");
  return `${minutes}:${remainder}`;
}

async function ensureAudioContext() {
  if (!state.audioContext) {
    state.audioContext = new AudioContext({ latencyHint: "interactive" });
  }

  if (state.audioContext.state === "suspended") {
    await state.audioContext.resume();
  }
}

function applyMixerGains() {
  const deckA = state.decks.get("a");
  const deckB = state.decks.get("b");

  deckA?.applyGain();
  deckB?.applyGain();

  document.querySelector("#gain-a").textContent = state.mixer.deck_a_gain().toFixed(3);
  document.querySelector("#gain-b").textContent = state.mixer.deck_b_gain().toFixed(3);
}

function bindCrossfader() {
  const crossfader = document.querySelector("#crossfader");
  const output = document.querySelector("#crossfader-value");

  crossfader.addEventListener("input", () => {
    const value = Number(crossfader.value);
    state.mixer.set_crossfader(value / 100);
    output.textContent = describeCrossfader(value);
    applyMixerGains();
  });
}

function describeCrossfader(value) {
  if (value === 0) {
    return "Center";
  }

  return `${Math.abs(value)}% toward ${value < 0 ? "A" : "B"}`;
}

async function start() {
  await init();
  state.mixer = new Mixer();

  state.decks.set(
    "a",
    new Deck(
      "a",
      (value) => state.mixer.set_deck_a_level(value),
      () => state.mixer.deck_a_gain(),
    ),
  );
  state.decks.set(
    "b",
    new Deck(
      "b",
      (value) => state.mixer.set_deck_b_level(value),
      () => state.mixer.deck_b_gain(),
    ),
  );

  bindCrossfader();
  applyMixerGains();
}

start().catch((error) => {
  console.error("DJ Party failed to initialize", error);
  const sessionStatus = document.querySelector(".session-status");
  sessionStatus.textContent = "Mixer engine unavailable";
});

window.addEventListener("beforeunload", () => {
  for (const deck of state.decks.values()) {
    deck.destroy();
  }
});
