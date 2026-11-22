/**
 * Stable entity identities, edge evidence contracts, and language-aware
 * source code parsers (JavaScript, JSX, TypeScript, PHP, SQL, Config).
 */

import crypto from "node:crypto";
import path from "node:path";
import { normalizeRelPath } from "../security/guards.js";

export const ENTITY_TYPES = Object.freeze([
  "file",
  "module",
  "class",
  "interface",
  "function",
  "method",
  "route",
  "model",
  "test",
  "knowledge",
]);

export const RELATIONSHIP_TYPES = Object.freeze([
  "CALLS",
  "IMPORTS",
  "EXPORTS",
  "DEFINES",
  "DEPENDS_ON",
  "EXTENDS",
  "IMPLEMENTS",
  "ROUTES_TO",
  "READS_FROM",
  "WRITES_TO",
  "TESTED_BY",
  "DOCUMENTED_BY",
  "FIXED_BY",
  "AFFECTED_BY_BUG",
  "PROTECTS_INVARIANT",
  "RELATED_KNOWLEDGE",
]);

export const EVIDENCE_STATUS = Object.freeze({
  CONFIRMED: "CONFIRMED",
  INFERRED: "INFERRED",
  UNKNOWN: "UNKNOWN",
  STALE: "STALE",
});

export function computeFileHash(content) {
  return crypto.createHash("sha256").update(String(content || ""), "utf8").digest("hex");
}

export function buildEntityId(repoId, relPath, kind, symbolName, occurrence = 1) {
  const normPath = normalizeRelPath(relPath);
  const cleanKind = String(kind || "symbol").toLowerCase();
  const cleanName = String(symbolName || path.posix.basename(normPath)).trim();
  const suffix = occurrence > 1 ? `#${occurrence}` : "";
  return `${repoId}::${normPath}::${cleanKind}::${cleanName}${suffix}`;
}

export function detectLanguage(relPath) {
  const ext = path.extname(String(relPath || "")).toLowerCase();
  if ([".js", ".mjs", ".cjs"].includes(ext)) return "javascript";
  if ([".jsx"].includes(ext)) return "jsx";
  if ([".ts", ".tsx"].includes(ext)) return "typescript";
  if (ext === ".php") return "php";
  if (ext === ".sql") return "sql";
  if ([".json", ".yaml", ".yml"].includes(ext)) return "config";
  return "other";
}

export function isTestFilePath(relPath) {
  const norm = normalizeRelPath(relPath).toLowerCase();
  return (
    norm.startsWith("tests/") ||
    norm.includes("/tests/") ||
    norm.includes("/__tests__/") ||
    /\.(?:test|spec)\.[jt]sx?$/i.test(norm) ||
    /test\.php$/i.test(norm)
  );
}

/**
 * Parse a source file into entities (file, classes, interfaces, functions, methods,
 * routes, tests) and relationships (DEFINES, IMPORTS, EXPORTS, EXTENDS, IMPLEMENTS,
 * CALLS, ROUTES_TO, READS_FROM, WRITES_TO) with traceable line evidence.
 */
export function parseSourceFile({ repoId = "default", relPath, content }) {
  const normPath = normalizeRelPath(relPath);
  const language = detectLanguage(normPath);
  const isTest = isTestFilePath(normPath);
  const lines = String(content || "").split(/\r?\n/);

  const entities = [];
  const relationships = [];
  const occurrenceCounters = new Map();

  const registerEntity = (kind, name, startLine, extra = {}) => {
    const key = `${kind}::${name}`;
    const occ = (occurrenceCounters.get(key) || 0) + 1;
    occurrenceCounters.set(key, occ);
    const id = buildEntityId(repoId, normPath, kind, name, occ);
    const entity = {
      id,
      repo_id: repoId,
      file_path: normPath,
      kind,
      name,
      language,
      line: startLine,
      occurrence: occ,
      is_test: isTest || kind === "test",
      signature: extra.signature || name,
      domain: extra.domain || null,
    };
    entities.push(entity);
    return entity;
  };

  const fileEntity = registerEntity("file", path.posix.basename(normPath), 1, {
    signature: normPath,
  });

  const declaredSymbolNames = new Set();
  let currentClassEntity = null;
  let currentCallableEntity = fileEntity;
  let hasDynamicDependency = false;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const raw = lines[i];
    const trimmed = raw.trim();

    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("#")) {
      continue;
    }

    if (language === "javascript" || language === "jsx" || language === "typescript") {
      // Dynamic import/require detection
      if (/\b(?:import|require)\s*\(\s*[^"'`)]/.test(trimmed)) {
        hasDynamicDependency = true;
      }

      // Static ES import
      const esImport = /^import\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/.exec(trimmed);
      if (esImport) {
        relationships.push({
          source_id: fileEntity.id,
          target_ref: esImport[1],
          type: "IMPORTS",
          status: EVIDENCE_STATUS.CONFIRMED,
          evidence: `${normPath}:${lineNum} ${trimmed.slice(0, 120)}`,
          line: lineNum,
        });
      }

      // CommonJS require
      const cjsRequire = /require\s*\(\s*["']([^"']+)["']\s*\)/.exec(trimmed);
      if (cjsRequire) {
        relationships.push({
          source_id: fileEntity.id,
          target_ref: cjsRequire[1],
          type: "IMPORTS",
          status: EVIDENCE_STATUS.CONFIRMED,
          evidence: `${normPath}:${lineNum} ${trimmed.slice(0, 120)}`,
          line: lineNum,
        });
      }

      // Class declaration
      const classMatch = /^(?:export\s+(?:default\s+)?)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+extends\s+([A-Za-z_$][A-Za-z0-9_$.]*))?(?:\s+implements\s+([A-Za-z0-9_$,\s]+))?/.exec(trimmed);
      if (classMatch) {
        const cls = registerEntity("class", classMatch[1], lineNum, { signature: trimmed.slice(0, 140) });
        declaredSymbolNames.add(classMatch[1]);
        currentClassEntity = cls;
        currentCallableEntity = cls;
        relationships.push({
          source_id: fileEntity.id,
          target_id: cls.id,
          target_ref: cls.name,
          type: "DEFINES",
          status: EVIDENCE_STATUS.CONFIRMED,
          evidence: `${normPath}:${lineNum}`,
          line: lineNum,
        });
        if (/^export\s+/.test(trimmed)) {
          relationships.push({
            source_id: fileEntity.id,
            target_id: cls.id,
            target_ref: cls.name,
            type: "EXPORTS",
            status: EVIDENCE_STATUS.CONFIRMED,
            evidence: `${normPath}:${lineNum}`,
            line: lineNum,
          });
        }
        if (classMatch[2]) {
          relationships.push({
            source_id: cls.id,
            target_ref: classMatch[2],
            type: "EXTENDS",
            status: EVIDENCE_STATUS.CONFIRMED,
            evidence: `${normPath}:${lineNum}`,
            line: lineNum,
          });
        }
        continue;
      }

      // Function declaration or arrow export
      const fnMatch =
        /^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/.exec(trimmed) ||
        /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/.exec(trimmed);
      if (fnMatch) {
        const fn = registerEntity("function", fnMatch[1], lineNum, { signature: trimmed.slice(0, 140) });
        declaredSymbolNames.add(fnMatch[1]);
        currentCallableEntity = fn;
        relationships.push({
          source_id: fileEntity.id,
          target_id: fn.id,
          target_ref: fn.name,
          type: "DEFINES",
          status: EVIDENCE_STATUS.CONFIRMED,
          evidence: `${normPath}:${lineNum}`,
          line: lineNum,
        });
        if (/^export\s+/.test(trimmed)) {
          relationships.push({
            source_id: fileEntity.id,
            target_id: fn.id,
            target_ref: fn.name,
            type: "EXPORTS",
            status: EVIDENCE_STATUS.CONFIRMED,
            evidence: `${normPath}:${lineNum}`,
            line: lineNum,
          });
        }
        continue;
      }

      // Test block in JS/TS (`test("...")`, `it("...")`)
      const testMatch = /^(?:test|it)\s*\(\s*["'`]([^"'`]{3,140})["'`]/.exec(trimmed);
      if (testMatch) {
        const tEnt = registerEntity("test", testMatch[1], lineNum, { signature: testMatch[1] });
        currentCallableEntity = tEnt;
        relationships.push({
          source_id: fileEntity.id,
          target_id: tEnt.id,
          target_ref: tEnt.name,
          type: "DEFINES",
          status: EVIDENCE_STATUS.CONFIRMED,
          evidence: `${normPath}:${lineNum}`,
          line: lineNum,
        });
        continue;
      }

      // Class method
      const methodMatch =
        currentClassEntity &&
        /^(?:public|private|protected|static|async|\s)*([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)\s*\{/.exec(trimmed);
      if (
        methodMatch &&
        !["if", "for", "while", "switch", "catch", "function", "constructor"].includes(methodMatch[1])
      ) {
        const meth = registerEntity("method", `${currentClassEntity.name}.${methodMatch[1]}`, lineNum, {
          signature: trimmed.slice(0, 140),
        });
        declaredSymbolNames.add(methodMatch[1]);
        currentCallableEntity = meth;
        relationships.push({
          source_id: currentClassEntity.id,
          target_id: meth.id,
          target_ref: meth.name,
          type: "DEFINES",
          status: EVIDENCE_STATUS.CONFIRMED,
          evidence: `${normPath}:${lineNum}`,
          line: lineNum,
        });
        continue;
      }
    } else if (language === "php") {
      // PHP use statement
      const useMatch = /^use\s+([A-Za-z0-9_\\]+)(?:\s+as\s+([A-Za-z0-9_]+))?;/.exec(trimmed);
      if (useMatch) {
        const shortName = useMatch[2] || useMatch[1].split("\\").pop();
        relationships.push({
          source_id: fileEntity.id,
          target_ref: shortName,
          type: "IMPORTS",
          status: EVIDENCE_STATUS.CONFIRMED,
          evidence: `${normPath}:${lineNum} ${trimmed}`,
          line: lineNum,
        });
        continue;
      }

      // PHP class / interface / trait
      const phpClassMatch =
        /^(?:final\s+|abstract\s+)?(class|interface|trait)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+extends\s+([A-Za-z0-9_\\]+))?(?:\s+implements\s+([A-Za-z0-9_\\,\s]+))?/.exec(
          trimmed
        );
      if (phpClassMatch) {
        const kind = phpClassMatch[1] === "interface" ? "interface" : "class";
        const cls = registerEntity(kind, phpClassMatch[2], lineNum, { signature: trimmed.slice(0, 140) });
        declaredSymbolNames.add(phpClassMatch[2]);
        currentClassEntity = cls;
        currentCallableEntity = cls;
        relationships.push({
          source_id: fileEntity.id,
          target_id: cls.id,
          target_ref: cls.name,
          type: "DEFINES",
          status: EVIDENCE_STATUS.CONFIRMED,
          evidence: `${normPath}:${lineNum}`,
          line: lineNum,
        });
        if (phpClassMatch[3]) {
          relationships.push({
            source_id: cls.id,
            target_ref: phpClassMatch[3].split("\\").pop(),
            type: "EXTENDS",
            status: EVIDENCE_STATUS.CONFIRMED,
            evidence: `${normPath}:${lineNum}`,
            line: lineNum,
          });
        }
        if (phpClassMatch[4]) {
          for (const iface of phpClassMatch[4].split(",").map((s) => s.trim().split("\\").pop()).filter(Boolean)) {
            relationships.push({
              source_id: cls.id,
              target_ref: iface,
              type: "IMPLEMENTS",
              status: EVIDENCE_STATUS.CONFIRMED,
              evidence: `${normPath}:${lineNum}`,
              line: lineNum,
            });
          }
        }
        continue;
      }

      // PHP method/function
      const phpFnMatch = /^(?:public|protected|private|static|\s)*function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(trimmed);
      if (phpFnMatch) {
        const fnName = currentClassEntity ? `${currentClassEntity.name}.${phpFnMatch[1]}` : phpFnMatch[1];
        const kind = isTest && /^test/i.test(phpFnMatch[1]) ? "test" : currentClassEntity ? "method" : "function";
        const fn = registerEntity(kind, fnName, lineNum, { signature: trimmed.slice(0, 140) });
        declaredSymbolNames.add(phpFnMatch[1]);
        currentCallableEntity = fn;
        relationships.push({
          source_id: (currentClassEntity || fileEntity).id,
          target_id: fn.id,
          target_ref: fn.name,
          type: "DEFINES",
          status: EVIDENCE_STATUS.CONFIRMED,
          evidence: `${normPath}:${lineNum}`,
          line: lineNum,
        });
        continue;
      }

      // Laravel route registration
      const routeMatch = /Route::(?:get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']\s*,\s*\[([A-Za-z0-9_\\]+)::class\s*,\s*["']([^"']+)["']\]/.exec(trimmed);
      if (routeMatch) {
        const routeEnt = registerEntity("route", routeMatch[1], lineNum, { signature: trimmed.slice(0, 140) });
        const ctrl = routeMatch[2].split("\\").pop();
        relationships.push({
          source_id: routeEnt.id,
          target_ref: `${ctrl}.${routeMatch[3]}`,
          type: "ROUTES_TO",
          status: EVIDENCE_STATUS.CONFIRMED,
          evidence: `${normPath}:${lineNum}`,
          line: lineNum,
        });
        continue;
      }
    } else if (language === "sql") {
      const tableMatch = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?([A-Za-z0-9_]+)[`"']?/i.exec(trimmed);
      if (tableMatch) {
        const tbl = registerEntity("model", tableMatch[1], lineNum, { signature: trimmed.slice(0, 120) });
        relationships.push({
          source_id: fileEntity.id,
          target_id: tbl.id,
          target_ref: tbl.name,
          type: "DEFINES",
          status: EVIDENCE_STATUS.CONFIRMED,
          evidence: `${normPath}:${lineNum}`,
          line: lineNum,
        });
      }
    }

    // Call site extraction (confirmed syntactic function/method invocations)
    if (language === "javascript" || language === "jsx" || language === "typescript" || language === "php") {
      const callRegex = /\b([A-Za-z_][A-Za-z0-9_]{2,})\s*\(/g;
      const keywords = new Set([
        "if", "for", "while", "switch", "catch", "function", "return", "typeof", "new",
        "await", "async", "import", "require", "export", "class", "extends", "super",
        "array", "echo", "isset", "empty", "unset", "print", "test", "describe", "assert",
      ]);
      let match;
      while ((match = callRegex.exec(trimmed)) !== null) {
        const callee = match[1];
        if (keywords.has(callee.toLowerCase())) continue;
        if (currentCallableEntity && currentCallableEntity.name.endsWith(callee)) continue;
        relationships.push({
          source_id: (currentCallableEntity || fileEntity).id,
          target_ref: callee,
          type: "CALLS",
          status: EVIDENCE_STATUS.INFERRED,
          evidence: `${normPath}:${lineNum} ${trimmed.slice(0, 100)}`,
          line: lineNum,
        });
      }
    }
  }

  return {
    fileEntity,
    entities,
    relationships,
    language,
    isTest,
    hasDynamicDependency,
  };
}
