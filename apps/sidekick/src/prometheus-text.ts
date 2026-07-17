export interface PrometheusSample {
  name: string;
  labels: Readonly<Record<string, string>>;
  value: number;
}

const metricNamePattern = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const labelNamePattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function parseLabels(input: string): Record<string, string> {
  const labels: Record<string, string> = {};
  let offset = 0;
  while (offset < input.length) {
    while (input[offset] === " " || input[offset] === "\t" || input[offset] === ",") offset += 1;
    if (offset >= input.length) break;
    const nameStart = offset;
    while (offset < input.length && /[a-zA-Z0-9_]/.test(input[offset] ?? "")) offset += 1;
    const name = input.slice(nameStart, offset);
    if (!labelNamePattern.test(name) || input[offset] !== "=") {
      throw new Error("Invalid Prometheus label");
    }
    offset += 1;
    if (input[offset] !== '"') throw new Error("Invalid Prometheus label value");
    offset += 1;
    let value = "";
    let closed = false;
    while (offset < input.length) {
      const character = input[offset];
      offset += 1;
      if (character === '"') {
        closed = true;
        break;
      }
      if (character !== "\\") {
        value += character;
        continue;
      }
      const escaped = input[offset];
      offset += 1;
      if (escaped === "n") value += "\n";
      else if (escaped === "\\" || escaped === '"') value += escaped;
      else throw new Error("Invalid Prometheus label escape");
    }
    if (!closed || value.length > 500) throw new Error("Invalid Prometheus label value");
    labels[name] = value;
    if (Object.keys(labels).length > 50) throw new Error("Too many Prometheus labels");
    while (input[offset] === " " || input[offset] === "\t") offset += 1;
    if (offset < input.length && input[offset] !== ",") {
      throw new Error("Invalid Prometheus label separator");
    }
  }
  return labels;
}

function splitMetricAndValue(line: string): { metric: string; value: string } {
  let quoted = false;
  let escaped = false;
  let braces = 0;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') quoted = !quoted;
    else if (!quoted && character === "{") braces += 1;
    else if (!quoted && character === "}") braces -= 1;
    else if (!quoted && braces === 0 && (character === " " || character === "\t")) {
      const metric = line.slice(0, index);
      const remainder = line.slice(index).trim();
      const value = remainder.split(/\s+/, 1)[0] ?? "";
      return { metric, value };
    }
  }
  throw new Error("Prometheus sample is missing a value");
}

export function parsePrometheusText(input: string): PrometheusSample[] {
  if (Buffer.byteLength(input, "utf8") > 1_048_576) {
    throw new Error("Prometheus exposition is too large");
  }
  const samples: PrometheusSample[] = [];
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.length > 16_384) throw new Error("Prometheus sample line is too long");
    const { metric, value: rawValue } = splitMetricAndValue(line);
    const brace = metric.indexOf("{");
    const name = brace === -1 ? metric : metric.slice(0, brace);
    if (!metricNamePattern.test(name) || name.length > 200) {
      throw new Error("Invalid Prometheus metric name");
    }
    let labels: Record<string, string> = {};
    if (brace !== -1) {
      if (!metric.endsWith("}")) throw new Error("Invalid Prometheus label set");
      labels = parseLabels(metric.slice(brace + 1, -1));
    }
    const value = Number(rawValue.replace("+Inf", "Infinity").replace("-Inf", "-Infinity"));
    if (!Number.isFinite(value)) continue;
    samples.push({ name, labels, value });
    if (samples.length > 25_000) throw new Error("Prometheus exposition has too many samples");
  }
  return samples;
}

export function samplesNamed(
  samples: readonly PrometheusSample[],
  name: string,
): PrometheusSample[] {
  return samples.filter((sample) => sample.name === name);
}

export function sampleValue(
  samples: readonly PrometheusSample[],
  name: string,
  labels: Readonly<Record<string, string>> = {},
): number | null {
  const sample = samples.find(
    (candidate) =>
      candidate.name === name &&
      Object.entries(labels).every(([key, value]) => candidate.labels[key] === value),
  );
  return sample?.value ?? null;
}
