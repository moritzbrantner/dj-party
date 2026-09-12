import {
  extractZipLibrary,
  isPlaylistFile,
  isZipFile,
  matchPlaylistReferences,
  parseM3u,
} from "./archive-import.js";

const DATABASE_NAME = "dj-party-playlists";
const DATABASE_VERSION = 1;
const PLAYLIST_STORE = "playlists";

export function installLibraryImports(library) {
  if (!library || typeof document === "undefined") {
    return null;
  }
  return new LibraryImports(library).install();
}

class LibraryImports {
  constructor(library) {
    this.library = library;
    this.databasePromise = null;
    this.playlists = [];
    this.list = null;
  }

  install() {
    this.installMarkup();
    this.bindEvents();
    void this.loadPlaylists();
    return this;
  }

  installMarkup() {
    const actions = document.querySelector("#music-library .library-import-actions");
    if (actions && !document.querySelector("#library-package")) {
      actions.insertAdjacentHTML(
        "beforeend",
        `<input id="library-package" class="library-file-input" type="file" accept=".zip,.m3u,.m3u8,application/zip,audio/x-mpegurl,application/vnd.apple.mpegurl" multiple />
         <label class="library-button" for="library-package">Import ZIP / playlist</label>`,
      );
    }

    const importSurface = document.querySelector("#library-import-surface");
    if (importSurface && !document.querySelector("#library-playlists")) {
      importSurface.insertAdjacentHTML(
        "beforeend",
        `<section id="library-playlists" class="library-playlists" aria-labelledby="library-playlists-title">
          <div class="library-playlists-heading">
            <div>
              <span class="library-playlists-kicker">Imported playlists</span>
              <strong id="library-playlists-title">Saved local sets</strong>
            </div>
            <span class="library-playlists-note">M3U entries only match tracks already stored in this browser.</span>
          </div>
          <div id="library-playlist-list" class="library-playlist-list"></div>
        </section>`,
      );
    }
    this.list = document.querySelector("#library-playlist-list");
  }

  bindEvents() {
    const input = document.querySelector("#library-package");
    input?.addEventListener("change", () => {
      const files = [...(input.files ?? [])];
      input.value = "";
      void this.importPackages(files);
    });
  }

  async importPackages(files) {
    if (!(await this.library.ready)) {
      this.library.setStatus("Persistent library is unavailable in this browser");
      return;
    }

    const supported = files.filter((file) => isZipFile(file) || isPlaylistFile(file));
    if (supported.length === 0) {
      this.library.setStatus("Select a ZIP, M3U, or M3U8 file to import");
      return;
    }

    let importedTracks = 0;
    let importedPlaylists = 0;
    let unmatched = 0;

    try {
      for (const file of supported) {
        if (isZipFile(file)) {
          this.library.setStatus(`Reading ${file.name}…`);
          const archive = await extractZipLibrary(file);
          if (archive.audioEntries.length > 0) {
            const before = new Set(this.library.records.map((record) => record.id));
            await this.library.importFiles(
              archive.audioEntries.map((entry) => entry.file),
              { silent: true },
            );
            importedTracks += this.library.records.filter((record) => !before.has(record.id)).length;
          }

          for (const playlist of archive.playlists) {
            const result = await this.savePlaylist(playlist.name, playlist.references, playlist.ignoredExternal);
            importedPlaylists += 1;
            unmatched += result.missing.length + playlist.ignoredExternal;
          }
        } else if (isPlaylistFile(file)) {
          const parsed = parseM3u(await file.text());
          const result = await this.savePlaylist(stripExtension(file.name), parsed.references, parsed.ignoredExternal);
          importedPlaylists += 1;
          unmatched += result.missing.length + parsed.ignoredExternal;
        }
      }

      await this.loadPlaylists();
      const parts = [];
      if (importedTracks > 0) {
        parts.push(`${importedTracks} new ${importedTracks === 1 ? "track" : "tracks"}`);
      }
      if (importedPlaylists > 0) {
        parts.push(`${importedPlaylists} ${importedPlaylists === 1 ? "playlist" : "playlists"}`);
      }
      if (unmatched > 0) {
        parts.push(`${unmatched} unmatched/external ${unmatched === 1 ? "entry" : "entries"}`);
      }
      this.library.setStatus(parts.length > 0 ? `Imported ${parts.join(" · ")}` : "Nothing new was imported");
    } catch (error) {
      console.error("Could not import ZIP or playlist", error);
      this.library.setStatus(error instanceof Error ? error.message : "ZIP / playlist import failed");
    }
  }

  async savePlaylist(name, references, ignoredExternal = 0) {
    const result = matchPlaylistReferences(references, this.library.records);
    const record = {
      id: playlistId(name),
      name: String(name || "Imported playlist"),
      trackIds: result.trackIds,
      missing: result.missing,
      ignoredExternal: Number(ignoredExternal) || 0,
      updatedAt: Date.now(),
    };

    const database = await this.openDatabase();
    const transaction = database.transaction(PLAYLIST_STORE, "readwrite");
    transaction.objectStore(PLAYLIST_STORE).put(record);
    await transactionDone(transaction);
    return result;
  }

  async loadPlaylists() {
    try {
      const database = await this.openDatabase();
      const transaction = database.transaction(PLAYLIST_STORE, "readonly");
      this.playlists = await requestResult(transaction.objectStore(PLAYLIST_STORE).getAll());
      await transactionDone(transaction);
      this.playlists.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
      this.render();
    } catch (error) {
      console.error("Could not open browser-local playlists", error);
      this.playlists = [];
      this.render();
    }
  }

  render() {
    if (!this.list) {
      return;
    }

    this.list.replaceChildren();
    if (this.playlists.length === 0) {
      const empty = document.createElement("p");
      empty.className = "library-empty";
      empty.textContent = "Import an M3U/M3U8 file, or a ZIP containing one, to save a local set order.";
      this.list.append(empty);
      return;
    }

    const records = new Map(this.library.records.map((record) => [record.id, record]));
    for (const playlist of this.playlists) {
      const details = document.createElement("details");
      details.className = "library-playlist";

      const summary = document.createElement("summary");
      const available = playlist.trackIds.filter((id) => records.has(id));
      const unavailable = playlist.trackIds.length - available.length + playlist.missing.length + playlist.ignoredExternal;
      summary.textContent = `${playlist.name} · ${available.length} ${available.length === 1 ? "track" : "tracks"}${unavailable > 0 ? ` · ${unavailable} unavailable` : ""}`;
      details.append(summary);

      const tracks = document.createElement("ol");
      tracks.className = "library-playlist-tracks";
      for (const id of playlist.trackIds) {
        const record = records.get(id);
        if (!record) {
          continue;
        }
        const item = document.createElement("li");
        const name = document.createElement("span");
        name.textContent = stripExtension(record.name);
        const actions = document.createElement("span");
        actions.className = "library-playlist-track-actions";
        for (const deckId of ["a", "b"]) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "library-button";
          button.textContent = `Load ${deckId.toUpperCase()}`;
          button.addEventListener("click", () => void this.library.loadIntoDeck(id, deckId));
          actions.append(button);
        }
        item.append(name, actions);
        tracks.append(item);
      }
      details.append(tracks);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "library-button library-remove library-playlist-remove";
      remove.textContent = "Remove playlist";
      remove.addEventListener("click", () => void this.removePlaylist(playlist.id));
      details.append(remove);

      this.list.append(details);
    }
  }

  async removePlaylist(id) {
    const database = await this.openDatabase();
    const transaction = database.transaction(PLAYLIST_STORE, "readwrite");
    transaction.objectStore(PLAYLIST_STORE).delete(id);
    await transactionDone(transaction);
    this.playlists = this.playlists.filter((playlist) => playlist.id !== id);
    this.render();
    this.library.setStatus("Removed the browser-local playlist; saved tracks were not changed");
  }

  async openDatabase() {
    if (!globalThis.indexedDB) {
      throw new Error("IndexedDB is unavailable in this browser");
    }

    if (!this.databasePromise) {
      this.databasePromise = new Promise((resolve, reject) => {
        const request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        request.addEventListener(
          "upgradeneeded",
          () => {
            const database = request.result;
            if (!database.objectStoreNames.contains(PLAYLIST_STORE)) {
              database.createObjectStore(PLAYLIST_STORE, { keyPath: "id" });
            }
          },
          { once: true },
        );
        request.addEventListener("success", () => resolve(request.result), { once: true });
        request.addEventListener("error", () => reject(request.error ?? new Error("Could not open playlists")), {
          once: true,
        });
      });
    }
    return this.databasePromise;
  }
}

function playlistId(name) {
  return String(name || "Imported playlist").trim().toLocaleLowerCase();
}

function stripExtension(name) {
  return String(name ?? "").replace(/\.[^.]+$/, "") || String(name ?? "");
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
