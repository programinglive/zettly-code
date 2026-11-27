import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * ZC-21 verifies that the repository is public through `gh repo view`.
 * GitHub CLI needs GH_TOKEN inside Actions; without it the acceptance test
 * fails even though the product is correct. This pins the CI wiring.
 */
test("CI test step supplies GH_TOKEN to the acceptance suite", () => {
  const workflow = readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(
    workflow,
    /- run: npm test\s*\n\s*env:\s*\n\s*GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/,
    "the npm test step must expose GH_TOKEN for gh-based acceptance checks",
  );
});
