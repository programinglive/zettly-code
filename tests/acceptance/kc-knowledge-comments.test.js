import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseKnowledgeComments,
  loadSidecarKnowledgeRecords,
  formatKnowledgeComment,
  generateBugFixKnowledge,
  validateKnowledgeAnnotations,
  indexRepository,
  retrieveCodeContext,
  evaluateBugFixKnowledgeGate,
} from "../../src/index.js";

function makeTempRepo(prefix = "zc-kc-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("KC-01: parses valid inline @zettly-code JSDoc bug-fix annotation with all canonical tags", () => {
  const code = `/**
 * @zettly-code ZC-AUTH-TOKEN-001
 * @purpose Verify bearer token expiry before issuing refresh session
 * @domain auth
 * @invariant Expired tokens must never mint a new session
 * @bug-fix BUG-401
 * @root-cause Expiry comparison used seconds instead of milliseconds
 * @fix Normalized exp claim by multiplying by 1000 before Date.now() check
 * @related SessionService
 * @tests auth-token.test.js
 * @commit abc1234
 */
export function verifyTokenExpiry(exp) {
  return exp * 1000 > Date.now();
}`;
  const parsed = parseKnowledgeComments({ relPath: "src/auth.js", content: code });
  assert.equal(parsed.syntaxErrors.length, 0);
  assert.equal(parsed.annotations.length, 1);
  const ann = parsed.annotations[0];
  assert.equal(ann.id, "ZC-AUTH-TOKEN-001");
  assert.equal(ann.attached_symbol, "verifyTokenExpiry");
  assert.equal(ann.domain, "auth");
  assert.equal(ann.rootCauseStatus, "CONFIRMED");
  assert.deepEqual(ann.bugFixes, ["BUG-401"]);
  assert.deepEqual(ann.related, ["SessionService"]);
  assert.deepEqual(ann.tests, ["auth-token.test.js"]);
});

test("KC-02: parses PHPDoc @zettly-code annotations on PHP classes and methods", () => {
  const php = `<?php
/**
 * @zettly-code ZC-PHP-INV-002
 * @purpose Compute invoice grand total with tax rounding
 * @bug-fix BUG-402
 * @root-cause Float rounding drifted by 1 cent on multi-line discounts
 * @fix Used integer minor units before formatting
 * @tests InvoiceCalculatorTest
 */
class InvoiceCalculator {
    public function total() { return 0; }
}`;
  const parsed = parseKnowledgeComments({ relPath: "app/InvoiceCalculator.php", content: php });
  assert.equal(parsed.syntaxErrors.length, 0);
  assert.equal(parsed.annotations[0].attached_symbol, "InvoiceCalculator");
});

test("KC-03: generateBugFixKnowledge inserts clean comment right above target symbol", () => {
  const src = `export function saveTodo(todo) {\n  return todo;\n}\n`;
  const res = generateBugFixKnowledge({
    content: src,
    relPath: "src/todo.js",
    targetSymbol: "saveTodo",
    id: "ZC-TODO-SAVE-003",
    purpose: "Persist todo item and notify sync worker",
    invariant: "Todo title must be non-empty",
    bugFix: "BUG-403",
    rootCause: "Empty whitespace titles bypassed validation",
    rootCauseConfirmed: true,
    fix: "Trim title before length check",
    related: ["SyncWorker"],
    tests: ["todo.test.js"],
  });
  assert.equal(res.ok, true);
  assert.equal(res.action, "INSERTED_BEFORE_SYMBOL");
  assert.match(res.updatedContent, /@zettly-code ZC-TODO-SAVE-003/);
  assert.match(res.updatedContent, /@root-cause Empty whitespace titles/);
});

test("KC-04: generateBugFixKnowledge updates existing comment in place without duplicating blocks", () => {
  const initial = generateBugFixKnowledge({
    content: `export function saveTodo(todo) { return todo; }\n`,
    relPath: "src/todo.js",
    targetSymbol: "saveTodo",
    id: "ZC-TODO-SAVE-004",
    purpose: "Persist todo item safely",
    bugFix: "BUG-404A",
    rootCause: "Initial race condition",
    fix: "Added mutex guard",
    related: ["LockManager"],
    tests: ["todo.test.js"],
  });
  const second = generateBugFixKnowledge({
    content: initial.updatedContent,
    relPath: "src/todo.js",
    targetSymbol: "saveTodo",
    id: "ZC-TODO-SAVE-004",
    purpose: "Persist todo item safely with retry",
    bugFix: "BUG-404B",
    rootCause: "Retry swallowed unique constraint error",
    fix: "Re-throw unique constraint error immediately",
    related: ["RetryPolicy"],
    tests: ["todo-retry.test.js"],
  });
  assert.equal(second.action, "UPDATED_EXISTING_COMMENT");
  const matches = second.updatedContent.match(/@zettly-code/g) || [];
  assert.equal(matches.length, 1);
  assert.match(second.updatedContent, /LockManager/);
  assert.match(second.updatedContent, /RetryPolicy/);
});

test("KC-05: validator detects duplicate @zettly-code IDs across files", () => {
  const a = parseKnowledgeComments({
    relPath: "src/a.js",
    content: `/**\n * @zettly-code ZC-DUP-005\n * @purpose Handle file A logic\n */\nexport function a() {}`,
  });
  const b = parseKnowledgeComments({
    relPath: "src/b.js",
    content: `/**\n * @zettly-code ZC-DUP-005\n * @purpose Handle file B logic\n */\nexport function b() {}`,
  });
  const val = validateKnowledgeAnnotations({
    annotations: [...a.annotations, ...b.annotations],
  });
  assert.equal(val.valid, false);
  assert.ok(val.errors.some((e) => e.code === "DUPLICATE_KNOWLEDGE_ID"));
});

test("KC-06: validator detects broken/stale @related and @tests references", () => {
  const parsed = parseKnowledgeComments({
    relPath: "src/service.js",
    content: `/**
 * @zettly-code ZC-STALE-006
 * @purpose Process billing webhook
 * @bug-fix BUG-406
 * @root-cause Missing idempotency key check
 * @fix Store processed webhook IDs
 * @related NonExistentOldClass
 * @tests missing-billing.test.js
 */
export function handleWebhook() {}`,
  });
  const val = validateKnowledgeAnnotations({
    annotations: parsed.annotations,
    knownSymbols: new Set(["handleWebhook"]),
    knownTestSymbols: new Set(["existing.test.js"]),
    knownFiles: new Set(["src/service.js"]),
  });
  assert.ok(val.warnings.some((w) => w.code === "BROKEN_RELATED_REFERENCE"));
  assert.ok(val.warnings.some((w) => w.code === "BROKEN_TEST_REFERENCE"));
});

test("KC-07: parser flags unknown tags and malformed knowledge IDs", () => {
  const parsed = parseKnowledgeComments({
    relPath: "src/bad.js",
    content: `/**\n * @zettly-code bad\n * @made-up-tag hello\n */\nexport function x() {}`,
  });
  assert.ok(parsed.syntaxErrors.some((e) => e.code === "UNKNOWN_ZETTLY_TAG"));
  assert.ok(parsed.syntaxErrors.some((e) => e.code === "INVALID_KNOWLEDGE_ID"));
});

test("KC-08: root-cause truthfulness uses @hypothesis when root cause is not confirmed", () => {
  const block = formatKnowledgeComment({
    id: "ZC-HYP-008",
    purpose: "Retry transient upstream timeouts",
    bugFix: "BUG-408",
    rootCause: "Suspected proxy keep-alive reset under burst load",
    rootCauseConfirmed: false,
    fix: "Added exponential backoff on ECONNRESET",
  });
  assert.doesNotMatch(block, /@root-cause/);
  assert.match(block, /@hypothesis Suspected proxy keep-alive reset/);
  const parsed = parseKnowledgeComments({ relPath: "src/net.js", content: block });
  assert.equal(parsed.annotations[0].rootCauseStatus, "HYPOTHESIS_ONLY");
});

test("KC-09: sidecar knowledge records support generated or non-commentable JSON files", () => {
  const tmp = makeTempRepo("zc-kc09-");
  try {
    fs.mkdirSync(path.join(tmp, "config"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "engineering", "zettly-code-sidecars"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "config", "routes.json"), `{"api": "/v1"}`);
    fs.writeFileSync(
      path.join(tmp, "engineering", "zettly-code-sidecars", "routes-bug.json"),
      JSON.stringify({
        id: "ZC-CFG-ROUTES-009",
        targetFile: "config/routes.json",
        purpose: "Define canonical API v1 route map",
        bugFix: "BUG-409",
        rootCause: "Trailing slash mismatch caused 301 redirect loop",
        fix: "Removed trailing slash from /v1 entry",
        tests: ["routes.test.js"],
      })
    );
    const sidecars = loadSidecarKnowledgeRecords(tmp);
    assert.equal(sidecars.length, 1);
    assert.equal(sidecars[0].source_kind, "sidecar_record");
    indexRepository(tmp, { mode: "initialize" });
    const gate = evaluateBugFixKnowledgeGate({
      projectDir: tmp,
      changedFiles: ["config/routes.json"],
      taskType: "BUG_FIX",
      bugId: "BUG-409",
    });
    assert.equal(gate.ok, true);
    assert.equal(gate.status, "PASSED");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("KC-10: bug-fix annotation missing @root-cause/@hypothesis or @fix fails validation", () => {
  const parsed = parseKnowledgeComments({
    relPath: "src/incomplete.js",
    content: `/**\n * @zettly-code ZC-INC-010\n * @purpose Handle checkout submit\n * @bug-fix BUG-410\n */\nexport function submit() {}`,
  });
  const val = validateKnowledgeAnnotations({ annotations: parsed.annotations });
  assert.equal(val.valid, false);
  assert.ok(val.errors.some((e) => e.code === "MISSING_ROOT_CAUSE_OR_HYPOTHESIS"));
  assert.ok(val.errors.some((e) => e.code === "MISSING_FIX_SUMMARY"));
});

test("KC-11: trivial or empty @purpose fails validation", () => {
  const parsed = parseKnowledgeComments({
    relPath: "src/triv.js",
    content: `/**\n * @zettly-code ZC-TRIV-011\n * @purpose ok\n */\nexport function y() {}`,
  });
  const val = validateKnowledgeAnnotations({ annotations: parsed.annotations });
  assert.equal(val.valid, false);
  assert.ok(val.errors.some((e) => e.code === "MISSING_OR_TRIVIAL_PURPOSE"));
});

test("KC-12: generator and validator block secret tokens and PII inside knowledge comments", () => {
  const secretToken = ["ghp_", "1234567890abcdef1234567890abcdef1234"].join("");
  const genSecret = generateBugFixKnowledge({
    content: "export function a() {}",
    relPath: "src/a.js",
    id: "ZC-SEC-012",
    purpose: `Uses token ${secretToken}`,
    bugFix: "BUG-412",
    rootCause: "Leak",
    fix: "Removed",
  });
  assert.equal(genSecret.ok, false);
  assert.equal(genSecret.code, "SECRET_MATERIAL_FORBIDDEN");

  const genPii = generateBugFixKnowledge({
    content: "export function a() {}",
    relPath: "src/a.js",
    id: "ZC-PII-012",
    purpose: "Reported by customer alice@example.com",
    bugFix: "BUG-412B",
    rootCause: "Leak",
    fix: "Removed",
  });
  assert.equal(genPii.ok, false);
  assert.equal(genPii.code, "PII_FORBIDDEN_IN_COMMENT");
});

test("KC-13: multi-line @purpose, @invariant, and @fix continuations parse cleanly", () => {
  const code = `/**
 * @zettly-code ZC-MULTI-013
 * @purpose Synchronize task state
 *   across concurrent worktrees safely
 * @invariant Never overwrite newer revision
 *   from an older lease holder
 * @bug-fix BUG-413
 * @root-cause Lease epoch was ignored during write
 * @fix Compare lease epoch before committing state
 */
export function syncState() {}`;
  const parsed = parseKnowledgeComments({ relPath: "src/sync.js", content: code });
  assert.match(parsed.annotations[0].purpose, /across concurrent worktrees safely/);
  assert.match(parsed.annotations[0].invariants[0], /from an older lease holder/);
});

test("KC-14: indexed @zettly-code annotations are immediately retrievable via code_context(debug)", () => {
  const tmp = makeTempRepo("zc-kc14-");
  try {
    fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "src", "retry.js"),
      `/**
 * @zettly-code ZC-RETRY-014
 * @purpose Retry idempotent HTTP requests with jitter
 * @bug-fix BUG-414
 * @root-cause Non-idempotent POST requests were retried on 502
 * @fix Restricted retry to GET and PUT only
 * @tests retry.test.js
 */
export function retryRequest(method) { return method === "GET"; }\n`
    );
    indexRepository(tmp, { mode: "initialize" });
    const ctx = retrieveCodeContext(tmp, { mode: "debug", query: "retryRequest" });
    assert.equal(ctx.ok, true);
    assert.ok(ctx.knowledgeAnnotations.some((a) => a.id === "ZC-RETRY-014"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("KC-15: renaming a symbol makes old @related reference detectable as stale warning", () => {
  const tmp = makeTempRepo("zc-kc15-");
  try {
    fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "src", "helper.js"), `export function newHelperName() { return 1; }\n`);
    fs.writeFileSync(
      path.join(tmp, "src", "main.js"),
      `/**
 * @zettly-code ZC-RENAME-015
 * @purpose Main entry calling helper
 * @related oldHelperName
 */
export function run() { return 2; }\n`
    );
    const idx = indexRepository(tmp, { mode: "initialize" });
    assert.ok(idx.knowledgeValidation.warnings.some((w) => w.code === "BROKEN_RELATED_REFERENCE"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("KC-16: non-bugfix tasks do not trigger mandatory bug-fix knowledge comment failure", () => {
  const tmp = makeTempRepo("zc-kc16-");
  try {
    fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "src", "feature.js"), `export function greet() { return "hi"; }\n`);
    const gate = evaluateBugFixKnowledgeGate({
      projectDir: tmp,
      changedFiles: ["src/feature.js"],
      taskType: "FEATURE",
    });
    assert.equal(gate.ok, true);
    assert.equal(gate.status, "NOT_APPLICABLE");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
