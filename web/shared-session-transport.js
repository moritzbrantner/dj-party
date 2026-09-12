import { sharedSession } from "./shared-session.js";

export function installSharedSessionTransport(multiplayerUi) {
  if (!multiplayerUi || typeof multiplayerUi.addEventListener !== "function") {
    return null;
  }

  let bridge = null;
  const abortController = new AbortController();
  const signal = abortController.signal;

  const detach = () => {
    bridge?.close();
    bridge = null;
    sharedSession.detachTransport();
  };

  multiplayerUi.addEventListener(
    "controller-ready",
    (event) => {
      detach();
      const controller = event.detail?.controller;
      if (!controller?.session) {
        return;
      }
      bridge = new MultiplayerSharedTransport(controller);
      sharedSession.attachTransport(bridge);
      bridge.emitInitialCompatiblePeers();
    },
    { signal },
  );

  multiplayerUi.addEventListener("controller-closed", detach, { signal });

  if (typeof window !== "undefined") {
    window.addEventListener(
      "beforeunload",
      () => {
        abortController.abort();
        detach();
      },
      { once: true },
    );
  }

  const note = typeof document === "undefined" ? null : document.querySelector(".multiplayer-note");
  if (note) {
    note.textContent =
      "The setup service remains signaling/transport only. Verified DJ Party peers synchronize bounded mixer commands through a host-sequenced application protocol; tracks and content bytes remain local.";
  }

  return {
    detach,
    close() {
      abortController.abort();
      detach();
    },
  };
}

export class MultiplayerSharedTransport extends EventTarget {
  constructor(controller) {
    super();
    if (!controller?.session || typeof controller.snapshot !== "function") {
      throw new Error("An established DJ Party multiplayer controller is required");
    }
    this.controller = controller;
    this.session = controller.session;
    this.abortController = new AbortController();
    this.knownCompatible = new Set();
    const signal = this.abortController.signal;

    controller.addEventListener("change", () => this.#controllerChanged(), { signal });
    this.session.addEventListener(
      "reliable",
      (event) => {
        const peerId = event.detail?.peerId;
        if (typeof peerId !== "string" || !this.controller.compatiblePeers?.has(peerId)) {
          return;
        }
        this.#noticeCompatible(peerId);
        this.dispatchEvent(
          new CustomEvent("application-message", {
            detail: { peerId, data: event.detail?.data },
          }),
        );
      },
      { signal },
    );
    this.#controllerChanged();
  }

  snapshot() {
    return this.controller.snapshot();
  }

  sendApplicationReliable(peerId, data) {
    if (!this.controller.compatiblePeers?.has(peerId)) {
      throw new Error(`Peer ${peerId} is not a verified DJ Party peer`);
    }
    if (this.controller.session !== this.session) {
      throw new Error("Multiplayer transport session changed");
    }
    this.session.sendReliable(peerId, data);
  }

  broadcastApplicationReliable(data) {
    const peers = [...(this.controller.compatiblePeers ?? [])].sort();
    for (const peerId of peers) {
      this.sendApplicationReliable(peerId, data);
    }
  }

  emitInitialCompatiblePeers() {
    for (const peerId of [...(this.controller.compatiblePeers ?? [])].sort()) {
      this.#noticeCompatible(peerId);
    }
  }

  close() {
    this.abortController.abort();
    this.knownCompatible.clear();
  }

  #controllerChanged() {
    const current = new Set(this.controller.compatiblePeers ?? []);
    for (const peerId of [...current].sort()) {
      this.#noticeCompatible(peerId);
    }
    for (const peerId of [...this.knownCompatible]) {
      if (!current.has(peerId)) {
        this.knownCompatible.delete(peerId);
      }
    }
    this.dispatchEvent(new CustomEvent("change", { detail: this.snapshot() }));
  }

  #noticeCompatible(peerId) {
    if (this.knownCompatible.has(peerId)) {
      return;
    }
    this.knownCompatible.add(peerId);
    this.dispatchEvent(new CustomEvent("peer-compatible", { detail: { peerId } }));
  }
}
