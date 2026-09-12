# DJ Party agent guide

## Product direction

DJ Party is a browser-first DJ application with a Rust core. The long-term direction is collaborative mixing, with session setup/signaling delegated to `multiplayer-setup-service` rather than reimplemented here.

## Ownership boundaries

- Rust is authoritative for deterministic mixer state and mix calculations.
- Rust is authoritative for DJ Party's tempo/rate policy, effective-BPM and BPM-sync surface, beat/bar position, phase-sync planning, cue quantization, beat jumps, beat-loop policy, per-deck EQ/filter parameter semantics, and headphone-monitor gain semantics. Reusable pure audio calculations such as equal-power crossfade gains, tempo/rate conversion, tempo-only BPM-sync math, generic beat-loop selection, waveform extrema, generic filter coefficients, and DSP primitives belong to shared audio/math layers and must be consumed rather than duplicated here.
- The browser adapter owns browser-only capabilities: local file/folder/ZIP/M3U selection, browser-local IndexedDB track/playlist/cache storage, bounded archive extraction, audio decoding, object URLs, Web Audio nodes, media-element playback, pitch-preservation/key-lock behavior, physical audio-output selection, DOM rendering, workers, and applying Rust-produced transport/gain/tone plans.
- ZIP import is only an ingestion adapter. Extracted audio must go through the existing idempotent track importer; archive code must not create an independent track identity or deck-loading path.
- ZIP extraction must remain fail-closed and bounded. Reject encrypted, multi-disk, ZIP64, malformed, oversized, unsupported-compression, truncated, and CRC-mismatched relevant entries rather than partially trusting them.
- M3U/M3U8 import is local-reference metadata only. Never fetch remote playlist URLs; unmatched references stay unavailable. Playlist actions must call the existing saved-track deck loader.
- Cached track analysis is an optimization, never authority. Cache keys must include content-derived identity, sample-rate semantics, and an explicit analysis namespace; stale/malformed entries must be ignored and cache read/write failures must fall back to normal analysis.
- Analysis caching must not move BPM, beat-grid, downbeat, waveform, Fourier, or related algorithm authority out of the existing Rust/shared-audio path.
- Per-deck EQ/filter nodes must sit before the master/cue split. Headphone cue therefore hears channel tone while remaining pre-fader. Do not apply independent EQ/filter state to the cue branch.
- The browser may apply Rust-produced tone parameters to native Web Audio `BiquadFilterNode`s, but it must not duplicate DJ Party's knob mapping, gain ranges, sweep curve, or generic coefficient-design algorithms.
- The browser-local music collection must reuse the existing deck file-selection/loading path when loading a saved track. Do not duplicate deck reset, analysis, transport, or mixer semantics inside the library adapter.
- Local library import must be idempotent for the same file identity; re-importing the same track must not create duplicate collection rows.
- Headphone cue branches are pre-fader. The monitor's Master contribution must follow the existing Rust-owned post-fader deck gains rather than duplicate crossfader or deck-level math in JavaScript.
- Audio-output routing must fail closed: when a separate permitted sink cannot be selected or disappears, stop that monitor route without changing the master playback route.
- Do not duplicate Rust mixer, monitor, transport, or tone-policy formulas in JavaScript.
- Local library blobs, playlists, cached analysis, tracks, decoded PCM, timing state, cue points, loops, tone state, and monitor state must stay local unless a future feature explicitly introduces user-approved transfer or sharing.
- Beat-dependent controls must fail closed outside the verified beat-grid horizon; never silently snap to stale analyzed data.
- `audio-analysis` remains authoritative for BPM, beat-grid, downbeat, Fourier, related reusable analysis semantics, and reusable policy-neutral audio/DJ calculations.
- Multiplayer session setup must use the reusable `LobbySession` client from `multiplayer-setup-service`; do not reimplement lobby HTTP, participant capability-token handling, signaling WebSockets, reconnect policy, ICE exchange, or WebRTC link establishment in DJ Party.
- The reusable multiplayer browser client must be pinned to an exact reviewed source commit. Do not switch DJ Party to an unpinned `main`/latest module URL.
- DJ Party's setup adapter uses `mesh` topology and keeps optional content sharing disabled until a later slice explicitly adds user-approved transfer with content verification.
- The setup service is rendezvous/control plane only. Gameplay/mixer authority, DJ Party commands, audio state, tracks, chat, and content bytes must not move into the service.
- Public invite state may contain only the setup-service API base and public lobby code. Participant capability tokens must remain inside the reusable service client and must never be copied into DJ Party state, storage, logs, or URLs.
- Remote reliable-channel messages must be ignored unless they match a versioned DJ Party application protocol. The session-setup slice may send only the compatibility hello; mixer commands belong to the next shared-session slice.

## Browser acceptance

The browser app is acceptable when all of these hold:

1. `cargo fmt --all --check`
2. `cargo clippy --all-targets --all-features -- -D warnings`
3. `cargo test --all-features`
4. browser-module syntax validation passes for `web/app.js`, `web/mixer-app.js`, `web/multiplayer.js`, `web/library.js`, `web/library-imports.js`, `web/archive-import.js`, `web/analysis-cache.js`, `web/analysis-worker.js`, `web/performance.js`, `web/output-routing.js`, and `web/effects.js`
5. `node --test web/library.test.mjs web/archive-import.test.mjs web/analysis-cache.test.mjs web/multiplayer.test.mjs` passes deterministic library/archive/cache/multiplayer helper contracts
6. `bash scripts/build-pages.sh`
7. the built Pages artifact contains the generated Rust/WASM package and all local browser modules/assets, including multiplayer setup, track-library, archive/playlist import, analysis-cache, deck-effects, and headphone-monitor routing assets
8. multi-file/folder/ZIP imports stay browser-local, duplicate audio imports still collapse through the canonical track importer, and saved/playlist tracks load through the existing deck file path
9. ZIP relevant entries are bounded and CRC-verified, remote playlist references are not fetched, and unsupported archive features fail closed
10. cached waveform/rhythm results are content-addressed/versioned and a cache miss, stale record, or cache failure falls back to normal worker analysis
11. multiplayer setup consumes an exact-commit reusable service client, uses mesh topology, keeps content sharing disabled, and never exposes participant capability tokens in DJ Party state/URLs
12. multiplayer setup sends no mixer/audio/content state; only the versioned DJ Party compatibility hello is accepted during this slice
13. BPM Sync remains tempo-only while Phase Sync explicitly owns the transport seek needed for phase alignment
14. per-deck tone controls use Rust-owned parameter plans, exact center filter state is a bypass, and both master and pre-fader cue consume the same tone-shaped signal
15. browsers without usable audio-output selection keep monitoring disabled without weakening or redirecting normal master playback

Do not weaken these checks to make a change mergeable.
