import { createHash } from "node:crypto";
import {
  AddressHashMode,
  AddressVersion,
  AnchorMode,
  AuthType,
  addressFromVersionHash,
  addressToString,
  ClarityType,
  ClarityVersion,
  cvToHex,
  deserializeTransaction,
  PayloadType,
  PostConditionMode,
  serializePostConditionWire,
  txidFromBytes,
} from "@stacks/transactions";
import type {
  BrowserWalletIntentNetwork,
  BrowserWalletTransaction,
} from "@stx-labs/signer-sidekick-api-contracts";

const mainnetTransactionVersion = 0;
const testnetTransactionVersion = 128;
export const mainnetChainId = 1;
export const pox5TestnetChainId = 0x80000005;
export const defaultPrivateChainId = 0x80000000;

export interface WalletTransactionNetworkBinding {
  network: BrowserWalletIntentNetwork;
  chainId: number;
  transactionVersion: typeof mainnetTransactionVersion | typeof testnetTransactionVersion;
}

export const mainnetWalletNetwork: WalletTransactionNetworkBinding = {
  network: "mainnet",
  chainId: mainnetChainId,
  transactionVersion: mainnetTransactionVersion,
};
export const pox5TestnetWalletNetwork: WalletTransactionNetworkBinding = {
  network: "pox5-testnet",
  chainId: pox5TestnetChainId,
  transactionVersion: testnetTransactionVersion,
};

export function createWalletTransactionNetworkBinding(
  network: BrowserWalletIntentNetwork,
  chainId: number,
): WalletTransactionNetworkBinding {
  if (!Number.isInteger(chainId) || chainId < 0 || chainId > 0xffff_ffff) {
    throw new Error("Wallet transaction chain ID must be a uint32");
  }
  if (network === "mainnet" && chainId !== mainnetChainId) {
    throw new Error("Mainnet wallet transactions require chain ID 1");
  }
  if (network === "pox5-testnet" && chainId !== pox5TestnetChainId) {
    throw new Error("PoX-5 Testnet wallet transactions require chain ID 0x80000005");
  }
  return {
    network,
    chainId,
    transactionVersion:
      network === "mainnet" ? mainnetTransactionVersion : testnetTransactionVersion,
  };
}

export interface VerifiedWalletTransaction {
  txid: `0x${string}`;
  sender: string;
  chainId: number;
  transactionVersion: number;
  sponsored: false;
  anchorMode: "any";
  postConditionMode: "deny";
  postConditionCount: number;
  payload:
    | {
        kind: "deploy-contract";
        contractName: string;
        clarityVersion: 6;
        sourceSha256: string;
      }
    | {
        kind: "call-contract";
        contract: string;
        functionName:
          | "register-self"
          | "update-admin"
          | "update-fees"
          | "withdraw-fees"
          | "sweep-fee-refunds"
          | "claim-staker-rewards"
          | "claim-rewards";
        argumentsSha256: string;
        signerKeyHex: string | null;
      };
}

export class WalletTransactionMismatchError extends Error {
  constructor(readonly reason: string) {
    super(
      `The submitted transaction does not match the prepared request (${reason}). Do not retry it; prepare a new transaction.`,
    );
    this.name = "WalletTransactionMismatchError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fail(reason: string): never {
  throw new WalletTransactionMismatchError(reason);
}

function senderAddress(
  hashMode: AddressHashMode,
  signer: string,
  transactionVersion: number,
): string {
  const singleSig = hashMode === AddressHashMode.P2PKH || hashMode === AddressHashMode.P2WPKH;
  const mainnet = transactionVersion === mainnetTransactionVersion;
  return addressToString(
    addressFromVersionHash(
      singleSig
        ? mainnet
          ? AddressVersion.MainnetSingleSig
          : AddressVersion.TestnetSingleSig
        : mainnet
          ? AddressVersion.MainnetMultiSig
          : AddressVersion.TestnetMultiSig,
      signer,
    ),
  );
}

function canonicalWireHex(value: string): string {
  return value.replace(/^0x/i, "").toLowerCase();
}

/**
 * Decode a node-fetched signed transaction and compare every authority-bearing field with the
 * server-prepared Connect request. The raw bytes are deliberately not returned or persisted.
 */
export function verifyWalletTransactionHex(input: {
  expectedTxid: string;
  requiredSender: string;
  request: BrowserWalletTransaction;
  transactionHex: string;
  expectedNetwork?: WalletTransactionNetworkBinding;
}): VerifiedWalletTransaction {
  const expectedNetwork = input.expectedNetwork ?? mainnetWalletNetwork;
  const expectedTxid = input.expectedTxid.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(expectedTxid)) fail("invalid transaction ID");
  if (!/^(?:[0-9a-f]{2})+$/i.test(input.transactionHex)) fail("invalid transaction encoding");

  let bytes: Uint8Array;
  let transaction: ReturnType<typeof deserializeTransaction>;
  try {
    bytes = Uint8Array.from(Buffer.from(input.transactionHex, "hex"));
    transaction = deserializeTransaction(bytes);
    if (
      Buffer.from(transaction.serializeBytes()).toString("hex") !==
      input.transactionHex.toLowerCase()
    ) {
      fail("non-canonical transaction encoding");
    }
    transaction.verifyOrigin();
  } catch (error) {
    if (error instanceof WalletTransactionMismatchError) throw error;
    fail("invalid origin signature or transaction encoding");
  }

  if (`0x${txidFromBytes(bytes)}` !== expectedTxid) fail("transaction ID");
  if (transaction.transactionVersion !== expectedNetwork.transactionVersion) {
    fail("network version");
  }
  if (transaction.chainId !== expectedNetwork.chainId) fail("chain ID");
  if (input.request.params.network !== expectedNetwork.network) fail("request network");
  if (transaction.auth.authType !== AuthType.Standard) fail("sponsored authorization");
  if (transaction.anchorMode !== AnchorMode.Any) fail("anchor mode");
  if (transaction.postConditionMode !== PostConditionMode.Deny) fail("post-condition mode");
  const postConditions = transaction.postConditions.values.map((condition) =>
    canonicalWireHex(serializePostConditionWire(condition)),
  );
  const expectedPostConditions = input.request.params.postConditions.map(canonicalWireHex);
  if (JSON.stringify(postConditions) !== JSON.stringify(expectedPostConditions)) {
    fail("post-conditions");
  }

  const sender = senderAddress(
    transaction.auth.spendingCondition.hashMode,
    transaction.auth.spendingCondition.signer,
    transaction.transactionVersion,
  );
  if (sender !== input.requiredSender || input.request.params.address !== input.requiredSender) {
    fail("origin sender");
  }

  if (input.request.method === "stx_deployContract") {
    if (transaction.payload.payloadType !== PayloadType.VersionedSmartContract) {
      fail("deployment payload type");
    }
    if (transaction.payload.clarityVersion !== ClarityVersion.Clarity6) fail("Clarity version");
    if (transaction.payload.contractName.content !== input.request.params.name) {
      fail("contract name");
    }
    if (transaction.payload.codeBody.content !== input.request.params.clarityCode) {
      fail("contract source");
    }
    return {
      txid: expectedTxid as `0x${string}`,
      sender,
      chainId: transaction.chainId,
      transactionVersion: transaction.transactionVersion,
      sponsored: false,
      anchorMode: "any",
      postConditionMode: "deny",
      postConditionCount: postConditions.length,
      payload: {
        kind: "deploy-contract",
        contractName: transaction.payload.contractName.content,
        clarityVersion: 6,
        sourceSha256: sha256(transaction.payload.codeBody.content),
      },
    };
  }

  if (transaction.payload.payloadType !== PayloadType.ContractCall) fail("contract-call payload");
  const contract = `${addressToString(transaction.payload.contractAddress)}.${transaction.payload.contractName.content}`;
  if (contract !== input.request.params.contract) fail("contract principal");
  if (transaction.payload.functionName.content !== input.request.params.functionName) {
    fail("function name");
  }
  const args = transaction.payload.functionArgs.map(cvToHex);
  if (JSON.stringify(args) !== JSON.stringify(input.request.params.functionArgs)) {
    fail("function arguments");
  }
  const signerKey =
    input.request.params.functionName === "register-self"
      ? transaction.payload.functionArgs[1]
      : null;
  if (
    input.request.params.functionName === "register-self" &&
    (!signerKey ||
      signerKey.type !== ClarityType.Buffer ||
      !/^(02|03)[0-9a-f]{64}$/.test(signerKey.value))
  ) {
    fail("signer key argument");
  }
  return {
    txid: expectedTxid as `0x${string}`,
    sender,
    chainId: transaction.chainId,
    transactionVersion: transaction.transactionVersion,
    sponsored: false,
    anchorMode: "any",
    postConditionMode: "deny",
    postConditionCount: postConditions.length,
    payload: {
      kind: "call-contract",
      contract,
      functionName: input.request.params.functionName,
      argumentsSha256: sha256(JSON.stringify(args)),
      signerKeyHex: signerKey && signerKey.type === ClarityType.Buffer ? signerKey.value : null,
    },
  };
}
