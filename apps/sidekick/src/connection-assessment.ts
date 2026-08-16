import {
  type ConnectionAssessment,
  type ConnectionOutcomeCode,
  connectionAssessmentSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import { parseContractPrincipal } from "@stx-labs/signer-sidekick-protocol/principals";
import {
  type StacksNodeClient,
  stacksTipIndexBlockHash,
  UpstreamHttpError,
} from "./chain-clients.js";
import { configuredNetworkId, type SidekickConfig } from "./config.js";
import { inspectManagerCapabilities } from "./manager-capabilities.js";
import { activePox5ContractId } from "./preflight.js";
import {
  InteractiveRequestDeadlineError,
  withInteractiveRequestDeadline,
} from "./request-context.js";
import type {
  LegacyDeploymentEvidence,
  StoredDeploymentIdentity,
} from "./storage/deployment-identity-repository.js";
import type { SidekickStore } from "./storage/store.js";

type ConnectionCheck = ConnectionAssessment["checks"][number];
type ObservedConnection = NonNullable<ConnectionAssessment["observed"]>;

const checkOrder = [
  "deployment-identity",
  "node-network",
  "pox5",
  "principal-network",
  "manager-trait",
] as const;

function configuredPrincipalNetwork(network: SidekickConfig["network"]): "mainnet" | "testnet" {
  return network === "mainnet" ? "mainnet" : "testnet";
}

function emptyChecks(): ConnectionCheck[] {
  return checkOrder.map((id) => ({
    id,
    status: "not-checked",
    message: "This check did not run because an earlier connection gate did not pass.",
  }));
}

function setCheck(
  checks: ConnectionCheck[],
  id: ConnectionCheck["id"],
  status: ConnectionCheck["status"],
  message: string,
): void {
  const index = checks.findIndex((check) => check.id === id);
  checks[index] = { id, status, message };
}

function hasLegacyEvidence(evidence: LegacyDeploymentEvidence): boolean {
  return (
    evidence.networks.length > 0 ||
    evidence.networkIds.length > 0 ||
    evidence.managerPrincipals.length > 0
  );
}

function legacyEvidenceMismatch(
  evidence: LegacyDeploymentEvidence,
  configured: { network: SidekickConfig["network"]; networkId: number; managerPrincipal: string },
): string | null {
  const networksMatch = evidence.networks.every((network) => network === configured.network);
  const networkIdsMatch = evidence.networkIds.every(
    (networkId) => networkId === configured.networkId,
  );
  const managersMatch = evidence.managerPrincipals.every(
    (managerPrincipal) => managerPrincipal === configured.managerPrincipal,
  );
  if (networksMatch && networkIdsMatch && managersMatch) return null;
  return [
    "Legacy database evidence does not unambiguously match the configured deployment.",
    `Stored networks: ${evidence.networks.join(", ") || "none"}.`,
    `Stored network IDs: ${evidence.networkIds.join(", ") || "none"}.`,
    `Stored managers: ${evidence.managerPrincipals.join(", ") || "none"}.`,
  ].join(" ");
}

function boundIdentityMismatch(
  identity: StoredDeploymentIdentity,
  configured: { network: SidekickConfig["network"]; networkId: number; managerPrincipal: string },
): string | null {
  if (
    identity.network === configured.network &&
    identity.networkId === configured.networkId &&
    identity.managerPrincipal === configured.managerPrincipal
  ) {
    return null;
  }
  return `Database is bound to ${identity.network} network ID ${identity.networkId} and ${identity.managerPrincipal}, but the process is configured for ${configured.network} network ID ${configured.networkId} and ${configured.managerPrincipal}.`;
}

function assessment(input: {
  status: ConnectionAssessment["status"];
  outcomeCode: ConnectionOutcomeCode | null;
  checkedAt: string;
  stale: boolean;
  configured: ConnectionAssessment["configured"];
  observed: ConnectionAssessment["observed"];
  identityStatus: ConnectionAssessment["deploymentIdentity"]["status"];
  identity: StoredDeploymentIdentity | null;
  identityReason: string | null;
  checks: ConnectionCheck[];
}): ConnectionAssessment {
  return connectionAssessmentSchema.parse({
    schemaVersion: 1,
    status: input.status,
    outcomeCode: input.outcomeCode,
    checkedAt: input.checkedAt,
    stale: input.stale,
    configured: input.configured,
    observed: input.observed,
    lastSuccessful: input.identity,
    deploymentIdentity: {
      status: input.identityStatus,
      stored: input.identity,
      reason: input.identityReason,
    },
    checks: input.checks,
  });
}

export interface ConnectionAssessmentOptions {
  config: Pick<SidekickConfig, "network" | "nodeRpcUrl" | "expectedNetworkId">;
  managerPrincipal: string;
  node: StacksNodeClient;
  runtime?(): {
    config: Pick<SidekickConfig, "network" | "nodeRpcUrl" | "expectedNetworkId">;
    node: StacksNodeClient;
  };
  store: Pick<SidekickStore, "deploymentIdentity">;
  now?: () => string;
  assessmentDeadlineMs?: number;
  inspectManager?: (tip: `0x${string}` | undefined) => Promise<ConnectionManagerInspection>;
}

export interface ConnectionManagerInspection {
  publishHeight: number | null;
  traitCompatible: boolean;
  traitReason: string;
  clarityVersion: string | null;
  epoch: string | null;
}

export class ConnectionAssessmentService {
  private lastAssessment: ConnectionAssessment | null = null;
  private inFlight: Promise<ConnectionAssessment> | null = null;

  constructor(private readonly options: ConnectionAssessmentOptions) {
    parseContractPrincipal(options.managerPrincipal);
  }

  private runtime(): {
    config: Pick<SidekickConfig, "network" | "nodeRpcUrl" | "expectedNetworkId">;
    node: StacksNodeClient;
  } {
    return this.options.runtime?.() ?? { config: this.options.config, node: this.options.node };
  }

  private configured(
    config: Pick<SidekickConfig, "network" | "nodeRpcUrl" | "expectedNetworkId">,
  ): ConnectionAssessment["configured"] {
    return {
      network: config.network,
      networkId: configuredNetworkId(config),
      nodeRpcUrl: config.nodeRpcUrl,
      managerPrincipal: this.options.managerPrincipal,
    };
  }

  private async inspectManager(
    node: StacksNodeClient,
    tip: `0x${string}` | undefined,
  ): Promise<ConnectionManagerInspection> {
    if (this.options.inspectManager) return await this.options.inspectManager(tip);
    const contractInterface = await node.getContractInterface(
      this.options.managerPrincipal,
      tip ? { tip } : undefined,
    );
    const trait = inspectManagerCapabilities({
      contractInterface,
      sourceSha256: "",
      exactSourceReviewed: false,
      sourceReviewReason: "Connection assessment checks only the universal signer-manager trait",
    }).signerManagerTrait;
    return {
      publishHeight: null,
      traitCompatible: trait.compatible,
      traitReason: trait.reason,
      clarityVersion: contractInterface.clarity_version ?? null,
      epoch: contractInterface.epoch ?? null,
    };
  }

  current(): ConnectionAssessment | null {
    return this.lastAssessment;
  }

  async check(force = false): Promise<ConnectionAssessment> {
    if (this.inFlight) return await this.inFlight;
    if (!force && this.lastAssessment) return this.lastAssessment;
    const pending = withInteractiveRequestDeadline(
      this.options.assessmentDeadlineMs ?? 12_000,
      async () => await this.assess(),
    )
      .catch((error: unknown) => {
        if (!(error instanceof InteractiveRequestDeadlineError)) throw error;
        return this.deadlineAssessment();
      })
      .then((result) => {
        this.lastAssessment = result;
        return result;
      });
    this.inFlight = pending;
    try {
      return await pending;
    } finally {
      if (this.inFlight === pending) this.inFlight = null;
    }
  }

  private deadlineAssessment(): ConnectionAssessment {
    const { config } = this.runtime();
    const configured = this.configured(config);
    const checkedAt = this.options.now?.() ?? new Date().toISOString();
    const checks = emptyChecks();
    const identity = this.options.store.deploymentIdentity.get();
    setCheck(
      checks,
      "deployment-identity",
      "pass",
      identity
        ? "Database deployment identity matches the configured network and manager."
        : "Database is unbound and may be bound after the first successful connection.",
    );
    setCheck(
      checks,
      "node-network",
      "unavailable",
      "The configured local node did not complete the connection check in time.",
    );
    return assessment({
      status: "unavailable",
      outcomeCode: "node-unreachable",
      checkedAt,
      stale: Boolean(identity),
      configured,
      observed: null,
      identityStatus: identity ? "bound" : "unbound",
      identity,
      identityReason: null,
      checks,
    });
  }

  private async assess(): Promise<ConnectionAssessment> {
    const { config, node } = this.runtime();
    const configured = this.configured(config);
    const checkedAt = this.options.now?.() ?? new Date().toISOString();
    const checks = emptyChecks();
    let identity = this.options.store.deploymentIdentity.get();
    const legacyEvidence = identity
      ? null
      : this.options.store.deploymentIdentity.inspectLegacyEvidence();
    const identityMismatch = identity
      ? boundIdentityMismatch(identity, configured)
      : legacyEvidenceMismatch(
          legacyEvidence ?? { networks: [], networkIds: [], managerPrincipals: [] },
          configured,
        );
    if (identityMismatch) {
      setCheck(checks, "deployment-identity", "fail", identityMismatch);
      return assessment({
        status: "blocked",
        outcomeCode: "deployment-identity-mismatch",
        checkedAt,
        stale: Boolean(identity),
        configured,
        observed: null,
        identityStatus: "mismatch",
        identity,
        identityReason: identityMismatch,
        checks,
      });
    }
    setCheck(
      checks,
      "deployment-identity",
      "pass",
      identity
        ? "Database deployment identity matches the configured network and manager."
        : hasLegacyEvidence(
              legacyEvidence ?? { networks: [], networkIds: [], managerPrincipals: [] },
            )
          ? "Legacy database evidence agrees with the configured deployment and may be bound after the public connection proves it."
          : "Database is unbound and may be bound after the first successful connection.",
    );

    let nodeInfo: Awaited<ReturnType<StacksNodeClient["getInfo"]>>;
    try {
      nodeInfo = await node.getInfo();
    } catch {
      setCheck(
        checks,
        "node-network",
        "unavailable",
        "The configured local node did not return its chain identity.",
      );
      return assessment({
        status: "unavailable",
        outcomeCode: "node-unreachable",
        checkedAt,
        stale: Boolean(identity),
        configured,
        observed: null,
        identityStatus: identity ? "bound" : "unbound",
        identity,
        identityReason: null,
        checks,
      });
    }
    const observedBase: ObservedConnection = {
      networkId: nodeInfo.network_id,
      parentNetworkId: nodeInfo.parent_network_id ?? null,
      stacksTipHeight: nodeInfo.stacks_tip_height,
      burnBlockHeight: nodeInfo.burn_block_height,
      pox5ContractId: null,
      manager: null,
    };
    if (nodeInfo.network_id !== configured.networkId) {
      setCheck(
        checks,
        "node-network",
        "fail",
        `Local node network ID ${nodeInfo.network_id} does not match configured network ID ${configured.networkId}.`,
      );
      return assessment({
        status: "blocked",
        outcomeCode: "node-network-mismatch",
        checkedAt,
        stale: Boolean(identity),
        configured,
        observed: observedBase,
        identityStatus: identity ? "bound" : "unbound",
        identity,
        identityReason: null,
        checks,
      });
    }
    setCheck(checks, "node-network", "pass", "Local node matches the configured network.");
    if (identity && identity.parentNetworkId !== (nodeInfo.parent_network_id ?? null)) {
      const reason = `Database parent network ID ${identity.parentNetworkId ?? "unknown"} does not match local node parent network ID ${nodeInfo.parent_network_id ?? "unknown"}.`;
      setCheck(checks, "deployment-identity", "fail", reason);
      return assessment({
        status: "blocked",
        outcomeCode: "deployment-identity-mismatch",
        checkedAt,
        stale: true,
        configured,
        observed: observedBase,
        identityStatus: "mismatch",
        identity,
        identityReason: reason,
        checks,
      });
    }

    const tip = stacksTipIndexBlockHash(nodeInfo);
    let poxInfo: Awaited<ReturnType<StacksNodeClient["getPoxInfo"]>>;
    try {
      poxInfo = await node.getPoxInfo(tip ? { tip } : undefined);
    } catch {
      setCheck(checks, "pox5", "unavailable", "The local node did not return PoX context.");
      return assessment({
        status: "unavailable",
        outcomeCode: "node-unreachable",
        checkedAt,
        stale: Boolean(identity),
        configured,
        observed: observedBase,
        identityStatus: identity ? "bound" : "unbound",
        identity,
        identityReason: null,
        checks,
      });
    }
    const pox5ContractId = activePox5ContractId(poxInfo);
    const observedWithPox = { ...observedBase, pox5ContractId };
    if (!pox5ContractId) {
      setCheck(checks, "pox5", "fail", "The local node does not advertise active PoX-5 context.");
      return assessment({
        status: "blocked",
        outcomeCode: "pox5-unavailable",
        checkedAt,
        stale: Boolean(identity),
        configured,
        observed: observedWithPox,
        identityStatus: identity ? "bound" : "unbound",
        identity,
        identityReason: null,
        checks,
      });
    }
    setCheck(checks, "pox5", "pass", `PoX-5 is active at ${pox5ContractId}.`);

    const principalNetwork = parseContractPrincipal(this.options.managerPrincipal).network;
    const expectedPrincipalNetwork = configuredPrincipalNetwork(config.network);
    if (principalNetwork !== expectedPrincipalNetwork) {
      setCheck(
        checks,
        "principal-network",
        "fail",
        `Manager principal belongs to ${principalNetwork}, not ${expectedPrincipalNetwork}.`,
      );
      return assessment({
        status: "blocked",
        outcomeCode: "principal-network-mismatch",
        checkedAt,
        stale: Boolean(identity),
        configured,
        observed: observedWithPox,
        identityStatus: identity ? "bound" : "unbound",
        identity,
        identityReason: null,
        checks,
      });
    }
    setCheck(
      checks,
      "principal-network",
      "pass",
      "Manager principal belongs to the configured address network.",
    );

    let manager: ConnectionManagerInspection;
    try {
      manager = await this.inspectManager(node, tip);
    } catch (error) {
      if (error instanceof UpstreamHttpError && error.status === 404) {
        const observed = {
          ...observedWithPox,
          manager: {
            deployed: false,
            traitCompatible: false,
            missingRequirements: ["A contract must exist at the configured principal"],
            publishHeight: null,
            clarityVersion: null,
            epoch: null,
          },
        };
        setCheck(
          checks,
          "manager-trait",
          "fail",
          "No contract exists at the configured manager principal.",
        );
        return assessment({
          status: "blocked",
          outcomeCode: "manager-not-deployed",
          checkedAt,
          stale: Boolean(identity),
          configured,
          observed,
          identityStatus: identity ? "bound" : "unbound",
          identity,
          identityReason: null,
          checks,
        });
      }
      setCheck(
        checks,
        "manager-trait",
        "unavailable",
        "The local node could not return the configured manager contract.",
      );
      return assessment({
        status: "unavailable",
        outcomeCode: "node-unreachable",
        checkedAt,
        stale: Boolean(identity),
        configured,
        observed: observedWithPox,
        identityStatus: identity ? "bound" : "unbound",
        identity,
        identityReason: null,
        checks,
      });
    }
    const traitReason = manager.traitReason;
    const observed = {
      ...observedWithPox,
      manager: {
        deployed: true,
        traitCompatible: manager.traitCompatible,
        missingRequirements: manager.traitCompatible ? [] : [traitReason],
        publishHeight: manager.publishHeight,
        clarityVersion: manager.clarityVersion,
        epoch: manager.epoch,
      },
    };
    if (!manager.traitCompatible) {
      setCheck(checks, "manager-trait", "fail", traitReason);
      return assessment({
        status: "blocked",
        outcomeCode: "manager-trait-mismatch",
        checkedAt,
        stale: Boolean(identity),
        configured,
        observed,
        identityStatus: identity ? "bound" : "unbound",
        identity,
        identityReason: null,
        checks,
      });
    }
    setCheck(checks, "manager-trait", "pass", traitReason);

    identity = identity
      ? this.options.store.deploymentIdentity.recordVerification({
          network: config.network,
          networkId: nodeInfo.network_id,
          parentNetworkId: nodeInfo.parent_network_id ?? null,
          managerPrincipal: this.options.managerPrincipal,
          verifiedAt: checkedAt,
          stacksTipHeight: nodeInfo.stacks_tip_height,
          burnBlockHeight: nodeInfo.burn_block_height,
          pox5ContractId,
        })
      : this.options.store.deploymentIdentity.bind({
          network: config.network,
          networkId: nodeInfo.network_id,
          parentNetworkId: nodeInfo.parent_network_id ?? null,
          managerPrincipal: this.options.managerPrincipal,
          bindingSource: hasLegacyEvidence(
            legacyEvidence ?? { networks: [], networkIds: [], managerPrincipals: [] },
          )
            ? "legacy-evidence"
            : "new",
          verifiedAt: checkedAt,
          stacksTipHeight: nodeInfo.stacks_tip_height,
          burnBlockHeight: nodeInfo.burn_block_height,
          pox5ContractId,
        });
    return assessment({
      status: "connected",
      outcomeCode: null,
      checkedAt,
      stale: false,
      configured,
      observed,
      identityStatus: "bound",
      identity,
      identityReason: null,
      checks,
    });
  }
}
