#!/usr/bin/env node

import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyManagerCensus } from "./census-signer-managers.mjs";

const directory = resolve("research/signer-manager-census");
const entries = (await readdir(directory))
  .filter((entry) => /^mainnet-\d{4}-\d{2}-\d{2}\.json$/.test(entry))
  .sort();
if (entries.length === 0) throw new Error("No signer-manager census snapshots were found");
for (const entry of entries) {
  const result = await verifyManagerCensus(resolve(directory, entry));
  console.log(
    `${entry}: ${result.managers} managers, ${result.sources} sources, ${result.interfaces} interfaces (${result.artifactSha256})`,
  );
}
