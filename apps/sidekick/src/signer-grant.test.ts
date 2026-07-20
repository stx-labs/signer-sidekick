import { bufferCV } from "@stacks/transactions";
import { describe, expect, it, vi } from "vitest";
import { parseAuthId, prepareSignerGrant, verifySignerGrantOutput } from "./signer-grant.js";

const pox5 = "ST000000000000000000002AMW42H.pox-5";
const manager = "ST000000000000000000002AMW42H.test-signer";
const expectedHash = "41339a30baf6f207fb56882c0d5246a91af8db0e6d3a2c07eb455c2330441256";
const signerOutput = {
  signerKey: "03bc489f27da3701d9f9e577c88de5567cf4023111b7577042d55cde4d823a3505",
  signerSignature:
    "2c83b6442a993d54ed2696789908fa963a50f748d0d06ca61445baed8bfb809a63f1182b350a46984e3b7cb67baa8e952b6c342f3354370bb7a7060e1bbc535e01",
  authId: "1",
  signerManager: manager,
};

function liveHashCaller() {
  return { callReadOnly: vi.fn().mockResolvedValue(bufferCV(Buffer.from(expectedHash, "hex"))) };
}

describe("signer grant ceremony", () => {
  it("prepares the released stacks-signer command and live message hash", async () => {
    const node = liveHashCaller();
    const preparation = await prepareSignerGrant(
      node,
      pox5,
      manager,
      "1",
      "/etc/stacks/signer.toml",
    );

    expect(preparation).toEqual({
      managerPrincipal: manager,
      pox5ContractId: pox5,
      authId: "1",
      expectedMessageHashHex: expectedHash,
      command:
        "stacks-signer generate-staking-signature --config '/etc/stacks/signer.toml' --signer-manager 'ST000000000000000000002AMW42H.test-signer' --auth-id 1 --json",
    });
  });

  it("verifies the stacks-core 4.0.0 cross-language signature fixture", async () => {
    const verified = await verifySignerGrantOutput(nodeForHash(), pox5, manager, "1", signerOutput);

    expect(verified).toMatchObject({
      managerPrincipal: manager,
      authId: "1",
      signerKeyHex: signerOutput.signerKey,
      expectedMessageHashHex: expectedHash,
      signatureValid: true,
      registerSelfCall: {
        contract: manager,
        functionName: "register-self",
        signingPrincipal: "ST000000000000000000002AMW42H",
        signingAuthority: "external-offline-admin",
      },
    });
    expect(verified.registerSelfCall.arguments).toHaveLength(4);
  });

  it("rejects ceremony mismatches and invalid uint values", async () => {
    await expect(
      verifySignerGrantOutput(nodeForHash(), pox5, manager, "2", signerOutput),
    ).rejects.toThrow("auth ID does not match");
    await expect(
      verifySignerGrantOutput(nodeForHash(), pox5, manager, "1", {
        ...signerOutput,
        signerManager: "ST000000000000000000002AMW42H.other-manager",
      }),
    ).rejects.toThrow("manager principal does not match");
    expect(() => parseAuthId("01")).toThrow("canonical unsigned decimal");
    expect(() => parseAuthId((1n << 128n).toString())).toThrow("exceeds Clarity uint range");
  });
});

function nodeForHash() {
  return liveHashCaller();
}
