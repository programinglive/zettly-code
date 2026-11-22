# Zettly Code (`@programinglive/zettly-code`)

> **PRIVATE REPOSITORY** — Persistent Code Memory & Self-Evolving Knowledge Graph for AI-assisted software engineering.

## Overview

Zettly Code transforms source code into a continuously maintained, revision-aware knowledge graph inspired by the Zettelkasten Method. It pairs:

1. **Mandatory `@zettly-code` Knowledge Comments** (inline JSDoc/PHPDoc + sidecar JSON records for generated/non-commentable files) documenting purpose, invariants, bug fixes, confirmed root causes (or explicit hypotheses), fixes, related entities, and regression tests.
2. **Embedded SQLite Code Knowledge Graph** (`.zettly-code/knowledge-graph.db`, WAL mode, 12 canonical tables, corruption quarantine & recovery).
3. **Incremental Revision-Aware Indexing** (`initialize`, `update`, `status`, `verify`, `rebuild`) that re-indexes only added, modified, or deleted files.
4. **Bounded Debugging Context Retrieval** (`debug`, `symbol`, `dependencies`, `callers`, `tests`, `impact`, `history`) with freshness verification, targeted fallback search, historical bug-fix validity checks, and secret redaction.
5. **DevWorkflow MCP v3.1.0 Adapter** exposing only two canonical public tools (`code_index` and `code_context`) plus the `bugfix_knowledge_gate` integrated into canonical `audit`.

## Architecture

- `src/security/guards.js` — Workspace containment, symlink escape blocking, secret file exclusion, secret/PII redaction.
- `src/parsers/source-parser.js` — Language-aware parsers (JS/JSX/TS/PHP/SQL/Config) producing stable entity IDs and evidenced relationships.
- `src/comments/knowledge-comments.js` — `@zettly-code` parser, sidecar loader, `generateBugFixKnowledge`, and `validateKnowledgeAnnotations`.
- `src/storage/sqlite-store.js` — 12-table SQLite WAL store with automatic corruption recovery.
- `src/indexer/incremental-indexer.js` — Revision-aware incremental indexing and freshness checks.
- `src/debugging/context-retriever.js` — Bounded graph traversal, fallback search, and debugging memory.
- `src/integrations/devworkflow/adapter.js` — Thin adapter for DevWorkflow MCP v3.1.0.

## Testing & Benchmarks

```bash
npm test
npm run test:bench
```
