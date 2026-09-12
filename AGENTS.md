# DJ Party agent guide

## Product direction

DJ Party is a browser-first DJ application with a Rust core. The long-term direction is collaborative mixing, with session setup/signaling delegated to `multiplayer-setup-service` rather than reimplemented here.

## Ownership boundaries

- Rust is authoritative for deterministic mixer state and mix calculations.
- Rust is authoritative for DJ Party's tempo/rate policy, effective-BPM and BPM-sync surface, beat/bar position, phase-sync planning, cue quantization, beat jumps, beat-loop policy, per-deck EQ/filter parameter semantics, and headphone-monitor gain semantics. Reusable pure audio calculations such as equal-power crossfade gains, tempo/rate conversion, tempo-only BPM-sync math, generic beat-loop selection, waveform extrema, generic filter coefficients, and DSP primitives belong to shared audio/math layers and must be consumed rather than duplicated here.
- The browser adapter owns browser-only capabilities: local file/folder selection, browser-local IndexedDB track storage, audio decoding, object URLs, Web Audio nodes, media-element playback, pitch-preservation/key-lock behavior, physical audio-output selection, DOM rendering, workers, and applying Rust-produced transport/gain/tone plans.
- Per-deck EQ/filter nodes must sit before the master/cue split. Headphone cue therefore hears channel tone while remaining pre-fader. Do not apply independent EQ/filter state to the cue branch.
- The browser may apply Rust-produced tone parameters to native Web Audio `BiquadFilterNode`s, but it must not duplicate DJ Party's knob mapping, gain ranges, sweep curve, or generic coefficient-design algorithms.
- The browser-local music collection must reuse the existing deck file-selection/loading path when loading a saved track. Do not duplicate deck reset, analysis, transport, or mixer semantics inside the library adapter.
- Local library import must be idempotent for the same file identity; re-importing the same track must not create duplicate collection rows.
- Headphone cue branches are pre-fader. The monitor's Master contribution must follow the existing Rust-owned post-fader deck gains rather than duplicate crossfader or deck-level math in JavaScript.
- Audio-output routing must fail closed: when a separate permitted sink cannot be selected or disappears, stop that monitor route without changing the master playback route.
- Do not duplicate Rust mixer, monitor, transport, or tone-policy formulas in JavaScript.
- Local library blobs, tracks, decoded PCM, timing state, cue points, loops, tone state, and monitor state must stay local unless a future feature explicitly introduces user-approved transfer or sharing.
- Beat-dependent controls must fail closed outside the verified beat-grid horizon; never silently snap to stale analyzed data.
- `audio-analysis` remains authoritative for BPM, beat-grid, downbeat, Fourier, related reusable analysis semantics, and reusable policy-neutral audio/DJ calculations.
- Multiplayer is not part of the current local mixer slices. When introduced, keep signaling/session setup behind a narrow adapter to `multiplayer-setup-service`.

## Browser acceptance

The browser app is acceptable when all of these hold:

1. `cargo fmt --all --check`
2. `cargo clippy --all-targets --all-features -- -D warnings`
3. `cargo test --all-features`
4. browser-module syntax validation passes for `web/app.js`, `web/mixer-app.js`, `web/library.js`, `web/analysis-worker.js`, `web/performance.js`, `web/output-routing.js`, and `web/effects.js`
5. `node --test web/library.test.mjs` passes the deterministic library helper contract
6. `bash scripts/build-pages.sh`
7. the built Pages artifact contains the generated Rust/WASM package and all local browser modules/assets, including track-library, deck-effects, and headphone-monitor routing assets
8. multi-file/folder imports stay browser-local, duplicate imports collapse to one collection identity, and saved tracks load through the existing deck file path
9. BPM Sync remains tempo-only while Phase Sync explicitly owns the transport seek needed for phase alignment
10. per-deck tone controls use Rust-owned parameter plans, exact center filter state is a bypass, and both master and pre-fader cue consume the same tone-shaped signal
11. browsers without usable audio-output selection keep monitoring disabled without weakening or redirecting normal master playback

Do not weaken these checks to make a change mergeable.
