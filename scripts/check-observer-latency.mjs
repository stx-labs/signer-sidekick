import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const latencyBuckets = [1, 2, 5, 10, 30, Number.POSITIVE_INFINITY];

function metricValue(metrics, name, domain) {
  const prefix = `${name}{domain="${domain}"} `;
  const line = metrics.split("\n").find((candidate) => candidate.startsWith(prefix));
  if (!line) throw new Error(`Metrics did not include ${name} for domain ${domain}`);
  const value = Number(line.slice(prefix.length));
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Metric ${name} for domain ${domain} was not a non-negative number`);
  }
  return value;
}

export function observerLatencySample(metrics, domain = "current") {
  const count = metricValue(
    metrics,
    "sidekick_observer_reconciliation_latency_seconds_count",
    domain,
  );
  const withinTwoSeconds = metricValue(
    metrics,
    "sidekick_observer_reconciliation_within_two_seconds_total",
    domain,
  );
  const buckets = Object.fromEntries(
    latencyBuckets.map((boundary) => {
      const rendered = Number.isFinite(boundary) ? String(boundary) : "+Inf";
      return [
        rendered,
        metricValue(
          metrics,
          "sidekick_observer_reconciliation_latency_seconds_bucket",
          `${domain}",le="${rendered}`,
        ),
      ];
    }),
  );
  return { count, withinTwoSeconds, buckets };
}

function delta(after, before = null) {
  const value = after - (before ?? 0);
  if (value < 0) {
    throw new Error("Observer latency counters reset during the measurement window; retry");
  }
  return value;
}

export function assessObserverLatency({ before = null, after, minimumSamples = 100 }) {
  if (!Number.isSafeInteger(minimumSamples) || minimumSamples < 1) {
    throw new Error("minimumSamples must be a positive integer");
  }
  const count = delta(after.count, before?.count);
  const withinTwoSeconds = delta(after.withinTwoSeconds, before?.withinTwoSeconds);
  const buckets = Object.fromEntries(
    latencyBuckets.map((boundary) => {
      const rendered = Number.isFinite(boundary) ? String(boundary) : "+Inf";
      return [rendered, delta(after.buckets[rendered], before?.buckets[rendered])];
    }),
  );
  if (withinTwoSeconds !== buckets["2"] || buckets["+Inf"] !== count) {
    throw new Error("Observer latency counters and histogram buckets disagree");
  }
  const requiredWithinTarget = Math.ceil(count * 0.95);
  const p95UpperBoundSeconds =
    count === 0
      ? undefined
      : latencyBuckets.find((boundary) => {
          const rendered = Number.isFinite(boundary) ? String(boundary) : "+Inf";
          return buckets[rendered] >= requiredWithinTarget;
        });
  const targetFraction = count === 0 ? 0 : withinTwoSeconds / count;
  const status =
    count < minimumSamples ? "insufficient-samples" : targetFraction >= 0.95 ? "pass" : "fail";
  return {
    status,
    targetSeconds: 2,
    requiredFraction: 0.95,
    minimumSamples,
    samples: count,
    withinTarget: withinTwoSeconds,
    withinTargetFraction: targetFraction,
    p95UpperBoundSeconds:
      p95UpperBoundSeconds === undefined || !Number.isFinite(p95UpperBoundSeconds)
        ? null
        : p95UpperBoundSeconds,
    buckets,
  };
}

function parseArguments(args) {
  const result = {
    url: "http://127.0.0.1:3998/metrics",
    domain: "current",
    observeSeconds: 600,
    minimumSamples: 100,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === "--url" && value) result.url = value;
    else if (argument === "--domain" && value) result.domain = value;
    else if (argument === "--observe-seconds" && value) result.observeSeconds = Number(value);
    else if (argument === "--minimum-samples" && value) result.minimumSamples = Number(value);
    else throw new Error(`Unknown or incomplete argument: ${argument}`);
    index += 1;
  }
  const url = new URL(result.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("--url must be an HTTP(S) URL without embedded credentials");
  }
  if (!Number.isSafeInteger(result.observeSeconds) || result.observeSeconds < 0) {
    throw new Error("--observe-seconds must be a non-negative integer");
  }
  if (!Number.isSafeInteger(result.minimumSamples) || result.minimumSamples < 1) {
    throw new Error("--minimum-samples must be a positive integer");
  }
  if (!/^[a-z][a-z-]*$/.test(result.domain)) throw new Error("--domain is invalid");
  return result;
}

async function fetchSample(url, domain) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Metrics endpoint returned HTTP ${response.status}`);
  return observerLatencySample(await response.text(), domain);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const before = options.observeSeconds > 0 ? await fetchSample(options.url, options.domain) : null;
  if (options.observeSeconds > 0) {
    console.error(
      `Observing ${options.domain} callback latency for ${options.observeSeconds} seconds...`,
    );
    await delay(options.observeSeconds * 1_000);
  }
  const after = await fetchSample(options.url, options.domain);
  const assessment = assessObserverLatency({
    before,
    after,
    minimumSamples: options.minimumSamples,
  });
  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        metricsUrl: options.url,
        domain: options.domain,
        observationSeconds: options.observeSeconds,
        ...assessment,
      },
      null,
      2,
    ),
  );
  if (assessment.status !== "pass") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
