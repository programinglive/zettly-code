/**
 * Canonical `@zettly-code` knowledge comment parser, formatter,
 * generator (`generateBugFixKnowledge`), and validator (`validateKnowledgeComments`).
 *
 * Supports JSDoc/PHPDoc block comments AND version-controlled sidecar records
 * (`.zettly-code/sidecars/*.json`) for generated or non-commentable files.
 */

import fs from "node:fs";
import path from "node:path";
import {
  containsSecretMaterial,
  PII_PATTERN,
  normalizeRelPath,
  resolveContainedPath,
} from "../security/guards.js";

export const REQUIRED_BUGFIX_TAGS = Object.freeze([
  "zettly-code",
  "purpose",
  "bug-fix",
  "fix",
]);

/**
 * Parse all `@zettly-code` structured comment blocks from a source file.
 */
export function parseKnowledgeComments({ relPath, content }) {
  const normPath = normalizeRelPath(relPath);
  const text = String(content || "");
  const annotations = [];
  const syntaxErrors = [];

  const blockRegex = /\/\*\*([\s\S]*?)\*\//g;
  let match;
  while ((match = blockRegex.exec(text)) !== null) {
    const rawBlock = match[0];
    if (!rawBlock.includes("@zettly-code")) continue;

    const beforeText = text.slice(0, match.index);
    const startLine = beforeText.split(/\r?\n/).length;
    const endLine = startLine + rawBlock.split(/\r?\n/).length - 1;

    const cleanedLines = match[1]
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*\*?\s?/, "").trimEnd());

    const fields = {
      id: null,
      purpose: "",
      domain: null,
      invariants: [],
      bugFixes: [],
      rootCause: null,
      rootCauseStatus: "UNSPECIFIED",
      hypothesis: null,
      fix: null,
      related: [],
      tests: [],
      commit: null,
      entity: null,
    };

    let currentTag = null;
    for (const line of cleanedLines) {
      const trimmed = line.trim();
      if (!trimmed) {
        currentTag = null;
        continue;
      }

      const tagMatch = /^@([a-z-]+)(?:\s+(.*))?$/i.exec(trimmed);
      if (tagMatch) {
        const tag = tagMatch[1].toLowerCase();
        const val = (tagMatch[2] || "").trim();
        currentTag = tag;

        if (tag === "zettly-code") {
          fields.id = val || null;
        } else if (tag === "purpose") {
          fields.purpose = val;
        } else if (tag === "domain") {
          fields.domain = val || null;
        } else if (tag === "invariant") {
          if (val) fields.invariants.push(val);
        } else if (tag === "bug-fix") {
          if (val) fields.bugFixes.push(val);
        } else if (tag === "root-cause") {
          fields.rootCause = val;
          fields.rootCauseStatus = "CONFIRMED";
        } else if (tag === "hypothesis") {
          fields.hypothesis = val;
          if (fields.rootCauseStatus === "UNSPECIFIED") {
            fields.rootCauseStatus = "HYPOTHESIS_ONLY";
          }
        } else if (tag === "fix") {
          fields.fix = val;
        } else if (tag === "related") {
          if (val) fields.related.push(...val.split(/[,\s]+/).filter(Boolean));
        } else if (tag === "tests" || tag === "test") {
          if (val) fields.tests.push(...val.split(/[,\s]+/).filter(Boolean));
        } else if (tag === "commit" || tag === "revision") {
          fields.commit = val || null;
        } else if (tag === "entity") {
          fields.entity = val || null;
        } else {
          syntaxErrors.push({
            code: "UNKNOWN_ZETTLY_TAG",
            file: normPath,
            line: startLine,
            message: `Unsupported @${tag} tag in @zettly-code block`,
          });
        }
      } else if (currentTag) {
        // Multi-line continuation
        if (currentTag === "purpose") fields.purpose = `${fields.purpose} ${trimmed}`.trim();
        else if (currentTag === "invariant" && fields.invariants.length) {
          fields.invariants[fields.invariants.length - 1] += ` ${trimmed}`;
        } else if (currentTag === "root-cause") {
          fields.rootCause = `${fields.rootCause || ""} ${trimmed}`.trim();
        } else if (currentTag === "hypothesis") {
          fields.hypothesis = `${fields.hypothesis || ""} ${trimmed}`.trim();
        } else if (currentTag === "fix") {
          fields.fix = `${fields.fix || ""} ${trimmed}`.trim();
        }
      }
    }

    // Attempt to identify immediately following code entity declaration
    const afterBlock = text.slice(match.index + rawBlock.length);
    const nextDeclMatch =
      /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+|public\s+|protected\s+|private\s+|static\s+|final\s+|abstract\s+)*(?:class|interface|trait|function)\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(
        afterBlock
      ) ||
      /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/.exec(afterBlock);

    const attachedSymbol = fields.entity || (nextDeclMatch ? nextDeclMatch[1] : null);

    if (!fields.id || !/^[A-Z0-9][A-Z0-9_-]{3,80}$/.test(fields.id)) {
      syntaxErrors.push({
        code: "INVALID_KNOWLEDGE_ID",
        file: normPath,
        line: startLine,
        message: `Invalid or missing @zettly-code ID '${fields.id || ""}' (expected format like ZC-TODO-SAVE-001).`,
      });
    }

    annotations.push({
      ...fields,
      file_path: normPath,
      start_line: startLine,
      end_line: endLine,
      attached_symbol: attachedSymbol,
      raw_block: rawBlock,
      source_kind: "inline_comment",
    });
  }

  return { annotations, syntaxErrors };
}

/**
 * Load version-controlled sidecar knowledge records for generated or non-commentable files
 * stored under `engineering/zettly-code-sidecars/*.json` or `.zettly-code-sidecars/*.json`.
 */
export function loadSidecarKnowledgeRecords(repoRoot) {
  const records = [];
  const dirs = [
    path.join(repoRoot, "engineering", "zettly-code-sidecars"),
    path.join(repoRoot, ".zettly-code-sidecars"),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, entry), "utf8"));
        const list = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of list) {
          if (!item || !item.id) continue;
          records.push({
            id: item.id,
            purpose: item.purpose || "",
            domain: item.domain || null,
            invariants: Array.isArray(item.invariants) ? item.invariants : item.invariant ? [item.invariant] : [],
            bugFixes: Array.isArray(item.bugFixes) ? item.bugFixes : item.bugFix ? [item.bugFix] : [],
            rootCause: item.rootCause || null,
            rootCauseStatus: item.rootCauseStatus || (item.rootCause ? "CONFIRMED" : "HYPOTHESIS_ONLY"),
            hypothesis: item.hypothesis || null,
            fix: item.fix || null,
            related: Array.isArray(item.related) ? item.related : [],
            tests: Array.isArray(item.tests) ? item.tests : [],
            commit: item.commit || null,
            file_path: normalizeRelPath(item.targetFile || item.file_path || `engineering/zettly-code-sidecars/${entry}`),
            start_line: 1,
            end_line: 1,
            attached_symbol: item.entity || item.attached_symbol || path.posix.basename(item.targetFile || entry),
            source_kind: "sidecar_record",
            sidecar_file: normalizeRelPath(path.relative(repoRoot, path.join(dir, entry))),
          });
        }
      } catch {
        // Ignore malformed sidecar JSON (reported by validator if needed)
      }
    }
  }
  return records;
}

/**
 * Format a concise, valid `@zettly-code` JSDoc/PHPDoc annotation block.
 * Enforces root-cause truthfulness: unconfirmed hypotheses use `@hypothesis`, NEVER `@root-cause`.
 */
export function formatKnowledgeComment({
  id,
  purpose,
  domain = null,
  invariant = null,
  bugFix = null,
  rootCause = null,
  rootCauseConfirmed = true,
  hypothesis = null,
  fix = null,
  related = [],
  tests = [],
  commit = null,
  indent = "",
}) {
  const lines = [`${indent}/**`, `${indent} * @zettly-code ${id}`];
  if (purpose) lines.push(`${indent} * @purpose ${purpose}`);
  if (domain) lines.push(`${indent} * @domain ${domain}`);
  if (invariant) {
    lines.push(`${indent} *`);
    lines.push(`${indent} * @invariant ${invariant}`);
  }
  if (bugFix) {
    lines.push(`${indent} *`);
    lines.push(`${indent} * @bug-fix ${bugFix}`);
  }
  if (rootCause && rootCauseConfirmed) {
    lines.push(`${indent} * @root-cause ${rootCause}`);
  } else if (hypothesis || (rootCause && !rootCauseConfirmed)) {
    lines.push(`${indent} * @hypothesis ${hypothesis || rootCause}`);
  }
  if (fix) {
    lines.push(`${indent} *`);
    lines.push(`${indent} * @fix ${fix}`);
  }
  const relList = Array.isArray(related) ? related.filter(Boolean) : [];
  const testList = Array.isArray(tests) ? tests.filter(Boolean) : [];
  if (relList.length > 0 || testList.length > 0 || commit) {
    lines.push(`${indent} *`);
    for (const r of relList) lines.push(`${indent} * @related ${r}`);
    for (const t of testList) lines.push(`${indent} * @tests ${t}`);
    if (commit) lines.push(`${indent} * @commit ${commit}`);
  }
  lines.push(`${indent} */`);
  return lines.join("\n");
}

/**
 * Internal capability: `generateBugFixKnowledge`.
 * Creates or updates a concise `@zettly-code` annotation on the owning symbol
 * without duplicating existing comment blocks or writing secrets/speculation.
 */
export function generateBugFixKnowledge({
  content,
  relPath,
  targetSymbol = null,
  id,
  purpose,
  domain = null,
  invariant = null,
  bugFix,
  rootCause = null,
  rootCauseConfirmed = true,
  hypothesis = null,
  fix,
  related = [],
  tests = [],
  commit = null,
}) {
  const payloadText = [purpose, invariant, rootCause, hypothesis, fix].filter(Boolean).join(" ");
  if (containsSecretMaterial(payloadText)) {
    return {
      ok: false,
      code: "SECRET_MATERIAL_FORBIDDEN",
      message: "Refused to generate @zettly-code comment containing secret or credential material.",
    };
  }
  if (PII_PATTERN.test(payloadText)) {
    return {
      ok: false,
      code: "PII_FORBIDDEN_IN_COMMENT",
      message: "Refused to generate @zettly-code comment containing personal email/phone data.",
    };
  }

  const parsed = parseKnowledgeComments({ relPath, content });
  const existing = parsed.annotations.find(
    (a) => a.id === id || (targetSymbol && a.attached_symbol === targetSymbol)
  );

  const mergedRelated = Array.from(new Set([...(existing?.related || []), ...(related || [])]));
  const mergedTests = Array.from(new Set([...(existing?.tests || []), ...(tests || [])]));
  const effectiveId = existing?.id || id;

  const formatted = formatKnowledgeComment({
    id: effectiveId,
    purpose: purpose || existing?.purpose || `Maintain ${targetSymbol || path.posix.basename(relPath)}`,
    domain: domain || existing?.domain || null,
    invariant: invariant || existing?.invariants?.[0] || null,
    bugFix: bugFix || existing?.bugFixes?.[0] || null,
    rootCause: rootCauseConfirmed ? rootCause || existing?.rootCause : null,
    rootCauseConfirmed,
    hypothesis: !rootCauseConfirmed ? hypothesis || rootCause : null,
    fix: fix || existing?.fix || null,
    related: mergedRelated,
    tests: mergedTests,
    commit: commit || existing?.commit || null,
  });

  if (existing) {
    const updatedContent = content.replace(existing.raw_block, formatted);
    return {
      ok: true,
      action: "UPDATED_EXISTING_COMMENT",
      id: effectiveId,
      relPath: normalizeRelPath(relPath),
      commentBlock: formatted,
      updatedContent,
    };
  }

  // Insert right before the targetSymbol declaration if found, else at top (after <?php if PHP)
  let updatedContent = content;
  if (targetSymbol) {
    const escaped = targetSymbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const declRegex = new RegExp(
      `^([ \\t]*)(?:export\\s+(?:default\\s+)?)?(?:async\\s+|public\\s+|protected\\s+|private\\s+|static\\s+|final\\s+|abstract\\s+)*(?:class|interface|function|const|let|var)\\s+${escaped}\\b`,
      "m"
    );
    const m = declRegex.exec(content);
    if (m) {
      const indent = m[1] || "";
      const indentedBlock = formatted
        .split("\n")
        .map((l) => `${indent}${l}`)
        .join("\n");
      updatedContent =
        content.slice(0, m.index) + indentedBlock + "\n" + content.slice(m.index);
      return {
        ok: true,
        action: "INSERTED_BEFORE_SYMBOL",
        id: effectiveId,
        relPath: normalizeRelPath(relPath),
        commentBlock: indentedBlock,
        updatedContent,
      };
    }
  }

  if (content.startsWith("<?php")) {
    updatedContent = content.replace(/^<\?php\r?\n/, `<?php\n\n${formatted}\n`);
  } else {
    updatedContent = `${formatted}\n\n${content}`;
  }

  return {
    ok: true,
    action: "INSERTED_AT_TOP",
    id: effectiveId,
    relPath: normalizeRelPath(relPath),
    commentBlock: formatted,
    updatedContent,
  };
}

/**
 * Validate a collection of parsed `@zettly-code` annotations (inline + sidecar)
 * against actual parsed repository symbols and test names.
 * Detects:
 * - Duplicate knowledge IDs (KC-05)
 * - Syntax / unknown tag errors (KC-07)
 * - Missing / broken `@related` or `@tests` references (KC-06, KC-15)
 * - Secret or PII leakage (KC-12)
 * - Empty or trivial purpose/fix statements
 */
export function validateKnowledgeAnnotations({
  annotations = [],
  syntaxErrors = [],
  knownSymbols = new Set(),
  knownTestSymbols = new Set(),
  knownFiles = new Set(),
}) {
  const issues = [...syntaxErrors];
  const seenIds = new Map();

  for (const ann of annotations) {
    // 1. Duplicate ID check
    if (ann.id) {
      if (seenIds.has(ann.id)) {
        issues.push({
          code: "DUPLICATE_KNOWLEDGE_ID",
          severity: "error",
          id: ann.id,
          file: ann.file_path,
          line: ann.start_line,
          message: `Duplicate @zettly-code ID '${ann.id}' already declared in ${seenIds.get(ann.id)}.`,
        });
      } else {
        seenIds.set(ann.id, `${ann.file_path}:${ann.start_line}`);
      }
    }

    // 2. Secret & PII check
    const fullText = [
      ann.purpose,
      ...(ann.invariants || []),
      ann.rootCause,
      ann.hypothesis,
      ann.fix,
    ]
      .filter(Boolean)
      .join(" ");

    if (containsSecretMaterial(fullText)) {
      issues.push({
        code: "SECRET_IN_KNOWLEDGE_COMMENT",
        severity: "error",
        id: ann.id,
        file: ann.file_path,
        line: ann.start_line,
        message: `Secret/credential pattern detected in @zettly-code '${ann.id}'.`,
      });
    }
    if (PII_PATTERN.test(fullText)) {
      issues.push({
        code: "PII_IN_KNOWLEDGE_COMMENT",
        severity: "error",
        id: ann.id,
        file: ann.file_path,
        line: ann.start_line,
        message: `Personal data (email/phone) detected in @zettly-code '${ann.id}'.`,
      });
    }

    // 3. Purpose non-triviality check
    if (!ann.purpose || ann.purpose.trim().length < 8) {
      issues.push({
        code: "MISSING_OR_TRIVIAL_PURPOSE",
        severity: "error",
        id: ann.id,
        file: ann.file_path,
        line: ann.start_line,
        message: `@zettly-code '${ann.id}' must include a meaningful @purpose (>= 8 chars).`,
      });
    }

    // 4. Bug-fix comment completeness check
    if (ann.bugFixes && ann.bugFixes.length > 0) {
      if (!ann.rootCause && !ann.hypothesis) {
        issues.push({
          code: "MISSING_ROOT_CAUSE_OR_HYPOTHESIS",
          severity: "error",
          id: ann.id,
          file: ann.file_path,
          line: ann.start_line,
          message: `Bug-fix annotation '${ann.id}' must record confirmed @root-cause or unconfirmed @hypothesis.`,
        });
      }
      if (!ann.fix || ann.fix.trim().length < 8) {
        issues.push({
          code: "MISSING_FIX_SUMMARY",
          severity: "error",
          id: ann.id,
          file: ann.file_path,
          line: ann.start_line,
          message: `Bug-fix annotation '${ann.id}' must include @fix summary.`,
        });
      }
    }

    // 5. Reference validation against actual parsed symbols / files (broken or stale links)
    if (knownSymbols.size > 0) {
      for (const rel of ann.related || []) {
        const exists =
          knownSymbols.has(rel) ||
          knownFiles.has(rel) ||
          Array.from(knownFiles).some((f) => path.posix.basename(f, path.posix.extname(f)) === rel);
        if (!exists) {
          issues.push({
            code: "BROKEN_RELATED_REFERENCE",
            severity: "warning",
            id: ann.id,
            file: ann.file_path,
            line: ann.start_line,
            reference: rel,
            message: `@related '${rel}' in '${ann.id}' does not match any indexed symbol or file (stale or broken reference).`,
          });
        }
      }
    }

    if (knownTestSymbols.size > 0 || knownFiles.size > 0) {
      for (const tRef of ann.tests || []) {
        const exists =
          knownTestSymbols.has(tRef) ||
          knownSymbols.has(tRef) ||
          knownFiles.has(tRef) ||
          Array.from(knownFiles).some(
            (f) =>
              path.posix.basename(f) === tRef ||
              path.posix.basename(f, path.posix.extname(f)) === tRef
          );
        if (!exists) {
          issues.push({
            code: "BROKEN_TEST_REFERENCE",
            severity: "warning",
            id: ann.id,
            file: ann.file_path,
            line: ann.start_line,
            reference: tRef,
            message: `@tests '${tRef}' in '${ann.id}' does not match any indexed test file or test symbol.`,
          });
        }
      }
    }
  }

  const errors = issues.filter((i) => i.severity !== "warning");
  const warnings = issues.filter((i) => i.severity === "warning");

  return {
    valid: errors.length === 0,
    annotationsCount: annotations.length,
    errorsCount: errors.length,
    warningsCount: warnings.length,
    errors,
    warnings,
    issues,
  };
}
