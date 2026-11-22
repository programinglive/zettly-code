/**
 * Performance & Repeated-Debugging Efficiency Benchmark for Zettly Code v1.0.
 *
 * Compares:
 *   1. Full repository scan (naive grep across all source files on every debugging query)
 *   2. Zettly Code persistent knowledge graph (1x initialize + incremental update + bounded `code_context`)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { indexRepository, retrieveCodeContext, walkRepositoryFiles } from "../../src/index.js";

function generateSyntheticRepo(moduleCount = 120) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zc-bench-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tests"), { recursive: true });

  for (let i = 0; i < moduleCount; i++) {
    const isTarget = i === 42;
    const comment = isTarget
      ? `/**
 * @zettly-code ZC-BENCH-042
 * @purpose Calculate prorated subscription invoice total
 * @invariant Proration factor must stay within [0, 1]
 * @bug-fix BUG-BENCH-42
 * @root-cause Negative proration factor occurred on mid-cycle downgrade
 * @fix Clamped proration factor to Math.max(0, Math.min(1, factor))
 * @related module41
 * @tests module42.test.js
 */\n`
      : "";
    const imp = i > 0 ? `import { computeModule${i - 1} } from "./module${i - 1}.js";\n` : "";
    const call = i > 0 ? `computeModule${i - 1}(x)` : "x";
    const body = `${imp}${comment}export function computeModule${i}(x) {\n  const base = ${call};\n  return base + ${i};\n}\n`;
    fs.writeFileSync(path.join(dir, "src", `module${i}.js`), body);
  }
  fs.writeFileSync(
    path.join(dir, "tests", "module42.test.js"),
    `import { computeModule42 } from "../src/module42.js";\ntest("clamps proration", () => computeModule42(10));\n`
  );
  return dir;
}

function naiveFullScanDebug(repoRoot, needle) {
  const start = performance.now();
  const { files } = walkRepositoryFiles(repoRoot);
  let bytesRead = 0;
  const matched = [];
  for (const f of files) {
    const content = fs.readFileSync(f.absPath, "utf8");
    bytesRead += Buffer.byteLength(content, "utf8");
    if (content.includes(needle)) matched.push(f.relPath);
  }
  return {
    durationMs: Number((performance.now() - start).toFixed(2)),
    filesOpened: files.length,
    bytesRead,
    matchedCount: matched.length,
  };
}

const repoDir = generateSyntheticRepo(120);
try {
  const initRes = indexRepository(repoDir, { mode: "initialize" });

  // Modify 1 file and measure incremental update
  fs.appendFileSync(path.join(repoDir, "src", "module42.js"), "\nexport const PRORATION_MIN = 0;\n");
  const incRes = indexRepository(repoDir, { mode: "update" });

  const queries = [
    "computeModule42",
    "proration",
    "BUG-BENCH-42",
    "ZC-BENCH-042",
    "computeModule42",
  ];

  let totalNaiveMs = 0;
  let totalNaiveFiles = 0;
  let totalNaiveBytes = 0;

  let totalGraphMs = 0;
  let totalGraphFiles = 0;
  let totalGraphBytes = 0;

  for (const q of queries) {
    const naive = naiveFullScanDebug(repoDir, q);
    totalNaiveMs += naive.durationMs;
    totalNaiveFiles += naive.filesOpened;
    totalNaiveBytes += naive.bytesRead;

    const ctx = retrieveCodeContext(repoDir, { mode: "debug", query: q, autoUpdate: false });
    totalGraphMs += ctx.durationMs;
    totalGraphFiles += ctx.filesReturned;
    totalGraphBytes += Buffer.byteLength(JSON.stringify(ctx), "utf8");
  }

  const report = {
    syntheticRepoFiles: initRes.stats.files_indexed,
    initialIndexDurationMs: initRes.durationMs,
    incrementalUpdateDurationMs: incRes.durationMs,
    incrementalFilesUpdated: incRes.filesUpdated,
    dbSizeBytes: incRes.stats.db_size_bytes,
    repeatedQueriesCount: queries.length,
    baselineFullScan: {
      totalDurationMs: Number(totalNaiveMs.toFixed(2)),
      avgDurationMs: Number((totalNaiveMs / queries.length).toFixed(2)),
      totalFilesOpened: totalNaiveFiles,
      totalBytesRead: totalNaiveBytes,
    },
    zettlyCodeGraph: {
      totalDurationMs: Number(totalGraphMs.toFixed(2)),
      avgDurationMs: Number((totalGraphMs / queries.length).toFixed(2)),
      totalFilesReturned: totalGraphFiles,
      totalContextBytes: totalGraphBytes,
    },
    reductions: {
      filesOpenedReductionPct: Number(
        (((totalNaiveFiles - totalGraphFiles) / totalNaiveFiles) * 100).toFixed(1)
      ),
      speedupFactor: Number((totalNaiveMs / Math.max(totalGraphMs, 0.1)).toFixed(2)),
    },
  };

  console.log(JSON.stringify(report, null, 2));
} finally {
  fs.rmSync(repoDir, { recursive: true, force: true });
}
