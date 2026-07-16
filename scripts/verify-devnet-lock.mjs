import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const lockPath = resolve(root, "test/e2e/devnet/versions.lock.json");
const settingsPath = resolve(root, "test/e2e/devnet/settings/Devnet.toml");
const offline = process.argv.includes("--offline");
const lock = JSON.parse(await readFile(lockPath, "utf8"));

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}${result.stderr}`);
  }
  return result.stdout.trim();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

invariant(lock.schemaVersion === 1, "Unsupported Devnet lock schema");
invariant(/^\d+\.\d+\.\d+$/.test(lock.clarinet.version), "Invalid Clarinet version");
invariant(/^[0-9a-f]{40}$/.test(lock.stacksCore.commit), "Invalid stacks-core commit");

const metadataPath = resolve(root, lock.manager.source.replace(/\.clar$/, ".metadata.json"));
const [managerSource, managerProfile, managerMetadata, devnetSettings] = await Promise.all([
  readFile(resolve(root, lock.manager.source), "utf8"),
  readFile(resolve(root, lock.manager.profile), "utf8").then(JSON.parse),
  readFile(metadataPath, "utf8").then(JSON.parse),
  readFile(settingsPath, "utf8"),
]);
invariant(
  sha256(managerSource) === lock.manager.sha256,
  `Devnet manager hash mismatch: expected ${lock.manager.sha256}, got ${sha256(managerSource)}`,
);
invariant(
  managerProfile.upstream.tag === lock.stacksCore.tag &&
    managerProfile.upstream.commit === lock.stacksCore.commit,
  "Devnet manager profile does not match the stacks-core lock",
);
invariant(managerMetadata.profileId === managerProfile.id, "Devnet manager metadata profile drift");
invariant(
  managerMetadata.network === managerProfile.network,
  "Devnet manager metadata network drift",
);
invariant(
  managerMetadata.productionApproved === managerProfile.productionApproved,
  "Devnet manager metadata approval drift",
);
invariant(
  managerMetadata.outputSha256 === lock.manager.sha256,
  "Devnet manager metadata output hash drift",
);
invariant(
  managerMetadata.canonicalOutputSha256 === lock.manager.canonicalSha256,
  "Devnet manager metadata canonical hash drift",
);
invariant(
  JSON.stringify(managerMetadata.replacements) ===
    JSON.stringify(managerProfile.expectedReplacements),
  "Devnet manager metadata replacement-count drift",
);

const imageResults = [];
for (const [name, image] of Object.entries(lock.images)) {
  invariant(/^sha256:[0-9a-f]{64}$/.test(image.digest), `Invalid ${name} image digest`);
  const pinned = `${image.reference}@${image.digest}`;
  invariant(
    devnetSettings.includes(pinned),
    `Devnet settings do not use locked ${name} image ${pinned}`,
  );
  if (offline) {
    imageResults.push({
      name,
      reference: image.reference,
      digest: image.digest,
      verified: "local",
    });
    continue;
  }
  const inspection = run("docker", ["buildx", "imagetools", "inspect", image.reference]);
  const resolved = inspection.match(/^Digest:\s+(sha256:[0-9a-f]{64})$/m)?.[1];
  invariant(resolved, `Could not resolve registry digest for ${image.reference}`);
  invariant(
    resolved === image.digest,
    `${name} image drift: lock has ${image.digest}, registry resolves ${resolved}`,
  );
  imageResults.push({ name, reference: image.reference, digest: resolved, verified: "registry" });
}

if (!offline) {
  const remote = run("git", [
    "ls-remote",
    lock.stacksCore.repository,
    `refs/tags/${lock.stacksCore.tag}`,
  ]);
  const commit = remote.split(/\s+/)[0];
  invariant(
    commit === lock.stacksCore.commit,
    `stacks-core tag drift: expected ${lock.stacksCore.commit}, got ${commit || "missing"}`,
  );
}

console.log(
  JSON.stringify(
    {
      status: "pass",
      mode: offline ? "offline" : "registry",
      clarinet: lock.clarinet.version,
      stacksCore: { tag: lock.stacksCore.tag, commit: lock.stacksCore.commit },
      manager: { source: lock.manager.source, sha256: lock.manager.sha256 },
      images: imageResults,
    },
    null,
    2,
  ),
);
