import { POX5_SIGNER_SET_MIN_USTX } from "@stx-labs/signer-sidekick-protocol";
import {
  type ClarityValue,
  decodeBoolean,
  decodeUInt,
  encodePrincipalHex,
  encodeUIntHex,
} from "@stx-labs/signer-sidekick-protocol/clarity-codecs";
import type { ManagerVerificationReport } from "./manager-verification.js";
import type { PreflightCheckStatus, PreflightResult } from "./preflight.js";
import type { RegistrationVerification } from "./registration-verification.js";

interface ReadOnlyCaller {
  callReadOnly(
    principal: string,
    functionName: string,
    sender: string,
    args: readonly string[],
  ): Promise<ClarityValue>;
}

export interface PoolCycleEligibility {
  cycleId: number;
  delegatedUstx: string;
  thresholdUstx: string;
  marginUstx: string;
  meetsThreshold: boolean;
  inSignerSet: boolean;
  thresholdAndMembershipAgree: boolean;
}

export interface SetupStatusCheck {
  id: string;
  status: PreflightCheckStatus;
  message: string;
}

export interface PoolSetupStatus {
  status: "ready" | "attention" | "blocked";
  managerPrincipal: string;
  pox5ContractId: string | null;
  observedAt: {
    burnBlockHeight: number;
    stacksTipHeight: number;
  };
  enrollmentWindow: {
    status: "open" | "prepare-phase" | "unknown";
    targetCycleId: number | null;
    preparePhaseStartBurnHeight: number | null;
    blocksUntilPreparePhase: number | null;
  };
  eligibility: {
    current: PoolCycleEligibility | null;
    next: PoolCycleEligibility | null;
  };
  checks: SetupStatusCheck[];
}

function signedMargin(value: bigint): string {
  return value.toString(10);
}

async function readCycleEligibility(
  node: ReadOnlyCaller,
  pox5ContractId: string,
  managerPrincipal: string,
  cycleId: number,
): Promise<PoolCycleEligibility> {
  const args = [encodePrincipalHex(managerPrincipal), encodeUIntHex(BigInt(cycleId))];
  const [delegated, membership] = await Promise.all([
    node.callReadOnly(pox5ContractId, "get-amount-delegated-for-signer", managerPrincipal, args),
    node.callReadOnly(pox5ContractId, "signer-set-contains-for-cycle", managerPrincipal, args),
  ]);
  const delegatedUstx = decodeUInt(delegated, "get-amount-delegated-for-signer");
  const inSignerSet = decodeBoolean(membership, "signer-set-contains-for-cycle");
  const meetsThreshold = delegatedUstx >= POX5_SIGNER_SET_MIN_USTX;

  return {
    cycleId,
    delegatedUstx: delegatedUstx.toString(10),
    thresholdUstx: POX5_SIGNER_SET_MIN_USTX.toString(10),
    marginUstx: signedMargin(delegatedUstx - POX5_SIGNER_SET_MIN_USTX),
    meetsThreshold,
    inSignerSet,
    thresholdAndMembershipAgree: meetsThreshold === inSignerSet,
  };
}

function overallStatus(checks: readonly SetupStatusCheck[]): PoolSetupStatus["status"] {
  if (checks.some((check) => check.status === "fail")) return "blocked";
  if (checks.some((check) => check.status === "warn")) return "attention";
  return "ready";
}

export async function readPoolSetupStatus(
  node: ReadOnlyCaller,
  preflight: PreflightResult,
  manager: ManagerVerificationReport,
  registration: RegistrationVerification | null,
): Promise<PoolSetupStatus> {
  const pox5ContractId = preflight.pox.pox5ContractId;
  const canReadEligibility = Boolean(pox5ContractId && manager.attachAllowed);
  const cycleIds = canReadEligibility
    ? [preflight.cycle.currentId, preflight.cycle.nextId].filter(
        (cycleId): cycleId is number => cycleId !== null,
      )
    : [];
  const eligibility =
    pox5ContractId && canReadEligibility
      ? await Promise.all(
          cycleIds.map((cycleId) =>
            readCycleEligibility(node, pox5ContractId, manager.managerPrincipal, cycleId),
          ),
        )
      : [];
  const current = eligibility.find(({ cycleId }) => cycleId === preflight.cycle.currentId) ?? null;
  const next = eligibility.find(({ cycleId }) => cycleId === preflight.cycle.nextId) ?? null;
  const checks: SetupStatusCheck[] = [
    {
      id: "preflight",
      status: preflight.status,
      message: `Node, API, and protocol preflight status is ${preflight.status}`,
    },
    {
      id: "manager-attachment",
      status: manager.attachAllowed ? "pass" : "fail",
      message: manager.attachAllowed
        ? "Manager network and interface are compatible"
        : "Manager cannot be attached on the configured network",
    },
    {
      id: "manager-artifact",
      status:
        manager.source.tier === "reference-built-in" || manager.source.tier === "reference-render"
          ? "pass"
          : "warn",
      message:
        manager.source.tier === "reference-built-in"
          ? `Manager source matches built-in profile ${manager.source.profileId}`
          : manager.source.tier === "reference-render"
            ? `Manager is a provenance-verified operator-installed reference render (${manager.source.profileId})`
            : manager.source.tier === "custom-observe"
              ? "Custom manager is operator-identified for attach and read-only monitoring; automation remains disabled"
              : "Manager source is not recognized — attach and read-only monitoring work, but automation remains disabled",
    },
    {
      id: "signer-registration",
      status: registration?.registered ? "pass" : "fail",
      message: registration?.registered
        ? "Manager has a PoX-5 signer registration"
        : "Manager does not have a verified PoX-5 signer registration",
    },
    {
      id: "signer-grant",
      status: registration?.signerKeyGrantValid ? "pass" : "fail",
      message: registration?.signerKeyGrantValid
        ? "Registered signer-key grant is currently valid"
        : "Registered signer-key grant is absent, revoked, or invalid",
    },
  ];

  if (!pox5ContractId) {
    checks.push({
      id: "pox5-eligibility",
      status: "fail",
      message: "PoX-5 is not available, so signer-set eligibility cannot be read",
    });
  } else if (!manager.attachAllowed) {
    checks.push({
      id: "pox5-eligibility",
      status: "fail",
      message: "Signer-set eligibility was not queried because the manager cannot be attached",
    });
  } else if (!next) {
    checks.push({
      id: "next-cycle-eligibility",
      status: "warn",
      message: "The node did not report a next reward cycle",
    });
  } else {
    checks.push({
      id: "next-cycle-eligibility",
      status: next.meetsThreshold && next.inSignerSet ? "pass" : "warn",
      message:
        next.meetsThreshold && next.inSignerSet
          ? `Manager is eligible for cycle ${next.cycleId}`
          : `Manager is not yet eligible for cycle ${next.cycleId}`,
    });
    if (!next.thresholdAndMembershipAgree) {
      checks.push({
        id: "next-cycle-eligibility-consistency",
        status: "warn",
        message: `Cycle ${next.cycleId} threshold and signer-set membership do not agree at this Stacks tip`,
      });
    }
  }

  const enrollmentWindowStatus =
    preflight.cycle.isPreparePhase === null
      ? "unknown"
      : preflight.cycle.isPreparePhase ||
          (preflight.cycle.blocksUntilPreparePhase !== null &&
            preflight.cycle.blocksUntilPreparePhase <= 1)
        ? "prepare-phase"
        : "open";
  checks.push({
    id: "enrollment-window",
    status: enrollmentWindowStatus === "open" ? "pass" : "warn",
    message:
      enrollmentWindowStatus === "open"
        ? `PoX-5 stake changes are open for cycle ${preflight.cycle.nextId ?? "unknown"}`
        : enrollmentWindowStatus === "prepare-phase"
          ? "PoX-5 stake changes are closed during the prepare phase and its final pre-execution Bitcoin block"
          : "The current PoX-5 enrollment window is unknown",
  });

  return {
    status: overallStatus(checks),
    managerPrincipal: manager.managerPrincipal,
    pox5ContractId,
    observedAt: {
      burnBlockHeight: preflight.node.burnBlockHeight,
      stacksTipHeight: preflight.node.stacksTipHeight,
    },
    enrollmentWindow: {
      status: enrollmentWindowStatus,
      targetCycleId: preflight.cycle.nextId,
      preparePhaseStartBurnHeight: preflight.cycle.preparePhaseStartBurnHeight,
      blocksUntilPreparePhase: preflight.cycle.blocksUntilPreparePhase,
    },
    eligibility: { current, next },
    checks,
  };
}
