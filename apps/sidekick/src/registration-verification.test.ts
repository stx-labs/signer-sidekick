import {
  bufferCV,
  noneCV,
  responseErrorCV,
  responseOkCV,
  someCV,
  trueCV,
  uintCV,
} from "@stacks/transactions";
import { describe, expect, it, vi } from "vitest";
import { verifyManagerRegistration } from "./registration-verification.js";

const pox5 = "SP000000000000000000002Q6VF78.pox-5";
const manager = "SP000000000000000000002Q6VF78.manager";

describe("manager registration verification", () => {
  it("reports an absent signer registration", async () => {
    const callReadOnly = vi.fn().mockResolvedValue(noneCV());

    await expect(verifyManagerRegistration({ callReadOnly }, pox5, manager)).resolves.toMatchObject(
      {
        registered: false,
        signerKeyHex: null,
        signerKeyGrantValid: null,
      },
    );
  });

  it("verifies the registered signer key and its live grant", async () => {
    const signerKey = new Uint8Array(33).fill(2);
    const callReadOnly = vi
      .fn()
      .mockResolvedValueOnce(someCV(bufferCV(signerKey)))
      .mockResolvedValueOnce(responseOkCV(trueCV()));

    await expect(verifyManagerRegistration({ callReadOnly }, pox5, manager)).resolves.toMatchObject(
      {
        registered: true,
        signerKeyHex: "02".repeat(33),
        signerKeyGrantValid: true,
      },
    );
    expect(callReadOnly).toHaveBeenCalledTimes(2);
  });

  it("pins signer-registration reads to the supplied chain anchor", async () => {
    const callReadOnly = vi.fn().mockResolvedValue(noneCV());
    const options = { tip: `0x${"ab".repeat(32)}` as const };

    await verifyManagerRegistration({ callReadOnly }, pox5, manager, options);

    expect(callReadOnly).toHaveBeenCalledWith(
      pox5,
      "get-signer-info",
      manager,
      expect.any(Array),
      options,
    );
  });

  it("distinguishes a revoked grant from a missing registration", async () => {
    const callReadOnly = vi
      .fn()
      .mockResolvedValueOnce(someCV(bufferCV(new Uint8Array(33).fill(3))))
      .mockResolvedValueOnce(responseErrorCV(uintCV(45n)));

    await expect(verifyManagerRegistration({ callReadOnly }, pox5, manager)).resolves.toMatchObject(
      {
        registered: true,
        signerKeyGrantValid: false,
      },
    );
  });
});
