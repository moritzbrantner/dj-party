import fs from "node:fs";

function replaceOnce(path, before, after) {
  let source = fs.readFileSync(path, "utf8");
  if (!source.includes(before)) throw new Error(`${path}: expected text not found`);
  source = source.replace(before, after);
  fs.writeFileSync(path, source);
}

replaceOnce(
  "web/analysis-cache.ts",
  "const all = await requestResult(read.objectStore(ANALYSIS_STORE).getAll());",
  "const all = await requestResult<any[]>(read.objectStore(ANALYSIS_STORE).getAll());",
);
replaceOnce(
  "web/library.ts",
  "const existingIds = new Set((await requestResult(store.getAllKeys())).map(String));",
  "const existingIds = new Set((await requestResult<IDBValidKey[]>(store.getAllKeys())).map(String));",
);
replaceOnce(
  "web/shared-playback.ts",
  "  declare clockOffsetMs: any;\n  declare blockedDeckIds: any;\n  declare canonicalSequence: any;\n  declare clockOffsetMs: any;",
  "  declare blockedDeckIds: any;\n  declare canonicalSequence: any;\n  declare clockOffsetMs: any;",
);
