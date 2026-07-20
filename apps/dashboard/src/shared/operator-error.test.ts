import { describe, expect, it } from "vitest";
import { ApiRequestError } from "../api-client.js";
import {
  operatorActionError,
  operatorErrorDetail,
  operatorErrorSentence,
} from "./operator-error.js";

describe("operator errors", () => {
  it("removes the generic request wrapper so the UI can name the failed action", () => {
    expect(operatorErrorDetail(new Error("Request failed: Node RPC timed out."))).toBe(
      "Node RPC timed out.",
    );
  });

  it("combines the failed action, safe detail, and recovery guidance", () => {
    expect(
      operatorActionError(
        new Error("Request failed: Node RPC timed out"),
        "Could not load signer health",
        "Retrying is safe",
      ),
    ).toBe("Could not load signer health: Node RPC timed out. Retrying is safe.");
  });

  it("uses a stable fallback for non-error values", () => {
    expect(
      operatorActionError(null, "Could not load settings", "Retry", "No detail returned"),
    ).toBe("Could not load settings: No detail returned. Retry.");
  });

  it("keeps a structured server message authoritative", () => {
    const error = new ApiRequestError(
      "Request failed: The transaction job changed. Refresh it before approving.",
      {
        kind: "http",
        status: 409,
        code: "engine_approval_hash_mismatch",
        body: {
          error: "engine_approval_hash_mismatch",
          message: "The transaction job changed. Refresh it before approving.",
          retryable: false,
        },
      },
    );

    expect(
      operatorActionError(
        error,
        "Could not confirm approval",
        "Refresh the job before approving again",
      ),
    ).toBe("Could not confirm approval: The transaction job changed. Refresh it before approving.");
  });

  it("normalizes a fallback before composing another sentence", () => {
    expect(operatorErrorSentence(null, "Sidekick returned no error detail")).toBe(
      "Sidekick returned no error detail.",
    );
  });
});
