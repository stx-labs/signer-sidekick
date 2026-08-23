import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoots = [
  "apps",
  "packages",
  "contracts",
  "network-compatibility",
  "trusted-managers",
  "scripts",
];
const sourceFiles = [
  ".dockerignore",
  ".github/workflows/release.yml",
  "Dockerfile",
  "compose.host-network.yaml",
  "compose.release.yaml",
  "compose.yaml",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
];
// Test-only tooling never ships and must not invalidate an approval: script unit tests and the
// released-Devnet harness (`e2e-devnet.mjs`, `devnet-*.mjs`, `verify-devnet-lock.mjs`).
const ignoredScriptFile =
  /^scripts\/(?:.*\.test\.mjs|e2e-devnet\.mjs|devnet-[a-z-]+\.mjs|verify-devnet-lock\.mjs)$/;
const ignoredDirectoryNames = new Set([
  "node_modules",
  "dist",
  "coverage",
  "data",
  "backups",
  "tmp",
  ".runtime",
  "artifacts",
  "playwright-report",
  "test-results",
]);

function normalized(path) {
  return relative(root, path).split(sep).join("/");
}

function ignored(path, directory) {
  const relativePath = normalized(path);
  const parts = relativePath.split("/");
  if (directory && ignoredDirectoryNames.has(parts.at(-1))) return true;
  if (!directory && relativePath.endsWith(".md")) return true;
  if (!directory && ignoredScriptFile.test(relativePath)) return true;
  return /^trusted-managers\/[^/]+\.json$/.test(relativePath);
}

async function filesUnder(path) {
  const files = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (ignored(child, entry.isDirectory())) continue;
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Symbolic link is not allowed in operator-run fingerprint scope: ${normalized(child)}`,
      );
    }
    if (entry.isDirectory()) files.push(...(await filesUnder(child)));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

export async function calculateSourceFingerprint() {
  const files = (
    await Promise.all([
      ...sourceRoots.map(async (path) => await filesUnder(resolve(root, path))),
      sourceFiles.map((path) => resolve(root, path)),
    ])
  )
    .flat()
    .sort((left, right) => normalized(left).localeCompare(normalized(right)));
  const aggregate = createHash("sha256");
  for (const path of files) {
    aggregate.update(normalized(path));
    aggregate.update("\0");
    aggregate.update(
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    );
    aggregate.update("\n");
  }
  return aggregate.digest("hex");
}

async function main() {
  const fingerprint = await calculateSourceFingerprint();
  const output = process.argv[2];
  if (output) await writeFile(resolve(output), `${fingerprint}\n`, { mode: 0o644 });
  process.stdout.write(`${fingerprint}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await main();
