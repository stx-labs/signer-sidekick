import {
  type ConnectionAssessment,
  type DeploymentRequirement,
  type DeploymentRequirements,
  deploymentRequirementsSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import { type ApiCredential, hiroReferenceApiCredential, type SidekickConfig } from "./config.js";
import { testHealthSource } from "./health-monitoring-sources.js";
import type { ObserverRuntimeStatus } from "./observer-server.js";
import { LiveTransactionReader } from "./transaction-engine/live-transaction-reader.js";

const docsUrl =
  "https://github.com/stx-labs/signer-sidekick/blob/main/docs/operator/node-signer-requirements.md";
const transactionIndexProbeTxid = `0x${"00".repeat(32)}`;

type HealthSourceKind = "node-metrics" | "signer-monitoring" | "hiro-reference";

export interface DeploymentRequirementsServiceOptions {
  getConfig(): SidekickConfig;
  getConnection(): ConnectionAssessment | null;
  getObserverStatus(): ObserverRuntimeStatus;
  testSource?: (
    kind: HealthSourceKind,
    url: string,
    credential?: ApiCredential,
  ) => Promise<{ status: "connected"; signals: number }>;
  probeTransactionIndex?: (nodeRpcUrl: string) => Promise<"enabled" | "disabled" | "unavailable">;
  now?: () => Date;
  cacheMs?: number;
}

async function referenceApiCheck(
  config: SidekickConfig,
  testSource: NonNullable<DeploymentRequirementsServiceOptions["testSource"]>,
): Promise<DeploymentRequirement> {
  const url = config.hiroReferenceApiUrl;
  if (!url) {
    return {
      id: "hiro-reference",
      component: "sidekick",
      importance: "recommended",
      status: "not-configured",
      title: "Network comparison API",
      summary:
        "No external comparison API is configured. Sidekick can monitor local services, but has less evidence for distinguishing a local problem from a network-wide one.",
      observed: null,
      remediation: remediation({
        steps: [
          "Set Network comparison API in Sidekick Settings to a Stacks API endpoint for this network, then rerun the connection checks.",
        ],
      }),
    };
  }
  try {
    const result = await testSource("hiro-reference", url, hiroReferenceApiCredential(config));
    if (result.signals === 0) {
      return {
        id: "hiro-reference",
        component: "sidekick",
        importance: "recommended",
        status: "attention",
        title: "Network comparison API",
        summary:
          "The endpoint responded, but Sidekick did not recognize the chain status needed for network comparison.",
        observed: url,
        remediation: remediation({
          steps: [
            "Confirm the URL targets a Stacks indexed API for the configured network, then rerun the connection checks.",
          ],
        }),
      };
    }
    return {
      id: "hiro-reference",
      component: "sidekick",
      importance: "recommended",
      status: "pass",
      title: "Network comparison API",
      summary: "Sidekick reached the external comparison API and verified its chain status.",
      observed: url,
      remediation: null,
    };
  } catch (error) {
    return {
      id: "hiro-reference",
      component: "sidekick",
      importance: "recommended",
      status: "unavailable",
      title: "Network comparison API",
      summary: `The endpoint is configured but its bounded health check failed: ${error instanceof Error ? error.message : "unexpected response"}`,
      observed: url,
      remediation: remediation({
        steps: [
          "Confirm the Network comparison API URL and its source-specific API key in Settings, then rerun the connection checks.",
        ],
      }),
    };
  }
}

function remediation(input: {
  steps: string[];
  configuration?: Array<{
    label: string;
    format: "toml" | "dotenv" | "command";
    content: string;
  }>;
  restartServices?: Array<"stacks-node" | "stacks-signer" | "sidekick">;
}): NonNullable<DeploymentRequirement["remediation"]> {
  return {
    steps: input.steps,
    configuration: input.configuration ?? [],
    restartServices: input.restartServices ?? [],
    docsUrl,
  };
}

async function defaultProbeTransactionIndex(
  nodeRpcUrl: string,
): Promise<"enabled" | "disabled" | "unavailable"> {
  const lookup = await new LiveTransactionReader({
    baseUrl: nodeRpcUrl,
    timeoutMs: 5_000,
    maxResponseBytes: 64 * 1_024,
  }).lookupIndexedTransaction(transactionIndexProbeTxid);
  if (lookup.status === "not-found" || lookup.status === "observed") return "enabled";
  if (lookup.status === "unavailable" && lookup.reason === "transaction-index-unavailable") {
    return "disabled";
  }
  return "unavailable";
}

function nodeRpcCheck(connection: ConnectionAssessment | null, config: SidekickConfig) {
  if (connection?.status === "connected") {
    return {
      id: "node-rpc",
      component: "node",
      importance: "required",
      status: "pass",
      title: "Stacks node RPC",
      summary: "Sidekick reached the configured node and verified its network and PoX-5 state.",
      observed: config.nodeRpcUrl,
      remediation: null,
    } as const satisfies DeploymentRequirement;
  }
  return {
    id: "node-rpc",
    component: "node",
    importance: "required",
    status: "unavailable",
    title: "Stacks node RPC",
    summary:
      connection?.checks.find(({ id }) => id === "node-network")?.message ??
      "Sidekick has not completed a node RPC connection check.",
    observed: config.nodeRpcUrl,
    remediation: remediation({
      steps: [
        "Expose the node RPC on an address reachable only from Sidekick; do not publish it to the internet.",
        "Set STACKS_NODE_RPC_URL to that HTTP endpoint, restart Sidekick, and rerun the deployment check.",
      ],
      configuration: [
        {
          label: "Stacks node [node] table",
          format: "toml",
          content: '[node]\nrpc_bind = "127.0.0.1:20443"',
        },
        {
          label: "Sidekick environment",
          format: "dotenv",
          content: "STACKS_NODE_RPC_URL=http://127.0.0.1:20443",
        },
      ],
      restartServices: ["stacks-node", "sidekick"],
    }),
  } as const satisfies DeploymentRequirement;
}

function transactionIndexCheck(
  result: "enabled" | "disabled" | "unavailable",
): DeploymentRequirement {
  if (result === "enabled") {
    return {
      id: "node-transaction-index",
      component: "node",
      importance: "required",
      status: "pass",
      title: "Node transaction index",
      summary:
        "The node transaction lookup endpoint is enabled for independent manager and reward verification.",
      observed: "GET /v3/transaction/<txid> returned the enabled-endpoint response",
      remediation: null,
    };
  }
  const disabled = result === "disabled";
  return {
    id: "node-transaction-index",
    component: "node",
    importance: "required",
    status: disabled ? "not-configured" : "unavailable",
    title: "Node transaction index",
    summary: disabled
      ? "Stacks Core returned HTTP 501 because transaction indexing is disabled. Manager activity and reward realization cannot be independently verified."
      : "Sidekick could not determine whether the local transaction index is enabled.",
    observed: disabled ? "HTTP 501 transaction-index-unavailable" : null,
    remediation: remediation({
      steps: [
        "Add txindex = true to the node's existing [node] table. It uses additional chain-data storage; keep that data on the same durable fast volume as chainstate.",
        "Restart stacks-node and allow its transaction index to catch up before rerunning this check.",
      ],
      configuration: [
        {
          label: "Stacks node [node] table",
          format: "toml",
          content: "[node]\ntxindex = true",
        },
      ],
      restartServices: ["stacks-node"],
    }),
  };
}

async function optionalSourceCheck(input: {
  id: string;
  component: "node" | "signer";
  title: string;
  kind: HealthSourceKind;
  url: string | undefined;
  envName: string;
  toml: string;
  restartService: "stacks-node" | "stacks-signer";
  testSource: NonNullable<DeploymentRequirementsServiceOptions["testSource"]>;
}): Promise<DeploymentRequirement> {
  if (!input.url) {
    return {
      id: input.id,
      component: input.component,
      importance: "recommended",
      status: "not-configured",
      title: input.title,
      summary:
        "This monitoring source is not configured. Core operation continues, but Sidekick has less evidence for local-versus-network diagnosis.",
      observed: null,
      remediation: remediation({
        steps: [
          `Enable the private ${input.title.toLowerCase()} endpoint and set ${input.envName} to its Sidekick-reachable URL.`,
          "Restart the affected service and Sidekick, then rerun the deployment check.",
        ],
        configuration: [
          { label: `${input.title} configuration`, format: "toml", content: input.toml },
          {
            label: "Sidekick environment",
            format: "dotenv",
            content: `${input.envName}=http://127.0.0.1:${input.kind === "node-metrics" ? "9153/metrics" : "30001"}`,
          },
        ],
        restartServices: [input.restartService, "sidekick"],
      }),
    };
  }
  try {
    const result = await input.testSource(input.kind, input.url);
    if (result.signals === 0) {
      return {
        id: input.id,
        component: input.component,
        importance: "recommended",
        status: "attention",
        title: input.title,
        summary:
          "The endpoint responded, but Sidekick did not recognize the monitoring signals needed for diagnosis.",
        observed: input.url,
        remediation: remediation({
          steps: [
            "Confirm the URL targets the running Stacks service rather than a generic or unrelated Prometheus endpoint.",
            "Review the service version and metrics configuration, then rerun this check.",
          ],
          configuration: [
            { label: `${input.title} configuration`, format: "toml", content: input.toml },
            {
              label: "Configured Sidekick endpoint",
              format: "dotenv",
              content: `${input.envName}=${input.url}`,
            },
          ],
        }),
      };
    }
    return {
      id: input.id,
      component: input.component,
      importance: "recommended",
      status: "pass",
      title: input.title,
      summary: `Sidekick reached the endpoint and recognized ${result.signals} monitoring signals.`,
      observed: input.url,
      remediation: null,
    };
  } catch (error) {
    return {
      id: input.id,
      component: input.component,
      importance: "recommended",
      status: "unavailable",
      title: input.title,
      summary: `The endpoint is configured but its bounded health check failed: ${error instanceof Error ? error.message : "unexpected response"}`,
      observed: input.url,
      remediation: remediation({
        steps: [
          `Confirm ${input.envName} is reachable from the Sidekick process and serves the expected endpoints.`,
          "Check the affected service, correct the endpoint or bind address, and rerun this check.",
        ],
        configuration: [
          { label: `${input.title} configuration`, format: "toml", content: input.toml },
          {
            label: "Configured Sidekick endpoint",
            format: "dotenv",
            content: `${input.envName}=${input.url}`,
          },
        ],
        restartServices: [],
      }),
    };
  }
}

function observerCheck(
  status: ObserverRuntimeStatus,
  connection: ConnectionAssessment | null,
): DeploymentRequirement {
  const commandPort = status.listener?.port ?? 3700;
  const observerToml =
    connection?.observed?.pox5ContractId && connection.configured.managerPrincipal
      ? `[[events_observer]]
endpoint = "<node-reachable-host:${commandPort}>"
events_keys = [
  "burn_blocks",
  "${connection.observed.pox5ContractId}::print",
  "${connection.configured.managerPrincipal}::print",
]
timeout_ms = 5000
disable_retries = false`
      : null;
  const configuration = [
    {
      label: "Sidekick listener environment",
      format: "dotenv" as const,
      content: `SIDEKICK_EVENT_HTTP_ENABLED=true
SIDEKICK_EVENT_HTTP_PORT=${commandPort}`,
    },
    {
      label: "Generate node-specific observer TOML",
      format: "command" as const,
      content: `sidekick observer config <node-reachable-host:${commandPort}>`,
    },
    ...(observerToml
      ? [
          {
            label: "Observer TOML template (replace the endpoint placeholder)",
            format: "toml" as const,
            content: observerToml,
          },
        ]
      : []),
    {
      label: "Stacks node [node] table",
      format: "toml" as const,
      content:
        "# Add these keys to the existing [node] table.\nevent_dispatcher_blocking = false\nevent_dispatcher_queue_size = 1000",
    },
  ];
  const fix = remediation({
    steps: [
      "Run the observer config command with the host and port that stacks-node can use to reach Sidekick. Loopback is correct only when both processes share a network namespace.",
      "Copy the generated [[events_observer]] stanza and [node] keys into the existing node configuration without replacing other observers, then restart stacks-node.",
      "Wait for the next Stacks or burn block and refresh this check. Sidekick never edits the node configuration itself.",
    ],
    configuration,
    restartServices:
      status.enabled && status.listening ? ["stacks-node"] : ["sidekick", "stacks-node"],
  });
  if (!status.enabled || !status.listening) {
    return {
      id: "sidekick-event-observer",
      component: "sidekick",
      importance: "recommended",
      status: status.enabled ? "unavailable" : "not-configured",
      title: "Sidekick event observer",
      summary: status.enabled
        ? "The private callback listener is configured but is not currently listening."
        : "The private callback listener is disabled, so Sidekick relies on bounded polling.",
      observed: status.listener
        ? `${status.listener.host}:${status.listener.port} (not listening)`
        : null,
      remediation: fix,
    };
  }
  if (!status.inbox.lastVerifiedStacksBlock) {
    return {
      id: "sidekick-event-observer",
      component: "sidekick",
      importance: "recommended",
      status: "attention",
      title: "Sidekick event observer",
      summary:
        "The callback listener is ready, but no node-verified block callback has arrived. Sidekick cannot inspect the node TOML, so compare it with the generated stanza.",
      observed: `${status.listener?.host}:${status.listener?.port}; 0 verified block callbacks`,
      remediation: fix,
    };
  }
  if (status.gap?.status === "degraded") {
    return {
      id: "sidekick-event-observer",
      component: "sidekick",
      importance: "recommended",
      status: "attention",
      title: "Sidekick event observer",
      summary:
        "The node advanced without a timely verified callback. Polling fallback is active while observer delivery recovers.",
      observed: `node ${status.gap.nodeStacksHeight ?? "unknown"}; observer ${status.gap.observerStacksHeight ?? "unknown"}; gap ${status.gap.stacksGap ?? "unknown"}`,
      remediation: fix,
    };
  }
  return {
    id: "sidekick-event-observer",
    component: "sidekick",
    importance: "recommended",
    status: "pass",
    title: "Sidekick event observer",
    summary: "The private listener has received and node-verified a Stacks block callback.",
    observed: `verified through Stacks ${status.inbox.lastVerifiedStacksBlock.height}`,
    remediation: null,
  };
}

export class DeploymentRequirementsService {
  readonly #options: DeploymentRequirementsServiceOptions;
  #cached: DeploymentRequirements | null = null;
  #cachedFingerprint: string | null = null;
  #inFlight: { fingerprint: string; promise: Promise<DeploymentRequirements> } | null = null;

  constructor(options: DeploymentRequirementsServiceOptions) {
    this.#options = options;
  }

  current(): DeploymentRequirements | null {
    return this.#cached;
  }

  async check(force = false): Promise<DeploymentRequirements> {
    const now = this.#options.now?.() ?? new Date();
    const cacheMs = this.#options.cacheMs ?? 60_000;
    const config = this.#options.getConfig();
    const connection = this.#options.getConnection();
    const observer = this.#options.getObserverStatus();
    const fingerprint = JSON.stringify([
      config.nodeRpcUrl,
      config.nodeMetricsUrl ?? null,
      config.signerMonitoringUrl ?? null,
      config.hiroReferenceApiUrl ?? null,
      config.hiroReferenceApiKeyHeader,
      Boolean(hiroReferenceApiCredential(config)),
      connection?.status ?? null,
      connection?.checkedAt ?? null,
      observer.enabled,
      observer.listening,
      observer.inbox.lastVerifiedStacksBlock?.height ?? null,
      observer.gap?.status ?? null,
      observer.gap?.checkedAt ?? null,
    ]);
    if (
      !force &&
      this.#cached &&
      this.#cachedFingerprint === fingerprint &&
      now.getTime() - Date.parse(this.#cached.checkedAt) < cacheMs
    ) {
      return this.#cached;
    }
    if (this.#inFlight?.fingerprint === fingerprint) return await this.#inFlight.promise;
    const promise = this.#collect(now, config, connection, observer);
    this.#inFlight = { fingerprint, promise };
    try {
      this.#cached = await promise;
      this.#cachedFingerprint = fingerprint;
      return this.#cached;
    } finally {
      if (this.#inFlight?.promise === promise) this.#inFlight = null;
    }
  }

  async #collect(
    now: Date,
    config: SidekickConfig,
    connection: ConnectionAssessment | null,
    observer: ObserverRuntimeStatus,
  ): Promise<DeploymentRequirements> {
    const testSource = this.#options.testSource ?? testHealthSource;
    const transactionIndex =
      connection?.status === "connected"
        ? await (this.#options.probeTransactionIndex ?? defaultProbeTransactionIndex)(
            config.nodeRpcUrl,
          ).catch(() => "unavailable" as const)
        : "unavailable";
    const checks = await Promise.all([
      Promise.resolve(nodeRpcCheck(connection, config)),
      Promise.resolve(transactionIndexCheck(transactionIndex)),
      optionalSourceCheck({
        id: "node-metrics",
        component: "node",
        title: "Node metrics",
        kind: "node-metrics",
        url: config.nodeMetricsUrl,
        envName: "STACKS_NODE_METRICS_URL",
        toml: '[node]\nprometheus_bind = "127.0.0.1:9153"',
        restartService: "stacks-node",
        testSource,
      }),
      optionalSourceCheck({
        id: "signer-monitoring",
        component: "signer",
        title: "Signer monitoring",
        kind: "signer-monitoring",
        url: config.signerMonitoringUrl,
        envName: "STACKS_SIGNER_MONITORING_URL",
        toml: 'metrics_endpoint = "127.0.0.1:30001"',
        restartService: "stacks-signer",
        testSource,
      }),
      referenceApiCheck(config, testSource),
      Promise.resolve(observerCheck(observer, connection)),
    ]);
    const requiredReady = checks
      .filter(({ importance }) => importance === "required")
      .every(({ status }) => status === "pass");
    return deploymentRequirementsSchema.parse({
      schemaVersion: 1,
      checkedAt: now.toISOString(),
      status: !requiredReady
        ? "blocked"
        : checks.every(({ status }) => status === "pass")
          ? "ready"
          : "attention",
      requiredReady,
      checks,
    });
  }
}
