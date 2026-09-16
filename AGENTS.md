# DJ Party agent guide

## Product direction

DJ Party is a browser-first DJ application with a Rust core. The long-term direction is collaborative mixing, with session setup/signaling delegated to `multiplayer-setup-service` rather than reimplemented here.

## Ownership boundaries

- Rust is authoritative for deterministic mixer state and mix calculations.
- Rust is authoritative for DJ Party's tempo/rate policy, effective-BPM and BPM-sync surface, beat/bar position, phase-sync planning, cue quantization, beat jumps, beat-loop policy, per-deck EQ/filter parameter semantics, and headphone-monitor gain semantics. Reusable pure audio calculations such as equal-power crossfade gains, tempo/rate conversion, tempo-only BPM-sync math, generic beat-loop selection, waveform extrema, generic filter coefficients, and DSP primitives belong to shared audio/math layers and must be consumed rather than duplicated here.
- The browser adapter owns browser-only capabilities: local file/folder/ZIP/M3U selection, browser-local IndexedDB track/playlist/cache storage, bounded archive extraction, audio decoding, object URLs, Web Audio nodes, media-element playback, pitch-preservation/key-lock behavior, physical audio-output selection, DOM rendering, workers, and applying Rust-produced transport/gain/tone plans.
- Browser application source is TypeScript under `web/`. Runtime `.js` modules are emitted into `.web-build/` and copied into the Pages artifact; generated browser JavaScript must not be committed as a second source of truth. Keep `.js` import specifiers in TypeScript when they name the emitted browser modules.
- Semantic TypeScript checking stays enabled for browser source. Generated-Wasm bindings and browser APIs may use narrow boundary declarations, but do not disable checking globally or replace class shapes with open-ended index signatures merely to silence the compiler.
- ZIP import is only an ingestion adapter. Extracted audio must go through the existing idempotent track importer; archive code must not create an independent track identity or deck-loading path.
- ZIP extraction must remain fail-closed and bounded. Reject encrypted, multi-disk, ZIP64, malformed, oversized, unsupported-compression, truncated, and CRC-mismatched relevant entries rather than partially trusting them.
- M3U/M3U8 import is local-reference metadata only. Never fetch remote playlist URLs; unmatched references stay unavailable. Playlist actions must call the existing saved-track deck loader.
- Cached track analysis is an optimization, never authority. Cache keys must include content-derived identity, sample-rate semantics, and an explicit analysis namespace; stale/malformed entries must be ignored and cache read/write failures must fall back to normal analysis.
- Analysis caching must not move BPM, beat-grid, downbeat, waveform, Fourier, or related algorithm authority out of the existing Rust/shared-audio path.
- Per-deck EQ/filter nodes must sit before the master/cue split. Headphone cue therefore hears channel tone while remaining pre-fader. Do not apply independent EQ/filter state to the cue branch.
- The browser may apply Rust-produced tone parameters to native Web Audio `BiquadFilterNode`s, but it must not duplicate DJ Party's knob mapping, gain ranges, sweep curve, or generic coefficient-design algorithms.
- The browser-local music collection must reuse the existing deck file-selection/loading path when loading a saved track. Do not duplicate deck reset, analysis, transport, or mixer semantics inside the library adapter.
- Local library import must be idempotent for the same file identity; re-importing the same track must not create duplicate collection rows.
- Headphone cue branches are pre-fader. The monitor's Master contribution must follow the existing Rust-owned post-fader deck gains rather than duplicate crossfader or deck-level math in the browser adapter.
- Audio-output routing must fail closed: when a separate permitted sink cannot be selected or disappears, stop that monitor route without changing the master playback route.
- Do not duplicate Rust mixer, monitor, transport, or tone-policy formulas in the browser adapter.
- Local library blobs, playlists, cached analysis, decoded PCM, cue definitions, hot-cue definitions, loop definitions, tone state, and monitor state stay local unless a later feature explicitly introduces user-approved transfer or sharing.
- Beat-dependent controls must fail closed outside the verified beat-grid horizon; never silently snap to stale analyzed data.
- `audio-analysis` remains authoritative for BPM, beat-grid, downbeat, Fourier, related reusable analysis semantics, and reusable policy-neutral audio/DJ calculations.
- Multiplayer session setup must use the reusable `LobbySession` client from `multiplayer-setup-service`; do not reimplement lobby HTTP, participant capability-token handling, signaling WebSockets, reconnect policy, ICE exchange, TURN credential handling, or WebRTC link establishment in DJ Party.
- The reusable multiplayer browser client must be pinned to an exact reviewed source commit. Do not switch DJ Party to an unpinned `main`/latest module URL.
- DJ Party's setup adapter uses `mesh` topology and keeps optional content sharing disabled until a later slice explicitly adds user-approved transfer with content verification.
- The setup service is rendezvous/control plane only. Mixer authority, DJ Party commands, audio state, tracks, chat, and content bytes must not move into the service.
- Public invite state may contain only the setup-service API base and public lobby code. Participant capability tokens must remain inside the reusable service client and must never be copied into DJ Party state, storage, logs, or URLs.
- Shared application messages may flow only through already verified DJ Party reliable peer links. Ignore application messages from unverified peers and ignore unknown protocol versions/types.
- DJ Party shared-session authority is host-sequenced application state, not signaling-service or server audio authority. The current lobby host assigns monotonic canonical sequence numbers; guests submit monotonic per-peer requests; the host rejects stale/duplicate guest requests before rebroadcasting canonical state.
- Mixer-state convergence and playback convergence are separate protocols. A failure or resnapshot in one must not silently rewrite the sequencing rules of the other.
- A guest is not considered mixer-converged merely because it received a later command. It must receive a valid host mixer snapshot. New/reconnected guests explicitly request a snapshot once both the verified host link and local mixer adapter are ready.
- Shared commands and snapshots must be strictly validated without numeric-string coercion. Invalid, stale, malformed, unknown, out-of-range, noncontiguous, or excessively old messages fail closed.
- The shared mixer surface is crossfader, Deck A/B levels, tempo percentages, key lock, and Low/Mid/High/filter controls. Apply remote canonical changes through the existing local DOM/Rust/WebAudio control paths; do not duplicate mixer or tone formulas in the networking layer.
- Shared playback may carry only bounded transport state plus an exact lowercase SHA-256 identity of the encoded local track bytes. The fingerprint proves identity; it is never permission to upload or fetch the track and must never be replaced by filename, title, duration, or other weak metadata identity.
- Track selection remains local. A remote play/pause/seek state may apply only when the receiving deck already has the same exact content identity. Missing or mismatched tracks fail closed and require a fresh host snapshot after the local track changes.
- Shared playback clock alignment uses bounded request/response samples to estimate the host clock and compensate command transit time. Clock estimation is synchronization metadata only; browser media elements remain the playback mechanism and the host remains a serializer rather than an audio-rendering authority.
- Playback snapshots are recovery/bootstrap state, not permission to transfer content. Late join/reconnect and canonical sequence gaps require a fresh snapshot before the guest reports aligned playback.
- Active beat loops remain local in this phase and must block shared playback application/submission rather than silently diverging. Loop definitions and loop lifecycle become shareable only in a later explicit protocol slice.
- Cue/hot-cue/beat-jump definitions remain local. Their resulting playhead seek may be represented by bounded shared transport state only when exact track identity and clock requirements hold.
- Physical headphone/master output routing and monitor cue/mix/level always remain local hardware policy and never enter mixer or playback snapshots.
- Content sharing remains disabled; optional asset transfer must be explicitly user-approved and content-verified in a later phase.

## Browser acceptance

The browser app is acceptable when all of these hold:

1. `cargo fmt --all --check`
2. `cargo clippy --all-targets --all-features -- -D warnings`
3. `cargo test --all-features`
4. `npm run typecheck` passes for the browser TypeScript source without disabling semantic checking or relying on generated JavaScript as source.
5. `npm run test:web` compiles the TypeScript browser modules and passes deterministic library/archive/cache/multiplayer/mixer/playback contracts against the emitted `.js` graph.
6. `bash scripts/build-pages.sh`
7. the built Pages artifact contains the generated Rust/WASM package and all emitted local browser modules/assets, including multiplayer setup, mixer authority, shared-playback authority, exact-track identity, track-library, archive/playlist import, analysis-cache, deck-effects, and headphone-monitor routing assets
8. multi-file/folder/ZIP imports stay browser-local, duplicate audio imports still collapse through the canonical track importer, and saved/playlist tracks load through the existing deck file path
9. ZIP relevant entries are bounded and CRC-verified, remote playlist references are not fetched, and unsupported archive features fail closed
10. cached waveform/rhythm results are content-addressed/versioned and a cache miss, stale record, or cache failure falls back to normal worker analysis
11. multiplayer setup consumes an exact-commit reusable service client, uses mesh topology, keeps content sharing disabled, and never exposes participant capability tokens in DJ Party state/URLs
12. only verified DJ Party peers can enter either shared application protocol; unverified reliable messages remain outside mixer and playback state
13. mixer authority covers host canonical sequencing, per-peer request replay protection, snapshot reconciliation, stale/non-host rejection, and feedback-free reuse of existing mixer/effects handlers
14. playback authority covers exact SHA-256 track identity, host sequencing, per-peer replay protection, bounded three-sample clock alignment, contiguous canonical commands, late-join/gap snapshots, and mismatched-track failure
15. track bytes, decoded PCM, library storage, capability tokens, physical output routing, monitor controls, and active loop definitions never enter shared playback messages
16. the mixer exposes only the bounded local playback bridge needed to capture/apply media-element transport; networking code must not reach into WebAudio graphs or duplicate transport math
17. BPM Sync remains tempo-only while Phase Sync explicitly owns the local transport seek needed for phase alignment
18. per-deck tone controls use Rust-owned parameter plans, exact center filter state is a bypass, and both master and pre-fader cue consume the same tone-shaped signal
19. browsers without usable audio-output selection keep monitoring disabled without weakening or redirecting normal master playback

Do not weaken these checks to make a change mergeable.
