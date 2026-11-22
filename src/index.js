/**
 * @programinglive/zettly-code — Persistent Code Memory & Self-Evolving Knowledge Graph.
 */

export {
  IGNORED_DIRECTORIES,
  SECRET_FILE_PATTERNS,
  SECRET_VALUE_REGEX,
  PII_PATTERN,
  isSecretFilePath,
  containsSecretMaterial,
  redactSecrets,
  normalizeRelPath,
  resolveContainedPath,
} from "./security/guards.js";

export {
  ENTITY_TYPES,
  RELATIONSHIP_TYPES,
  EVIDENCE_STATUS,
  computeFileHash,
  buildEntityId,
  detectLanguage,
  isTestFilePath,
  parseSourceFile,
} from "./parsers/source-parser.js";

export {
  REQUIRED_BUGFIX_TAGS,
  parseKnowledgeComments,
  loadSidecarKnowledgeRecords,
  formatKnowledgeComment,
  generateBugFixKnowledge,
  validateKnowledgeAnnotations,
} from "./comments/knowledge-comments.js";

export {
  GRAPH_SCHEMA_VERSION,
  resolveGraphDbPath,
  computeRepoId,
  CodeKnowledgeGraphStore,
} from "./storage/sqlite-store.js";

export {
  getGitContext,
  walkRepositoryFiles,
  inspectFreshness,
  indexRepository,
} from "./indexer/incremental-indexer.js";

export { retrieveCodeContext } from "./debugging/context-retriever.js";

export {
  handleCodeIndex,
  handleCodeContext,
  evaluateBugFixKnowledgeGate,
  buildZettlySyncReference,
} from "./integrations/devworkflow/adapter.js";
