import { formatFileSize, isSupportedAudioFile } from "./library.js";
import { sharedAssetTransferSession } from "./shared-assets.js";

const DECK_IDS = ["a", "b"];

export function installCollaborativeAssetTransfer(
  library,
  { coordinator = sharedAssetTransferSession } = {},
) {
  if (
    typeof document === "undefined" ||
    !library ||
    typeof library.importFiles !== "function"
  ) {
    return null;
  }

  return new CollaborativeAssetTransferAdapter({ library, coordinator }).install();
}

export class CollaborativeAssetTransferAdapter {
  declare abortController: any;
  declare coordinator: any;
  declare deckFiles: any;
  declare guestControls: any;
  declare hostControls: any;
  declare library: any;
  declare offer: any;
  declare receiveButton: any;
  declare shareButtons: any;
  declare status: any;
  declare stopButton: any;

  constructor(
    { library, coordinator = sharedAssetTransferSession }: { library?: any; coordinator?: any } = {},
  ) {
    this.library = library;
    this.coordinator = coordinator;
    this.deckFiles = new Map(DECK_IDS.map((deckId) => [deckId, null]));
    this.abortController = new AbortController();
    this.status = null;
    this.offer = null;
    this.hostControls = null;
    this.guestControls = null;
    this.shareButtons = new Map();
    this.stopButton = null;
    this.receiveButton = null;
  }

  install() {
    this.#installStylesheet();
    this.#installMarkup();
    this.#bindDeckFiles();
    this.#bindActions();
    this.coordinator.addEventListener("change", (event) => this.#render(event.detail), {
      signal: this.abortController.signal,
    });
    this.#render(this.coordinator.snapshot());
    return this;
  }

  destroy() {
    this.abortController.abort();
  }

  #installStylesheet() {
    if (document.querySelector('link[data-shared-assets-styles]')) {
      return;
    }
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = new URL("./shared-assets.css", import.meta.url).href;
    stylesheet.dataset.sharedAssetsStyles = "true";
    document.head.append(stylesheet);
  }

  #installMarkup() {
    const panel = document.querySelector("#multiplayer-session");
    if (!panel || document.querySelector("#shared-track-transfer")) {
      return;
    }

    const note = panel.querySelector(".multiplayer-note");
    const markup = `<section id="shared-track-transfer" class="shared-track-transfer" aria-labelledby="shared-track-title">
      <div class="shared-track-heading">
        <div>
          <span class="shared-track-kicker">Optional track transfer</span>
          <strong id="shared-track-title">Share one verified track</strong>
        </div>
        <output id="shared-track-status" class="shared-track-status" aria-live="polite">Track transfer inactive</output>
      </div>
      <div id="shared-track-host-controls" class="shared-track-controls" hidden>
        <span class="shared-track-label">Host consent</span>
        <button class="mini-button" type="button" data-share-deck="a" disabled>Share Deck A</button>
        <button class="mini-button" type="button" data-share-deck="b" disabled>Share Deck B</button>
        <button id="shared-track-stop" class="mini-button" type="button" disabled>Stop sharing</button>
      </div>
      <div id="shared-track-guest-controls" class="shared-track-controls" hidden>
        <div id="shared-track-offer" class="shared-track-offer">The host is not offering a track.</div>
        <button id="shared-track-receive" class="secondary-button" type="button" disabled>Save shared track</button>
      </div>
      <p class="shared-track-note">
        Sharing never starts automatically. The sender chooses one loaded deck, the receiver chooses whether to save it,
        and the reusable peer content channel verifies every chunk plus the full SHA-256. Loading the saved track into a
        deck remains a local action.
      </p>
    </section>`;

    if (note) {
      note.insertAdjacentHTML("beforebegin", markup);
    } else {
      panel.insertAdjacentHTML("beforeend", markup);
    }

    this.status = document.querySelector("#shared-track-status");
    this.offer = document.querySelector("#shared-track-offer");
    this.hostControls = document.querySelector("#shared-track-host-controls");
    this.guestControls = document.querySelector("#shared-track-guest-controls");
    this.stopButton = document.querySelector("#shared-track-stop");
    this.receiveButton = document.querySelector("#shared-track-receive");
    for (const deckId of DECK_IDS) {
      this.shareButtons.set(
        deckId,
        document.querySelector(`[data-share-deck="${deckId}"]`),
      );
    }
  }

  #bindDeckFiles() {
    const signal = this.abortController.signal;
    for (const deckId of DECK_IDS) {
      const input = document.querySelector<HTMLInputElement>(`#deck-${deckId}-file`);
      const dropZone = document.querySelector<HTMLElement>(`#deck-${deckId}-drop-zone`);

      input?.addEventListener(
        "change",
        () => {
          const [file] = input.files ?? [];
          this.setDeckFile(deckId, file);
        },
        { signal, capture: true },
      );

      dropZone?.addEventListener(
        "drop",
        (event) => {
          const [file] = event.dataTransfer?.files ?? [];
          this.setDeckFile(deckId, file);
        },
        { signal, capture: true },
      );

      const [initial] = input?.files ?? [];
      this.setDeckFile(deckId, initial, { initial: true, render: false });
    }
  }

  #bindActions() {
    const signal = this.abortController.signal;
    for (const deckId of DECK_IDS) {
      this.shareButtons.get(deckId)?.addEventListener(
        "click",
        () => void this.#shareDeck(deckId),
        { signal },
      );
    }
    this.stopButton?.addEventListener("click", () => {
      try {
        this.coordinator.stopOffering();
      } catch (error) {
        this.#setStatus(errorMessage(error));
      }
    }, { signal });
    this.receiveButton?.addEventListener("click", () => void this.#receiveTrack(), { signal });
  }

  setDeckFile(deckId, file, { initial = false, render = true } = {}) {
    const previous = this.deckFiles.get(deckId) ?? null;
    const next = isSupportedAudioFile(file) ? file : null;
    this.deckFiles.set(deckId, next);

    if (!initial && previous !== next) {
      const snapshot = this.coordinator.snapshot();
      if (snapshot?.active && snapshot.role === "host" && snapshot.offer?.deckId === deckId) {
        try {
          this.coordinator.stopOffering();
        } catch {
          // A concurrent session transition already revoked the old offer.
        }
      }
    }

    if (render) {
      this.#render(this.coordinator.snapshot());
    }
  }

  async #shareDeck(deckId) {
    const file = this.deckFiles.get(deckId);
    if (!file) {
      this.#setStatus(`Load a track into Deck ${deckId.toUpperCase()} first`);
      return;
    }

    this.#setStatus(`Preparing ${file.name} for verified sharing…`);
    try {
      await this.coordinator.offerTrack(file, deckId);
    } catch (error) {
      this.#setStatus(errorMessage(error));
    }
  }

  async #receiveTrack() {
    this.#setStatus("Receiving and verifying the shared track…");
    try {
      const file = await this.coordinator.requestOfferedTrack();
      const result = await this.library.importFiles([file]);
      if (!result) {
        throw new Error("The track was verified, but the browser-local collection is unavailable");
      }
      this.#setStatus(
        result.added?.length > 0
          ? `Verified ${file.name} and saved it to your local collection`
          : `${file.name} is already in your local collection`,
      );
    } catch (error) {
      this.#setStatus(errorMessage(error));
    }
  }

  #render(snapshot) {
    if (!this.status || !this.hostControls || !this.guestControls) {
      return;
    }

    const isHost = snapshot?.active && snapshot.role === "host";
    const isGuest = snapshot?.active && snapshot.role === "guest";
    this.hostControls.hidden = !isHost;
    this.guestControls.hidden = !isGuest;

    if (!snapshot?.active) {
      this.#setStatus("Track transfer inactive");
      return;
    }

    if (isHost) {
      for (const deckId of DECK_IDS) {
        const file = this.deckFiles.get(deckId);
        const button = this.shareButtons.get(deckId);
        if (button) {
          button.disabled = snapshot.busy || !snapshot.transferAvailable || !file;
          button.title = file
            ? `Explicitly offer ${file.name} to verified DJ Party peers`
            : `Load a track into Deck ${deckId.toUpperCase()} first`;
        }
      }
      if (this.stopButton) {
        this.stopButton.disabled = snapshot.busy || !snapshot.offer;
      }

      if (!snapshot.transferAvailable) {
        this.#setStatus("Verified track transfer is unavailable in this multiplayer client");
      } else if (snapshot.busy) {
        this.#setStatus("Preparing verified track metadata…");
      } else if (snapshot.offer) {
        this.#setStatus(
          `Offering Deck ${snapshot.offer.deckId.toUpperCase()} · ${snapshot.offer.name} · ${formatFileSize(snapshot.offer.bytes)}`,
        );
      } else {
        this.#setStatus("Nothing is shared until you choose a loaded deck");
      }
      return;
    }

    if (!isGuest) {
      this.#setStatus("Track transfer waiting for session role");
      return;
    }

    const offer = snapshot.offer;
    if (this.offer) {
      this.offer.textContent = offer
        ? `Deck ${offer.deckId.toUpperCase()} · ${offer.name} · ${formatFileSize(offer.bytes)} · SHA-256 ${offer.sha256.slice(0, 12)}…`
        : "The host is not offering a track.";
    }
    if (this.receiveButton) {
      this.receiveButton.disabled =
        !offer ||
        snapshot.busy ||
        !snapshot.transferAvailable ||
        !snapshot.contentReady;
    }

    if (!snapshot.transferAvailable) {
      this.#setStatus("Verified track transfer is unavailable in this multiplayer client");
    } else if (!offer) {
      this.#setStatus("The host is not offering a track");
    } else if (snapshot.busy && snapshot.progress?.totalChunks > 0) {
      const percent = Math.floor(
        (snapshot.progress.receivedChunks / snapshot.progress.totalChunks) * 100,
      );
      this.#setStatus(`Receiving and verifying… ${percent}%`);
    } else if (snapshot.busy) {
      this.#setStatus("Starting verified transfer…");
    } else if (!snapshot.contentReady) {
      this.#setStatus("Shared track offered · waiting for the peer content channel");
    } else {
      this.#setStatus("Shared track offered · save only if you want a local copy");
    }
  }

  #setStatus(message) {
    if (this.status) {
      this.status.textContent = message;
    }
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error ?? "Verified track transfer failed");
}
