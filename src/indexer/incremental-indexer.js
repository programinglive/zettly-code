/**
 * Revision-aware, incremental repository indexer for Zettly Code.
 *
 * Supports modes:
 *   - initialize : build the SQLite knowledge graph from scratch if missing
 *   - update     : incrementally re-index only added/modified/deleted/renamed files
 *   - status     : inspect graph stats and freshness without mutating the graph
 *   - verify     : run full freshness, integrity, and @zettly-code validation checks
 *   - rebuild    : wipe and deterministically rebuild the entire graph
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  IGNORED_DIRECTORIES,
  isSecretFilePath,
  normalizeRelPath,
  resolveContainedPath,
} from "../security/guards.js";
import {
  computeFileHash,
  detectLanguage,
  isTestFilePath,
  parseSourceFile,
} from "../parsers/source-parser.js";
import {
  loadSidecarKnowledgeRecords,
  parseKnowledgeComments,
  validateKnowledgeAnnotations,
} from "../comments/knowledge-comments.js";
import { CodeKnowledgeGraphStore } from "../storage/sqlite-store.js";

const INDEXABLE_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".php",
  ".sql",
  ".json",
  ".yml",
  ".yaml",
]);

const MAX_FILE_SIZE_BYTES = 1024 * 1024; // 1 MB cap to avoid generated bundles

export function getGitContext(repoRoot) {
  const runGit = (args) => {
    try {
      return execFileSync("git", args, {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 4000,
      }).trim();
    } catch {
      return null;
    }
  };

  const head = runGit(["rev-parse", "HEAD"]);
  const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  const dirtyRaw = runGit(["status", "--porcelain"]);
  const isDirty = Boolean(dirtyRaw && dirtyRaw.length > 0);
  return {
    isGitRepo: Boolean(head),
    headRevision: head || null,
    branch: branch || null,
    isDirty,
  };
}

/**
 * Walk indexable source files inside `repoRoot` with strict containment,
 * symlink escape prevention, and secret/ignored directory exclusion.
 */
export function walkRepositoryFiles(repoRoot, options = {}) {
  const maxFiles = Number(options.maxFiles || 5000);
  const realRoot = fs.realpathSync(path.resolve(repoRoot));
  const files = [];
  const skipped = {
    ignoredDirs: 0,
    secretFiles: 0,
    symlinkEscapes: 0,
    tooLarge: 0,
    unsupportedExt: 0,
  };

  const stack = [realRoot];
  while (stack.length > 0 && files.length < maxFiles) {
    const currentDir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const fullPath = path.join(currentDir, entry.name);
      const relPath = normalizeRelPath(path.relative(realRoot, fullPath));

      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) {
          skipped.ignoredDirs += 1;
          continue;
        }
        const contained = resolveContainedPath(realRoot, fullPath);
        if (!contained.ok) {
          skipped.symlinkEscapes += 1;
          continue;
        }
        stack.push(contained.absPath);
        continue;
      }

      if (entry.isSymbolicLink()) {
        const contained = resolveContainedPath(realRoot, fullPath);
        if (!contained.ok) {
          skipped.symlinkEscapes += 1;
          continue;
        }
        let stat;
        try {
          stat = fs.statSync(contained.absPath);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name)) stack.push(contained.absPath);
          continue;
        }
      }

      if (isSecretFilePath(relPath)) {
        skipped.secretFiles += 1;
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      if (!INDEXABLE_EXTENSIONS.has(ext)) {
        skipped.unsupportedExt += 1;
        continue;
      }

      // Skip package-lock / composer.lock / huge minified bundles
      if (
        entry.name === "package-lock.json" ||
        entry.name === "composer.lock" ||
        /\.min\.[jt]s$/i.test(entry.name)
      ) {
        skipped.unsupportedExt += 1;
        continue;
      }

      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.size > MAX_FILE_SIZE_BYTES) {
        skipped.tooLarge += 1;
        continue;
      }

      files.push({
        absPath: fullPath,
        relPath,
        sizeBytes: stat.size,
        mtimeMs: Math.floor(stat.mtimeMs),
        language: detectLanguage(relPath),
      });
    }
  }

  return { files, skipped };
}

function extractTestTargets(relPath, parsed, content) {
  if (!isTestFilePath(relPath)) return [];
  const targets = [];
  const seen = new Set();

  for (const rel of parsed.relationships) {
    if (rel.type === "IMPORTS" && rel.target_ref) {
      const base = path.posix.basename(rel.target_ref, path.posix.extname(rel.target_ref));
      if (base && !seen.has(base)) {
        seen.add(base);
        targets.push({
          target_symbol: base,
          evidence: rel.evidence,
          status: "CONFIRMED",
        });
      }
    }
    if (rel.type === "CALLS" && rel.target_ref && !seen.has(rel.target_ref)) {
      seen.add(rel.target_ref);
      targets.push({
        target_symbol: rel.target_ref,
        evidence: rel.evidence,
        status: "INFERRED",
      });
    }
  }

  // Also check explicit @tests or symbol mentions in imports
  const importNames = content.matchAll(/import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']/g);
  for (const m of importNames) {
    for (const part of m[1].split(",")) {
      const sym = part.trim().split(/\s+as\s+/)[0].trim();
      if (sym && !seen.has(sym)) {
        seen.add(sym);
        targets.push({
          target_symbol: sym,
          evidence: `${relPath} imports ${sym} from ${m[2]}`,
          status: "CONFIRMED",
        });
      }
    }
  }

  return targets;
}

/**
 * Inspect whether the stored knowledge graph is fresh compared to current disk state.
 */
export function inspectFreshness(repoRoot, store, options = {}) {
  const git = getGitContext(repoRoot);
  const repoRow = store.getRepository();
  const indexedMap = store.getIndexedFilesMap();
  const { files: diskFiles, skipped } = walkRepositoryFiles(repoRoot, options);

  const diskMap = new Map();
  for (const f of diskFiles) diskMap.set(f.relPath, f);

  const addedFiles = [];
  const modifiedFiles = [];
  const deletedFiles = [];

  for (const f of diskFiles) {
    const prev = indexedMap.get(f.relPath);
    if (!prev) {
      addedFiles.push(f);
      continue;
    }
    if (prev.size_bytes !== f.sizeBytes || prev.mtime_ms !== f.mtimeMs) {
      const content = fs.readFileSync(f.absPath, "utf8");
      const hash = computeFileHash(content);
      if (hash !== prev.content_hash) {
        modifiedFiles.push({ ...f, content, contentHash: hash });
      }
    }
  }

  for (const prevPath of indexedMap.keys()) {
    if (!diskMap.has(prevPath)) {
      deletedFiles.push(prevPath);
    }
  }

  const revisionDrifted =
    Boolean(git.headRevision) &&
    Boolean(repoRow?.last_revision) &&
    git.headRevision !== repoRow.last_revision;

  const isInitialized = Boolean(repoRow && indexedMap.size > 0);
  const isStale =
    !isInitialized ||
    addedFiles.length > 0 ||
    modifiedFiles.length > 0 ||
    deletedFiles.length > 0 ||
    revisionDrifted;

  return {
    isInitialized,
    isStale,
    freshnessStatus: !isInitialized ? "UNINITIALIZED" : isStale ? "STALE" : "FRESH",
    revisionDrifted,
    currentRevision: git.headRevision,
    indexedRevision: repoRow?.last_revision || null,
    branch: git.branch,
    isDirty: git.isDirty,
    diskFilesCount: diskFiles.length,
    indexedFilesCount: indexedMap.size,
    addedFiles,
    modifiedFiles,
    deletedFiles,
    skipped,
  };
}

function collectGraphValidation(store, syntaxErrors = []) {
  const db = store.open();
  const entities = db.prepare("SELECT name, kind, file_path, is_test FROM code_entities WHERE repo_id = ?").all(store.repoId);
  const files = db.prepare("SELECT file_path FROM source_files WHERE repo_id = ?").all(store.repoId);
  const annRows = db.prepare("SELECT * FROM knowledge_annotations WHERE repo_id = ?").all(store.repoId);

  const knownSymbols = new Set();
  const knownTestSymbols = new Set();
  const knownFiles = new Set(files.map((f) => f.file_path));

  for (const e of entities) {
    knownSymbols.add(e.name);
    if (e.name.includes(".")) {
      knownSymbols.add(e.name.split(".").pop());
    }
    if (e.is_test || e.kind === "test") {
      knownTestSymbols.add(e.name);
      knownTestSymbols.add(e.file_path);
    }
  }

  const annotations = annRows.map((row) => ({
    id: row.knowledge_id,
    file_path: row.file_path,
    start_line: row.start_line,
    end_line: row.end_line,
    attached_symbol: row.attached_symbol,
    source_kind: row.source_kind,
    purpose: row.purpose,
    domain: row.domain,
    invariants: JSON.parse(row.invariants_json || "[]"),
    bugFixes: JSON.parse(row.bug_fixes_json || "[]"),
    rootCause: row.root_cause,
    rootCauseStatus: row.root_cause_status,
    hypothesis: row.hypothesis,
    fix: row.fix_summary,
    related: JSON.parse(row.related_json || "[]"),
    tests: JSON.parse(row.tests_json || "[]"),
    commit: row.commit_ref,
  }));

  return validateKnowledgeAnnotations({
    annotations,
    syntaxErrors,
    knownSymbols,
    knownTestSymbols,
    knownFiles,
  });
}

/**
 * Primary indexing entrypoint (`code_index` backend).
 */
export function indexRepository(repoRoot, options = {}) {
  const startedAt = performance.now();
  const mode = String(options.mode || "status").toLowerCase();
  const validModes = new Set(["status", "initialize", "update", "verify", "rebuild"]);
  if (!validModes.has(mode)) {
    throw new Error(`Invalid code_index mode '${mode}'. Expected: status | initialize | update | verify | rebuild.`);
  }

  const resolvedRoot = fs.realpathSync(path.resolve(repoRoot));
  const store = new CodeKnowledgeGraphStore(resolvedRoot, {
    repoId: options.repoId,
    dbPath: options.dbPath,
  });

  try {
    store.open();
    const git = getGitContext(resolvedRoot);

    if (mode === "status") {
      const freshness = inspectFreshness(resolvedRoot, store, options);
      const stats = store.getStats();
      return {
        ok: true,
        mode,
        freshnessStatus: freshness.freshnessStatus,
        isStale: freshness.isStale,
        currentRevision: freshness.currentRevision,
        indexedRevision: freshness.indexedRevision,
        pendingChanges: {
          added: freshness.addedFiles.length,
          modified: freshness.modifiedFiles.length,
          deleted: freshness.deletedFiles.length,
        },
        skipped: freshness.skipped,
        stats,
        durationMs: Number((performance.now() - startedAt).toFixed(2)),
      };
    }

    if (mode === "verify") {
      const freshness = inspectFreshness(resolvedRoot, store, options);
      const validation = collectGraphValidation(store);
      const stats = store.getStats();
      return {
        ok: freshness.freshnessStatus === "FRESH" && validation.valid,
        mode,
        freshnessStatus: freshness.freshnessStatus,
        isStale: freshness.isStale,
        pendingChanges: {
          added: freshness.addedFiles.map((f) => f.relPath),
          modified: freshness.modifiedFiles.map((f) => f.relPath),
          deleted: freshness.deletedFiles,
        },
        knowledgeValidation: validation,
        stats,
        durationMs: Number((performance.now() - startedAt).toFixed(2)),
      };
    }

    if (mode === "rebuild") {
      const db = store.open();
      db.exec(`
        DELETE FROM source_files WHERE repo_id = '${store.repoId}';
        DELETE FROM code_entities WHERE repo_id = '${store.repoId}';
        DELETE FROM code_relationships WHERE repo_id = '${store.repoId}';
        DELETE FROM knowledge_annotations WHERE repo_id = '${store.repoId}';
        DELETE FROM test_relationships WHERE repo_id = '${store.repoId}';
      `);
    }

    const freshness = inspectFreshness(resolvedRoot, store, options);
    const shouldFullIndex = mode === "rebuild" || (mode === "initialize" && !freshness.isInitialized);

    let filesToIndex = [];
    let filesToDelete = [];

    if (shouldFullIndex) {
      const { files } = walkRepositoryFiles(resolvedRoot, options);
      filesToIndex = files;
      filesToDelete = freshness.deletedFiles;
    } else if (mode === "initialize" && freshness.isInitialized) {
      // Already initialized — treat as incremental update so initialize is idempotent
      filesToIndex = [...freshness.addedFiles, ...freshness.modifiedFiles];
      filesToDelete = freshness.deletedFiles;
    } else {
      // mode === "update"
      filesToIndex = [...freshness.addedFiles, ...freshness.modifiedFiles];
      filesToDelete = freshness.deletedFiles;
    }

    const allSyntaxErrors = [];
    const db = store.open();
    const tx = db.transaction(() => {
      store.upsertRepository({
        name: path.basename(resolvedRoot),
        revision: git.headRevision,
        branch: git.branch,
      });

      for (const delPath of filesToDelete) {
        store.deleteFileData(delPath);
      }

      for (const fileInfo of filesToIndex) {
        const content =
          typeof fileInfo.content === "string"
            ? fileInfo.content
            : fs.readFileSync(fileInfo.absPath, "utf8");
        const contentHash = fileInfo.contentHash || computeFileHash(content);
        const parsed = parseSourceFile({
          repoId: store.repoId,
          relPath: fileInfo.relPath,
          content,
        });
        const commentParse = parseKnowledgeComments({
          relPath: fileInfo.relPath,
          content,
        });
        allSyntaxErrors.push(...commentParse.syntaxErrors);

        const testTargets = extractTestTargets(fileInfo.relPath, parsed, content);

        store.upsertFileGraph({
          fileRecord: {
            file_path: fileInfo.relPath,
            language: parsed.language,
            content_hash: contentHash,
            size_bytes: fileInfo.sizeBytes,
            mtime_ms: fileInfo.mtimeMs,
            is_test: parsed.isTest,
            has_dynamic_dependency: parsed.hasDynamicDependency,
          },
          entities: parsed.entities,
          relationships: parsed.relationships,
          annotations: commentParse.annotations,
          testTargets,
          revision: git.headRevision,
        });
      }

      const sidecars = loadSidecarKnowledgeRecords(resolvedRoot);
      store.replaceSidecarAnnotations(sidecars, git.headRevision);
    });

    tx();

    const durationMs = Number((performance.now() - startedAt).toFixed(2));
    store.recordIndexOperation({
      operation: mode,
      revision: git.headRevision,
      filesScanned: freshness.diskFilesCount,
      filesUpdated: filesToIndex.length,
      filesDeleted: filesToDelete.length,
      durationMs,
      status: "OK",
    });

    const validation = collectGraphValidation(store, allSyntaxErrors);
    const stats = store.getStats();

    return {
      ok: true,
      mode,
      incremental: !shouldFullIndex,
      freshnessStatus: "FRESH",
      currentRevision: git.headRevision,
      filesScanned: freshness.diskFilesCount,
      filesUpdated: filesToIndex.length,
      filesDeleted: filesToDelete.length,
      updatedPaths: filesToIndex.map((f) => f.relPath),
      deletedPaths: filesToDelete,
      skipped: freshness.skipped,
      knowledgeValidation: validation,
      stats,
      durationMs,
    };
  } finally {
    store.close();
  }
}
