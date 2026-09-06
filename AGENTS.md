# DJ Party agent guide

## Product direction

DJ Party is a browser-first DJ application with a Rust core. The long-term direction is collaborative mixing, with session setup/signaling delegated to `multiplayer-setup-service` rather than reimplemented here.

## Ownership boundaries

- Rust is authoritative for deterministic mixer state, mix calculations, tempo/rate mapping, sync-rate planning, cue semantics, beat-loop boundary selection, waveform reduction, and reusable audio analysis.
- The browser adapter owns browser-only capabilities: local file selection/decoding, object URLs, Web Audio/media-element playback, `preservesPitch` key-lock behavior, worker orchestration, DOM/canvas rendering, and interaction wiring.
- Do not duplicate Rust mixer, tempo, sync, loop-selection, BPM, rhythm, or Fourier formulas in JavaScript.
- Local tracks and decoded PCM must stay local unless a future feature explicitly introduces user-approved transfer or sharing.
- Multiplayer is not part of the local DJ slices. When introduced, keep signaling/session setup behind a narrow adapter to `multiplayer-setup-service`.
- Audio analysis must reuse suitable `audio-analysis` Rust/WASM surfaces instead of creating parallel BPM, rhythm, Fourier, or related implementations here.
- Sync is currently tempo synchronization only. Do not claim beat-phase synchronization until a separate authoritative phase-alignment contract is implemented and verified.

## Acceptance

A browser slice is acceptable when all of these hold:

1. `cargo fmt --all --check`
2. `cargo clippy --all-targets --all-features -- -D warnings`
3. `cargo test --all-features`
4. Browser JavaScript modules pass syntax validation.
5. `bash scripts/build-pages.sh`
6. The built Pages artifact contains the generated Rust/WASM package, analysis worker, and all local browser assets.

Do not weaken these checks to make a change mergeable.
