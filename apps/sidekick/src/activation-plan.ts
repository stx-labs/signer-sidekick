import { knownManagerArtifactsForNetwork } from "@stx-labs/signer-sidekick-protocol/known-managers";
import { parseContractPrincipal } from "@stx-labs/signer-sidekick-protocol/principals";
import { z } from "zod";
import type { SidekickNetwork } from "./config.js";
import type { ManagerVerificationReport } from "./manager-verification.js";
import type { PreflightResult } from "./preflight.js";
import type { RegistrationVerification } from "./registration-verification.js";
import type { PoolSetupStatus } from "./setup-status.js";
import { parseAuthId } from "./signer-grant.js";

const activationStepStatusSchema = z.enum(["complete", "ready", "pending", "attention", "blocked"]);

const activationPlanStepSchema = z
  .object({
    id: z.string(),
    status: activationStepStatusSchema,
    title: z.string(),
    detail: z.string(),
    command: z.string().nullable(),
    requires: z.array(z.string()),
  })
  .strict();

export const activationPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    documentType: z.literal("signer-sidekick-activation-plan"),
    path: z.enum(["fresh", "attach"]),
    status: z.enum(["ready", "attention", "blocked", "complete"]),
    network: z.enum(["mainnet", "testnet", "devnet", "regtest"]),
    managerPrincipal: z.string(),
    mode: z.literal("observe"),
    steps: z.array(activationPlanStepSchema),
    safety: z
      .object({
        deploysContract: z.literal(false),
        readsSignerConfig: z.literal(false),
        signsTransaction: z.literal(false),
        broadcastsTransaction: z.literal(false),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const stepIds = new Set<string>();
    for (const [index, step] of value.steps.entries()) {
      if (stepIds.has(step.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate activation step ID ${step.id}`,
          path: ["steps", index, "id"],
        });
      }
      stepIds.add(step.id);
    }
    for (const [index, step] of value.steps.entries()) {
      for (const requirement of step.requires) {
        if (!stepIds.has(requirement) || requirement === step.id) {
          context.addIssue({
            code: "custom",
            message: `Invalid activation step dependency ${requirement}`,
            path: ["steps", index, "requires"],
          });
        }
      }
    }
  });

export type ActivationStepStatus = z.infer<typeof activationStepStatusSchema>;
export type ActivationPlanStep = z.infer<typeof activationPlanStepSchema>;
export type ActivationPlan = z.infer<typeof activationPlanSchema>;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function planStatus(steps: readonly ActivationPlanStep[]): ActivationPlan["status"] {
  if (steps.some((step) => step.status === "blocked")) return "blocked";
  if (steps.some((step) => step.status === "attention")) return "attention";
  if (steps.every((step) => step.status === "complete")) return "complete";
  return "ready";
}

function plan(
  path: ActivationPlan["path"],
  network: SidekickNetwork,
  managerPrincipal: string,
  steps: ActivationPlanStep[],
): ActivationPlan {
  return activationPlanSchema.parse({
    schemaVersion: 1,
    documentType: "signer-sidekick-activation-plan",
    path,
    status: planStatus(steps),
    network,
    managerPrincipal,
    mode: "observe",
    steps,
    safety: {
      deploysContract: false,
      readsSignerConfig: false,
      signsTransaction: false,
      broadcastsTransaction: false,
    },
  });
}

export interface FreshActivationPlanOptions {
  network: SidekickNetwork;
  preflight: PreflightResult;
  adminPrincipal: string;
  contractName: string;
  outputDirectory: string;
  authId: string;
  signerConfigPath?: string;
}

export function createFreshActivationPlan(options: FreshActivationPlanOptions): ActivationPlan {
  const managerPrincipal = `${options.adminPrincipal}.${options.contractName}`;
  const manager = parseContractPrincipal(managerPrincipal);
  const expectedNetwork = options.network === "mainnet" ? "mainnet" : "testnet";
  if (manager.network !== expectedNetwork) {
    throw new Error("Manager admin principal does not match the selected network");
  }
  const authId = parseAuthId(options.authId).toString(10);
  const artifacts = knownManagerArtifactsForNetwork(options.network);
  if (artifacts.length > 1) {
    throw new Error(`Expected at most one built-in manager profile for ${options.network}`);
  }
  const compatibilityProfileId = options.preflight.compatibility?.managerProfileId;
  const profileId = compatibilityProfileId ?? artifacts[0]?.profile.id;
  if (!profileId) {
    throw new Error(
      `No reviewed manager artifact is available for ${options.network}; install an operator-provided network compatibility profile`,
    );
  }
  const preflightStatus =
    options.preflight.status === "fail"
      ? "blocked"
      : options.preflight.status === "warn"
        ? "attention"
        : "complete";
  const signerConfigPath = options.signerConfigPath ?? "<SIGNER_CONFIG_PATH>";
  const steps: ActivationPlanStep[] = [
    {
      id: "preflight",
      status: preflightStatus,
      title: "Verify node, API, network, and PoX-5",
      detail: `Connected preflight status is ${options.preflight.status}`,
      command: "sidekick preflight",
      requires: [],
    },
    {
      id: "render-manager",
      status: "ready",
      title: "Render the pinned manager artifact",
      detail: `Render profile ${profileId} and verify its immutable source hash`,
      command: [
        "sidekick manager render",
        shellQuote(options.adminPrincipal),
        shellQuote(options.contractName),
        shellQuote(options.outputDirectory),
      ].join(" "),
      requires: [],
    },
    {
      id: "deploy-manager",
      status: options.preflight.status === "fail" ? "blocked" : "pending",
      title: "Deploy the manager with the external admin wallet",
      detail:
        "Review the rendered principals and source hashes, then sign and submit the Clarity 6 deployment outside Sidekick",
      command: null,
      requires: ["render-manager"],
    },
    {
      id: "prepare-signer-grant",
      status: options.preflight.pox.pox5ContractId ? "ready" : "blocked",
      title: "Prepare the live PoX-5 signer grant",
      detail: options.preflight.pox.pox5ContractId
        ? `Use auth ID ${authId}; Sidekick reads the live grant hash but never reads the signer key`
        : "Wait until the connected node exposes the active PoX-5 contract",
      command: options.preflight.pox.pox5ContractId
        ? [
            "sidekick signer-grant prepare",
            shellQuote(managerPrincipal),
            authId,
            shellQuote(signerConfigPath),
          ].join(" ")
        : null,
      requires: ["preflight"],
    },
    {
      id: "verify-signer-grant",
      status: options.preflight.pox.pox5ContractId ? "ready" : "blocked",
      title: "Verify signer output and prepare register-self",
      detail:
        "Sidekick verifies the signer key, signature, manager, auth ID, and live PoX-5 hash before emitting register-self arguments",
      command: options.preflight.pox.pox5ContractId
        ? [
            "sidekick signer-grant verify",
            shellQuote(managerPrincipal),
            authId,
            "<SIGNER_OUTPUT_JSON>",
          ].join(" ")
        : null,
      requires: ["prepare-signer-grant"],
    },
    {
      id: "register-manager",
      status: "pending",
      title: "Register the manager with the external admin wallet",
      detail: "Sign and submit the generated register-self call outside Sidekick",
      command: null,
      requires: ["deploy-manager", "verify-signer-grant"],
    },
    {
      id: "verify-setup",
      status: "pending",
      title: "Verify registration, grant, and pool eligibility",
      detail: "Re-read PoX-5 state directly after register-self confirms",
      command: `sidekick setup status ${shellQuote(managerPrincipal)}`,
      requires: ["register-manager"],
    },
    {
      id: "publish-enrollment-info",
      status: "pending",
      title: "Generate pool enrollment information",
      detail: "Publish only the reviewed, provider-neutral public fields",
      command: `sidekick pool enrollment-info ${shellQuote(managerPrincipal)} <POOL_CONFIG_JSON>`,
      requires: ["verify-setup"],
    },
  ];

  return plan("fresh", options.network, managerPrincipal, steps);
}

export function createAttachActivationPlan(
  preflight: PreflightResult,
  manager: ManagerVerificationReport,
  registration: RegistrationVerification | null,
  setup: PoolSetupStatus,
): ActivationPlan {
  const registrationValid = Boolean(registration?.registered);
  const grantValid = Boolean(registration?.signerKeyGrantValid);
  const nextEligibility = setup.eligibility.next;
  const steps: ActivationPlanStep[] = [
    {
      id: "preflight",
      status:
        preflight.status === "fail"
          ? "blocked"
          : preflight.status === "warn"
            ? "attention"
            : "complete",
      title: "Verify node, API, network, and PoX-5",
      detail: `Connected preflight status is ${preflight.status}`,
      command: "sidekick preflight",
      requires: [],
    },
    {
      id: "verify-manager",
      status: manager.attachAllowed
        ? manager.source.tier === "reference-built-in" || manager.source.tier === "reference-render"
          ? "complete"
          : "attention"
        : "blocked",
      title: "Verify the deployed manager",
      detail: manager.attachAllowed
        ? manager.source.tier === "reference-built-in"
          ? `Manager source matches built-in profile ${manager.source.profileId}`
          : manager.source.tier === "reference-render"
            ? `Manager is a provenance-verified operator-installed reference render (${manager.source.profileId})`
            : manager.source.tier === "custom-observe"
              ? "Custom manager source is recorded; fixed external actions remain available, but reference-manager Assist is disabled"
              : "Manager source is unrecognized; fixed external actions remain available, but Assist is disabled"
        : "Manager network or interface is incompatible",
      command: `sidekick manager verify ${shellQuote(manager.managerPrincipal)}`,
      requires: ["preflight"],
    },
    {
      id: "verify-registration",
      status: registrationValid ? "complete" : "blocked",
      title: "Verify PoX-5 registration",
      detail: registration?.reason ?? "Registration could not be checked",
      command: `sidekick setup status ${shellQuote(manager.managerPrincipal)}`,
      requires: ["verify-manager"],
    },
    {
      id: "verify-signer-grant",
      status: grantValid ? "complete" : "blocked",
      title: "Verify the live signer-key grant",
      detail: grantValid
        ? "The registered signer-key grant is valid"
        : "A fresh offline signer grant and register-self call are required",
      command: grantValid
        ? null
        : `sidekick signer-grant prepare ${shellQuote(manager.managerPrincipal)} <NEW_AUTH_ID>`,
      requires: ["verify-registration"],
    },
    {
      id: "verify-next-cycle-eligibility",
      status:
        nextEligibility?.meetsThreshold && nextEligibility.inSignerSet ? "complete" : "attention",
      title: "Check next-cycle pool eligibility",
      detail: nextEligibility
        ? `Cycle ${nextEligibility.cycleId} margin is ${nextEligibility.marginUstx} uSTX`
        : "Next-cycle eligibility is not available from the connected node",
      command: `sidekick setup status ${shellQuote(manager.managerPrincipal)}`,
      requires: ["verify-signer-grant"],
    },
    {
      id: "publish-enrollment-info",
      status: manager.attachAllowed && registrationValid && grantValid ? "ready" : "blocked",
      title: "Generate pool enrollment information",
      detail: "Publish only the reviewed, provider-neutral public fields",
      command: `sidekick pool enrollment-info ${shellQuote(manager.managerPrincipal)} <POOL_CONFIG_JSON>`,
      requires: ["verify-manager", "verify-registration", "verify-signer-grant"],
    },
  ];

  return plan("attach", preflight.network, manager.managerPrincipal, steps);
}
