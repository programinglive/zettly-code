# Changelog

## [1.0.1] - 2026-11-23

### Changed
- Open-sourced `@programinglive/zettly-code` under the MIT License (`PUBLIC` GitHub repository `programinglive/zettly-code`).
- Integrated Zettly Code as an official core component of the Zettly (`https://zettly.programinglive.com`) and DevWorkflow (`https://devworkflow.programinglive.com`) ecosystem.
- Documented mandatory workflow discipline (`code_context`, `code_index`, `@zettly-code` bugfix annotation gate, and `zettly-code-reference/v1` task sync).

## [1.0.0] - 2026-11-22

### Added
- Initial release of `@programinglive/zettly-code`.
- Canonical `@zettly-code` knowledge comment parser, formatter, `generateBugFixKnowledge`, and `validateKnowledgeAnnotations` with inline + sidecar record support.
- Embedded SQLite Code Knowledge Graph (`CodeKnowledgeGraphStore`) with 12 canonical tables, WAL mode, and automatic corruption recovery.
- Language-aware source parsers for JavaScript, JSX, TypeScript, PHP, SQL, and configuration files.
- Incremental revision-aware repository indexer (`status`, `initialize`, `update`, `verify`, `rebuild`).
- Bounded debugging context retrieval (`debug`, `symbol`, `dependencies`, `callers`, `tests`, `impact`, `history`) with freshness checks, targeted fallback search, and historical bug-fix validity tracking.
- Thin DevWorkflow MCP adapter (`handleCodeIndex`, `handleCodeContext`, `evaluateBugFixKnowledgeGate`, `buildZettlySyncReference`).
- Full acceptance test suites (`KC-01..KC-16`, `ZC-01..ZC-22`) and repeated-debugging performance benchmark.
