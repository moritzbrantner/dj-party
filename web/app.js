import { installCollaborativeMixer } from "./collaborative-mixer.js";
import { installCollaborativePlayback } from "./collaborative-playback.js";
import { installLibraryImports } from "./library-imports.js";
import { installTrackLibrary } from "./library.js";
import { installMultiplayerSessions } from "./multiplayer.js";
import { installSharedSessionTransport } from "./shared-session-transport.js";

const library = installTrackLibrary();
if (library) {
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = new URL("./library-imports.css", import.meta.url).href;
  stylesheet.dataset.libraryImportsStyles = "true";
  document.head.append(stylesheet);
  installLibraryImports(library);
}

const multiplayer = installMultiplayerSessions();
installSharedSessionTransport(multiplayer);
const mixerModule = await import("./mixer-app.js");
installCollaborativeMixer();
await installCollaborativePlayback(mixerModule);
