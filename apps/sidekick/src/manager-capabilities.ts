import { createHash } from "node:crypto";
import type {
  ManagerActionCapability,
  ManagerActionCapabilityId,
  ManagerCapabilities,
} from "@stx-labs/signer-sidekick-api-contracts";
import {
  REFERENCE_MANAGER_PUBLIC_FUNCTIONS,
  REFERENCE_MANAGER_READ_ONLY_FUNCTIONS,
} from "@stx-labs/signer-sidekick-protocol";
import type { ContractInterface } from "./chain-clients.js";

type RequiredAccess = "public" | "read_only";

interface CapabilityDefinition {
  id: ManagerActionCapabilityId;
  adapterId: string;
  revision: number;
  functions: readonly { name: string; access: RequiredAccess }[];
}

const CAPABILITY_DEFINITIONS: readonly CapabilityDefinition[] = [
  {
    id: "register-self",
    adapterId: "reference-manager-register-self",
    revision: 1,
    functions: [{ name: "register-self", access: "public" }],
  },
  {
    id: "update-admin",
    adapterId: "reference-manager-update-admin",
    revision: 1,
    functions: [
      { name: "update-admin", access: "public" },
      { name: "is-admin", access: "read_only" },
    ],
  },
  {
    id: "update-fees",
    adapterId: "reference-manager-update-fees",
    revision: 1,
    functions: [
      { name: "update-fees", access: "public" },
      { name: "get-fee-bips-for-cycle", access: "read_only" },
    ],
  },
  {
    id: "withdraw-fees",
    adapterId: "reference-manager-withdraw-fees",
    revision: 1,
    functions: [
      { name: "withdraw-fees", access: "public" },
      { name: "get-earned-fees", access: "read_only" },
    ],
  },
  {
    id: "sweep-fee-refunds",
    adapterId: "reference-manager-sweep-fee-refunds",
    revision: 1,
    functions: [
      { name: "sweep-fee-refunds", access: "public" },
      { name: "get-unclaimed-staker-rewards", access: "read_only" },
      { name: "get-withdrawal-liability", access: "read_only" },
    ],
  },
  {
    id: "reference-reward-claims",
    adapterId: "reference-manager-claim-rewards",
    revision: 1,
    functions: [
      { name: "claim-rewards", access: "public" },
      { name: "claim-staker-rewards", access: "public" },
      { name: "reclaim-failed-withdrawal", access: "public" },
      { name: "settle-accepted-withdrawal", access: "public" },
      { name: "get-earned-staker-rewards", access: "read_only" },
      { name: "get-unclaimed-staker-rewards", access: "read_only" },
      { name: "get-withdrawal-liability", access: "read_only" },
      { name: "get-withdrawal-request-staker", access: "read_only" },
    ],
  },
] as const;

function canonicalAbiValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonicalAbiValue).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalAbiValue(entry)}`)
    .join(",")}}`;
}

export function managerInterfaceSha256(contractInterface: ContractInterface): string {
  const functions = [...contractInterface.functions].sort((left, right) =>
    canonicalAbiValue(left).localeCompare(canonicalAbiValue(right)),
  );
  return createHash("sha256")
    .update(
      canonicalAbiValue({
        clarityVersion: contractInterface.clarity_version ?? null,
        epoch: contractInterface.epoch ?? null,
        functions,
      }),
    )
    .digest("hex");
}

const EXPECTED_TRAIT_ARGUMENT_TYPES: readonly unknown[] = [
  "principal",
  "uint128",
  "uint128",
  "uint128",
  "uint128",
  "bool",
  { optional: { buffer: { length: 500 } } },
];
const EXPECTED_TRAIT_OUTPUT = { type: { response: { ok: "bool", error: "uint128" } } };

function signerManagerTraitCompatibility(contractInterface: ContractInterface): {
  compatible: boolean;
  reason: string;
} {
  const candidate = contractInterface.functions.find(
    ({ name, access }) => name === "validate-stake!" && access === "public",
  );
  if (!candidate) {
    return {
      compatible: false,
      reason: "Manager does not expose the required public validate-stake! function",
    };
  }
  if (candidate.args.length !== EXPECTED_TRAIT_ARGUMENT_TYPES.length) {
    return {
      compatible: false,
      reason: "Manager validate-stake! arguments do not match the PoX-5 signer-manager trait",
    };
  }
  const argumentTypes = candidate.args.map((argument) =>
    typeof argument === "object" && argument !== null && "type" in argument
      ? (argument as { type: unknown }).type
      : undefined,
  );
  if (
    argumentTypes.some(
      (type, index) =>
        canonicalAbiValue(type) !== canonicalAbiValue(EXPECTED_TRAIT_ARGUMENT_TYPES[index]),
    )
  ) {
    return {
      compatible: false,
      reason: "Manager validate-stake! arguments do not match the PoX-5 signer-manager trait",
    };
  }
  if (canonicalAbiValue(candidate.outputs) !== canonicalAbiValue(EXPECTED_TRAIT_OUTPUT)) {
    return {
      compatible: false,
      reason: "Manager validate-stake! response does not match the PoX-5 signer-manager trait",
    };
  }
  return {
    compatible: true,
    reason: "Manager exposes the exact PoX-5 signer-manager validate-stake! trait signature",
  };
}

function availableFunctions(contractInterface: ContractInterface): Map<string, string> {
  return new Map(contractInterface.functions.map(({ name, access }) => [name, access]));
}

function missingFunctions(
  functions: ReadonlyMap<string, string>,
  required: readonly { name: string; access: RequiredAccess }[],
): string[] {
  return required
    .filter(({ name, access }) => functions.get(name) !== access)
    .map(({ name }) => name);
}

export function missingReferenceManagerFunctions(contractInterface: ContractInterface): string[] {
  const functions = availableFunctions(contractInterface);
  return [
    ...REFERENCE_MANAGER_PUBLIC_FUNCTIONS.filter((name) => functions.get(name) !== "public"),
    ...REFERENCE_MANAGER_READ_ONLY_FUNCTIONS.filter((name) => functions.get(name) !== "read_only"),
  ];
}

export function inspectManagerCapabilities(input: {
  contractInterface: ContractInterface;
  sourceSha256: string;
  exactSourceReviewed: boolean;
  sourceReviewReason: string;
}): ManagerCapabilities {
  const functions = availableFunctions(input.contractInterface);
  const actions: ManagerActionCapability[] = CAPABILITY_DEFINITIONS.map((definition) => {
    const missing = missingFunctions(functions, definition.functions);
    const interfaceAvailable = missing.length === 0;
    const executionAvailable = interfaceAvailable && input.exactSourceReviewed;
    return {
      id: definition.id,
      interfaceAvailable,
      executionAvailable,
      missingFunctions: missing,
      adapter: executionAvailable
        ? {
            id: definition.adapterId,
            revision: definition.revision,
            reviewedSourceSha256: input.sourceSha256,
          }
        : null,
      reason: !interfaceAvailable
        ? `Manager is missing required ${missing.length === 1 ? "function" : "functions"}: ${missing.join(", ")}`
        : input.exactSourceReviewed
          ? `The deployed source exactly matches the reviewed ${definition.adapterId} capability`
          : `The interface is present, but the deployed byte-exact source is not reviewed for ${definition.adapterId}`,
    };
  });
  const observedPublic = [
    ...new Set(
      input.contractInterface.functions
        .filter(({ access }) => access === "public")
        .map(({ name }) => name),
    ),
  ].sort();
  const observedReadOnly = [
    ...new Set(
      input.contractInterface.functions
        .filter(({ access }) => access === "read_only")
        .map(({ name }) => name),
    ),
  ].sort();
  const eventVocabulary = {
    id: "reference-manager-v1" as const,
    normalizationAvailable: input.exactSourceReviewed,
    adapter: input.exactSourceReviewed
      ? {
          id: "reference-manager-print-events",
          revision: 1,
          reviewedSourceSha256: input.sourceSha256,
        }
      : null,
    reason: input.exactSourceReviewed
      ? "The deployed source exactly matches the reviewed reference-manager print-event vocabulary"
      : "Manager print events remain generic because the deployed byte-exact source is not reviewed for the reference-manager event vocabulary",
  };
  return {
    signerManagerTrait: signerManagerTraitCompatibility(input.contractInterface),
    observedFunctions: {
      public: observedPublic,
      readOnly: observedReadOnly,
    },
    sourceReview: {
      exactReviewed: input.exactSourceReviewed,
      reason: input.sourceReviewReason,
      clarityVersion: input.contractInterface.clarity_version ?? null,
      epoch: input.contractInterface.epoch ?? null,
      interfaceSha256: managerInterfaceSha256(input.contractInterface),
    },
    eventVocabulary,
    actions,
  };
}

export function managerActionCapability(
  capabilities: ManagerCapabilities | undefined,
  id: ManagerActionCapabilityId,
): ManagerActionCapability {
  const capability = capabilities?.actions.find((candidate) => candidate.id === id);
  if (!capability) {
    return {
      id,
      interfaceAvailable: false,
      executionAvailable: false,
      missingFunctions: [],
      adapter: null,
      reason: `Sidekick has no reviewed capability evidence for ${id}`,
    };
  }
  return capability;
}
