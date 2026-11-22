/**
 * Debugging Memory & Bounded Knowledge Graph Context Retrieval (`code_context`).
 *
 * Modes:
 *   - debug        : targeted debugging context (symbols, @zettly-code notes, invariants,
 *                    historical bug fixes, direct deps/callers, related tests)
 *   - symbol       : resolve a symbol's definition, annotations, and immediate neighborhood
 *   - dependencies : bounded outbound dependency traversal (IMPORTS / CALLS / EXTENDS)
 *   - callers      : bounded inbound caller / importer traversal
 *   - tests        : discover tests covering a symbol or file
 *   - impact       : bounded blast-radius impact analysis (direct + 2-hop dependents + tests)
 *   - history      : past bug fixes and debugging memory for a symbol/file/query
 *
 * Enforces:
 *   - Freshness check before serving context (with optional auto-update)
 *   - Bounded traversal depth and result size
 *   - Targeted fallback search when graph has dynamic dependencies or zero matches
 *   - Historical bug-fix validity checks (VALID | NEEDS_REVERIFICATION | SUPERSEDED)
 *   - Secret redaction on all returned snippets
 */

import fs from "node:fs";
import path from "node:path";
import { CodeKnowledgeGraphStore } from "../storage/sqlite-store.js";
import { indexRepository, inspectFreshness, walkRepositoryFiles } from "../indexer/incremental-indexer.js";
import { normalizeRelPath, redactSecrets } from "../security/guards.js";

const VALID_MODES = new Set([
  "debug",
  "symbol",
  "dependencies",
  "callers",
  "tests",
  "impact",
  "history",
]);

function tokenizeQuery(query) {
  return Array.from(
    new Set(
      String(query || "")
        .split(/[^A-Za-z0-9_.-]+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 2)
    )
  ).slice(0, 12);
}

function hydrateAnnotation(row) {
  return {
    id: row.knowledge_id,
    file: row.file_path,
    symbol: row.attached_symbol,
    sourceKind: row.source_kind,
    line: row.start_line,
    purpose: redactSecrets(row.purpose || ""),
    domain: row.domain,
    invariants: JSON.parse(row.invariants_json || "[]").map(redactSecrets),
    bugFixes: JSON.parse(row.bug_fixes_json || "[]").map(redactSecrets),
    rootCauseStatus: row.root_cause_status,
    rootCause: row.root_cause ? redactSecrets(row.root_cause) : null,
    hypothesis: row.hypothesis ? redactSecrets(row.hypothesis) : null,
    fix: row.fix_summary ? redactSecrets(row.fix_summary) : null,
    related: JSON.parse(row.related_json || "[]"),
    tests: JSON.parse(row.tests_json || "[]"),
    commit: row.commit_ref,
  };
}

function hydrateBugFix(row, indexedFilesMap, currentRevision) {
  const affected = JSON.parse(row.affected_entities_json || "[]");
  let validityStatus = row.validity_status || "VALID";

  if (affected.length > 0) {
    const anyExisting = affected.some((ref) => {
      const norm = normalizeRelPath(ref);
      return indexedFilesMap.has(norm) || Array.from(indexedFilesMap.keys()).some((k) => k.includes(ref));
    });
    if (!anyExisting) {
      validityStatus = "SUPERSEDED";
    } else if (row.revision && currentRevision && row.revision !== currentRevision) {
      validityStatus = "NEEDS_REVERIFICATION";
    }
  }

  return {
    bugId: row.bug_id,
    revision: row.revision,
    problemDescription: redactSecrets(row.problem_description),
    affectedEntities: affected,
    rootCauseStatus: row.root_cause_status,
    confirmedRootCause: row.confirmed_root_cause ? redactSecrets(row.confirmed_root_cause) : null,
    fixSummary: redactSecrets(row.fix_summary || ""),
    testReferences: JSON.parse(row.test_references_json || "[]"),
    gitCommit: row.git_commit,
    knowledgeIds: JSON.parse(row.knowledge_ids_json || "[]"),
    validityStatus,
    zettlyTodoId: row.zettly_todo_id,
    updatedAt: row.updated_at,
  };
}

function targetedFallbackSearch(repoRoot, tokens, maxFiles = 6) {
  if (!tokens.length) return [];
  const { files } = walkRepositoryFiles(repoRoot, { maxFiles: 1500 });
  const hits = [];
  const lowerTokens = tokens.map((t) => t.toLowerCase());

  for (const f of files) {
    let content;
    try {
      content = fs.readFileSync(f.absPath, "utf8");
    } catch {
      continue;
    }
    const lower = content.toLowerCase();
    let score = 0;
    for (const tok of lowerTokens) {
      if (lower.includes(tok)) score += 1;
    }
    if (score > 0) {
      const lines = content.split(/\r?\n/);
      const matchedLineIdx = lines.findIndex((l) =>
        lowerTokens.some((tok) => l.toLowerCase().includes(tok))
      );
      hits.push({
        file: f.relPath,
        score,
        line: matchedLineIdx >= 0 ? matchedLineIdx + 1 : 1,
        snippet: redactSecrets((lines[matchedLineIdx] || "").trim().slice(0, 160)),
      });
    }
  }

  hits.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return hits.slice(0, maxFiles);
}

/**
 * Primary retrieval entrypoint (`code_context` backend).
 */
export function retrieveCodeContext(repoRoot, options = {}) {
  const startedAt = performance.now();
  const mode = String(options.mode || "debug").toLowerCase();
  if (!VALID_MODES.has(mode)) {
    throw new Error(
      `Invalid code_context mode '${mode}'. Expected: debug | symbol | dependencies | callers | tests | impact | history.`
    );
  }

  const resolvedRoot = fs.realpathSync(path.resolve(repoRoot));
  const query = String(options.query || options.symbol || options.file || "").trim();
  const targetSymbol = options.symbol ? String(options.symbol).trim() : null;
  const targetFile = options.file ? normalizeRelPath(options.file) : null;
  const maxDepth = Math.min(Math.max(Number(options.depth || 2), 1), 3);
  const maxFiles = Math.min(Math.max(Number(options.maxFiles || 12), 1), 30);
  const autoUpdate = options.autoUpdate !== false;

  const store = new CodeKnowledgeGraphStore(resolvedRoot, {
    repoId: options.repoId,
    dbPath: options.dbPath,
  });

  try {
    store.open();
    let freshness = inspectFreshness(resolvedRoot, store);

    if (autoUpdate && (freshness.freshnessStatus === "UNINITIALIZED" || freshness.isStale)) {
      store.close();
      indexRepository(resolvedRoot, {
        mode: freshness.freshnessStatus === "UNINITIALIZED" ? "initialize" : "update",
        repoId: options.repoId,
        dbPath: options.dbPath,
      });
      store.open();
      freshness = inspectFreshness(resolvedRoot, store);
    }

    const db = store.open();
    const indexedFilesMap = store.getIndexedFilesMap();
    const tokens = tokenizeQuery(query);

    // 1. Find seed entities matching symbol, file, or query tokens
    let seedEntities = [];
    if (targetSymbol) {
      seedEntities = db
        .prepare(
          `SELECT * FROM code_entities
           WHERE repo_id = ? AND (name = ? OR name LIKE ? OR signature LIKE ?)
           ORDER BY CASE WHEN name = ? THEN 0 ELSE 1 END, line ASC
           LIMIT 25`
        )
        .all(store.repoId, targetSymbol, `%${targetSymbol}%`, `%${targetSymbol}%`, targetSymbol);
    } else if (targetFile) {
      seedEntities = db
        .prepare(
          `SELECT * FROM code_entities
           WHERE repo_id = ? AND (file_path = ? OR file_path LIKE ?)
           ORDER BY line ASC
           LIMIT 25`
        )
        .all(store.repoId, targetFile, `%${targetFile}%`);
    } else if (tokens.length > 0) {
      const allEntities = db
        .prepare("SELECT * FROM code_entities WHERE repo_id = ?")
        .all(store.repoId);
      const scored = [];
      for (const e of allEntities) {
        const hay = `${e.name} ${e.file_path} ${e.signature || ""}`.toLowerCase();
        let score = 0;
        for (const tok of tokens) {
          const lt = tok.toLowerCase();
          if (e.name.toLowerCase() === lt) score += 5;
          else if (e.name.toLowerCase().includes(lt)) score += 3;
          else if (hay.includes(lt)) score += 1;
        }
        if (score > 0) scored.push({ entity: e, score });
      }
      scored.sort((a, b) => b.score - a.score || a.entity.file_path.localeCompare(b.entity.file_path));
      seedEntities = scored.slice(0, 20).map((s) => s.entity);
    }

    const seedFiles = new Set(seedEntities.map((e) => e.file_path));
    if (targetFile && indexedFilesMap.has(targetFile)) seedFiles.add(targetFile);

    const seedNames = new Set(
      seedEntities.flatMap((e) => {
        const parts = [e.name];
        if (e.name.includes(".")) parts.push(e.name.split(".").pop());
        return parts;
      })
    );
    if (targetSymbol) seedNames.add(targetSymbol);

    // 2. Bounded relationship traversal (dependencies & callers)
    const dependencies = [];
    const callers = [];
    const visitedRefs = new Set();

    if (seedFiles.size > 0 || seedNames.size > 0) {
      const allRels = db
        .prepare("SELECT * FROM code_relationships WHERE repo_id = ?")
        .all(store.repoId);

      // Outbound dependencies from seed files (up to maxDepth)
      let frontierFiles = new Set(seedFiles);
      for (let hop = 1; hop <= maxDepth; hop++) {
        const nextFrontier = new Set();
        for (const rel of allRels) {
          if (!frontierFiles.has(rel.file_path)) continue;
          if (!["IMPORTS", "CALLS", "EXTENDS", "IMPLEMENTS", "ROUTES_TO", "RELATED_KNOWLEDGE"].includes(rel.type)) {
            continue;
          }
          const key = `dep:${rel.file_path}:${rel.type}:${rel.target_ref}`;
          if (visitedRefs.has(key)) continue;
          visitedRefs.add(key);
          dependencies.push({
            hop,
            fromFile: rel.file_path,
            type: rel.type,
            target: rel.target_ref,
            status: rel.status,
            evidence: redactSecrets(rel.evidence || ""),
            line: rel.line,
          });
          // Resolve target_ref to file for next hop
          const normTarget = normalizeRelPath(rel.target_ref);
          const targetBase = path.posix.basename(normTarget, path.posix.extname(normTarget));
          for (const fPath of indexedFilesMap.keys()) {
            const base = path.posix.basename(fPath, path.posix.extname(fPath));
            if (fPath.endsWith(normTarget) || base === targetBase) {
              nextFrontier.add(fPath);
            }
          }
        }
        frontierFiles = nextFrontier;
        if (dependencies.length >= 40) break;
      }

      // Inbound callers referencing any seed symbol or seed file basename
      const seedBasenames = new Set(
        Array.from(seedFiles).map((f) => path.posix.basename(f, path.posix.extname(f)))
      );
      for (const rel of allRels) {
        if (!["CALLS", "IMPORTS", "EXTENDS", "IMPLEMENTS", "ROUTES_TO"].includes(rel.type)) continue;
        const targetBase = path.posix.basename(rel.target_ref, path.posix.extname(rel.target_ref));
        const matchesSymbol = seedNames.has(rel.target_ref) || seedBasenames.has(targetBase);
        if (!matchesSymbol || seedFiles.has(rel.file_path)) continue;
        const key = `caller:${rel.file_path}:${rel.type}:${rel.target_ref}`;
        if (visitedRefs.has(key)) continue;
        visitedRefs.add(key);
        callers.push({
          callerFile: rel.file_path,
          type: rel.type,
          target: rel.target_ref,
          status: rel.status,
          evidence: redactSecrets(rel.evidence || ""),
          line: rel.line,
        });
        if (callers.length >= 40) break;
      }
    }

    // 3. Knowledge annotations matching seed files, symbols, or query tokens
    const allAnnotations = db
      .prepare("SELECT * FROM knowledge_annotations WHERE repo_id = ?")
      .all(store.repoId);
    const matchedAnnotations = allAnnotations
      .filter((row) => {
        if (seedFiles.has(row.file_path)) return true;
        if (row.attached_symbol && seedNames.has(row.attached_symbol)) return true;
        const hay = `${row.knowledge_id} ${row.purpose} ${row.root_cause || ""} ${row.fix_summary || ""} ${row.bug_fixes_json}`.toLowerCase();
        return tokens.some((tok) => hay.includes(tok.toLowerCase()));
      })
      .slice(0, 15)
      .map(hydrateAnnotation);

    // 4. Related tests (from test_relationships + @tests annotations)
    const testFilesSet = new Set();
    const relatedTests = [];
    for (const ann of matchedAnnotations) {
      for (const t of ann.tests) {
        if (!testFilesSet.has(t)) {
          testFilesSet.add(t);
          relatedTests.push({ test: t, source: `annotation:${ann.id}`, status: "CONFIRMED" });
        }
      }
    }
    const allTestRels = db
      .prepare("SELECT * FROM test_relationships WHERE repo_id = ?")
      .all(store.repoId);
    const targetBasenames = new Set(
      Array.from(seedFiles).map((f) => path.posix.basename(f, path.posix.extname(f)))
    );
    for (const tr of allTestRels) {
      if (seedNames.has(tr.target_symbol) || targetBasenames.has(tr.target_symbol)) {
        if (!testFilesSet.has(tr.test_file)) {
          testFilesSet.add(tr.test_file);
          relatedTests.push({
            test: tr.test_file,
            targetSymbol: tr.target_symbol,
            source: "graph:test_relationships",
            status: tr.status,
            evidence: redactSecrets(tr.evidence || ""),
          });
        }
      }
    }

    // 5. Historical bug fixes
    const allBugFixes = db
      .prepare("SELECT * FROM bug_fix_records WHERE repo_id = ? ORDER BY updated_at DESC")
      .all(store.repoId);
    const matchedBugFixes = allBugFixes
      .filter((row) => {
        const hay = `${row.bug_id} ${row.problem_description} ${row.affected_entities_json} ${row.confirmed_root_cause || ""} ${row.fix_summary || ""}`.toLowerCase();
        if (Array.from(seedFiles).some((f) => hay.includes(f.toLowerCase()))) return true;
        if (Array.from(seedNames).some((n) => hay.includes(n.toLowerCase()))) return true;
        return tokens.some((tok) => hay.includes(tok.toLowerCase()));
      })
      .slice(0, 10)
      .map((row) => hydrateBugFix(row, indexedFilesMap, freshness.currentRevision));

    // 6. Dynamic dependency detection & targeted fallback search
    const hasDynamicDependencies = Array.from(seedFiles).some(
      (f) => Boolean(indexedFilesMap.get(f)?.has_dynamic_dependency)
    );
    let fallbackMatches = [];
    let usedFallbackSearch = false;
    if (
      (seedEntities.length === 0 && matchedAnnotations.length === 0 && tokens.length > 0) ||
      hasDynamicDependencies
    ) {
      usedFallbackSearch = true;
      fallbackMatches = targetedFallbackSearch(resolvedRoot, tokens, 6);
    }

    // Bounded candidate file list
    const candidateFiles = Array.from(
      new Set([
        ...Array.from(seedFiles),
        ...matchedAnnotations.map((a) => a.file),
        ...callers.map((c) => c.callerFile),
        ...fallbackMatches.map((m) => m.file),
      ])
    ).slice(0, maxFiles);

    const durationMs = Number((performance.now() - startedAt).toFixed(2));
    store.recordDebugQuery({
      query: query || mode,
      matchedSymbols: Array.from(seedNames).slice(0, 15),
      matchedKnowledgeIds: matchedAnnotations.map((a) => a.id),
      filesReturned: candidateFiles.length,
      usedFallback: usedFallbackSearch,
      durationMs,
    });

    const baseResult = {
      ok: true,
      mode,
      query,
      freshnessStatus: freshness.freshnessStatus,
      indexedRevision: freshness.indexedRevision,
      currentRevision: freshness.currentRevision,
      hasDynamicDependencies,
      usedFallbackSearch,
      fallbackReason: usedFallbackSearch
        ? hasDynamicDependencies
          ? "DYNAMIC_DEPENDENCY_DETECTED"
          : "NO_DIRECT_GRAPH_MATCH"
        : null,
      filesReturned: candidateFiles.length,
      candidateFiles,
      durationMs,
    };

    if (mode === "symbol") {
      return {
        ...baseResult,
        symbols: seedEntities.slice(0, 15),
        knowledgeAnnotations: matchedAnnotations,
        fallbackMatches,
      };
    }
    if (mode === "dependencies") {
      return {
        ...baseResult,
        dependencies,
        fallbackMatches,
      };
    }
    if (mode === "callers") {
      return {
        ...baseResult,
        callers,
        fallbackMatches,
      };
    }
    if (mode === "tests") {
      return {
        ...baseResult,
        relatedTests,
        knowledgeAnnotations: matchedAnnotations,
      };
    }
    if (mode === "impact") {
      const impactedFiles = Array.from(
        new Set([...Array.from(seedFiles), ...callers.map((c) => c.callerFile)])
      ).slice(0, maxFiles);
      return {
        ...baseResult,
        impactedFiles,
        callers,
        dependencies,
        relatedTests,
        knowledgeAnnotations: matchedAnnotations,
      };
    }
    if (mode === "history") {
      return {
        ...baseResult,
        bugFixes: matchedBugFixes,
        knowledgeAnnotations: matchedAnnotations,
      };
    }

    // Default mode === "debug"
    return {
      ...baseResult,
      symbols: seedEntities.slice(0, 15),
      knowledgeAnnotations: matchedAnnotations,
      bugFixes: matchedBugFixes,
      dependencies: dependencies.slice(0, 15),
      callers: callers.slice(0, 15),
      relatedTests,
      fallbackMatches,
    };
  } finally {
    store.close();
  }
}
