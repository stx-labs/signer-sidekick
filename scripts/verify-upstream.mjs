import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sources = new Map([
  [
    "contracts/upstream/stacks-core-4.0.0/pox-5.clar",
    "39c33b7e2cf9864e974e15b1d776045fcc46c583092330305293b97d2ae4135c",
  ],
  [
    "contracts/reference-manager/upstream/signer-manager.clar",
    "f86819132e5c4e6f00d491b27f32ded4c3342c2be875ff90d1eba70fd5f0a5cf",
  ],
]);

for (const [path, expected] of sources) {
  const body = await readFile(resolve(root, path));
  const actual = createHash("sha256").update(body).digest("hex");
  if (actual !== expected) {
    throw new Error(`Hash mismatch for ${path}: expected ${expected}, got ${actual}`);
  }
  console.log(`Verified ${path} (${actual})`);
}

const metadataPath = resolve(
  root,
  "contracts/reference-manager/generated/mainnet/signer-manager.metadata.json",
);

try {
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  const generatedPath = resolve(
    root,
    "contracts/reference-manager/generated/mainnet/signer-manager.clar",
  );
  const generated = await readFile(generatedPath);
  const actual = createHash("sha256").update(generated).digest("hex");
  if (metadata.outputSha256 !== actual) {
    throw new Error(
      `Generated manager hash mismatch: expected ${metadata.outputSha256}, got ${actual}`,
    );
  }
  console.log(`Verified generated mainnet manager (${actual})`);
} catch (error) {
  if (error?.code === "ENOENT") {
    console.log("Generated mainnet manager is not present yet; source pins are valid");
  } else {
    throw error;
  }
}
