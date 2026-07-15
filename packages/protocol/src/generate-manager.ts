import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { generateManagerArtifact } from "./manager-artifact.js";
import { parseManagerProfile } from "./profile.js";

const { values } = parseArgs({
  options: {
    profile: { type: "string" },
    source: { type: "string" },
    output: { type: "string" },
  },
});

if (!values.profile || !values.source || !values.output) {
  throw new Error("Usage: generate-manager --profile <json> --source <clar> --output <clar>");
}

const profilePath = resolve(values.profile);
const sourcePath = resolve(values.source);
const outputPath = resolve(values.output);
if (!outputPath.endsWith(".clar")) {
  throw new Error("--output must end in .clar so contract metadata cannot overwrite the artifact");
}
const metadataPath = outputPath.replace(/\.clar$/, ".metadata.json");

const profile = parseManagerProfile(JSON.parse(await readFile(profilePath, "utf8")));
const source = await readFile(sourcePath, "utf8");
const artifact = generateManagerArtifact(source, profile);

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, artifact.source);
await writeFile(metadataPath, `${JSON.stringify(artifact.metadata, null, 2)}\n`);

console.log(`Generated ${outputPath}`);
console.log(`Output SHA-256: ${artifact.metadata.outputSha256}`);
if (!artifact.metadata.productionApproved) {
  console.log("Profile is deterministic but not approved for production deployment");
}
