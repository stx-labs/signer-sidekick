import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const sources = [
  {
    path: "contracts/upstream/stacks-core-4.0.0/pox-5.clar",
    url: "https://raw.githubusercontent.com/stacks-network/stacks-core/4.0.0/stackslib/src/chainstate/stacks/boot/pox-5.clar",
    sha256: "39c33b7e2cf9864e974e15b1d776045fcc46c583092330305293b97d2ae4135c",
  },
  {
    path: "contracts/reference-manager/upstream/signer-manager.clar",
    url: "https://raw.githubusercontent.com/stacks-network/stacks-core/4.0.0/contrib/core-contract-tests/contracts/signer-manager.clar",
    sha256: "f86819132e5c4e6f00d491b27f32ded4c3342c2be875ff90d1eba70fd5f0a5cf",
  },
];

for (const source of sources) {
  const response = await fetch(source.url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Unable to fetch ${source.url}: ${response.status} ${response.statusText}`);
  }

  const body = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(body).digest("hex");
  if (actual !== source.sha256) {
    throw new Error(`Hash mismatch for ${source.path}: expected ${source.sha256}, got ${actual}`);
  }

  const destination = resolve(root, source.path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, body);
  console.log(`Vendored ${source.path} (${actual})`);
}
