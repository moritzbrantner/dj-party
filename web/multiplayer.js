export const MULTIPLAYER_CLIENT_SOURCE_COMMIT = "556f1aa2ac889acffd5b2b27163fca10f1901793";
const MULTIPLAYER_CLIENT_BASE_URL = `https://cdn.jsdelivr.net/gh/moritzbrantner/multiplayer-setup-service@${MULTIPLAYER_CLIENT_SOURCE_COMMIT}/web`;
export const MULTIPLAYER_CLIENT_MODULE_URL = `${MULTIPLAYER_CLIENT_BASE_URL}/lobby-session.js`;
export const MULTIPLAYER_TURN_MODULE_URL = `${MULTIPLAYER_CLIENT_BASE_URL}/turn-credentials.js`;
export const DJ_PARTY_SESSION_PROTOCOL = 1;

const LOCAL_SIGNALING_API = "http://127.0.0.1:8787";
const HELLO_TYPE = "dj-party/session-hello";

export async function loadMultiplayerClientModules(importModule = (url) => import(url)) {
  const sessionModule = await importModule(MULTIPLAYER_CLIENT_MODULE_URL);
  let refreshTurnIceServers = null;
  try {
    const turnModule = await importModule(MULTIPLAYER_TURN_MODULE_URL);
    if (typeof turnModule?.refreshTurnIceServers === "function") {
      refreshTurnIceServers = turnModule.refreshTurnIceServers;
    }
  } catch {
    // TURN is optional. The reusable session client remains direct-first.
  }
  return {
    LobbySession: sessionModule?.LobbySession,
    refreshTurnIceServers,
  };
}

export function normalizeMultiplayerApiBase(value, { pageProtocol = "https:" } = {}) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    throw new Error("Enter the multiplayer setup service URL");
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Enter a valid multiplayer setup service URL");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("The multiplayer setup service must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("The multiplayer setup service URL must not contain credentials");
  }

  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol === "http:" && !loopback) {
    throw new Error("Non-local multiplayer setup services must use HTTPS");
  }
  if (pageProtocol === "https:" && url.protocol === "http:") {
    throw new Error("An HTTPS DJ Party page cannot use an HTTP multiplayer service");
  }

  return url.origin;
}

export function multiplayerApiFromLocation(locationLike = globalThis.location) {
  if (!locationLike) {
    return "";
  }

  const url = new URL(locationLike.href ?? String(locationLike));
  const configured = url.searchParams.get("api");
  if (configured) {
    try {
      return normalizeMultiplayerApiBase(configured, { pageProtocol: url.protocol });
    } catch {
      return "";
    }
  }

  if (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")
  ) {
    return LOCAL_SIGNALING_API;
  }
  return "";
}

export function normalizeLobbyCode(value) {
  const code = String(value ?? "").trim().toUpperCase();
  if (!code) {
    throw new Error("Enter a lobby code");
  }
  if (!/^[0-9A-Z-]{4,40}$/.test(code)) {
    throw new Error("Lobby codes may contain only letters, numbers, and hyphens");
  }
  return code;
}

export function multiplayerInviteUrl(locationLike, { apiBase, lobbyCode }) {
  const url = new URL(locationLike.href ?? String(locationLike));
  url.search = "";
  url.hash = "";
  url.searchParams.set("api", normalizeMultiplayerApiBase(apiBase, { pageProtocol: url.protocol }));
  url.searchParams.set("lobby", normalizeLobbyCode(lobbyCode));
  return url;
}

export function isDjPartySessionHello(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    value.type === HELLO_TYPE &&
    value.protocol === DJ_PARTY_SESSION_PROTOCOL &&
    value.application === "dj-party"
  );
}

export class DjPartyMultiplayerSession extends EventTarget {
  constructor({
    apiBase,
    loadClient = loadMultiplayerClientModules,
  } = {}) {
    super();
    this.apiBase = normalizeMultiplayerApiBase(apiBase, {
      pageProtocol: globalThis.location?.protocol ?? "https:",
    });
    this.loadClient = loadClient;
    this.session = null;
    this.compatiblePeers = new Set();
    this.abortController = null;
    this.state = "idle";
    this.turnAvailable = null;
    this.setupGeneration = 0;
  }

  async host(maxParticipants = 4) {
    if (!Number.isInteger(maxParticipants) || maxParticipants < 2 || maxParticipants > 16) {
      throw new Error("Lobby size must be between 2 and 16");
    }
    return this.#start((session) => session.host(maxParticipants));
  }

  async join(lobbyCode) {
    const code = normalizeLobbyCode(lobbyCode);
    return this.#start((session) => session.join(code));
  }

  snapshot() {
    const session = this.session;
    return {
      state: this.state,
      lobbyId: session?.lobbyId ?? null,
      displayCode: session?.displayCode ?? null,
      participantId: session?.participantId ?? null,
      hostParticipantId: session?.hostParticipantId ?? null,
      maxParticipants: session?.maxParticipants ?? null,
      participantCount: session?.participants instanceof Set ? session.participants.size : 0,
      readyPeerIds: typeof session?.readyPeerIds === "function" ? session.readyPeerIds() : [],
      compatiblePeerIds: [...this.compatiblePeers].sort(),
      turnAvailable: this.turnAvailable,
    };
  }

  close() {
    const session = this.session;
    this.setupGeneration += 1;
    this.abortController?.abort();
    this.abortController = null;
    this.session = null;
    this.compatiblePeers.clear();
    this.turnAvailable = null;
    this.state = "closed";
    session?.close();
    this.#emit("change", this.snapshot());
  }

  async #start(setup) {
    if (this.state === "closed") {
      throw new Error("Multiplayer session is closed");
    }
    if (this.session) {
      throw new Error("A multiplayer session is already active");
    }

    const generation = ++this.setupGeneration;
    this.state = "connecting";
    this.turnAvailable = null;
    this.#emit("change", this.snapshot());

    let session = null;
    try {
      const module = await this.loadClient();
      this.#assertSetupActive(generation);
      if (typeof module?.LobbySession !== "function") {
        throw new Error("The multiplayer setup browser client is incompatible");
      }

      session = new module.LobbySession({
        apiBase: this.apiBase,
        topology: "mesh",
        contentSharing: false,
      });
      this.session = session;
      this.#wireSession(session);
      const lobby = await setup(session);
      this.#assertSetupActive(generation);
      if (this.session !== session) {
        throw new Error("Multiplayer session setup was cancelled");
      }
      this.state = "connected";
      this.#emit("change", this.snapshot());
      void this.#configureTurn(module.refreshTurnIceServers, session);
      return lobby;
    } catch (error) {
      const cancelled = this.setupGeneration !== generation || this.state === "closed";
      if (this.session === session) {
        this.abortController?.abort();
        this.abortController = null;
        this.session = null;
      }
      session?.close();
      this.compatiblePeers.clear();
      this.turnAvailable = null;
      if (!cancelled) {
        this.state = "idle";
        this.#emit("change", this.snapshot());
      }
      throw error;
    }
  }

  #assertSetupActive(generation) {
    if (this.setupGeneration !== generation || this.state === "closed") {
      throw new Error("Multiplayer session setup was cancelled");
    }
  }

  async #configureTurn(refreshTurnIceServers, session) {
    if (typeof refreshTurnIceServers !== "function") {
      if (this.session === session) {
        this.turnAvailable = false;
        this.#emit("change", this.snapshot());
      }
      return;
    }

    try {
      await refreshTurnIceServers(session);
      if (this.session !== session) {
        return;
      }
      this.turnAvailable = true;
      this.#emit("change", this.snapshot());
    } catch (error) {
      if (this.session !== session) {
        return;
      }
      this.turnAvailable = false;
      this.#emit("turn-unavailable", { error });
      this.#emit("change", this.snapshot());
    }
  }

  #wireSession(session) {
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const refresh = () => this.#emit("change", this.snapshot());

    for (const type of ["lobby", "participant-connected", "statechange"]) {
      session.addEventListener(type, refresh, { signal });
    }

    session.addEventListener(
      "peer-statechange",
      (event) => {
        const peerId = event.detail?.peerId;
        const state = event.detail?.state;
        if (typeof peerId === "string" && state !== "connected") {
          this.compatiblePeers.delete(peerId);
        }
        refresh();
      },
      { signal },
    );

    session.addEventListener(
      "participant-disconnected",
      (event) => {
        const participantId = event.detail?.participantId;
        if (typeof participantId === "string") {
          this.compatiblePeers.delete(participantId);
        }
        refresh();
      },
      { signal },
    );

    session.addEventListener(
      "peer-ready",
      (event) => {
        const peerId = event.detail?.peerId;
        if (typeof peerId === "string") {
          try {
            session.sendReliable(peerId, {
              type: HELLO_TYPE,
              protocol: DJ_PARTY_SESSION_PROTOCOL,
              application: "dj-party",
            });
          } catch (error) {
            this.#emit("error", { error });
          }
        }
        refresh();
      },
      { signal },
    );

    session.addEventListener(
      "reliable",
      (event) => {
        const peerId = event.detail?.peerId;
        if (typeof peerId !== "string" || !isDjPartySessionHello(event.detail?.data)) {
          return;
        }
        this.compatiblePeers.add(peerId);
        refresh();
      },
      { signal },
    );

    session.addEventListener(
      "error",
      (event) => {
        this.#emit("error", { error: event.detail?.error ?? new Error("Multiplayer session error") });
      },
      { signal },
    );
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

export function installMultiplayerSessions() {
  if (typeof document === "undefined") {
    return null;
  }
  return new MultiplayerSessionUi().install();
}

class MultiplayerSessionUi {
  constructor() {
    this.controller = null;
    this.sessionStatus = document.querySelector(".session-status");
    this.panel = null;
    this.apiInput = null;
    this.lobbyInput = null;
    this.maxParticipants = null;
    this.hostButton = null;
    this.joinButton = null;
    this.leaveButton = null;
    this.copyButton = null;
    this.inviteCode = null;
    this.status = null;
    this.peerStatus = null;
  }

  install() {
    this.installStylesheet();
    this.installMarkup();
    this.bindEvents();
    this.renderIdle();
    return this;
  }

  installStylesheet() {
    if (document.querySelector('link[data-multiplayer-styles]')) {
      return;
    }
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = new URL("./multiplayer.css", import.meta.url).href;
    stylesheet.dataset.multiplayerStyles = "true";
    document.head.append(stylesheet);
  }

  installMarkup() {
    const topbar = document.querySelector(".topbar");
    if (!topbar || document.querySelector("#multiplayer-session")) {
      return;
    }

    topbar.insertAdjacentHTML(
      "afterend",
      `<section id="multiplayer-session" class="multiplayer-session" aria-labelledby="multiplayer-title">
        <div class="multiplayer-heading">
          <div>
            <span class="multiplayer-kicker">Optional network session</span>
            <strong id="multiplayer-title">Connect DJs peer to peer</strong>
          </div>
          <output id="multiplayer-status" class="multiplayer-status" aria-live="polite">Local mixer only</output>
        </div>
        <div class="multiplayer-controls">
          <label class="multiplayer-field multiplayer-api-field" for="multiplayer-api">
            <span>Setup service</span>
            <input id="multiplayer-api" type="url" inputmode="url" placeholder="https://multiplayer.example.com" autocomplete="url" />
          </label>
          <label class="multiplayer-field multiplayer-size-field" for="multiplayer-size">
            <span>Players</span>
            <input id="multiplayer-size" type="number" min="2" max="16" step="1" value="4" />
          </label>
          <button id="multiplayer-host" class="secondary-button" type="button">Host session</button>
          <label class="multiplayer-field multiplayer-code-field" for="multiplayer-code">
            <span>Lobby code</span>
            <input id="multiplayer-code" type="text" maxlength="40" autocomplete="off" spellcheck="false" placeholder="0123-ABCD-EFGH" />
          </label>
          <button id="multiplayer-join" class="secondary-button" type="button">Join session</button>
          <button id="multiplayer-leave" class="mini-button" type="button" disabled>Leave</button>
        </div>
        <div class="multiplayer-live">
          <div class="multiplayer-invite">
            <span>Invite</span>
            <output id="multiplayer-invite-code">—</output>
            <button id="multiplayer-copy" class="mini-button" type="button" disabled>Copy link</button>
          </div>
          <output id="multiplayer-peer-status" class="multiplayer-peer-status" aria-live="polite">No peer links</output>
        </div>
        <p class="multiplayer-note">The setup service handles lobby admission and WebRTC signaling only. DJ Party audio, tracks, mixer state, and content bytes are not sent in this slice.</p>
      </section>`,
    );

    this.panel = document.querySelector("#multiplayer-session");
    this.apiInput = document.querySelector("#multiplayer-api");
    this.lobbyInput = document.querySelector("#multiplayer-code");
    this.maxParticipants = document.querySelector("#multiplayer-size");
    this.hostButton = document.querySelector("#multiplayer-host");
    this.joinButton = document.querySelector("#multiplayer-join");
    this.leaveButton = document.querySelector("#multiplayer-leave");
    this.copyButton = document.querySelector("#multiplayer-copy");
    this.inviteCode = document.querySelector("#multiplayer-invite-code");
    this.status = document.querySelector("#multiplayer-status");
    this.peerStatus = document.querySelector("#multiplayer-peer-status");

    const currentUrl = new URL(window.location.href);
    this.apiInput.value = multiplayerApiFromLocation(window.location);
    this.lobbyInput.value = currentUrl.searchParams.get("lobby") ?? "";
  }

  bindEvents() {
    this.apiInput?.addEventListener("change", () => this.persistConfiguration());
    this.lobbyInput?.addEventListener("change", () => this.persistConfiguration());
    this.hostButton?.addEventListener("click", () => void this.startHost());
    this.joinButton?.addEventListener("click", () => void this.startJoin());
    this.leaveButton?.addEventListener("click", () => this.leave());
    this.copyButton?.addEventListener("click", () => void this.copyInvite());
    window.addEventListener("beforeunload", () => this.controller?.close(), { once: true });
  }

  async startHost() {
    await this.start(async (controller) => {
      const size = Number(this.maxParticipants.value);
      return controller.host(size);
    });
  }

  async startJoin() {
    await this.start((controller) => controller.join(this.lobbyInput.value));
  }

  async start(setup) {
    if (this.controller) {
      return;
    }

    let controller = null;
    try {
      const apiBase = normalizeMultiplayerApiBase(this.apiInput.value, { pageProtocol: window.location.protocol });
      this.apiInput.value = apiBase;
      this.persistConfiguration();
      this.setBusy(true);
      this.status.textContent = "Connecting…";
      this.updateTopbar("Connecting…");

      controller = new DjPartyMultiplayerSession({ apiBase });
      this.controller = controller;
      controller.addEventListener("change", (event) => this.renderSession(event.detail));
      controller.addEventListener("error", (event) => this.renderError(event.detail?.error));
      controller.addEventListener("turn-unavailable", () => {
        if (this.status.textContent === "Network session active") {
          this.status.textContent = "Network session active · direct ICE only";
        }
      });
      const lobby = await setup(controller);
      if (this.controller !== controller) {
        return;
      }
      this.lobbyInput.value = lobby.displayCode ?? lobby.lobbyId ?? this.lobbyInput.value;
      this.persistConfiguration();
      this.renderSession(controller.snapshot());
    } catch (error) {
      if (controller && this.controller !== controller) {
        return;
      }
      this.controller?.close();
      this.controller = null;
      this.setBusy(false);
      this.renderError(error);
      this.updateTopbar("Local session");
    }
  }

  leave() {
    this.controller?.close();
    this.controller = null;
    this.setBusy(false);
    this.inviteCode.textContent = "—";
    this.copyButton.disabled = true;
    this.peerStatus.textContent = "No peer links";
    this.status.textContent = "Local mixer only";
    this.updateTopbar("Local session");
    const url = new URL(window.location.href);
    url.searchParams.delete("lobby");
    history.replaceState(null, "", url);
  }

  renderSession(snapshot) {
    if (!snapshot) {
      return;
    }

    if (snapshot.state === "connecting") {
      this.status.textContent = "Connecting…";
      return;
    }
    if (snapshot.state === "closed") {
      return;
    }

    const code = snapshot.displayCode ?? snapshot.lobbyId;
    if (code) {
      this.inviteCode.textContent = code;
      this.copyButton.disabled = false;
    }

    const ready = snapshot.readyPeerIds.length;
    const compatible = snapshot.compatiblePeerIds.length;
    const relay = snapshot.turnAvailable === true ? " · TURN fallback ready" : snapshot.turnAvailable === false ? " · direct ICE only" : "";
    this.peerStatus.textContent = `${ready} peer ${ready === 1 ? "link" : "links"} ready · ${compatible} DJ Party ${compatible === 1 ? "peer" : "peers"} verified${relay}`;
    this.status.textContent = snapshot.state === "connected" ? "Network session active" : `Network: ${snapshot.state}`;
    this.updateTopbar(snapshot.state === "connected" ? "Network session" : `Network: ${snapshot.state}`);
    this.leaveButton.disabled = false;
  }

  renderError(error) {
    const message = error instanceof Error ? error.message : String(error ?? "Multiplayer session failed");
    this.status.textContent = message;
  }

  setBusy(busy) {
    this.apiInput.disabled = busy;
    this.lobbyInput.disabled = busy;
    this.maxParticipants.disabled = busy;
    this.hostButton.disabled = busy;
    this.joinButton.disabled = busy;
    this.leaveButton.disabled = !busy;
  }

  renderIdle() {
    this.setBusy(false);
    this.status.textContent = "Local mixer only";
  }

  persistConfiguration() {
    const url = new URL(window.location.href);
    const api = this.apiInput.value.trim();
    const lobby = this.lobbyInput.value.trim();
    if (api) {
      try {
        url.searchParams.set("api", normalizeMultiplayerApiBase(api, { pageProtocol: url.protocol }));
      } catch {
        url.searchParams.delete("api");
      }
    } else {
      url.searchParams.delete("api");
    }
    if (lobby) {
      try {
        url.searchParams.set("lobby", normalizeLobbyCode(lobby));
      } catch {
        url.searchParams.delete("lobby");
      }
    } else {
      url.searchParams.delete("lobby");
    }
    history.replaceState(null, "", url);
  }

  async copyInvite() {
    if (!this.controller) {
      return;
    }
    const snapshot = this.controller.snapshot();
    const code = snapshot.displayCode ?? snapshot.lobbyId;
    if (!code) {
      return;
    }

    try {
      const invite = multiplayerInviteUrl(window.location, {
        apiBase: this.controller.apiBase,
        lobbyCode: code,
      });
      await navigator.clipboard.writeText(invite.href);
      this.status.textContent = "Invite link copied";
    } catch (error) {
      this.renderError(error);
    }
  }

  updateTopbar(text) {
    if (!this.sessionStatus) {
      return;
    }
    const dot = this.sessionStatus.querySelector(".status-dot");
    this.sessionStatus.replaceChildren();
    if (dot) {
      this.sessionStatus.append(dot);
    }
    this.sessionStatus.append(document.createTextNode(text));
  }
}
