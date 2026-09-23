import { installCollaborativeAssetTransfer } from "./collaborative-assets.js";
import { installCollaborativeMixer } from "./collaborative-mixer.js";
import { installCollaborativePlayback } from "./collaborative-playback.js";
import { installLibraryImports } from "./library-imports.js";
import { installTrackLibrary } from "./library.js";
import { installMultiplayerSessions } from "./multiplayer.js";
import { installDjPartySettings } from "./settings.js";
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

void installDjPartySettings().catch((error) => {
  console.error("DJ Party settings failed to initialize", error);
});

const multiplayer = installMultiplayerSessions();
installSharedSessionTransport(multiplayer);
installCollaborativeAssetTransfer(library);
const mixerModule = await import("./mixer-app.js");
installCollaborativeMixer();
installCollaborativePlayback(mixerModule);
