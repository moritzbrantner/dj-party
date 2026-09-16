import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const webRoot = path.join(root, "web");

function matchingBrace(source, open) {
  let depth = 0;
  let mode = "code";
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (mode === "line-comment") {
      if (char === "\n") mode = "code";
      continue;
    }
    if (mode === "block-comment") {
      if (char === "*" && next === "/") {
        mode = "code";
        index += 1;
      }
      continue;
    }
    if (mode === "single") {
      if (char === "\\") index += 1;
      else if (char === "'") mode = "code";
      continue;
    }
    if (mode === "double") {
      if (char === "\\") index += 1;
      else if (char === '"') mode = "code";
      continue;
    }
    if (mode === "template") {
      if (char === "\\") index += 1;
      else if (char === "`") mode = "code";
      continue;
    }

    if (char === "/" && next === "/") {
      mode = "line-comment";
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      mode = "block-comment";
      index += 1;
      continue;
    }
    if (char === "'") {
      mode = "single";
      continue;
    }
    if (char === '"') {
      mode = "double";
      continue;
    }
    if (char === "`") {
      mode = "template";
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error(`Unbalanced class body at offset ${open}`);
}

function declaredMembers(body) {
  const names = new Set();
  for (const match of body.matchAll(/^\s*(?:declare\s+)?([A-Za-z_$][\w$]*)\s*(?::|=|\()/gm)) {
    names.add(match[1]);
  }
  return names;
}

for (const entry of fs.readdirSync(webRoot).filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"))) {
  const filePath = path.join(webRoot, entry);
  let source = fs.readFileSync(filePath, "utf8");
  const classes = [];
  const classPattern = /\bclass(?:\s+[A-Za-z_$][\w$]*)?(?:\s+extends\s+[^\{]+)?\s*\{/g;
  let match;
  while ((match = classPattern.exec(source)) !== null) {
    const open = source.indexOf("{", match.index);
    const close = matchingBrace(source, open);
    classes.push({ open, close });
    classPattern.lastIndex = close + 1;
  }

  for (const { open, close } of classes.reverse()) {
    const body = source.slice(open + 1, close);
    const existing = declaredMembers(body);
    const assigned = new Set();
    const assignmentPattern = /\bthis\.([A-Za-z_$][\w$]*)\s*(?:=|\?\?=|\|\|=|&&=|\+=|-=|\*=|\/=|%=|\*\*=|\+\+|--)/g;
    for (const assignment of body.matchAll(assignmentPattern)) assigned.add(assignment[1]);
    const missing = [...assigned].filter((name) => !existing.has(name)).sort();
    if (missing.length === 0) continue;

    const lineStart = source.lastIndexOf("\n", open) + 1;
    const classIndent = source.slice(lineStart, open).match(/^\s*/)?.[0] ?? "";
    const memberIndent = `${classIndent}  `;
    const declarations = `\n${missing.map((name) => `${memberIndent}declare ${name}: any;`).join("\n")}`;
    source = `${source.slice(0, open + 1)}${declarations}${source.slice(open + 1)}`;
  }

  fs.writeFileSync(filePath, source);
}

const tsconfigPath = path.join(root, "tsconfig.json");
const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, "utf8"));
delete tsconfig.compilerOptions.noCheck;
fs.writeFileSync(tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`);
