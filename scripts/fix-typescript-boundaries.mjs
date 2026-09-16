import fs from "node:fs";

function edit(path, replacements) {
  let source = fs.readFileSync(path, "utf8");
  for (const [before, after] of replacements) {
    if (!source.includes(before)) throw new Error(`${path}: expected text not found: ${before.slice(0, 80)}`);
    source = source.replace(before, after);
  }
  fs.writeFileSync(path, source);
}

const idbHelpers = [
  ["function requestResult(request) {\n  return new Promise((resolve, reject) => {", "function requestResult<T>(request: IDBRequest<T>): Promise<T> {\n  return new Promise<T>((resolve, reject) => {"],
  ["function transactionDone(transaction) {\n  return new Promise((resolve, reject) => {", "function transactionDone(transaction: IDBTransaction): Promise<void> {\n  return new Promise<void>((resolve, reject) => {"],
];

edit("web/analysis-cache.ts", [
  ...idbHelpers,
  ["return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);", "return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice().buffer;"],
]);
edit("web/track-identity.ts", [
  ["return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);", "return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice().buffer;"],
]);
edit("web/library.ts", [
  ...idbHelpers,
  ["const filesInput = document.querySelector(\"#library-files\");", "const filesInput = document.querySelector<HTMLInputElement>(\"#library-files\");"],
  ["const folderInput = document.querySelector(\"#library-folder\");", "const folderInput = document.querySelector<HTMLInputElement>(\"#library-folder\");"],
  ["const input = document.querySelector(`#deck-${id}-file`);", "const input = document.querySelector<HTMLInputElement>(`#deck-${id}-file`);"],
  ["const input = document.querySelector(`#deck-${deckId}-file`);", "const input = document.querySelector<HTMLInputElement>(`#deck-${deckId}-file`);"],
]);
edit("web/library-imports.ts", [
  ...idbHelpers,
  ["const input = document.querySelector(\"#library-package\");", "const input = document.querySelector<HTMLInputElement>(\"#library-package\");"],
  ["const records = new Map(this.library.records.map((record) => [record.id, record]));", "const records = new Map<string, any>(this.library.records.map((record) => [record.id, record]));"],
]);
edit("web/collaborative-mixer.ts", [
  ["return new Promise((resolve) => {\n    if (typeof requestAnimationFrame", "return new Promise<void>((resolve) => {\n    if (typeof requestAnimationFrame"],
]);
edit("web/collaborative-playback.ts", [
  ["constructor({ mixerModule, coordinator = sharedPlaybackSession } = {}) {", "constructor({ mixerModule, coordinator = sharedPlaybackSession }: { mixerModule?: any; coordinator?: any } = {}) {"],
  ["const fileInput = document.querySelector(`#deck-${deckId}-file`);", "const fileInput = document.querySelector<HTMLInputElement>(`#deck-${deckId}-file`);"],
  ["return new Promise((resolve) => {\n    if (typeof requestAnimationFrame", "return new Promise<void>((resolve) => {\n    if (typeof requestAnimationFrame"],
]);
edit("web/effects.ts", [
  ["low: document.querySelector(`#deck-${id}-low`),", "low: document.querySelector<HTMLInputElement>(`#deck-${id}-low`),"],
  ["mid: document.querySelector(`#deck-${id}-mid`),", "mid: document.querySelector<HTMLInputElement>(`#deck-${id}-mid`),"],
  ["high: document.querySelector(`#deck-${id}-high`),", "high: document.querySelector<HTMLInputElement>(`#deck-${id}-high`),"],
  ["filter: document.querySelector(`#deck-${id}-filter`),", "filter: document.querySelector<HTMLInputElement>(`#deck-${id}-filter`),"],
  ["for (const control of Object.values(this.controls)) {", "for (const control of Object.values(this.controls) as HTMLInputElement[]) {"],
  ["for (const control of Object.values(this.controls)) {", "for (const control of Object.values(this.controls) as HTMLInputElement[]) {"],
]);
edit("web/mixer-app.ts", [
  ["const crossfader = document.querySelector(\"#crossfader\");", "const crossfader = document.querySelector<HTMLInputElement>(\"#crossfader\");"],
  ["const chooseHeadphones = document.querySelector(\"#choose-headphones\");", "const chooseHeadphones = document.querySelector<HTMLButtonElement>(\"#choose-headphones\");"],
  ["const chooseMaster = document.querySelector(\"#choose-master-output\");", "const chooseMaster = document.querySelector<HTMLButtonElement>(\"#choose-master-output\");"],
  ["const mix = document.querySelector(\"#monitor-mix\");", "const mix = document.querySelector<HTMLInputElement>(\"#monitor-mix\");"],
  ["const level = document.querySelector(\"#monitor-level\");", "const level = document.querySelector<HTMLInputElement>(\"#monitor-level\");"],
  ["document.querySelector(\"#monitor-mix\").disabled = !enabled;", "document.querySelector<HTMLInputElement>(\"#monitor-mix\")!.disabled = !enabled;"],
  ["document.querySelector(\"#monitor-level\").disabled = !enabled;", "document.querySelector<HTMLInputElement>(\"#monitor-level\")!.disabled = !enabled;"],
]);
edit("web/multiplayer.ts", [
  ["declare compatiblePeers: any;", "declare compatiblePeers: any;\n  declare apiBase: any;\n  declare loadClient: any;\n  declare session: any;\n  declare state: any;\n  declare turnAvailable: any;"],
  ["  } = {}) {\n    super();\n    this.apiBase = normalizeMultiplayerApiBase", "  }: { apiBase?: string; loadClient?: typeof loadMultiplayerClientModules } = {}) {\n    super();\n    this.apiBase = normalizeMultiplayerApiBase"],
  ["class MultiplayerSessionUi extends EventTarget {\n  declare apiInput: any;", "class MultiplayerSessionUi extends EventTarget {\n  declare apiInput: any;\n  declare controller: any;"],
]);
edit("web/shared-playback.ts", [
  ["  declare clockRequestPending: any;", "  declare blockedDeckIds: any;\n  declare canonicalSequence: any;\n  declare clockOffsetMs: any;\n  declare clockReady: any;\n  declare clockRttMs: any;\n  declare ready: any;\n  declare clockRequestPending: any;"],
]);
edit("web/shared-session.ts", [
  ["export class SharedSessionCoordinator extends EventTarget {\n  declare lastCanonicalSequence: any;", "export class SharedSessionCoordinator extends EventTarget {\n  declare canonicalSequence: any;\n  declare ready: any;\n  declare lastCanonicalSequence: any;"],
]);
