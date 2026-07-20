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
    path: "contracts/upstream/stacks-core-4.0.1/pox-5.clar",
    url: "https://raw.githubusercontent.com/stacks-network/stacks-core/4.0.1/stackslib/src/chainstate/stacks/boot/pox-5.clar",
    sha256: "ffad35ad181d85832ebd7b998f445204c92d5cd19549166e644fb1f3988fa385",
  },
  {
    path: "contracts/reference-manager/upstream/signer-manager.clar",
    url: "https://raw.githubusercontent.com/stacks-network/stacks-core/4.0.0/contrib/core-contract-tests/contracts/signer-manager.clar",
    sha256: "f86819132e5c4e6f00d491b27f32ded4c3342c2be875ff90d1eba70fd5f0a5cf",
  },
  {
    path: "contracts/upstream/sbtc-mainnet/sbtc-registry.clar",
    url: "https://api.mainnet.hiro.so/v2/contracts/source/SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4/sbtc-registry?proof=0",
    sha256: "6769b24ae384bf5c3a15922a8ed42298b6bb7723ae30cf59c8619c172f500887",
    jsonField: "source",
  },
  {
    path: "contracts/upstream/sbtc-mainnet/sbtc-token.clar",
    url: "https://api.mainnet.hiro.so/v2/contracts/source/SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4/sbtc-token?proof=0",
    sha256: "8f0a0edd55fa25613aac50769cf18a671227333850950d4f7f1f913ea0a9c8d1",
    jsonField: "source",
  },
  {
    path: "contracts/upstream/sbtc-mainnet/sbtc-deposit.clar",
    url: "https://api.mainnet.hiro.so/v2/contracts/source/SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4/sbtc-deposit?proof=0",
    sha256: "769a9a1e933c7dc23fd3b974d897ddcbb4b0f7b2329017bdbb84fd924bfcca29",
    jsonField: "source",
  },
  {
    path: "contracts/upstream/sbtc-mainnet/sbtc-withdrawal.clar",
    url: "https://api.mainnet.hiro.so/v2/contracts/source/SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4/sbtc-withdrawal?proof=0",
    sha256: "104a89bc5b54bb5c8c8c1429e2e10e43e324e00249a096f04084d536055e1e71",
    jsonField: "source",
  },
];

for (const source of sources) {
  const response = await fetch(source.url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Unable to fetch ${source.url}: ${response.status} ${response.statusText}`);
  }

  const responseBody = Buffer.from(await response.arrayBuffer());
  const body = source.jsonField
    ? Buffer.from(JSON.parse(responseBody.toString("utf8"))[source.jsonField], "utf8")
    : responseBody;
  const actual = createHash("sha256").update(body).digest("hex");
  if (actual !== source.sha256) {
    throw new Error(`Hash mismatch for ${source.path}: expected ${source.sha256}, got ${actual}`);
  }

  const destination = resolve(root, source.path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, body);
  console.log(`Vendored ${source.path} (${actual})`);
}
