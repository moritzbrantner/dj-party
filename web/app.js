import { installLibraryImports } from "./library-imports.js";
import { installTrackLibrary } from "./library.js";
import { installMultiplayerSessions } from "./multiplayer.js";

const library = installTrackLibrary();
if (library) {
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = new URL("./library-imports.css", import.meta.url).href;
  stylesheet.dataset.libraryImportsStyles = "true";
  document.head.append(stylesheet);
  installLibraryImports(library);
}

installMultiplayerSessions();
await import("./mixer-app.js");
