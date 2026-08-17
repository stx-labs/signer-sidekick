import { describe, expect, it } from "vitest";
import { managerEventStream, managerEventVocabularyFor } from "./manager-event-vocabulary.js";

describe("manager event vocabulary", () => {
  it("fails closed to generic storage without reviewed adapter evidence", () => {
    expect(managerEventVocabularyFor(undefined)).toBe("generic-v1");
    expect(
      managerEventVocabularyFor({
        signerManagerTrait: { compatible: true, reason: "Exact trait" },
        observedFunctions: { public: [], readOnly: [] },
        sourceReview: { exactReviewed: true, reason: "Reviewed source" },
        eventVocabulary: {
          id: "reference-manager-v1",
          normalizationAvailable: true,
          adapter: null,
          reason: "Adapter evidence is missing",
        },
        actions: [],
      }),
    ).toBe("generic-v1");
  });

  it("names streams by vocabulary so classification changes force a replay", () => {
    const manager = "SP000000000000000000002Q6VF78.signer-manager";
    expect(managerEventStream(manager, "generic-v1")).toBe(`manager-logs:v3:generic-v1:${manager}`);
    expect(managerEventStream(manager, "reference-manager-v1")).toBe(
      `manager-logs:v3:reference-manager-v1:${manager}`,
    );
  });
});
