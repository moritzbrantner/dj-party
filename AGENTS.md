# DJ Party agent guide

## Product direction

DJ Party is a browser-first DJ application with a Rust core. The long-term direction is collaborative mixing, with session setup/signaling delegated to `multiplayer-setup-service` rather than reimplemented here.

## Ownership boundaries

- Rust is authoritative for deterministic mixer state and mix calculations.
- Rust is authoritative for tempo/rate mapping, effective BPM, BPM-sync planning, beat/bar position, phase-sync planning, cue quantization, beat jumps, and beat-loop boundaries.
- The browser adapter owns browser-only capabilities: local file selection and decoding, object URLs, Web Audio nodes, media-element playback, pitch-preservation/key-lock behavior, DOM rendering, workers, and applying Rust-produced transport plans.
- Do not duplicate Rust mixer or transport formulas in JavaScript.
- Local tracks, decoded PCM, timing state, cue points, and loops must stay local unless a future feature explicitly introduces user-approved transfer or sharing.
- Beat-dependent controls must fail closed outside the verified beat-grid horizon; never silently snap to stale analyzed data.
- `audio-analysis` remains authoritative for BPM, beat-grid, downbeat, Fourier, and related reusable analysis semantics.
- Multiplayer is not part of the current local mixer slices. When introduced, keep signaling/session setup behind a narrow adapter to `multiplayer-setup-service`.

## Browser acceptance

The browser app is acceptable when all of these hold:

1. `cargo fmt --all --check`
2. `cargo clippy --all-targets --all-features -- -D warnings`
3. `cargo test --all-features`
4. browser-module syntax validation passes for `web/app.js`, `web/analysis-worker.js`, and `web/performance.js`
5. `bash scripts/build-pages.sh`
6. the built Pages artifact contains the generated Rust/WASM package and all local browser modules/assets
7. BPM Sync remains tempo-only while Phase Sync explicitly owns the transport seek needed for phase alignment

Do not weaken these checks to make a change mergeable.
