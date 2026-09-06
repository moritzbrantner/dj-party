# DJ Party

DJ Party is a browser-first DJ mixing experiment with a Rust core. The long-term goal is collaborative mixing, while the current local workflow runs entirely on GitHub Pages.

## Current browser workflow

DJ Party can:

- load local audio into either of two decks;
- drag and drop MP3 and other browser-supported audio files;
- play, pause, restart, seek, and set/jump to cue points;
- render full-track waveforms with analyzed beats and downbeats;
- estimate BPM through the pinned `audio-analysis` rhythm engine;
- control each deck level and mix both decks with an equal-power crossfader;
- adjust tempo by ±16% with optional browser key lock;
- create quantized 1/2/4/8-beat loops from the analyzed beat grid;
- sync one deck's effective BPM to the other within the supported tempo range.

Selected tracks, decoded PCM, waveform/beat data, cue points, loops, and timing state stay on the device. DJ Party does not upload audio anywhere.

## Architecture

Rust/WASM is authoritative for deterministic mixer state, gain calculations, waveform reduction, cue semantics, tempo/rate mapping, sync-rate planning, beat-loop boundaries, and rhythm analysis. The browser owns only browser-specific capabilities such as local file decoding, object URLs, media/Web Audio playback, `preservesPitch` key lock, workers, canvas rendering, and DOM interaction.

Rhythm analysis reuses `audio-analysis` at an exact pinned Git revision instead of duplicating BPM, beat-tracking, or Fourier code. Collaborative lobby/signaling will integrate through `multiplayer-setup-service` rather than becoming part of the mixer core.

The current Sync action synchronizes **tempo**, not beat phase. Phase-aware synchronization is deliberately deferred until it can be represented and verified as its own deterministic contract.

## Build and validate

Requirements: Rust 1.95.0, the `wasm32-unknown-unknown` target, and `wasm-pack` 0.13.1.

```sh
cargo fmt --all --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features
cargo install wasm-pack --version 0.13.1 --locked
bash scripts/build-pages.sh
```

The generated static site is written to `_site/` and can be served by any local static HTTP server.

## Roadmap

1. Browser two-deck MVP on GitHub Pages — done
2. Waveforms, cue points, BPM, beat/downbeat analysis — done
3. Tempo/key-lock controls, beat loops, and tempo Sync — current slice
4. Beat-phase alignment and stronger transport/cue workflows
5. EQ/filtering and headphone cue/master routing where browser APIs allow it
6. Multiplayer sessions through `multiplayer-setup-service`
7. Shared-session authority, synchronized collaborative control, and optional user-approved asset transfer
