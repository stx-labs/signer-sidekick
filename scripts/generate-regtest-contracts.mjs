import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const upstreamDeployer = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4";
// Clarinet preloads the canonical testnet sBTC token and registry at this address before boot
// contracts are analyzed. The harness deploys the pinned withdrawal source beside them.
const regtestDeployer = "ST1F7QA2MDF17S807EPA36TSS8AMEFY4KA9TVGWXT";
const names = ["sbtc-registry", "sbtc-token", "sbtc-deposit", "sbtc-withdrawal"];
const outputDirectory = resolve(root, "test/integration/regtest/contracts");

await mkdir(outputDirectory, { recursive: true });

const metadata = {
  upstreamDeployer,
  regtestDeployer,
  contracts: {},
};

const pox5Source = await readFile(
  resolve(root, "contracts/upstream/stacks-core-4.0.0/pox-5.clar"),
  "utf8",
);
const pox5Replacements = pox5Source.split(upstreamDeployer).length - 1;
if (pox5Replacements !== 12) {
  throw new Error(`Expected 12 PoX-5 sBTC principal replacements, found ${pox5Replacements}`);
}
const generatedPox5 = pox5Source.replaceAll(upstreamDeployer, regtestDeployer);
await writeFile(resolve(outputDirectory, "pox-5.clar"), generatedPox5);
metadata.contracts["pox-5"] = {
  upstreamSha256: createHash("sha256").update(pox5Source).digest("hex"),
  outputSha256: createHash("sha256").update(generatedPox5).digest("hex"),
  replacements: pox5Replacements,
};
console.log(`Generated pox-5.clar (${pox5Replacements} sBTC principal replacements)`);

for (const name of names) {
  const upstreamPath = resolve(root, `contracts/upstream/sbtc-mainnet/${name}.clar`);
  const source = await readFile(upstreamPath, "utf8");
  const replacements = source.split(upstreamDeployer).length - 1;
  const generated = source.replaceAll(upstreamDeployer, regtestDeployer);
  if (generated.includes(upstreamDeployer)) {
    throw new Error(`${name} still contains the upstream sBTC deployer`);
  }
  const outputPath = resolve(outputDirectory, `${name}.clar`);
  await writeFile(outputPath, generated);
  metadata.contracts[name] = {
    upstreamSha256: createHash("sha256").update(source).digest("hex"),
    outputSha256: createHash("sha256").update(generated).digest("hex"),
    replacements,
  };
  console.log(
    `Generated ${name}.clar (${replacements} absolute principal replacements; relative calls retained)`,
  );
}

await writeFile(
  resolve(outputDirectory, "metadata.json"),
  `${JSON.stringify(metadata, null, 2)}\n`,
);
