import {
  ClarityCodecError,
  type ClarityValue,
  decodeBoolean,
  decodeOptionalBuffer,
  decodeResponseOk,
  encodeBufferHex,
  encodePrincipalHex,
} from "@stx-labs/signer-sidekick-protocol/clarity-codecs";
import type { ChainReadOptions } from "./chain-clients.js";

interface ReadOnlyCaller {
  callReadOnly(
    principal: string,
    functionName: string,
    sender: string,
    args: readonly string[],
    options?: ChainReadOptions,
  ): Promise<ClarityValue>;
}

export interface RegistrationVerification {
  managerPrincipal: string;
  pox5ContractId: string;
  registered: boolean;
  signerKeyHex: string | null;
  signerKeyGrantValid: boolean | null;
  reason: string;
}

export async function verifyManagerRegistration(
  node: ReadOnlyCaller,
  pox5ContractId: string,
  managerPrincipal: string,
  options?: ChainReadOptions,
): Promise<RegistrationVerification> {
  const signerInfo = await node.callReadOnly(
    pox5ContractId,
    "get-signer-info",
    managerPrincipal,
    [encodePrincipalHex(managerPrincipal)],
    options,
  );
  const signerKeyHex = decodeOptionalBuffer(signerInfo, "get-signer-info");
  if (!signerKeyHex) {
    return {
      managerPrincipal,
      pox5ContractId,
      registered: false,
      signerKeyHex: null,
      signerKeyGrantValid: null,
      reason: "PoX-5 has no signer registration for this manager",
    };
  }
  if (signerKeyHex.length !== 66) {
    throw new Error(
      `PoX-5 returned a signer key with ${signerKeyHex.length / 2} bytes; expected 33`,
    );
  }

  const grant = await node.callReadOnly(
    pox5ContractId,
    "verify-signer-key-grant",
    managerPrincipal,
    [encodePrincipalHex(managerPrincipal), encodeBufferHex(signerKeyHex)],
    options,
  );
  let signerKeyGrantValid = false;
  try {
    signerKeyGrantValid = decodeBoolean(
      decodeResponseOk(grant, "verify-signer-key-grant"),
      "verify-signer-key-grant.ok",
    );
  } catch (error) {
    if (!(error instanceof ClarityCodecError)) throw error;
  }

  return {
    managerPrincipal,
    pox5ContractId,
    registered: true,
    signerKeyHex,
    signerKeyGrantValid,
    reason: signerKeyGrantValid
      ? "Manager registration and signer-key grant are valid"
      : "Manager is registered, but its signer-key grant is not currently valid",
  };
}
