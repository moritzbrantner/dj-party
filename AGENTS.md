# DJ Party agent guide

## Product direction

DJ Party is a browser-first DJ application with a Rust core. The long-term direction is collaborative mixing, with session setup/signaling delegated to `multiplayer-setup-service` rather than reimplemented here.

## Ownership boundaries

- Rust is authoritative for deterministic mixer state and mix calculations.
- The browser adapter owns browser-only capabilities: local file selection, object URLs, Web Audio nodes, user-gesture playback, DOM rendering, and interaction wiring.
- Do not duplicate Rust mixer formulas in JavaScript.
- Local tracks must stay local unless a future feature explicitly introduces user-approved transfer or sharing.
- Multiplayer is not part of the first MVP. When introduced, keep signaling/session setup behind a narrow adapter to `multiplayer-setup-service`.
- Audio analysis should reuse suitable `audio-analysis` Rust/WASM surfaces instead of creating parallel BPM, rhythm, Fourier, or related implementations here.

## First MVP acceptance

The browser MVP is acceptable when all of these hold:

1. `cargo fmt --all --check`
2. `cargo clippy --all-targets --all-features -- -D warnings`
3. `cargo test --all-features`
4. `node --input-type=module --check < web/app.js`
5. `bash scripts/build-pages.sh`
6. The built Pages artifact contains the generated Rust/WASM package and all local browser assets.

Do not weaken these checks to make a change mergeable.
