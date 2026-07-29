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
    "contracts/upstream/stacks-core-4.0.1/pox-5.clar",
    "ffad35ad181d85832ebd7b998f445204c92d5cd19549166e644fb1f3988fa385",
  ],
  [
    "contracts/reference-manager/upstream/signer-manager.clar",
    "ac552739b668226930e679b6b13fcf1af411b30688d8b258cfae7ff7bf0b8695",
  ],
  [
    "contracts/upstream/sbtc-mainnet/sbtc-registry.clar",
    "6769b24ae384bf5c3a15922a8ed42298b6bb7723ae30cf59c8619c172f500887",
  ],
  [
    "contracts/upstream/sbtc-mainnet/sbtc-token.clar",
    "8f0a0edd55fa25613aac50769cf18a671227333850950d4f7f1f913ea0a9c8d1",
  ],
  [
    "contracts/upstream/sbtc-mainnet/sbtc-deposit.clar",
    "769a9a1e933c7dc23fd3b974d897ddcbb4b0f7b2329017bdbb84fd924bfcca29",
  ],
  [
    "contracts/upstream/sbtc-mainnet/sbtc-withdrawal.clar",
    "104a89bc5b54bb5c8c8c1429e2e10e43e324e00249a096f04084d536055e1e71",
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

const generatedManagers = [
  {
    network: "mainnet",
    profileId: "stacks-4.0.0-mainnet-reference-manager",
    sha256: "05aaf409ed285f02d8b6d5d540f94feb8baea139a14263b7e7de7ba9f054d3c5",
  },
  {
    network: "devnet",
    profileId: "stacks-4.0.0-devnet-reference-manager",
    sha256: "403254a3ce0a65a32b2aeb64a3c116a1a3ce5ee339f36d99edab3e4a605d7f38",
  },
  {
    network: "regtest",
    profileId: "stacks-4.0.0-regtest-reference-manager",
    sha256: "d5dfb736a5d464fac49ccfe38f77c100fe03464fb084a711c2ec21d2d0cc8045",
  },
];

for (const manager of generatedManagers) {
  const directory = resolve(root, `contracts/reference-manager/generated/${manager.network}`);
  const profile = JSON.parse(
    await readFile(
      resolve(root, `contracts/reference-manager/profiles/${manager.network}.json`),
      "utf8",
    ),
  );
  const metadata = JSON.parse(
    await readFile(resolve(directory, "signer-manager.metadata.json"), "utf8"),
  );
  const generated = await readFile(resolve(directory, "signer-manager.clar"));
  const actual = createHash("sha256").update(generated).digest("hex");
  if (metadata.profileId !== manager.profileId) {
    throw new Error(
      `Generated ${manager.network} manager profile mismatch: expected ${manager.profileId}, got ${metadata.profileId}`,
    );
  }
  if (
    metadata.network !== profile.network ||
    metadata.productionApproved !== profile.productionApproved ||
    metadata.upstreamTag !== profile.upstream.tag ||
    metadata.upstreamCommit !== profile.upstream.commit ||
    metadata.sourceSha256 !== profile.upstream.sourceSha256 ||
    JSON.stringify(metadata.replacements) !== JSON.stringify(profile.expectedReplacements)
  ) {
    throw new Error(`Generated ${manager.network} manager metadata does not match its profile`);
  }
  if (metadata.outputSha256 !== actual || actual !== manager.sha256) {
    throw new Error(
      `Generated ${manager.network} manager hash mismatch: expected ${manager.sha256}, got ${actual}`,
    );
  }
  console.log(`Verified generated ${manager.network} manager (${actual})`);
}

const regtestMetadata = JSON.parse(
  await readFile(resolve(root, "test/integration/regtest/contracts/metadata.json"), "utf8"),
);
if (
  regtestMetadata.upstreamDeployer !== "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4" ||
  regtestMetadata.regtestDeployer !== "ST1F7QA2MDF17S807EPA36TSS8AMEFY4KA9TVGWXT"
) {
  throw new Error("Regtest dependency metadata contains unexpected deployer principals");
}
for (const [name, metadata] of Object.entries(regtestMetadata.contracts)) {
  const body = await readFile(resolve(root, `test/integration/regtest/contracts/${name}.clar`));
  const actual = createHash("sha256").update(body).digest("hex");
  if (actual !== metadata.outputSha256) {
    throw new Error(
      `Generated regtest ${name} hash mismatch: expected ${metadata.outputSha256}, got ${actual}`,
    );
  }
  console.log(`Verified generated regtest ${name} (${actual})`);
}
