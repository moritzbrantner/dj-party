const DATABASE_NAME = "dj-party-library";
const DATABASE_VERSION = 1;
const TRACK_STORE = "tracks";
const AUDIO_EXTENSION = /\.(aac|aif|aiff|flac|m4a|mp3|mp4|oga|ogg|opus|wav|webm)$/i;

export function isSupportedAudioFile(file) {
  if (!file) {
    return false;
  }

  const type = String(file.type ?? "").toLowerCase();
  const name = String(file.name ?? "");
  return type.startsWith("audio/") || AUDIO_EXTENSION.test(name);
}

export function trackIdForFile(file, sourcePath = "") {
  const explicitPath = String(sourcePath ?? "").replaceAll("\\", "/").trim();
  const name = explicitPath || String(file?.name ?? "");
  const size = Number.isFinite(Number(file?.size)) ? Number(file.size) : 0;
  const lastModified = Number.isFinite(Number(file?.lastModified)) ? Number(file.lastModified) : 0;
  return `${name}\u0000${size}\u0000${lastModified}`;
}

export function formatFileSize(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const digits = unitIndex === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function importItem(value) {
  if (value?.file) {
    return {
      file: value.file,
      path: String(value.path ?? "").replaceAll("\\", "/").trim(),
    };
  }
  return { file: value, path: "" };
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed")), {
      once: true,
    });
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("IndexedDB transaction aborted")), {
      once: true,
    });
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("IndexedDB transaction failed")), {
      once: true,
    });
  });
}

class TrackStore {
  constructor(indexedDb = globalThis.indexedDB) {
    this.indexedDb = indexedDb;
    this.databasePromise = null;
  }

  async open() {
    if (!this.indexedDb) {
      throw new Error("IndexedDB is unavailable in this browser");
    }

    if (!this.databasePromise) {
      this.databasePromise = new Promise((resolve, reject) => {
        const request = this.indexedDb.open(DATABASE_NAME, DATABASE_VERSION);
        request.addEventListener(
          "upgradeneeded",
          () => {
            const database = request.result;
            if (!database.objectStoreNames.contains(TRACK_STORE)) {
              database.createObjectStore(TRACK_STORE, { keyPath: "id" });
            }
          },
          { once: true },
        );
        request.addEventListener("success", () => resolve(request.result), { once: true });
        request.addEventListener("error", () => reject(request.error ?? new Error("Could not open track library")), {
          once: true,
        });
        request.addEventListener(
          "blocked",
          () => reject(new Error("Track library upgrade is blocked by another DJ Party tab")),
          { once: true },
        );
      });
    }

    return this.databasePromise;
  }

  async list() {
    const database = await this.open();
    const transaction = database.transaction(TRACK_STORE, "readonly");
    const records = await requestResult(transaction.objectStore(TRACK_STORE).getAll());
    await transactionDone(transaction);
    return records;
  }

  async addMany(values) {
    const database = await this.open();
    const transaction = database.transaction(TRACK_STORE, "readwrite");
    const store = transaction.objectStore(TRACK_STORE);
    const existingIds = new Set((await requestResult(store.getAllKeys())).map(String));
    const added = [];
    const skipped = [];

    for (const value of values) {
      const { file, path } = importItem(value);
      const id = trackIdForFile(file, path);
      if (existingIds.has(id)) {
        skipped.push(id);
        continue;
      }

      const record = {
        id,
        name: file.name,
        path: path || String(file.webkitRelativePath ?? "").replaceAll("\\", "/").trim() || file.name,
        type: file.type || "",
        size: file.size,
        lastModified: file.lastModified || 0,
        addedAt: Date.now(),
        blob: file.slice(0, file.size, file.type || ""),
      };
      store.add(record);
      existingIds.add(id);
      added.push(record);
    }

    await transactionDone(transaction);
    return { added, skipped };
  }

  async get(id) {
    const database = await this.open();
    const transaction = database.transaction(TRACK_STORE, "readonly");
    const record = await requestResult(transaction.objectStore(TRACK_STORE).get(id));
    await transactionDone(transaction);
    return record ?? null;
  }

  async remove(id) {
    const database = await this.open();
    const transaction = database.transaction(TRACK_STORE, "readwrite");
    transaction.objectStore(TRACK_STORE).delete(id);
    await transactionDone(transaction);
  }
}

class BrowserTrackLibrary {
  constructor() {
    this.store = new TrackStore();
    this.records = [];
    this.searchText = "";
    this.storageReady = false;
    this.status = null;
    this.list = null;
    this.search = null;
    this.importSurface = null;
    this.deckPersistenceSkips = new Set();
    this.ready = Promise.resolve(false);
  }

  install() {
    this.installStylesheet();
    this.installMarkup();
    this.bindLibraryEvents();
    this.bindDeckPersistence();
    this.ready = this.loadInitialRecords();
    return this;
  }

  installStylesheet() {
    if (document.querySelector('link[data-library-styles]')) {
      return;
    }

    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = new URL("./library.css", import.meta.url).href;
    stylesheet.dataset.libraryStyles = "true";
    document.head.append(stylesheet);
  }

  installMarkup() {
    if (document.querySelector("#music-library")) {
      return;
    }

    const topbar = document.querySelector(".topbar");
    if (!topbar) {
      return;
    }

    topbar.insertAdjacentHTML(
      "afterend",
      `<section id="music-library" class="music-library" aria-labelledby="music-library-title">
        <div class="library-heading">
          <div>
            <p class="library-eyebrow">Music collection</p>
            <h2 id="music-library-title">Your browser-local tracks</h2>
            <p class="library-description">Import many songs once, then load any saved track into either deck. Audio stays on this device.</p>
          </div>
          <div class="library-import-actions">
            <input id="library-files" class="library-file-input" type="file" accept="audio/*,.aac,.aif,.aiff,.flac,.m4a,.mp3,.mp4,.oga,.ogg,.opus,.wav,.webm" multiple />
            <label class="library-button library-button-primary" for="library-files">Import files</label>
            <input id="library-folder" class="library-file-input" type="file" accept="audio/*,.aac,.aif,.aiff,.flac,.m4a,.mp3,.mp4,.oga,.ogg,.opus,.wav,.webm" webkitdirectory directory multiple />
            <label class="library-button" for="library-folder">Import folder</label>
          </div>
        </div>
        <div id="library-import-surface" class="library-import-surface">
          <div class="library-toolbar">
            <label class="library-search-label" for="library-search">
              <span>Find a track</span>
              <input id="library-search" type="search" placeholder="Search filenames" autocomplete="off" />
            </label>
            <output id="library-status" class="library-status" aria-live="polite">Opening local collection…</output>
          </div>
          <div id="library-track-list" class="library-track-list" role="list"></div>
          <p class="library-drop-hint">You can also drop multiple audio files anywhere in this collection.</p>
        </div>
      </section>`,
    );

    this.status = document.querySelector("#library-status");
    this.list = document.querySelector("#library-track-list");
    this.search = document.querySelector("#library-search");
    this.importSurface = document.querySelector("#library-import-surface");
  }

  bindLibraryEvents() {
    const filesInput = document.querySelector("#library-files");
    const folderInput = document.querySelector("#library-folder");

    for (const input of [filesInput, folderInput]) {
      input?.addEventListener("change", () => {
        const files = [...(input.files ?? [])];
        input.value = "";
        void this.importFiles(files);
      });
    }

    this.search?.addEventListener("input", () => {
      this.searchText = this.search.value.trim().toLocaleLowerCase();
      this.render();
    });

    for (const eventName of ["dragenter", "dragover"]) {
      this.importSurface?.addEventListener(eventName, (event) => {
        event.preventDefault();
        this.importSurface.classList.add("is-dragging");
      });
    }

    for (const eventName of ["dragleave", "drop"]) {
      this.importSurface?.addEventListener(eventName, (event) => {
        event.preventDefault();
        this.importSurface.classList.remove("is-dragging");
      });
    }

    this.importSurface?.addEventListener("drop", (event) => {
      void this.importFiles([...(event.dataTransfer?.files ?? [])]);
    });
  }

  bindDeckPersistence() {
    for (const id of ["a", "b"]) {
      const input = document.querySelector(`#deck-${id}-file`);
      input?.addEventListener(
        "change",
        () => {
          if (this.deckPersistenceSkips.delete(id)) {
            return;
          }
          void this.importFiles([...(input.files ?? [])], { silent: true });
        },
        { capture: true },
      );

      const dropZone = document.querySelector(`#deck-${id}-drop-zone`);
      dropZone?.addEventListener(
        "drop",
        (event) => {
          void this.importFiles([...(event.dataTransfer?.files ?? [])], { silent: true });
        },
        { capture: true },
      );
    }
  }

  async loadInitialRecords() {
    try {
      this.records = await this.store.list();
      this.storageReady = true;
      this.render();
      this.setStatus(
        this.records.length === 0
          ? "No saved tracks yet"
          : `${this.records.length} saved ${this.records.length === 1 ? "track" : "tracks"} ready`,
      );
      return true;
    } catch (error) {
      console.error("Could not open browser-local track library", error);
      this.storageReady = false;
      this.render();
      this.setStatus("Persistent library unavailable; direct deck loading still works");
      return false;
    }
  }

  async importFiles(values, { silent = false } = {}) {
    const supported = values.map(importItem).filter((entry) => isSupportedAudioFile(entry.file));
    if (supported.length === 0) {
      if (!silent && values.length > 0) {
        this.setStatus("No supported audio files were selected");
      }
      return;
    }

    if (!(await this.ready)) {
      if (!silent) {
        this.setStatus("Persistent library is unavailable in this browser");
      }
      return;
    }

    if (!silent) {
      this.setStatus(`Saving ${supported.length} ${supported.length === 1 ? "track" : "tracks"} locally…`);
    }

    try {
      const result = await this.store.addMany(supported);
      if (result.added.length > 0) {
        this.records = await this.store.list();
        this.render();
      }

      if (!silent) {
        if (result.added.length === 0) {
          this.setStatus("Those tracks are already in your collection");
        } else if (result.skipped.length > 0) {
          this.setStatus(`Added ${result.added.length}; skipped ${result.skipped.length} duplicate ${result.skipped.length === 1 ? "track" : "tracks"}`);
        } else {
          this.setStatus(`Added ${result.added.length} ${result.added.length === 1 ? "track" : "tracks"}`);
        }
      }
    } catch (error) {
      console.error("Could not save tracks in browser-local library", error);
      if (!silent) {
        this.setStatus(describeStorageError(error));
      }
    }
  }

  render() {
    if (!this.list) {
      return;
    }

    this.list.replaceChildren();
    const sorted = [...this.records].sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }),
    );
    const visible = this.searchText
      ? sorted.filter((record) => record.name.toLocaleLowerCase().includes(this.searchText))
      : sorted;

    if (visible.length === 0) {
      const empty = document.createElement("p");
      empty.className = "library-empty";
      empty.textContent = this.records.length === 0 ? "Import audio files to build your local collection." : "No tracks match this search.";
      this.list.append(empty);
      return;
    }

    for (const record of visible) {
      this.list.append(this.createTrackRow(record));
    }
  }

  createTrackRow(record) {
    const row = document.createElement("article");
    row.className = "library-track";
    row.setAttribute("role", "listitem");

    const identity = document.createElement("div");
    identity.className = "library-track-identity";

    const title = document.createElement("strong");
    title.className = "library-track-title";
    title.textContent = stripExtension(record.name);

    const metadata = document.createElement("span");
    metadata.className = "library-track-meta";
    metadata.textContent = `${fileKind(record)} · ${formatFileSize(record.size)}`;

    identity.append(title, metadata);

    const actions = document.createElement("div");
    actions.className = "library-track-actions";
    for (const deckId of ["a", "b"]) {
      const button = document.createElement("button");
      button.className = `library-button library-load-${deckId}`;
      button.type = "button";
      button.textContent = `Load ${deckId.toUpperCase()}`;
      button.addEventListener("click", () => void this.loadIntoDeck(record.id, deckId));
      actions.append(button);
    }

    const remove = document.createElement("button");
    remove.className = "library-button library-remove";
    remove.type = "button";
    remove.textContent = "Remove";
    remove.title = "Remove from this browser collection; the original file is not deleted";
    remove.addEventListener("click", () => void this.removeTrack(record.id));
    actions.append(remove);

    row.append(identity, actions);
    return row;
  }

  async loadIntoDeck(id, deckId) {
    if (!this.storageReady) {
      return;
    }

    try {
      const record = await this.store.get(id);
      if (!record) {
        this.setStatus("That saved track is no longer available");
        this.records = await this.store.list();
        this.render();
        return;
      }

      const file = new File([record.blob], record.name, {
        type: record.type,
        lastModified: record.lastModified,
      });
      const input = document.querySelector(`#deck-${deckId}-file`);
      const transfer = createDataTransfer();
      if (!input || !transfer) {
        this.setStatus("This browser cannot hand saved tracks back to the deck picker");
        return;
      }

      transfer.items.add(file);
      input.files = transfer.files;
      this.deckPersistenceSkips.add(deckId);
      input.dispatchEvent(new Event("change", { bubbles: true }));
      this.setStatus(`Loaded ${stripExtension(record.name)} into Deck ${deckId.toUpperCase()}`);
    } catch (error) {
      this.deckPersistenceSkips.delete(deckId);
      console.error(`Could not load saved track into Deck ${deckId.toUpperCase()}`, error);
      this.setStatus("Could not load that saved track");
    }
  }

  async removeTrack(id) {
    try {
      await this.store.remove(id);
      this.records = this.records.filter((record) => record.id !== id);
      this.render();
      this.setStatus("Removed from this browser collection; the original file was not changed");
    } catch (error) {
      console.error("Could not remove track from browser-local library", error);
      this.setStatus("Could not remove that track from the collection");
    }
  }

  setStatus(message) {
    if (this.status) {
      this.status.textContent = message;
    }
  }
}

function createDataTransfer() {
  if (typeof DataTransfer === "function") {
    try {
      return new DataTransfer();
    } catch {
      return null;
    }
  }
  return null;
}

function stripExtension(fileName) {
  return fileName.replace(/\.[^.]+$/, "") || fileName;
}

function fileKind(record) {
  const type = String(record.type ?? "");
  if (type.startsWith("audio/") && type.length > 6) {
    return type.slice(6).toUpperCase();
  }

  const extension = record.name.match(/\.([^.]+)$/)?.[1];
  return extension ? extension.toUpperCase() : "Audio";
}

function describeStorageError(error) {
  if (error?.name === "QuotaExceededError") {
    return "Browser storage is full; remove tracks or free site storage before importing more";
  }
  return "Could not save these tracks in the browser-local collection";
}

export function installTrackLibrary() {
  if (typeof document === "undefined") {
    return null;
  }

  return new BrowserTrackLibrary().install();
}
