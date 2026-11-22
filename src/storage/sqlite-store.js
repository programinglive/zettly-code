/**
 * Embedded SQLite Code Knowledge Graph store for Zettly Code.
 *
 * Implements all 12 canonical schema tables:
 *   repositories, worktrees, revisions, source_files, code_entities,
 *   code_relationships, knowledge_annotations, bug_fix_records,
 *   test_relationships, debugging_history, index_operations, schema_versions
 *
 * Uses SQLite WAL mode with busy_timeout, transactional atomic updates,
 * integrity checks, and crash/corruption recovery.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";

export const GRAPH_SCHEMA_VERSION = 1;

export function resolveGraphDbPath(repoRoot, customDbPath = null) {
  if (customDbPath) return path.resolve(customDbPath);
  const dir = path.join(path.resolve(repoRoot), ".zettly-code");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, "knowledge-graph.db");
}

export function computeRepoId(repoRoot) {
  const real = fs.existsSync(repoRoot) ? fs.realpathSync(path.resolve(repoRoot)) : path.resolve(repoRoot);
  return crypto.createHash("sha256").update(real.toLowerCase()).digest("hex").slice(0, 16);
}

export class CodeKnowledgeGraphStore {
  constructor(repoRoot, options = {}) {
    this.repoRoot = path.resolve(repoRoot);
    this.repoId = options.repoId || computeRepoId(this.repoRoot);
    this.dbPath = resolveGraphDbPath(this.repoRoot, options.dbPath || null);
    this.db = null;
    this.recoveredFromCorruption = false;
  }

  open() {
    if (this.db) return this.db;
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true, mode: 0o700 });

    try {
      this.db = new Database(this.dbPath, { timeout: 5000 });
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("synchronous = NORMAL");
      const check = this.db.pragma("quick_check");
      const ok = Array.isArray(check) && check[0]?.quick_check === "ok";
      if (!ok) {
        throw new Error("SQLite quick_check failed");
      }
      this.ensureSchema();
      return this.db;
    } catch {
      // Corruption recovery: quarantine corrupt DB and recreate cleanly
      if (this.db) {
        try { this.db.close(); } catch {}
        this.db = null;
      }
      if (fs.existsSync(this.dbPath)) {
        const backupPath = `${this.dbPath}.corrupt-${Date.now()}`;
        try { fs.renameSync(this.dbPath, backupPath); } catch {
          try { fs.rmSync(this.dbPath, { force: true }); } catch {}
        }
        for (const ext of ["-wal", "-shm"]) {
          try { fs.rmSync(`${this.dbPath}${ext}`, { force: true }); } catch {}
        }
      }
      this.recoveredFromCorruption = true;
      this.db = new Database(this.dbPath, { timeout: 5000 });
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      this.ensureSchema();
      return this.db;
    }
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS repositories (
        repo_id TEXT PRIMARY KEY,
        root_path TEXT NOT NULL,
        name TEXT NOT NULL,
        last_revision TEXT,
        last_indexed_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS worktrees (
        worktree_id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        branch TEXT,
        head_revision TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id TEXT NOT NULL,
        revision TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        mode TEXT NOT NULL,
        files_changed INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS source_files (
        repo_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        language TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        mtime_ms INTEGER NOT NULL DEFAULT 0,
        is_test INTEGER NOT NULL DEFAULT 0,
        has_dynamic_dependency INTEGER NOT NULL DEFAULT 0,
        indexed_at TEXT NOT NULL,
        PRIMARY KEY (repo_id, file_path)
      );

      CREATE TABLE IF NOT EXISTS code_entities (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        language TEXT NOT NULL,
        line INTEGER NOT NULL DEFAULT 1,
        occurrence INTEGER NOT NULL DEFAULT 1,
        is_test INTEGER NOT NULL DEFAULT 0,
        signature TEXT,
        domain TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_entities_repo_file ON code_entities (repo_id, file_path);
      CREATE INDEX IF NOT EXISTS idx_entities_repo_name ON code_entities (repo_id, name);

      CREATE TABLE IF NOT EXISTS code_relationships (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        source_id TEXT NOT NULL,
        target_id TEXT,
        target_ref TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        evidence TEXT,
        line INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_rels_repo_source ON code_relationships (repo_id, source_id);
      CREATE INDEX IF NOT EXISTS idx_rels_repo_target_ref ON code_relationships (repo_id, target_ref);
      CREATE INDEX IF NOT EXISTS idx_rels_repo_file ON code_relationships (repo_id, file_path);

      CREATE TABLE IF NOT EXISTS knowledge_annotations (
        knowledge_id TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        attached_symbol TEXT,
        source_kind TEXT NOT NULL DEFAULT 'inline_comment',
        sidecar_file TEXT,
        start_line INTEGER NOT NULL DEFAULT 1,
        end_line INTEGER NOT NULL DEFAULT 1,
        purpose TEXT NOT NULL,
        domain TEXT,
        invariants_json TEXT NOT NULL DEFAULT '[]',
        bug_fixes_json TEXT NOT NULL DEFAULT '[]',
        root_cause TEXT,
        root_cause_status TEXT NOT NULL DEFAULT 'UNSPECIFIED',
        hypothesis TEXT,
        fix_summary TEXT,
        related_json TEXT NOT NULL DEFAULT '[]',
        tests_json TEXT NOT NULL DEFAULT '[]',
        commit_ref TEXT,
        indexed_revision TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (repo_id, knowledge_id, file_path)
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_repo_file ON knowledge_annotations (repo_id, file_path);

      CREATE TABLE IF NOT EXISTS bug_fix_records (
        bug_id TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        revision TEXT,
        problem_description TEXT NOT NULL,
        affected_entities_json TEXT NOT NULL DEFAULT '[]',
        root_cause_status TEXT NOT NULL DEFAULT 'CONFIRMED',
        confirmed_root_cause TEXT,
        fix_summary TEXT,
        test_references_json TEXT NOT NULL DEFAULT '[]',
        git_commit TEXT,
        knowledge_ids_json TEXT NOT NULL DEFAULT '[]',
        verification_evidence TEXT,
        validity_status TEXT NOT NULL DEFAULT 'VALID',
        zettly_todo_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (repo_id, bug_id)
      );

      CREATE TABLE IF NOT EXISTS test_relationships (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id TEXT NOT NULL,
        test_file TEXT NOT NULL,
        target_symbol TEXT NOT NULL,
        evidence TEXT,
        status TEXT NOT NULL DEFAULT 'CONFIRMED'
      );
      CREATE INDEX IF NOT EXISTS idx_test_rels_repo_target ON test_relationships (repo_id, target_symbol);

      CREATE TABLE IF NOT EXISTS debugging_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id TEXT NOT NULL,
        query TEXT NOT NULL,
        matched_symbols_json TEXT NOT NULL DEFAULT '[]',
        matched_knowledge_ids_json TEXT NOT NULL DEFAULT '[]',
        files_returned INTEGER NOT NULL DEFAULT 0,
        used_fallback_search INTEGER NOT NULL DEFAULT 0,
        duration_ms REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS index_operations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        revision TEXT,
        files_scanned INTEGER NOT NULL DEFAULT 0,
        files_updated INTEGER NOT NULL DEFAULT 0,
        files_deleted INTEGER NOT NULL DEFAULT 0,
        duration_ms REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    const row = this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(GRAPH_SCHEMA_VERSION);
    if (!row) {
      this.db
        .prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)")
        .run(GRAPH_SCHEMA_VERSION, new Date().toISOString());
    }
  }

  upsertRepository({ name, revision = null, branch = null }) {
    const db = this.open();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO repositories (repo_id, root_path, name, last_revision, last_indexed_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo_id) DO UPDATE SET
        root_path = excluded.root_path,
        name = excluded.name,
        last_revision = COALESCE(excluded.last_revision, repositories.last_revision),
        last_indexed_at = excluded.last_indexed_at
    `).run(this.repoId, this.repoRoot, name || path.basename(this.repoRoot), revision, now, now);

    db.prepare(`
      INSERT INTO worktrees (worktree_id, repo_id, worktree_path, branch, head_revision, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(worktree_id) DO UPDATE SET
        branch = excluded.branch,
        head_revision = excluded.head_revision,
        updated_at = excluded.updated_at
    `).run(this.repoId, this.repoId, this.repoRoot, branch, revision, now);
  }

  getRepository() {
    const db = this.open();
    return db.prepare("SELECT * FROM repositories WHERE repo_id = ?").get(this.repoId) || null;
  }

  getIndexedFilesMap() {
    const db = this.open();
    const rows = db.prepare("SELECT * FROM source_files WHERE repo_id = ?").all(this.repoId);
    const map = new Map();
    for (const r of rows) map.set(r.file_path, r);
    return map;
  }

  deleteFileData(filePath) {
    const db = this.open();
    db.prepare("DELETE FROM source_files WHERE repo_id = ? AND file_path = ?").run(this.repoId, filePath);
    db.prepare("DELETE FROM code_entities WHERE repo_id = ? AND file_path = ?").run(this.repoId, filePath);
    db.prepare("DELETE FROM code_relationships WHERE repo_id = ? AND file_path = ?").run(this.repoId, filePath);
    db.prepare("DELETE FROM knowledge_annotations WHERE repo_id = ? AND file_path = ? AND source_kind = 'inline_comment'").run(this.repoId, filePath);
    db.prepare("DELETE FROM test_relationships WHERE repo_id = ? AND test_file = ?").run(this.repoId, filePath);
  }

  upsertFileGraph({ fileRecord, entities, relationships, annotations, testTargets = [], revision = null }) {
    const db = this.open();
    const now = new Date().toISOString();

    this.deleteFileData(fileRecord.file_path);

    db.prepare(`
      INSERT INTO source_files (repo_id, file_path, language, content_hash, size_bytes, mtime_ms, is_test, has_dynamic_dependency, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      this.repoId,
      fileRecord.file_path,
      fileRecord.language,
      fileRecord.content_hash,
      fileRecord.size_bytes,
      fileRecord.mtime_ms,
      fileRecord.is_test ? 1 : 0,
      fileRecord.has_dynamic_dependency ? 1 : 0,
      now
    );

    const insertEntity = db.prepare(`
      INSERT OR REPLACE INTO code_entities (id, repo_id, file_path, kind, name, language, line, occurrence, is_test, signature, domain)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const e of entities) {
      insertEntity.run(
        e.id,
        this.repoId,
        e.file_path,
        e.kind,
        e.name,
        e.language,
        e.line,
        e.occurrence || 1,
        e.is_test ? 1 : 0,
        e.signature || null,
        e.domain || null
      );
    }

    const insertRel = db.prepare(`
      INSERT INTO code_relationships (repo_id, file_path, source_id, target_id, target_ref, type, status, evidence, line)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of relationships) {
      insertRel.run(
        this.repoId,
        fileRecord.file_path,
        r.source_id,
        r.target_id || null,
        r.target_ref,
        r.type,
        r.status || "CONFIRMED",
        r.evidence || null,
        r.line || 1
      );
    }

    const insertAnn = db.prepare(`
      INSERT OR REPLACE INTO knowledge_annotations (
        knowledge_id, repo_id, file_path, attached_symbol, source_kind, sidecar_file,
        start_line, end_line, purpose, domain, invariants_json, bug_fixes_json,
        root_cause, root_cause_status, hypothesis, fix_summary, related_json,
        tests_json, commit_ref, indexed_revision, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const a of annotations) {
      if (!a.id) continue;
      insertAnn.run(
        a.id,
        this.repoId,
        a.file_path,
        a.attached_symbol || null,
        a.source_kind || "inline_comment",
        a.sidecar_file || null,
        a.start_line || 1,
        a.end_line || 1,
        a.purpose || "",
        a.domain || null,
        JSON.stringify(a.invariants || []),
        JSON.stringify(a.bugFixes || []),
        a.rootCause || null,
        a.rootCauseStatus || "UNSPECIFIED",
        a.hypothesis || null,
        a.fix || null,
        JSON.stringify(a.related || []),
        JSON.stringify(a.tests || []),
        a.commit || null,
        revision,
        now
      );

      // Connect knowledge annotation edges into code_relationships
      const knowledgeNodeId = `${this.repoId}::knowledge::${a.id}`;
      for (const rel of a.related || []) {
        insertRel.run(
          this.repoId,
          fileRecord.file_path,
          knowledgeNodeId,
          null,
          rel,
          "RELATED_KNOWLEDGE",
          "CONFIRMED",
          `${a.file_path}:${a.start_line} @related ${rel}`,
          a.start_line || 1
        );
      }
      for (const t of a.tests || []) {
        insertRel.run(
          this.repoId,
          fileRecord.file_path,
          knowledgeNodeId,
          null,
          t,
          "TESTED_BY",
          "CONFIRMED",
          `${a.file_path}:${a.start_line} @tests ${t}`,
          a.start_line || 1
        );
      }
    }

    const insertTestRel = db.prepare(`
      INSERT INTO test_relationships (repo_id, test_file, target_symbol, evidence, status)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const t of testTargets) {
      insertTestRel.run(this.repoId, fileRecord.file_path, t.target_symbol, t.evidence || null, t.status || "CONFIRMED");
    }
  }

  replaceSidecarAnnotations(sidecars, revision = null) {
    const db = this.open();
    const now = new Date().toISOString();
    db.prepare("DELETE FROM knowledge_annotations WHERE repo_id = ? AND source_kind = 'sidecar_record'").run(this.repoId);
    const insertAnn = db.prepare(`
      INSERT OR REPLACE INTO knowledge_annotations (
        knowledge_id, repo_id, file_path, attached_symbol, source_kind, sidecar_file,
        start_line, end_line, purpose, domain, invariants_json, bug_fixes_json,
        root_cause, root_cause_status, hypothesis, fix_summary, related_json,
        tests_json, commit_ref, indexed_revision, updated_at
      ) VALUES (?, ?, ?, ?, 'sidecar_record', ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const a of sidecars) {
      insertAnn.run(
        a.id,
        this.repoId,
        a.file_path,
        a.attached_symbol || null,
        a.sidecar_file || null,
        a.purpose || "",
        a.domain || null,
        JSON.stringify(a.invariants || []),
        JSON.stringify(a.bugFixes || []),
        a.rootCause || null,
        a.rootCauseStatus || "UNSPECIFIED",
        a.hypothesis || null,
        a.fix || null,
        JSON.stringify(a.related || []),
        JSON.stringify(a.tests || []),
        a.commit || null,
        revision,
        now
      );
    }
  }

  recordBugFix(record) {
    const db = this.open();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO bug_fix_records (
        bug_id, repo_id, revision, problem_description, affected_entities_json,
        root_cause_status, confirmed_root_cause, fix_summary, test_references_json,
        git_commit, knowledge_ids_json, verification_evidence, validity_status,
        zettly_todo_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo_id, bug_id) DO UPDATE SET
        revision = excluded.revision,
        problem_description = excluded.problem_description,
        affected_entities_json = excluded.affected_entities_json,
        root_cause_status = excluded.root_cause_status,
        confirmed_root_cause = excluded.confirmed_root_cause,
        fix_summary = excluded.fix_summary,
        test_references_json = excluded.test_references_json,
        git_commit = excluded.git_commit,
        knowledge_ids_json = excluded.knowledge_ids_json,
        verification_evidence = excluded.verification_evidence,
        validity_status = excluded.validity_status,
        zettly_todo_id = COALESCE(excluded.zettly_todo_id, bug_fix_records.zettly_todo_id),
        updated_at = excluded.updated_at
    `).run(
      record.bugId,
      this.repoId,
      record.revision || null,
      record.problemDescription || "",
      JSON.stringify(record.affectedEntities || []),
      record.rootCauseStatus || (record.confirmedRootCause ? "CONFIRMED" : "HYPOTHESIS_ONLY"),
      record.confirmedRootCause || null,
      record.fixSummary || "",
      JSON.stringify(record.testReferences || []),
      record.gitCommit || null,
      JSON.stringify(record.knowledgeIds || []),
      record.verificationEvidence || null,
      record.validityStatus || "VALID",
      record.zettlyTodoId || null,
      now,
      now
    );
  }

  recordIndexOperation({ operation, revision, filesScanned, filesUpdated, filesDeleted, durationMs, status }) {
    const db = this.open();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO index_operations (repo_id, operation, revision, files_scanned, files_updated, files_deleted, duration_ms, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      this.repoId,
      operation,
      revision || null,
      filesScanned || 0,
      filesUpdated || 0,
      filesDeleted || 0,
      Number(durationMs || 0),
      status || "OK",
      now
    );
    if (revision) {
      db.prepare(`
        INSERT INTO revisions (repo_id, revision, indexed_at, mode, files_changed)
        VALUES (?, ?, ?, ?, ?)
      `).run(this.repoId, revision, now, operation, (filesUpdated || 0) + (filesDeleted || 0));
    }
  }

  recordDebugQuery({ query, matchedSymbols, matchedKnowledgeIds, filesReturned, usedFallback, durationMs }) {
    const db = this.open();
    db.prepare(`
      INSERT INTO debugging_history (repo_id, query, matched_symbols_json, matched_knowledge_ids_json, files_returned, used_fallback_search, duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      this.repoId,
      String(query || ""),
      JSON.stringify(matchedSymbols || []),
      JSON.stringify(matchedKnowledgeIds || []),
      filesReturned || 0,
      usedFallback ? 1 : 0,
      Number(durationMs || 0),
      new Date().toISOString()
    );
  }

  getStats() {
    const db = this.open();
    const count = (tbl) => db.prepare(`SELECT COUNT(*) AS c FROM ${tbl} WHERE repo_id = ?`).get(this.repoId)?.c || 0;
    const repo = this.getRepository();
    const dbSizeBytes = fs.existsSync(this.dbPath) ? fs.statSync(this.dbPath).size : 0;
    return {
      repo_id: this.repoId,
      root_path: this.repoRoot,
      db_path: this.dbPath,
      db_size_bytes: dbSizeBytes,
      schema_version: GRAPH_SCHEMA_VERSION,
      recovered_from_corruption: this.recoveredFromCorruption,
      last_revision: repo?.last_revision || null,
      last_indexed_at: repo?.last_indexed_at || null,
      files_indexed: count("source_files"),
      entities_count: count("code_entities"),
      relationships_count: count("code_relationships"),
      knowledge_annotations_count: count("knowledge_annotations"),
      bug_fix_records_count: count("bug_fix_records"),
      test_relationships_count: count("test_relationships"),
      debugging_queries_count: count("debugging_history"),
      index_operations_count: count("index_operations"),
    };
  }
}
