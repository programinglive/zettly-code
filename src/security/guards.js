/**
 * Security & path containment guards for Zettly Code.
 * Enforces workspace containment, symlink safety, secret exclusion,
 * and output redaction so confidential code knowledge never leaks.
 */

import fs from "node:fs";
import path from "node:path";

export const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  ".next",
  ".state",
  ".zettly-code",
  ".superpowers",
  "storage",
  "coverage",
  "__pycache__",
]);

export const SECRET_FILE_PATTERNS = [
  /^\.env(?:\.|$)/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /^id_(?:rsa|ed25519|ecdsa)$/i,
  /credentials\.json$/i,
  /secrets?\.(?:json|ya?ml)$/i,
];

export const SECRET_VALUE_REGEX =
  /(?:\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:live-|proj-|test-)?[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|AIza[0-9A-Za-z_-]{35}|xox[baprs]-[A-Za-z0-9-]{10,})\b|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----)/g;

export const PII_PATTERN =
  /\b(?:[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\+?\d{1,3}[-.\s]?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4})\b/;

export function isSecretFilePath(relPath) {
  const norm = String(relPath || "").replaceAll("\\", "/");
  const base = path.posix.basename(norm);
  return SECRET_FILE_PATTERNS.some((rx) => rx.test(base) || rx.test(norm));
}

export function containsSecretMaterial(text) {
  if (typeof text !== "string" || !text) return false;
  SECRET_VALUE_REGEX.lastIndex = 0;
  return SECRET_VALUE_REGEX.test(text);
}

export function redactSecrets(text) {
  if (typeof text !== "string" || !text) return "";
  SECRET_VALUE_REGEX.lastIndex = 0;
  return text.replace(SECRET_VALUE_REGEX, "<REDACTED_SECRET>");
}

export function normalizeRelPath(relPath) {
  return String(relPath || "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
}

/**
 * Resolve a candidate path strictly inside `repoRoot`.
 * Blocks path traversal (`../`) and symlinks escaping `repoRoot`.
 */
export function resolveContainedPath(repoRoot, candidatePath) {
  const realRoot = fs.realpathSync(path.resolve(repoRoot));
  const rawTarget = path.isAbsolute(candidatePath)
    ? path.resolve(candidatePath)
    : path.resolve(realRoot, candidatePath);

  const relFromRoot = path.relative(realRoot, rawTarget);
  if (relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot)) {
    return {
      ok: false,
      code: "PATH_TRAVERSAL_BLOCKED",
      reason: `Path escapes repository root: ${candidatePath}`,
    };
  }

  if (fs.existsSync(rawTarget)) {
    const lstat = fs.lstatSync(rawTarget);
    const realTarget = fs.realpathSync(rawTarget);
    const realRel = path.relative(realRoot, realTarget);
    if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
      return {
        ok: false,
        code: "SYMLINK_ESCAPE_BLOCKED",
        reason: `Symlink target escapes repository root: ${candidatePath}`,
      };
    }
    return {
      ok: true,
      absPath: realTarget,
      relPath: normalizeRelPath(realRel),
      isSymlink: lstat.isSymbolicLink(),
    };
  }

  return {
    ok: true,
    absPath: rawTarget,
    relPath: normalizeRelPath(relFromRoot),
    isSymlink: false,
  };
}
