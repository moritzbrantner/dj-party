# DJ Party

DJ Party is a browser-first DJ mixing experiment with a Rust core. The long-term goal is collaborative mixing, while the first milestone is deliberately small enough to run entirely on GitHub Pages.

## Browser MVP

The MVP can:

- load a local audio file into either of two decks;
- drag and drop MP3 and other browser-supported audio files;
- play, pause, restart, and seek each deck independently;
- control each deck level;
- mix both decks with an equal-power crossfader;
- show the live gain values calculated by the Rust/WASM mixer core.

Selected tracks stay on the device. The MVP does not upload audio anywhere.

## Architecture

Rust/WASM is authoritative for deterministic mixer state and gain calculations. The browser layer is intentionally thin and owns only browser-specific capabilities such as local file selection, object URLs, `AudioContext`, `MediaElementAudioSourceNode`, gain nodes, and DOM interaction.

This keeps a clean path toward later reuse:

- suitable BPM/rhythm/Fourier analysis should come from `audio-analysis` rather than being reimplemented here;
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

1. Browser MVP on GitHub Pages
2. Real waveform display and cue points
3. Tempo/BPM and beat-grid analysis through reusable Rust audio analysis
4. Pitch/tempo controls and beat-aligned transport
5. Headphone cue/master routing where browser APIs allow it
6. Multiplayer sessions through `multiplayer-setup-service`
7. Shared-session authority, synchronization, optional asset transfer, and collaborative mixing
