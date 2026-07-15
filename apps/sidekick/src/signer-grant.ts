import { publicKeyFromSignatureRsv, verifySignature } from "@stacks/transactions";
import {
  type ClarityValue,
  decodeBuffer,
  encodeBufferHex,
  encodePrincipalHex,
  encodeUIntHex,
} from "@stx-labs/signer-sidekick-protocol/clarity-codecs";
import { parseContractPrincipal } from "@stx-labs/signer-sidekick-protocol/principals";
import { z } from "zod";

const uint128Max = (1n << 128n) - 1n;
const signerGrantOutputSchema = z
  .object({
    signerKey: z.string().regex(/^(?:02|03)[0-9a-f]{64}$/),
    signerSignature: z.string().regex(/^[0-9a-f]{130}$/),
    authId: z.string().regex(/^(?:0|[1-9][0-9]*)$/),
    signerManager: z.string(),
  })
  .strict();

interface ReadOnlyCaller {
  callReadOnly(
    principal: string,
    functionName: string,
    sender: string,
    args: readonly string[],
  ): Promise<ClarityValue>;
}

export interface SignerGrantPreparation {
  managerPrincipal: string;
  pox5ContractId: string;
  authId: string;
  expectedMessageHashHex: string;
  command: string;
}

export interface VerifiedSignerGrant {
  managerPrincipal: string;
  pox5ContractId: string;
  authId: string;
  signerKeyHex: string;
  signerSignatureHex: string;
  expectedMessageHashHex: string;
  signatureValid: true;
  registerSelfCall: {
    contract: string;
    functionName: "register-self";
    arguments: string[];
    signingPrincipal: string;
    signingAuthority: "external-offline-admin";
  };
}

export function parseAuthId(value: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("auth-id must be a canonical unsigned decimal integer");
  }
  const authId = BigInt(value);
  if (authId > uint128Max) throw new Error("auth-id exceeds Clarity uint range");
  return authId;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function getSignerGrantMessageHash(
  node: ReadOnlyCaller,
  pox5ContractId: string,
  managerPrincipal: string,
  authId: bigint,
): Promise<string> {
  const manager = parseContractPrincipal(managerPrincipal);
  const pox5 = parseContractPrincipal(pox5ContractId);
  if (manager.network !== pox5.network) {
    throw new Error("Manager and PoX-5 contract principals are on different networks");
  }
  const result = await node.callReadOnly(
    pox5ContractId,
    "get-signer-grant-message-hash",
    managerPrincipal,
    [encodePrincipalHex(managerPrincipal), encodeUIntHex(authId)],
  );
  const hash = decodeBuffer(result, "get-signer-grant-message-hash");
  if (hash.length !== 64) {
    throw new Error(`PoX-5 returned a ${hash.length / 2}-byte signer grant hash; expected 32`);
  }
  return hash;
}

export async function prepareSignerGrant(
  node: ReadOnlyCaller,
  pox5ContractId: string,
  managerPrincipal: string,
  authIdInput: string,
  signerConfigPath = "<SIGNER_CONFIG_PATH>",
): Promise<SignerGrantPreparation> {
  const authId = parseAuthId(authIdInput);
  const expectedMessageHashHex = await getSignerGrantMessageHash(
    node,
    pox5ContractId,
    managerPrincipal,
    authId,
  );
  const command = [
    "stacks-signer generate-staking-signature",
    `--config ${shellQuote(signerConfigPath)}`,
    `--signer-manager ${shellQuote(managerPrincipal)}`,
    `--auth-id ${authId}`,
    "--json",
  ].join(" ");

  return {
    managerPrincipal,
    pox5ContractId,
    authId: authId.toString(),
    expectedMessageHashHex,
    command,
  };
}

export async function verifySignerGrantOutput(
  node: ReadOnlyCaller,
  pox5ContractId: string,
  expectedManagerPrincipal: string,
  expectedAuthIdInput: string,
  input: unknown,
): Promise<VerifiedSignerGrant> {
  const output = signerGrantOutputSchema.parse(input);
  const manager = parseContractPrincipal(expectedManagerPrincipal);
  const expectedAuthId = parseAuthId(expectedAuthIdInput);
  if (output.signerManager !== expectedManagerPrincipal) {
    throw new Error("Signer output manager principal does not match the ceremony");
  }
  if (output.authId !== expectedAuthId.toString()) {
    throw new Error("Signer output auth ID does not match the ceremony");
  }
  const recoveryId = Number.parseInt(output.signerSignature.slice(-2), 16);
  if (recoveryId > 3) throw new Error("Signer signature has an invalid recovery ID");

  const expectedMessageHashHex = await getSignerGrantMessageHash(
    node,
    pox5ContractId,
    expectedManagerPrincipal,
    expectedAuthId,
  );
  const compactSignature = output.signerSignature.slice(0, 128);
  const signatureValid = verifySignature(
    compactSignature,
    expectedMessageHashHex,
    output.signerKey,
  );
  let recoveredKey: string;
  try {
    recoveredKey = publicKeyFromSignatureRsv(expectedMessageHashHex, output.signerSignature);
  } catch {
    throw new Error("Signer signature could not recover a public key");
  }
  if (!signatureValid || recoveredKey !== output.signerKey) {
    throw new Error("Signer signature is not valid for the live PoX-5 grant hash and signer key");
  }

  return {
    managerPrincipal: expectedManagerPrincipal,
    pox5ContractId,
    authId: expectedAuthId.toString(),
    signerKeyHex: output.signerKey,
    signerSignatureHex: output.signerSignature,
    expectedMessageHashHex,
    signatureValid: true,
    registerSelfCall: {
      contract: expectedManagerPrincipal,
      functionName: "register-self",
      arguments: [
        encodePrincipalHex(expectedManagerPrincipal),
        encodeBufferHex(output.signerKey),
        encodeUIntHex(expectedAuthId),
        encodeBufferHex(output.signerSignature),
      ],
      signingPrincipal: manager.address,
      signingAuthority: "external-offline-admin",
    },
  };
}
