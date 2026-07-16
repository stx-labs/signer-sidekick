import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const arguments_ = process.argv.slice(2);
const valueFor = (flag) => arguments_[arguments_.indexOf(flag) + 1];
const outputPath = valueFor("--output");
const sidekickPrefix = valueFor("--sidekick-prefix") ?? "signer-sidekick-e2e-";
const intervalMs = Number(process.env.SIDEKICK_RESOURCE_SAMPLE_INTERVAL_MS ?? "5000");
const clarinetProject = "signer-sidekick-pox5-e2e";

if (!outputPath) throw new Error("Usage: devnet-resource-monitor.mjs --output <path>");
if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000) {
  throw new Error("SIDEKICK_RESOURCE_SAMPLE_INTERVAL_MS must be an integer >= 1000");
}

function docker(arguments__) {
  const result = spawnSync("docker", arguments__, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return "";
  return String(result.stdout ?? "").trim();
}

function parseBytes(value) {
  const match = String(value)
    .trim()
    .match(/^([0-9.]+)\s*([kmgt]?i?b)$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = {
    b: 1,
    kb: 1_000,
    mb: 1_000_000,
    gb: 1_000_000_000,
    tb: 1_000_000_000_000,
    kib: 1_024,
    mib: 1_048_576,
    gib: 1_073_741_824,
    tib: 1_099_511_627_776,
  };
  return Number.isFinite(amount) ? Math.round(amount * multipliers[unit]) : null;
}

function parsePair(value) {
  const [first, second] = String(value)
    .split("/")
    .map((item) => parseBytes(item));
  return [first ?? null, second ?? null];
}

function containers() {
  const output = docker([
    "ps",
    "--format",
    '{{.ID}}\t{{.Names}}\t{{.Label "com.docker.compose.project"}}',
  ]);
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id, name, project] = line.split("\t");
      return { id, name, project };
    })
    .filter(({ name, project }) => project === clarinetProject || name.startsWith(sidekickPrefix));
}

function sample() {
  const observations = [];
  for (const container of containers()) {
    const raw = docker(["stats", "--no-stream", "--format", "{{json .}}", container.id]);
    if (!raw) continue;
    try {
      const stats = JSON.parse(raw);
      const [memoryBytes, memoryLimitBytes] = parsePair(stats.MemUsage);
      const [blockReadBytes, blockWriteBytes] = parsePair(stats.BlockIO);
      const writableLayer = docker(["inspect", "--size", "--format", "{{.SizeRw}}", container.id]);
      observations.push({
        name: container.name,
        image: stats.Image,
        cpuPercent: Number.parseFloat(stats.CPUPerc) || 0,
        memoryBytes,
        memoryLimitBytes,
        memoryPercent: Number.parseFloat(stats.MemPerc) || 0,
        blockReadBytes,
        blockWriteBytes,
        writableLayerBytes: /^\d+$/.test(writableLayer) ? Number(writableLayer) : null,
        pids: Number(stats.PIDs) || 0,
      });
    } catch {
      // A container may disappear between `docker ps` and `docker stats` during cleanup.
    }
  }
  appendFileSync(
    outputPath,
    `${JSON.stringify({ observedAt: new Date().toISOString(), containers: observations })}\n`,
    { mode: 0o600 },
  );
}

let stopping = false;
const stop = () => {
  stopping = true;
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

sample();
while (!stopping) {
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
  if (!stopping) sample();
}
