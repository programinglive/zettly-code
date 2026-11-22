import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  CodeKnowledgeGraphStore,
  indexRepository,
  retrieveCodeContext,
  resolveContainedPath,
  isSecretFilePath,
  redactSecrets,
  evaluateBugFixKnowledgeGate,
} from "../../src/index.js";

function createSampleRepo(prefix = "zc-graph-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tests"), { recursive: true });

  fs.writeFileSync(
    path.join(dir, "src", "validator.js"),
    `export function validateOrder(order) {\n  return Boolean(order && order.total > 0);\n}\n`
  );
  fs.writeFileSync(
    path.join(dir, "src", "checkout.js"),
    `import { validateOrder } from "./validator.js";\n/**\n * @zettly-code ZC-CHECKOUT-001\n * @purpose Process customer checkout safely\n * @invariant Order total must be positive\n * @bug-fix BUG-900\n * @root-cause Zero-total orders bypassed payment guard\n * @fix Enforced validateOrder before charging\n * @related validateOrder\n * @tests checkout.test.js\n */\nexport function processCheckout(order) {\n  if (!validateOrder(order)) throw new Error("Invalid order");\n  return { charged: order.total };\n}\n`
  );
  fs.writeFileSync(
    path.join(dir, "src", "api.js"),
    `import { processCheckout } from "./checkout.js";\nexport function checkoutEndpoint(req) {\n  return processCheckout(req.body);\n}\n`
  );
  fs.writeFileSync(
    path.join(dir, "tests", "checkout.test.js"),
    `import { processCheckout } from "../src/checkout.js";\ntest("rejects zero total", () => { processCheckout({ total: 10 }); });\n`
  );
  return dir;
}

test("ZC-01: SQLite graph store initializes all 12 canonical tables in WAL mode", () => {
  const dir = createSampleRepo("zc-01-");
  try {
    const store = new CodeKnowledgeGraphStore(dir);
    const db = store.open();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => r.name);
    const expected = [
      "schema_versions",
      "repositories",
      "worktrees",
      "revisions",
      "source_files",
      "code_entities",
      "code_relationships",
      "knowledge_annotations",
      "bug_fix_records",
      "test_relationships",
      "debugging_history",
      "index_operations",
    ];
    for (const t of expected) {
      assert.ok(tables.includes(t), `Missing canonical table ${t}`);
    }
    const mode = db.pragma("journal_mode", { simple: true });
    assert.equal(String(mode).toLowerCase(), "wal");
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ZC-02: initialize indexes files, symbols, relationships, annotations, and test links", () => {
  const dir = createSampleRepo("zc-02-");
  try {
    const res = indexRepository(dir, { mode: "initialize" });
    assert.equal(res.ok, true);
    assert.equal(res.freshnessStatus, "FRESH");
    assert.equal(res.stats.files_indexed, 4);
    assert.ok(res.stats.entities_count >= 8);
    assert.ok(res.stats.relationships_count >= 5);
    assert.equal(res.stats.knowledge_annotations_count, 1);
    assert.ok(res.stats.test_relationships_count >= 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ZC-03: incremental update re-indexes ONLY modified file and skips unchanged files", () => {
  const dir = createSampleRepo("zc-03-");
  try {
    indexRepository(dir, { mode: "initialize" });
    const target = path.join(dir, "src", "validator.js");
    fs.writeFileSync(
      target,
      `export function validateOrder(order) {\n  return Boolean(order && order.total > 0 && order.currency);\n}\n`
    );
    const upd = indexRepository(dir, { mode: "update" });
    assert.equal(upd.ok, true);
    assert.equal(upd.incremental, true);
    assert.equal(upd.filesUpdated, 1);
    assert.deepEqual(upd.updatedPaths, ["src/validator.js"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ZC-04: deleted and renamed files are purged cleanly during incremental update", () => {
  const dir = createSampleRepo("zc-04-");
  try {
    indexRepository(dir, { mode: "initialize" });
    fs.renameSync(path.join(dir, "src", "api.js"), path.join(dir, "src", "checkout-route.js"));
    const upd = indexRepository(dir, { mode: "update" });
    assert.equal(upd.ok, true);
    assert.deepEqual(upd.deletedPaths, ["src/api.js"]);
    assert.deepEqual(upd.updatedPaths, ["src/checkout-route.js"]);
    const ctx = retrieveCodeContext(dir, { mode: "symbol", symbol: "checkoutEndpoint" });
    assert.ok(ctx.symbols.every((s) => s.file_path === "src/checkout-route.js"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ZC-05: status and verify detect stale graph when disk changes occur after indexing", () => {
  const dir = createSampleRepo("zc-05-");
  try {
    indexRepository(dir, { mode: "initialize" });
    fs.writeFileSync(path.join(dir, "src", "extra.js"), `export function extra() { return 42; }\n`);
    const st = indexRepository(dir, { mode: "status" });
    assert.equal(st.freshnessStatus, "STALE");
    assert.equal(st.pendingChanges.added, 1);
    const ver = indexRepository(dir, { mode: "verify" });
    assert.equal(ver.ok, false);
    assert.equal(ver.freshnessStatus, "STALE");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ZC-06: rebuild deterministically reconstructs identical entity and file counts", () => {
  const dir = createSampleRepo("zc-06-");
  try {
    const first = indexRepository(dir, { mode: "initialize" });
    const rebuilt = indexRepository(dir, { mode: "rebuild" });
    assert.equal(rebuilt.stats.files_indexed, first.stats.files_indexed);
    assert.equal(rebuilt.stats.entities_count, first.stats.entities_count);
    assert.equal(rebuilt.stats.knowledge_annotations_count, first.stats.knowledge_annotations_count);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ZC-07: corruption recovery quarantines corrupt SQLite file and rebuilds cleanly", () => {
  const dir = createSampleRepo("zc-07-");
  try {
    const dbDir = path.join(dir, ".zettly-code");
    fs.mkdirSync(dbDir, { recursive: true });
    fs.writeFileSync(path.join(dbDir, "knowledge-graph.db"), "NOT A VALID SQLITE FILE!!!");
    const res = indexRepository(dir, { mode: "initialize" });
    assert.equal(res.ok, true);
    assert.equal(res.stats.recovered_from_corruption, true);
    assert.equal(res.stats.files_indexed, 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ZC-08: code_context(debug) returns symbols, annotations, deps, callers, and related tests", () => {
  const dir = createSampleRepo("zc-08-");
  try {
    indexRepository(dir, { mode: "initialize" });
    const ctx = retrieveCodeContext(dir, { mode: "debug", query: "processCheckout" });
    assert.equal(ctx.ok, true);
    assert.equal(ctx.freshnessStatus, "FRESH");
    assert.ok(ctx.symbols.some((s) => s.name === "processCheckout"));
    assert.ok(ctx.knowledgeAnnotations.some((a) => a.id === "ZC-CHECKOUT-001"));
    assert.ok(ctx.dependencies.some((d) => d.target.includes("validator")));
    assert.ok(ctx.callers.some((c) => c.callerFile === "src/api.js"));
    assert.ok(ctx.relatedTests.some((t) => t.test.includes("checkout.test.js")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ZC-09: code_context(dependencies) performs bounded multi-hop outbound traversal", () => {
  const dir = createSampleRepo("zc-09-");
  try {
    indexRepository(dir, { mode: "initialize" });
    const ctx = retrieveCodeContext(dir, { mode: "dependencies", file: "src/api.js", depth: 2 });
    assert.ok(ctx.dependencies.some((d) => d.hop === 1 && d.target.includes("checkout")));
    assert.ok(ctx.dependencies.some((d) => d.hop === 2 && d.target.includes("validator")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ZC-10: code_context(callers) resolves inbound callers of a symbol", () => {
  const dir = createSampleRepo("zc-10-");
  try {
    indexRepository(dir, { mode: "initialize" });
    const ctx = retrieveCodeContext(dir, { mode: "callers", symbol: "validateOrder" });
    assert.ok(ctx.callers.some((c) => c.callerFile === "src/checkout.js"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ZC-11: code_context(tests) resolves covering test files", () => {
  const dir = createSampleRepo("zc-11-");
  try {
    indexRepository(dir, { mode: "initialize" });
    const ctx = retrieveCodeContext(dir, { mode: "tests", symbol: "processCheckout" });
    assert.ok(ctx.relatedTests.some((t) => t.test.includes("checkout.test.js")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ZC-12: code_context(impact) computes bounded impacted files and callers", () => {
  const dir = createSampleRepo("zc-12-");
  try {
    indexRepository(dir, { mode: "initialize" });
    const ctx = retrieveCodeContext(dir, { mode: "impact", file: "src/checkout.js" });
    assert.ok(ctx.impactedFiles.includes("src/checkout.js"));
    assert.ok(ctx.impactedFiles.includes("src/api.js"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ZC-13: code_context(history) retrieves recorded bug fixes with validity status", () => {
  const dir = createSampleRepo("zc-13-");
  try {
    indexRepository(dir, { mode: "initialize" });
    const gate = evaluateBugFixKnowledgeGate({
      projectDir: dir,
      changedFiles: ["src/checkout.js"],
      taskType: "BUG_FIX",
      bugId: "BUG-900",
      problemDescription: "Zero-total checkout bypassed payment",
      confirmedRootCause: "Missing validateOrder check",
      fixSummary: "Added validateOrder guard",
      testReferences: ["tests/checkout.test.js"],
    });
    assert.equal(gate.ok, true);
    const hist = retrieveCodeContext(dir, { mode: "history", query: "BUG-900" });
    assert.equal(hist.bugFixes.length, 1);
    assert.equal(hist.bugFixes[0].validityStatus, "VALID");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ZC-14: dynamic imports trigger targeted fallback search and report hasDynamicDependencies", () => {
  const dir = createSampleRepo("zc-14-");
  try {
    fs.writeFileSync(
      path.join(dir, "src", "loader.js"),
      `export async function loadPlugin(name) {\n  return await import(name);\n}\n`
    );
    indexRepository(dir, { mode: "initialize" });
    const ctx = retrieveCodeContext(dir, { mode: "debug", symbol: "loadPlugin" });
    assert.equal(ctx.hasDynamicDependencies, true);
    assert.equal(ctx.usedFallbackSearch, true);
    assert.equal(ctx.fallbackReason, "DYNAMIC_DEPENDENCY_DETECTED");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ZC-15: unindexed literal query triggers targeted fallback search safely", () => {
  const dir = createSampleRepo("zc-15-");
  try {
    fs.writeFileSync(path.join(dir, "src", "messages.js"), `export const ERR_MAGIC_42 = "E_UNIQUE_XYZ";\n`);
    indexRepository(dir, { mode: "initialize" });
    const ctx = retrieveCodeContext(dir, { mode: "debug", query: "E_UNIQUE_XYZ" });
    assert.equal(ctx.usedFallbackSearch, true);
    assert.ok(ctx.fallbackMatches.some((m) => m.file === "src/messages.js"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ZC-16: secret files (.env, *.pem, credentials.json) are never indexed into graph", () => {
  const dir = createSampleRepo("zc-16-");
  try {
    fs.writeFileSync(path.join(dir, ".env"), "API_KEY=ghp_1234567890abcdef1234567890abcdef1234\n");
    fs.writeFileSync(path.join(dir, "credentials.json"), `{"secret":"topsecret"}`);
    const res = indexRepository(dir, { mode: "initialize" });
    assert.ok(res.skipped.secretFiles >= 2);
    assert.equal(isSecretFilePath(".env.production"), true);
    assert.equal(isSecretFilePath("keys/server.pem"), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ZC-17: workspace containment blocks path traversal (../)", () => {
  const dir = createSampleRepo("zc-17-");
  try {
    const res = resolveContainedPath(dir, "../../etc/passwd");
    assert.equal(res.ok, false);
    assert.equal(res.code, "PATH_TRAVERSAL_BLOCKED");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ZC-18: output redaction masks credential tokens in returned snippets", () => {
  const token = ["ghp_", "abcdef1234567890abcdef1234567890abcd"].join("");
  const redacted = redactSecrets(`Authorization: Bearer ${token}`);
  assert.doesNotMatch(redacted, /ghp_/);
  assert.match(redacted, /<REDACTED_SECRET>/);
});

test("ZC-19: PHP Laravel classes, interfaces, methods, and routes are parsed and indexed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zc-19-"));
  try {
    fs.mkdirSync(path.join(dir, "app", "Http", "Controllers"), { recursive: true });
    fs.mkdirSync(path.join(dir, "routes"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "app", "Http", "Controllers", "TodoController.php"),
      `<?php\nclass TodoController extends Controller {\n  public function store() { return true; }\n}\n`
    );
    fs.writeFileSync(
      path.join(dir, "routes", "api.php"),
      `<?php\nRoute::post('/todos', [TodoController::class, 'store']);\n`
    );
    const res = indexRepository(dir, { mode: "initialize" });
    assert.equal(res.stats.files_indexed, 2);
    const ctx = retrieveCodeContext(dir, { mode: "symbol", symbol: "TodoController.store" });
    assert.ok(ctx.symbols.some((s) => s.name === "TodoController.store"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ZC-20: historical bug-fix record transitions to SUPERSEDED when affected file is deleted", () => {
  const dir = createSampleRepo("zc-20-");
  try {
    indexRepository(dir, { mode: "initialize" });
    evaluateBugFixKnowledgeGate({
      projectDir: dir,
      changedFiles: ["src/checkout.js"],
      taskType: "BUG_FIX",
      bugId: "BUG-920",
      confirmedRootCause: "Old logic",
      fixSummary: "Patched old logic",
    });
    fs.unlinkSync(path.join(dir, "src", "checkout.js"));
    indexRepository(dir, { mode: "update" });
    const hist = retrieveCodeContext(dir, { mode: "history", query: "BUG-920" });
    assert.equal(hist.bugFixes[0].validityStatus, "SUPERSEDED");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ZC-21: programinglive/zettly-code GitHub repository privacy verification (PRIVATE)", () => {
  const out = execFileSync(
    "gh",
    ["repo", "view", "programinglive/zettly-code", "--json", "name,visibility,isPrivate"],
    { encoding: "utf8", timeout: 10000 }
  );
  const parsed = JSON.parse(out);
  assert.equal(parsed.name, "zettly-code");
  assert.equal(parsed.isPrivate, true);
  assert.equal(parsed.visibility, "PRIVATE");
});

test("ZC-22: code_context auto-updates stale graph before returning fresh debugging context", () => {
  const dir = createSampleRepo("zc-22-");
  try {
    indexRepository(dir, { mode: "initialize" });
    fs.writeFileSync(
      path.join(dir, "src", "new-guard.js"),
      `export function enforceRateLimit(ip) { return Boolean(ip); }\n`
    );
    const ctx = retrieveCodeContext(dir, { mode: "debug", query: "enforceRateLimit", autoUpdate: true });
    assert.equal(ctx.freshnessStatus, "FRESH");
    assert.ok(ctx.symbols.some((s) => s.name === "enforceRateLimit"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
