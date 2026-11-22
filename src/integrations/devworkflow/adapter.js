/**
 * Thin DevWorkflow MCP adapter for Zettly Code.
 *
 * Exposes ONLY:
 *   - handleCodeIndex              (canonical `code_index` tool)
 *   - handleCodeContext            (canonical `code_context` tool)
 *   - evaluateBugFixKnowledgeGate  (integrated into canonical `audit` tool)
 *   - buildZettlySyncReference     (lightweight reference payload for Zettly)
 */

import fs from "node:fs";
import path from "node:path";
import { indexRepository, inspectFreshness } from "../../indexer/incremental-indexer.js";
import { retrieveCodeContext } from "../../debugging/context-retriever.js";
import {
  loadSidecarKnowledgeRecords,
  parseKnowledgeComments,
  validateKnowledgeAnnotations,
} from "../../comments/knowledge-comments.js";
import { CodeKnowledgeGraphStore } from "../../storage/sqlite-store.js";
import { normalizeRelPath, resolveContainedPath } from "../../security/guards.js";
import { detectLanguage, isTestFilePath } from "../../parsers/source-parser.js";

const NON_COMMENTABLE_EXTENSIONS = new Set([".json", ".lock", ".env", ".txt", ".csv", ".svg"]);
const DOC_OR_FORMATTING_ONLY_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".css", ".scss"]);

export function handleCodeIndex(args = {}) {
  const projectDir = args.projectDir || process.cwd();
  return indexRepository(projectDir, {
    mode: args.mode || "status",
    dbPath: args.dbPath || null,
    maxFiles: args.maxFiles || 5000,
  });
}

export function handleCodeContext(args = {}) {
  const projectDir = args.projectDir || process.cwd();
  return retrieveCodeContext(projectDir, {
    mode: args.mode || "debug",
    query: args.query || "",
    symbol: args.symbol || null,
    file: args.file || null,
    depth: args.depth || 2,
    maxFiles: args.maxFiles || 12,
    autoUpdate: args.autoUpdate !== false,
    dbPath: args.dbPath || null,
  });
}

/**
 * Mandatory Bug-Fix Knowledge Quality Gate (`bugfix_knowledge_gate`).
 *
 * Enforces that every verified BUG_FIX task leaves behind:
 *   1. Valid `@zettly-code` inline comments (or sidecar records for generated/non-commentable files)
 *      on the affected production source files with `@purpose`, `@bug-fix`, `@root-cause` or `@hypothesis`, and `@fix`.
 *   2. Zero secret/PII leakage, zero duplicate knowledge IDs, zero syntax errors.
 *   3. Fresh Zettly Code knowledge graph updated after the fix.
 *   4. Optional persistence of the structured `bug_fix_records` entry and compact Zettly sync reference.
 */
export function evaluateBugFixKnowledgeGate({
  projectDir,
  changedFiles = [],
  taskType = "BUG_FIX",
  bugId = null,
  problemDescription = "",
  confirmedRootCause = null,
  fixSummary = "",
  testReferences = [],
  gitCommit = null,
  verificationEvidence = null,
  zettlyTodoId = null,
  requireFreshGraph = true,
  dbPath = null,
}) {
  const resolvedRoot = fs.realpathSync(path.resolve(projectDir));
  const normalizedType = String(taskType || "BUG_FIX").toUpperCase();
  const isBugFixTask =
    normalizedType === "BUG_FIX" ||
    normalizedType === "BUGFIX" ||
    normalizedType === "HOTFIX" ||
    normalizedType === "FIX";

  const normFiles = Array.from(
    new Set((changedFiles || []).map(normalizeRelPath).filter(Boolean))
  );

  // Separate production source files from tests and docs-only files
  const prodSourceFiles = normFiles.filter((f) => {
    if (isTestFilePath(f)) return false;
    const ext = path.extname(f).toLowerCase();
    if (DOC_OR_FORMATTING_ONLY_EXTENSIONS.has(ext)) return false;
    return true;
  });

  if (!isBugFixTask) {
    return {
      ok: true,
      gate: "bugfix_knowledge_gate",
      status: "NOT_APPLICABLE",
      reason: `Task type '${taskType}' is not a bug-fix workflow; mandatory bug-fix knowledge comment gate skipped.`,
      checkedFiles: prodSourceFiles,
      findings: [],
    };
  }

  if (prodSourceFiles.length === 0) {
    return {
      ok: true,
      gate: "bugfix_knowledge_gate",
      status: "SKIPPED_NO_PRODUCTION_SOURCE_CHANGES",
      reason: "Changed files contain only tests or documentation; no production source code modified.",
      checkedFiles: [],
      findings: [],
    };
  }

  const findings = [];
  const sidecars = loadSidecarKnowledgeRecords(resolvedRoot);
  const sidecarsByFile = new Map();
  for (const s of sidecars) {
    const list = sidecarsByFile.get(s.file_path) || [];
    list.push(s);
    sidecarsByFile.set(s.file_path, list);
  }

  const allAnnotations = [];
  const allSyntaxErrors = [];
  const coveredFiles = [];
  const uncoveredFiles = [];

  for (const relPath of prodSourceFiles) {
    const contained = resolveContainedPath(resolvedRoot, relPath);
    if (!contained.ok) {
      findings.push({
        code: contained.code,
        severity: "error",
        file: relPath,
        message: contained.reason,
      });
      continue;
    }

    if (!fs.existsSync(contained.absPath)) continue;

    const ext = path.extname(relPath).toLowerCase();
    const fileSidecars = sidecarsByFile.get(relPath) || [];
    let fileAnnotations = [...fileSidecars];

    if (!NON_COMMENTABLE_EXTENSIONS.has(ext)) {
      const content = fs.readFileSync(contained.absPath, "utf8");
      const parsed = parseKnowledgeComments({ relPath, content });
      allSyntaxErrors.push(...parsed.syntaxErrors);
      fileAnnotations = [...fileAnnotations, ...parsed.annotations];
    }

    allAnnotations.push(...fileAnnotations);

    const hasBugFixAnnotation = fileAnnotations.some(
      (a) =>
        a.id &&
        a.purpose &&
        a.bugFixes &&
        a.bugFixes.length > 0 &&
        (a.rootCause || a.hypothesis) &&
        a.fix
    );

    if (hasBugFixAnnotation) {
      coveredFiles.push(relPath);
    } else {
      uncoveredFiles.push(relPath);
      findings.push({
        code: "MISSING_BUGFIX_KNOWLEDGE_COMMENT",
        severity: "error",
        file: relPath,
        message: NON_COMMENTABLE_EXTENSIONS.has(ext)
          ? `Modified non-commentable file '${relPath}' lacks a sidecar @zettly-code bug-fix knowledge record in engineering/zettly-code-sidecars/*.json.`
          : `Modified source file '${relPath}' lacks a valid @zettly-code bug-fix comment with @purpose, @bug-fix, @root-cause/@hypothesis, and @fix.`,
      });
    }
  }

  // Validate annotations against graph if store exists
  const store = new CodeKnowledgeGraphStore(resolvedRoot, { dbPath });
  let freshnessStatus = "UNINITIALIZED";
  let knowledgeValidation = null;

  try {
    store.open();
    const freshness = inspectFreshness(resolvedRoot, store);
    freshnessStatus = freshness.freshnessStatus;

    const db = store.open();
    const entities = db.prepare("SELECT name, kind, file_path, is_test FROM code_entities WHERE repo_id = ?").all(store.repoId);
    const files = db.prepare("SELECT file_path FROM source_files WHERE repo_id = ?").all(store.repoId);

    const knownSymbols = new Set(entities.map((e) => e.name));
    const knownTestSymbols = new Set(
      entities.filter((e) => e.is_test || e.kind === "test").map((e) => e.name)
    );
    const knownFiles = new Set(files.map((f) => f.file_path));

    knowledgeValidation = validateKnowledgeAnnotations({
      annotations: allAnnotations,
      syntaxErrors: allSyntaxErrors,
      knownSymbols,
      knownTestSymbols,
      knownFiles,
    });

    for (const err of knowledgeValidation.errors) {
      findings.push({ ...err, severity: "error" });
    }
    for (const warn of knowledgeValidation.warnings) {
      findings.push({ ...warn, severity: "warning" });
    }

    if (requireFreshGraph && freshnessStatus !== "FRESH") {
      findings.push({
        code: "STALE_CODE_KNOWLEDGE_GRAPH",
        severity: "error",
        file: ".zettly-code/knowledge-graph.db",
        message: `Zettly Code knowledge graph is ${freshnessStatus}. Run code_index(mode="update") after editing source files.`,
      });
    }

    const errors = findings.filter((f) => f.severity === "error");
    const passed = errors.length === 0;

    // Persist bug-fix record into SQLite when gate passes and bugId is known
    const knowledgeIds = Array.from(new Set(allAnnotations.map((a) => a.id).filter(Boolean)));
    const effectiveBugId =
      bugId ||
      allAnnotations.flatMap((a) => a.bugFixes || [])[0] ||
      null;

    if (passed && effectiveBugId) {
      store.recordBugFix({
        bugId: effectiveBugId,
        revision: freshness.currentRevision,
        problemDescription: problemDescription || allAnnotations[0]?.purpose || "",
        affectedEntities: coveredFiles,
        rootCauseStatus: confirmedRootCause || allAnnotations.some((a) => a.rootCause) ? "CONFIRMED" : "HYPOTHESIS_ONLY",
        confirmedRootCause: confirmedRootCause || allAnnotations.find((a) => a.rootCause)?.rootCause || null,
        fixSummary: fixSummary || allAnnotations.find((a) => a.fix)?.fix || "",
        testReferences:
          testReferences.length > 0
            ? testReferences
            : Array.from(new Set(allAnnotations.flatMap((a) => a.tests || []))),
        gitCommit: gitCommit || allAnnotations.find((a) => a.commit)?.commit || freshness.currentRevision,
        knowledgeIds,
        verificationEvidence,
        validityStatus: "VALID",
        zettlyTodoId,
      });
    }

    return {
      ok: passed,
      gate: "bugfix_knowledge_gate",
      status: passed ? "PASSED" : "BLOCKED",
      freshnessStatus,
      checkedFiles: prodSourceFiles,
      coveredFiles,
      uncoveredFiles,
      knowledgeIds,
      errorsCount: errors.length,
      warningsCount: findings.filter((f) => f.severity === "warning").length,
      findings,
      zettlySyncReference: buildZettlySyncReference({
        bugId: effectiveBugId,
        knowledgeIds,
        affectedFiles: coveredFiles,
        tests: Array.from(new Set([...(testReferences || []), ...allAnnotations.flatMap((a) => a.tests || [])])),
        commit: gitCommit || freshness.currentRevision,
        zettlyTodoId,
      }),
    };
  } finally {
    store.close();
  }
}

/**
 * Compact reference payload for Zettly task/outcome sync.
 * Explicitly avoids duplicating the full SQLite code graph into Zettly.
 */
export function buildZettlySyncReference({
  bugId = null,
  knowledgeIds = [],
  affectedFiles = [],
  tests = [],
  commit = null,
  zettlyTodoId = null,
}) {
  return {
    schema: "zettly-code-reference/v1",
    bugId,
    zettlyTodoId,
    knowledgeIds: Array.from(new Set(knowledgeIds)).slice(0, 20),
    affectedFiles: Array.from(new Set(affectedFiles)).slice(0, 20),
    tests: Array.from(new Set(tests)).slice(0, 20),
    commit,
  };
}
