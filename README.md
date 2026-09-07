# DJ Party

DJ Party is a browser-first DJ mixing experiment with a Rust core. The long-term goal is collaborative mixing, while the current milestone remains deliberately small enough to run entirely on GitHub Pages.

## Browser MVP

The app can:

- load local audio files into two independent decks;
- drag and drop MP3 and other browser-supported audio files;
- play, pause, restart, seek, and control deck level;
- mix decks with a Rust-owned equal-power crossfader;
- render full-track waveforms with Rust-owned extrema;
- analyze BPM, beats, downbeats, and rhythm confidence through the pinned `audio-analysis` Rust engine;
- set an exact cue plus four beat-quantized hot cues per deck;
- adjust tempo by ±16% with optional browser key lock;
- BPM-sync one deck to the other within the supported playback-rate range;
- phase-sync one deck to the other using fractional beat phase and, when verified downbeats are present, the same beat within the 4/4 bar;
- create quantized 1/2/4/8-beat loops;
- jump ±4 or ±8 beats while preserving fractional beat phase;
- show the current analyzed bar, beat, and beat phase;
- route either deck pre-fader to a separate headphone output when the browser exposes secure audio-output selection;
- blend the cued decks with the post-fader master in the headphone monitor using a Rust-owned equal-power Cue ↔ Master control.

Selected tracks, decoded PCM, timing state, cue points, loops, analysis results, and monitor state stay on the device. Nothing is uploaded by the current app.

## Architecture

Rust/WASM is authoritative for deterministic mixer state, gain calculations, tempo/rate mapping, BPM sync planning, beat/bar position, phase-sync planning, hot-cue quantization, beat jumps, beat-loop boundaries, and headphone-monitor gain semantics.

The browser layer owns browser-only capabilities: local file selection and decoding, object URLs, `AudioContext`, media-element playback, pitch-preservation/key-lock behavior, DOM rendering, workers, physical audio-output selection, and applying the seek/rate/gain plans returned by Rust.

Headphone cueing is deliberately pre-fader: the selected deck cue branches bypass the deck level and crossfader, while the optional Master contribution follows the same Rust-owned post-fader deck gains heard on the main output. If the browser cannot select a separate audio output, the headphone controls stay disabled and the existing master playback route is unchanged.

Reusable ownership remains explicit:

- BPM, beat-grid, downbeat, and related rhythm analysis comes from `audio-analysis` rather than being reimplemented here;
- collaborative lobby/signaling should integrate through `multiplayer-setup-service` rather than becoming part of the mixer core.

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

1. Browser MVP on GitHub Pages — done
2. Waveform display and cue point — done
3. Reusable BPM/beat-grid analysis — done
4. Tempo, beat loops, and BPM sync — done
5. Phase sync, quantized hot cues, and beat-jump transport — done
6. Headphone cue/master routing where browser APIs allow it — current slice
7. Mixer EQ/filter controls with deterministic parameter semantics
8. Multiplayer sessions through `multiplayer-setup-service`
9. Shared-session authority, synchronization, optional asset transfer, and collaborative mixing
