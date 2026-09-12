# DJ Party

DJ Party is a browser-first DJ mixing experiment with a Rust core. The long-term goal is collaborative mixing, while the current milestone remains deliberately small enough to run entirely on GitHub Pages.

## Browser MVP

The app can:

- import many local audio files at once, including folder selection where the browser exposes it;
- import bounded local ZIP archives containing audio and M3U/M3U8 playlists, with checksum verification and no upload/server dependency;
- import standalone M3U/M3U8 playlists and match their local entries to tracks already stored in the browser;
- keep an idempotent browser-local music collection in IndexedDB so previously imported tracks can be picked again on later visits;
- keep imported playlist ordering browser-local and load playlist tracks through the same existing deck-loading path;
- reuse versioned, content-addressed waveform/BPM/beat/downbeat analysis from a bounded browser-local cache when decoded PCM and sample rate match;
- search the collection and load any saved track into Deck A or Deck B without re-selecting the original file;
- load local audio files directly into two independent decks;
- drag and drop MP3 and other browser-supported audio files;
- play, pause, restart, seek, and control deck level;
- mix decks with a Rust-owned equal-power crossfader;
- shape each deck with Rust-owned Low/Mid/High ±12 dB product semantics and a bipolar low-pass ↔ bypass ↔ high-pass sweep;
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
- blend the cued decks with the post-fader master in the headphone monitor using a Rust-owned equal-power Cue ↔ Master control;
- host or join a 2–16 participant peer-to-peer lobby through `multiplayer-setup-service` without moving mixer authority into the setup service;
- share a public lobby/service invite URL while keeping participant capability tokens inside the reusable service client;
- verify connected peers with a versioned DJ Party hello;
- synchronize crossfader, deck levels, tempo, key lock, and per-deck EQ/filter state between verified DJ Party peers through a host-sequenced application protocol.

Imported library blobs, playlists, cached analysis metadata, selected tracks, decoded PCM, timing state, cue points, loops, and physical monitor/output routing remain on the device. Multiplayer uses the configured setup service only for lobby/signaling/TURN setup; verified peers exchange bounded DJ Party mixer commands directly over the service-created reliable WebRTC channel. Tracks, decoded audio, chat, and content bytes are not transferred in the current shared-mixer phase.

## Architecture

DJ Party's Rust/WASM layer is authoritative for deterministic mixer state and product policy: tempo range, effective-BPM/BPM-sync surface, beat/bar and phase-sync behavior, hot-cue and beat-jump semantics, beat-loop policy, per-deck EQ/filter parameter semantics, and headphone-monitor semantics. Reusable policy-neutral audio/DJ calculations such as equal-power crossfade gains, tempo/rate conversion, tempo-only BPM-sync math, generic beat-loop selection, waveform extrema, and generic filter/DSP primitives remain outside DJ Party and are consumed rather than reimplemented here.

The browser layer owns browser-only capabilities: local file/folder/ZIP/M3U selection, browser-local IndexedDB track/playlist/cache storage, object URLs, bounded ZIP extraction, audio decoding, `AudioContext`, media-element playback, Web Audio EQ/filter nodes, pitch-preservation/key-lock behavior, DOM rendering, workers, physical audio-output selection, and applying the transport/gain/tone plans returned by Rust. DJ Party does not implement biquad coefficient design in the browser adapter.

The local library deliberately reuses the existing deck file-input path when a saved or playlist track is loaded. ZIP audio is handed to the same idempotent track importer rather than creating an archive-specific track store. M3U/M3U8 files contain references only: remote URLs are ignored, and unmatched local entries remain visibly unavailable instead of being fetched or guessed.

ZIP extraction is deliberately fail-closed: multi-disk/ZIP64/encrypted entries and unsupported compression methods are rejected, extracted audio/playlist bytes are bounded, and each materialized entry is checked against its ZIP CRC. Deflated entries require browser `DecompressionStream("deflate-raw")` support.

Track-analysis cache entries are keyed by a SHA-256 fingerprint of decoded mono PCM plus sample rate and an explicit analysis namespace. A stale namespace or malformed cached record is ignored. The cache is an optimization only: cache failures never replace or weaken the normal Rust-backed waveform/rhythm analysis path.

Headphone cueing is deliberately pre-fader: each deck's tone chain is applied before the signal splits into the post-fader master branch and pre-fader cue branch. The selected cue therefore hears the same EQ/filter state as the deck while still bypassing deck level and crossfader. The optional Master contribution follows the same Rust-owned post-fader deck gains heard on the main output. Physical headphone/master output selection and monitor cue state remain local hardware policy and are never shared.

### Multiplayer setup boundary

DJ Party consumes the reusable `LobbySession` browser client from `multiplayer-setup-service`, pinned to source commit `556f1aa2ac889acffd5b2b27163fca10f1901793`. DJ Party does not copy the service's lobby, capability-token, signaling, reconnect, ICE, TURN, or WebRTC peer-link state machines.

The adapter uses `mesh` topology with optional content sharing disabled. The setup service remains a rendezvous/control-plane service: lobby creation/join, participant admission, authenticated signaling, and peer connection setup. It does not receive or own DJ Party mixer/audio state.

The configured signaling API and public lobby code may be stored in URL query parameters (`api` and `lobby`) so an invite can be copied. Participant capability tokens are never copied into DJ Party state or URLs. On localhost the UI defaults to `http://127.0.0.1:8787`; hosted pages require an explicitly configured HTTPS service. The service must allow the DJ Party page origin through its `ALLOWED_ORIGINS` configuration.

### Shared mixer authority

Shared mixer state is a DJ Party application protocol layered over already verified reliable peer links. The lobby host is the canonical serializer, not an authoritative audio server: the host assigns monotonically increasing sequence numbers to valid mixer changes, and every browser still applies the same existing Rust/WebAudio mixer behavior locally.

Guests send bounded change requests with monotonically increasing per-guest request numbers. The host rejects duplicate/stale requests, applies a valid request through the same local control path, and broadcasts the resulting canonical command. Guests accept canonical commands and snapshots only from the current lobby host and ignore stale sequence numbers.

A host snapshot is required before a guest reports the shared mixer as converged. New/reconnected guests explicitly request the snapshot, so session setup finishing before the mixer UI initializes cannot silently lose the canonical state.

The current synchronized surface is deliberately limited to:

- crossfader position;
- Deck A/B level;
- Deck A/B tempo percentage;
- Deck A/B key-lock state;
- Deck A/B Low/Mid/High EQ and filter controls.

Play/pause/seek, cue points, loops, hot cues, track selection, and content bytes remain local in this phase. Those transport operations require verified track identity and clock/alignment semantics and will be added together rather than pretending two browsers necessarily have the same audio loaded.

Reusable ownership remains explicit:

- BPM, beat-grid, downbeat, related rhythm analysis, reusable policy-neutral playback/DJ calculations, and generic DSP/filter math come from shared audio/math layers rather than being reimplemented here;
- collaborative lobby/signaling and WebRTC connection setup come from `multiplayer-setup-service`;
- host sequencing, convergence, replay protection, and mixer commands are DJ Party application semantics.

## Build and validate

Requirements: Rust 1.95.0, the `wasm32-unknown-unknown` target, and `wasm-pack` 0.13.1.

```sh
cargo fmt --all --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features
node --test web/library.test.mjs web/archive-import.test.mjs web/analysis-cache.test.mjs web/multiplayer.test.mjs web/shared-session.test.mjs web/shared-session-transport.test.mjs web/collaborative-mixer.test.mjs
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
6. Headphone cue/master routing where browser APIs allow it — done
7. Browser-local multi-file/folder music collection — done
8. Mixer EQ/filter controls with deterministic parameter semantics — done
9. ZIP/playlist library import plus reusable cached track-analysis metadata — done
10. Multiplayer sessions through `multiplayer-setup-service` — done
11. Shared-session authority, synchronization, optional asset transfer, and collaborative mixing — current slice
   - host-sequenced shared mixer controls and late-join reconciliation — implemented in the current phase
   - track identity + synchronized transport/clock alignment — next
   - optional verified asset transfer and broader collaborative mixing — later
