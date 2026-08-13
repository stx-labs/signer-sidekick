import {
  bufferCV,
  ClarityVersion,
  contractPrincipalCV,
  cvToHex,
  getAddressFromPrivateKey,
  makeContractCall,
  makeContractDeploy,
  Pc,
  PostConditionMode,
  postConditionToHex,
  principalCV,
  uintCV,
} from "@stacks/transactions";
import { describe, expect, it } from "vitest";
import {
  verifyWalletTransactionHex,
  WalletTransactionMismatchError,
} from "./wallet-transaction-verification.js";

const senderKey = "1".padStart(64, "0");
const sender = getAddressFromPrivateKey(senderKey, "mainnet");
const source = "(define-public (ping) (ok true))";

function encoded(tx: Awaited<ReturnType<typeof makeContractDeploy>>) {
  return {
    expectedTxid: `0x${tx.txid()}`,
    transactionHex: Buffer.from(tx.serializeBytes()).toString("hex"),
  };
}

describe("browser-wallet transaction verification", () => {
  it("accepts only the exact Clarity 6 deployment prepared by Sidekick", async () => {
    const tx = await makeContractDeploy({
      contractName: "signer-manager",
      codeBody: source,
      clarityVersion: ClarityVersion.Clarity6,
      senderKey,
      network: "mainnet",
      fee: 1_000,
      nonce: 7,
      sponsored: false,
      postConditionMode: PostConditionMode.Deny,
      postConditions: [],
    });
    const verified = verifyWalletTransactionHex({
      ...encoded(tx),
      requiredSender: sender,
      request: {
        method: "stx_deployContract",
        params: {
          name: "signer-manager",
          clarityCode: source,
          clarityVersion: 6,
          network: "mainnet",
          address: sender,
          sponsored: false,
          postConditionMode: "deny",
          postConditions: [],
        },
      },
    });

    expect(verified).toMatchObject({
      sender,
      chainId: 1,
      sponsored: false,
      postConditionMode: "deny",
      payload: { kind: "deploy-contract", contractName: "signer-manager", clarityVersion: 6 },
    });
  });

  it("rejects a wallet deployment that ignores the requested Clarity version", async () => {
    const tx = await makeContractDeploy({
      contractName: "signer-manager",
      codeBody: source,
      clarityVersion: ClarityVersion.Clarity3,
      senderKey,
      network: "mainnet",
      fee: 1_000,
    });

    expect(() =>
      verifyWalletTransactionHex({
        ...encoded(tx),
        requiredSender: sender,
        request: {
          method: "stx_deployContract",
          params: {
            name: "signer-manager",
            clarityCode: source,
            clarityVersion: 6,
            network: "mainnet",
            address: sender,
            sponsored: false,
            postConditionMode: "deny",
            postConditions: [],
          },
        },
      }),
    ).toThrowError(WalletTransactionMismatchError);
  });

  it("accepts the exact register-self call and rejects altered arguments", async () => {
    const manager = `${sender}.signer-manager`;
    const args = [
      contractPrincipalCV(sender, "signer-manager"),
      bufferCV(Uint8Array.from({ length: 33 }, () => 2)),
      uintCV(7),
      bufferCV(Uint8Array.from({ length: 65 }, () => 3)),
    ];
    const tx = await makeContractCall({
      contractAddress: sender,
      contractName: "signer-manager",
      functionName: "register-self",
      functionArgs: args,
      senderKey,
      network: "mainnet",
      fee: 1_000,
      nonce: 8,
      sponsored: false,
      postConditionMode: PostConditionMode.Deny,
      postConditions: [],
    });
    const request = {
      method: "stx_callContract" as const,
      params: {
        contract: manager,
        functionName: "register-self" as const,
        functionArgs: args.map(cvToHex),
        network: "mainnet" as const,
        address: sender,
        sponsored: false as const,
        postConditionMode: "deny" as const,
        postConditions: [] as [],
      },
    };

    expect(
      verifyWalletTransactionHex({
        ...encoded(tx),
        requiredSender: sender,
        request,
      }),
    ).toMatchObject({
      sender,
      payload: {
        kind: "call-contract",
        contract: manager,
        functionName: "register-self",
        signerKeyHex: "02".repeat(33),
      },
    });

    expect(() =>
      verifyWalletTransactionHex({
        ...encoded(tx),
        requiredSender: sender,
        request: {
          ...request,
          params: { ...request.params, functionArgs: [...request.params.functionArgs].reverse() },
        },
      }),
    ).toThrow("function arguments");
  });

  it("rejects a different sender or permissive post-condition mode", async () => {
    const tx = await makeContractDeploy({
      contractName: "signer-manager",
      codeBody: source,
      clarityVersion: ClarityVersion.Clarity6,
      senderKey,
      network: "mainnet",
      fee: 1_000,
      postConditionMode: PostConditionMode.Allow,
    });
    const request = {
      method: "stx_deployContract" as const,
      params: {
        name: "signer-manager",
        clarityCode: source,
        clarityVersion: 6 as const,
        network: "mainnet" as const,
        address: sender,
        sponsored: false as const,
        postConditionMode: "deny" as const,
        postConditions: [] as [],
      },
    };

    expect(() =>
      verifyWalletTransactionHex({ ...encoded(tx), requiredSender: sender, request }),
    ).toThrow("post-condition mode");

    const denyTx = await makeContractDeploy({
      contractName: "signer-manager",
      codeBody: source,
      clarityVersion: ClarityVersion.Clarity6,
      senderKey,
      network: "mainnet",
      fee: 1_000,
    });
    expect(() =>
      verifyWalletTransactionHex({
        ...encoded(denyTx),
        requiredSender: "SP000000000000000000002Q6VF78",
        request,
      }),
    ).toThrow("origin sender");
  });

  it("binds manager calls to the exact serialized sBTC postcondition", async () => {
    const manager = `${sender}.signer-manager`;
    const token = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
    const amount = 12_345n;
    const postCondition = postConditionToHex(
      Pc.principal(manager).willSendEq(amount).ft(token, "sbtc-token"),
    );
    const args = [uintCV(amount), principalCV(sender)];
    const tx = await makeContractCall({
      contractAddress: sender,
      contractName: "signer-manager",
      functionName: "withdraw-fees",
      functionArgs: args,
      senderKey,
      network: "mainnet",
      fee: 1_000,
      nonce: 9,
      sponsored: false,
      postConditionMode: PostConditionMode.Deny,
      postConditions: [postCondition],
    });
    const request = {
      method: "stx_callContract" as const,
      params: {
        contract: manager,
        functionName: "withdraw-fees" as const,
        functionArgs: args.map(cvToHex),
        network: "mainnet" as const,
        address: sender,
        sponsored: false as const,
        postConditionMode: "deny" as const,
        postConditions: [postCondition],
      },
    };

    expect(
      verifyWalletTransactionHex({
        ...encoded(tx),
        requiredSender: sender,
        request,
      }),
    ).toMatchObject({
      postConditionCount: 1,
      payload: { kind: "call-contract", functionName: "withdraw-fees", signerKeyHex: null },
    });

    const alteredPostCondition = postConditionToHex(
      Pc.principal(manager)
        .willSendEq(amount + 1n)
        .ft(token, "sbtc-token"),
    );
    expect(() =>
      verifyWalletTransactionHex({
        ...encoded(tx),
        requiredSender: sender,
        request: {
          ...request,
          params: { ...request.params, postConditions: [alteredPostCondition] },
        },
      }),
    ).toThrow("post-conditions");
  });
});
