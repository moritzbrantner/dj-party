import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript";

const root = process.cwd();
const webRoot = path.join(root, "web");

function memberName(member) {
  const name = member.name;
  return name && ts.isIdentifier(name) ? name.text : null;
}

function indentationAt(source, position) {
  const lineStart = source.lastIndexOf("\n", position - 1) + 1;
  return source.slice(lineStart, position).match(/^\s*/)?.[0] ?? "";
}

for (const entry of fs.readdirSync(webRoot).filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"))) {
  const filePath = path.join(webRoot, entry);
  let source = fs.readFileSync(filePath, "utf8");
  const parsed = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const insertions = [];

  function visit(node) {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const existing = new Set(node.members.map(memberName).filter(Boolean));
      const used = new Set();

      function collect(current) {
        if (
          ts.isPropertyAccessExpression(current) &&
          current.expression.kind === ts.SyntaxKind.ThisKeyword &&
          ts.isIdentifier(current.name)
        ) {
          used.add(current.name.text);
        }
        ts.forEachChild(current, collect);
      }
      for (const member of node.members) collect(member);

      const missing = [...used].filter((name) => !existing.has(name)).sort();
      if (missing.length > 0) {
        const firstMember = node.members[0];
        const position = firstMember ? firstMember.getFullStart() : node.end - 1;
        const classIndent = indentationAt(source, node.getStart(parsed));
        const memberIndent = `${classIndent}  `;
        const declaration = `${firstMember ? "" : "\n"}${missing
          .map((name) => `${memberIndent}declare ${name}: any;`)
          .join("\n")}\n`;
        insertions.push({ position, declaration });
      }
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(parsed);
  for (const insertion of insertions.sort((a, b) => b.position - a.position)) {
    source = `${source.slice(0, insertion.position)}${insertion.declaration}${source.slice(insertion.position)}`;
  }
  fs.writeFileSync(filePath, source);
}

const tsconfigPath = path.join(root, "tsconfig.json");
const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, "utf8"));
delete tsconfig.compilerOptions.noCheck;
fs.writeFileSync(tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`);
