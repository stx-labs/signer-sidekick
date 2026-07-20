import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = join(repositoryRoot, "dist", "THIRD_PARTY_LICENSES.txt");
const overrideRegistryPath = join(repositoryRoot, "scripts", "third-party-license-overrides.json");
const overrideDocumentRoot = join(repositoryRoot, "scripts", "third-party-license-overrides");
const documentNamePattern = /^(?:licen[cs]e|notice|copying|copyright)(?:[._-].*)?$/i;
const releaseProjects = ["@stx-labs/signer-sidekick", "@stx-labs/signer-sidekick-dashboard"];
const overrideRegistry = JSON.parse(readFileSync(overrideRegistryPath, "utf8"));
if (
  overrideRegistry.schemaVersion !== 1 ||
  !overrideRegistry.packages ||
  typeof overrideRegistry.packages !== "object" ||
  !Array.isArray(overrideRegistry.packagePrefixes)
) {
  throw new Error("Invalid third-party license override registry");
}
const usedOverrides = new Set();

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function pnpmLicenseReports() {
  return releaseProjects.map((project) => {
    const pnpmArgs = ["--filter", project, "licenses", "list", "--prod", "--json"];
    const result = spawnSync("pnpm", pnpmArgs, {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
    });
    if (result.status !== 0) {
      process.stderr.write(result.stderr || result.stdout);
      throw new Error(`Unable to read installed production licenses for ${project}`);
    }
    return JSON.parse(result.stdout);
  });
}

function normalizedText(value) {
  return value
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .trimEnd();
}

function packageDocuments(packagePath) {
  return readdirSync(packagePath)
    .filter((name) => documentNamePattern.test(name))
    .filter((name) => statSync(join(packagePath, name)).isFile())
    .sort(compare)
    .map((name) => ({ name, text: normalizedText(readFileSync(join(packagePath, name), "utf8")) }));
}

function authorName(author) {
  if (typeof author === "string") return author;
  if (author && typeof author === "object" && typeof author.name === "string") return author.name;
  return null;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactOverride(key) {
  const override = overrideRegistry.packages[key];
  return override ? { id: `package:${key}`, ...override } : null;
}

function prefixOverride(metadata) {
  const matches = overrideRegistry.packagePrefixes.filter(
    ({ namePrefix, version }) =>
      metadata.name.startsWith(namePrefix) && metadata.version === version,
  );
  if (matches.length > 1) {
    throw new Error(
      `Multiple third-party license overrides match ${metadata.name}@${metadata.version}`,
    );
  }
  return matches[0]
    ? {
        id: `prefix:${matches[0].namePrefix}@${matches[0].version}`,
        ...matches[0],
      }
    : null;
}

function renderedSpdxLicense(override) {
  if (override.spdx === "MIT") {
    return `${override.copyright}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
  }
  if (override.spdx === "BSD-3-Clause") {
    return `${override.copyright}

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.`;
  }
  throw new Error(`Unsupported SPDX fallback ${override.spdx}`);
}

function overrideDocuments(metadata, key, licenses) {
  const override = exactOverride(key) ?? prefixOverride(metadata);
  if (!override) {
    throw new Error(`${key} has no installed license or notice document and no audited override`);
  }
  if (licenses.length !== 1 || licenses[0] !== override.spdx) {
    throw new Error(
      `Audited override ${override.id} declares ${override.spdx}, installed package declares ${licenses.join(" AND ")}`,
    );
  }
  if (typeof override.source !== "string" || !override.source.startsWith("https://")) {
    throw new Error(`Audited override ${override.id} has no HTTPS source`);
  }

  let licenseText;
  if (override.document) {
    const documentPath = resolve(overrideDocumentRoot, override.document);
    const documentRelativePath = relative(overrideDocumentRoot, documentPath);
    if (documentRelativePath.startsWith("..") || isAbsolute(documentRelativePath)) {
      throw new Error(`Audited override ${override.id} escapes its document directory`);
    }
    licenseText = normalizedText(readFileSync(documentPath, "utf8"));
    if (sha256(`${licenseText}\n`) !== override.sha256) {
      throw new Error(`Audited override ${override.id} failed its document checksum`);
    }
  } else {
    if (typeof override.copyright !== "string" || !override.copyright.startsWith("Copyright")) {
      throw new Error(`Audited override ${override.id} has no copyright attribution`);
    }
    licenseText = renderedSpdxLicense(override);
  }

  usedOverrides.add(override.id);
  return [
    {
      name: "LICENSE (audited override)",
      text: `Audited source: ${override.source}\n\n${licenseText}`,
    },
  ];
}

export function productionPackages(reports) {
  const packages = new Map();
  for (const report of reports) {
    for (const [licenseGroup, entries] of Object.entries(report)) {
      for (const entry of entries) {
        for (const packagePath of entry.paths) {
          const metadata = JSON.parse(readFileSync(join(packagePath, "package.json"), "utf8"));
          const key = `${metadata.name}@${metadata.version}`;
          const documents = packageDocuments(packagePath);
          const candidate = {
            key,
            name: metadata.name,
            version: metadata.version,
            licenses: [entry.license ?? licenseGroup].filter(Boolean),
            author: authorName(metadata.author) ?? entry.author ?? null,
            homepage: metadata.homepage ?? entry.homepage ?? metadata.repository?.url ?? null,
            documents,
          };
          if (candidate.documents.length === 0) {
            candidate.documents = overrideDocuments(metadata, key, candidate.licenses);
          }
          const existing = packages.get(key);
          if (!existing) {
            packages.set(key, candidate);
            continue;
          }
          existing.licenses = [...new Set([...existing.licenses, ...candidate.licenses])].sort(
            compare,
          );
          const existingDocuments = JSON.stringify(existing.documents);
          const candidateDocuments = JSON.stringify(candidate.documents);
          if (existingDocuments !== candidateDocuments) {
            throw new Error(`Installed copies of ${key} contain different license documents`);
          }
        }
      }
    }
  }
  const configuredOverrides = [
    ...Object.keys(overrideRegistry.packages).map((key) => `package:${key}`),
    ...overrideRegistry.packagePrefixes.map(
      ({ namePrefix, version }) => `prefix:${namePrefix}@${version}`,
    ),
  ];
  const unusedOverrides = configuredOverrides.filter((id) => !usedOverrides.has(id));
  if (unusedOverrides.length > 0) {
    throw new Error(`Unused third-party license overrides: ${unusedOverrides.join(", ")}`);
  }
  return [...packages.values()].sort((left, right) => compare(left.key, right.key));
}

function render(packages) {
  const lines = [
    "THIRD-PARTY SOFTWARE LICENSES AND NOTICES",
    "========================================",
    "",
    "Generated by scripts/generate-third-party-licenses.mjs from the exact installed",
    "production dependency graph. Do not edit this file by hand.",
    "",
    `PACKAGES: ${packages.length}`,
    "",
  ];
  for (const dependency of packages) {
    lines.push("------------------------------------------------------------------------", "");
    lines.push(`PACKAGE: ${dependency.key}`);
    lines.push(`DECLARED LICENSE: ${dependency.licenses.join(" AND ") || "UNKNOWN"}`);
    if (dependency.author) lines.push(`AUTHOR: ${dependency.author}`);
    if (dependency.homepage) lines.push(`HOMEPAGE: ${dependency.homepage}`);
    lines.push("");
    for (const document of dependency.documents) {
      lines.push(`--- ${document.name} ---`, "", document.text, "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function main() {
  const packages = productionPackages(pnpmLicenseReports());
  const artifact = render(packages);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, artifact, "utf8");
  process.stdout.write(`Generated dist/THIRD_PARTY_LICENSES.txt (${packages.length} packages)\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
