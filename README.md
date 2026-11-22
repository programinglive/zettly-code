# Zettly Code (`@programinglive/zettly-code`)

[![License: MIT](https://img.shields.io/badge/License-MIT-emerald.svg)](LICENSE)
[![Part of Zettly](https://img.shields.io/badge/Ecosystem-Zettly%20%26%20DevWorkflow-blue)](https://zettly.programinglive.com)

> **Open-Source Persistent Source-Code Memory & Self-Evolving Zettelkasten Knowledge Graph** — an official core component of the [Zettly](https://zettly.programinglive.com) and [DevWorkflow MCP](https://devworkflow.programinglive.com) engineering ecosystem.

## Overview

Zettly Code transforms source code into a continuously maintained, revision-aware knowledge graph inspired by the Zettelkasten Method. Instead of forcing AI coding agents to re-scan hundreds of raw files on every turn, Zettly Code links codebase structure, invariants, and verified root-cause debugging memory directly to **Zettly Tasks & Notes**:

1. **Mandatory `@zettly-code` Knowledge Comments** (inline JSDoc/PHPDoc + sidecar JSON records under `engineering/zettly-code-sidecars/*.json` for non-commentable files) documenting purpose, invariants, bug fixes, confirmed root causes (or explicit hypotheses), fixes, related entities, and regression tests.
2. **Embedded SQLite Code Knowledge Graph** (`.zettly-code/knowledge-graph.db`, WAL mode, 12 canonical tables, corruption quarantine & automatic recovery).
3. **Incremental Revision-Aware Indexing** (`initialize`, `update`, `status`, `verify`, `rebuild`) that re-indexes only added, modified, or deleted files.
4. **Bounded Debugging Context Retrieval** (`debug`, `symbol`, `dependencies`, `callers`, `tests`, `impact`, `history`) with freshness verification, targeted fallback search, historical bug-fix validity checks, and secret redaction.
5. **Mandatory DevWorkflow MCP Gate & Zettly Sync** exposing canonical `code_index` and `code_context` tools plus the automated `bugfix_knowledge_gate` enforced during `check_ready_to_commit` and `audit`, syncing compact `zettly-code-reference/v1` payloads directly to Zettly Tasks.

## Mandatory Workflow Discipline

In the shared **Zettly + DevWorkflow** engineering workflow, Zettly Code is **mandatory**:

1. **Before Debugging or Modifying Code (`code_context` & `code_index`):**
   - Query `code_context({ mode: "debug", query: "<symbol or symptom>" })` or `code_context({ mode: "impact", file: "<path>" })` to retrieve existing `@zettly-code` invariants, callers, dependencies, tests, and past bug-fix history before scanning files.
2. **On Every Bugfix Task (`@zettly-code` Annotation Gate):**
   - Every modified production source file in a `bugfix` task **MUST** record a structured `@zettly-code` annotation (or sidecar JSON record for non-commentable files):
     ```js
     /**
      * @zettly-code ZC-MODULE-001
      * @purpose Concise responsibility of this function/class
      * @invariant Key domain invariant that must never be violated
      * @bug-fix BUG-1234
      * @root-cause Verified empirical root cause (or @hypothesis if unconfirmed)
      * @fix Summary of the minimal fix applied
      * @related relatedSymbolName
      * @tests regression-test-file.test.js
      */
     ```
3. **Pre-Commit Enforcement (`check_ready_to_commit`):**
   - `code_index({ mode: "update" })` refreshes `.zettly-code/knowledge-graph.db` and `check_ready_to_commit` verifies that all modified production source files in a bugfix task pass the `bugfix_knowledge_gate` before committing.

## Architecture

- `src/security/guards.js` — Workspace containment, symlink escape blocking, secret file exclusion, secret/PII redaction.
- `src/parsers/source-parser.js` — Language-aware parsers (JS/JSX/TS/PHP/SQL/Config) producing stable entity IDs and evidenced relationships.
- `src/comments/knowledge-comments.js` — `@zettly-code` parser, sidecar loader, `generateBugFixKnowledge`, and `validateKnowledgeAnnotations`.
- `src/storage/sqlite-store.js` — 12-table SQLite WAL store with automatic corruption recovery.
- `src/indexer/incremental-indexer.js` — Revision-aware incremental indexing and freshness checks.
- `src/debugging/context-retriever.js` — Bounded graph traversal, fallback search, and debugging memory.
- `src/integrations/devworkflow/adapter.js` — Canonical adapter for DevWorkflow MCP and Zettly reference sync (`zettly-code-reference/v1`).

## Installation & Testing

```bash
npm install @programinglive/zettly-code
npm test
npm run test:bench
```

## License

Released as open-source software under the [MIT License](LICENSE).
