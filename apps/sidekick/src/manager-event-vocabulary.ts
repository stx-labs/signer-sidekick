import type { ManagerCapabilities } from "@stx-labs/signer-sidekick-api-contracts";

export type ManagerEventVocabulary = "generic-v1" | "reference-manager-v1";

export function managerEventVocabularyFor(
  capabilities: ManagerCapabilities | undefined,
): ManagerEventVocabulary {
  return capabilities?.eventVocabulary.normalizationAvailable &&
    capabilities.eventVocabulary.adapter !== null
    ? "reference-manager-v1"
    : "generic-v1";
}

export function managerEventStream(
  managerPrincipal: string,
  vocabulary: ManagerEventVocabulary,
): string {
  return `manager-logs:v3:${vocabulary}:${managerPrincipal}`;
}
