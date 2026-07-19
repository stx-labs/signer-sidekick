import type { StacksProvider } from "@stacks/connect";
import type { BrowserWalletIntent } from "@stx-labs/signer-sidekick-api-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type BrowserWalletAction,
  type BrowserWalletDependencies,
  BrowserWalletError,
  browserWalletManifestSha256,
  browserWalletProviderIds,
  browserWalletSupport,
  canPrepareBrowserWalletIntent,
  executeBrowserWalletIntent,
  executeRevalidatedBrowserWalletIntent,
  LEATHER_PROVIDER_ID,
  MAINNET_CHAIN_ID,
  POX5_TESTNET_CHAIN_ID,
  XVERSE_PROVIDER_ID,
} from "./browser-wallet.js";

const admin = "SP000000000000000000002Q6VF78";
const testnetAdmin = "ST000000000000000000002AMW42H";
const txid = `0x${"ab".repeat(32)}`;
const provider = { request: vi.fn() } as unknown as StacksProvider;

afterEach(() => {
  vi.unstubAllGlobals();
});

function deployIntent(overrides: Partial<BrowserWalletIntent> = {}): BrowserWalletIntent {
  return {
    schemaVersion: 1,
    id: "4e011bf7-f291-42c4-a35b-ab299a87ff8c",
    action: "deploy-manager",
    network: "mainnet",
    chainId: 1,
    requiredSender: admin,
    createdAt: "2026-07-18T18:00:00.000Z",
    expiresAt: "2099-07-18T19:00:00.000Z",
    transaction: {
      method: "stx_deployContract",
      params: {
        name: "signer-manager",
        clarityCode: "(define-public (ping) (ok true))",
        clarityVersion: 6,
        network: "mainnet",
        address: admin,
        sponsored: false,
        postConditionMode: "deny",
        postConditions: [],
      },
    },
    review: {
      title: "Deploy signer manager",
      summary: "Deploy the reviewed manager source.",
      expectedPostState: "The exact manager source is confirmed.",
    },
    seal: { factsSha256: "11".repeat(32), manifestSha256: "22".repeat(32) },
    status: "prepared",
    txid: null,
    verification: null,
    ...overrides,
  } as BrowserWalletIntent;
}

function registerIntent(): BrowserWalletIntent {
  return {
    ...deployIntent(),
    action: "register-self",
    transaction: {
      method: "stx_callContract",
      params: {
        contract: `${admin}.signer-manager`,
        functionName: "register-self",
        functionArgs: ["0x0516", "0x0200000021", "0x01000000000000002a", "0x0200000041"],
        network: "mainnet",
        address: admin,
        sponsored: false,
        postConditionMode: "deny",
        postConditions: [],
      },
    },
  } as BrowserWalletIntent;
}

type ManagerAction = Exclude<
  BrowserWalletIntent["action"],
  "deploy-manager" | "register-self" | "claim-rewards"
>;

function managerActionIntent(
  action: ManagerAction,
  overrides: Partial<BrowserWalletIntent> = {},
): BrowserWalletIntent {
  const functions = {
    "add-admin": "update-admin",
    "remove-admin": "update-admin",
    "update-fees": "update-fees",
    "withdraw-fees": "withdraw-fees",
    "sweep-fee-refunds": "sweep-fee-refunds",
  } as const;
  const functionArgs = {
    "add-admin": ["0x0516", "0x03"],
    "remove-admin": ["0x0516", "0x04"],
    "update-fees": ["0x010000000000000064"],
    "withdraw-fees": ["0x010000000000000064", "0x0516"],
    "sweep-fee-refunds": ["0x0516"],
  } as const;
  const requests = {
    "add-admin": { action: "add-admin", actorPrincipal: admin, adminPrincipal: admin },
    "remove-admin": { action: "remove-admin", actorPrincipal: admin, adminPrincipal: admin },
    "update-fees": { action: "update-fees", actorPrincipal: admin, feeBips: "100" },
    "withdraw-fees": {
      action: "withdraw-fees",
      actorPrincipal: admin,
      amountSats: "100",
      recipient: admin,
    },
    "sweep-fee-refunds": {
      action: "sweep-fee-refunds",
      actorPrincipal: admin,
      recipient: admin,
    },
  } as const;
  const needsAssetPostcondition = action === "withdraw-fees" || action === "sweep-fee-refunds";
  return {
    ...deployIntent(),
    schemaVersion: 2,
    action,
    request: requests[action],
    transaction: {
      method: "stx_callContract",
      params: {
        contract: `${admin}.signer-manager`,
        functionName: functions[action],
        functionArgs: [...functionArgs[action]],
        network: "mainnet",
        address: admin,
        sponsored: false,
        postConditionMode: "deny",
        postConditions: needsAssetPostcondition ? ["0x0001"] : [],
      },
    },
    review: {
      title: "Manager operation",
      summary: "Perform the exact reviewed operation.",
      expectedPostState: "The manager state is updated.",
      fields: [
        { label: "Manager", value: `${admin}.signer-manager` },
        { label: "Sender", value: admin },
      ],
    },
    ...overrides,
  } as BrowserWalletIntent;
}

function nonMainnetIntent(
  network: "pox5-testnet" | "devnet" | "regtest",
  chainId: number,
  action: ManagerAction = "update-fees",
): BrowserWalletIntent {
  const intent = managerActionIntent(action);
  if (intent.transaction.method !== "stx_callContract") throw new Error("Expected contract call");
  return {
    ...intent,
    network,
    chainId,
    requiredSender: testnetAdmin,
    request:
      action === "update-fees"
        ? { action, actorPrincipal: testnetAdmin, feeBips: "100" }
        : intent.request,
    transaction: {
      ...intent.transaction,
      params: {
        ...intent.transaction.params,
        contract: `${testnetAdmin}.signer-manager`,
        network,
        address: testnetAdmin,
      },
    },
    review: {
      ...intent.review,
      fields: [
        { label: "Manager", value: `${testnetAdmin}.signer-manager` },
        { label: "Sender", value: testnetAdmin },
      ],
    },
  } as BrowserWalletIntent;
}

function pox5Intent(action: ManagerAction = "update-fees"): BrowserWalletIntent {
  return nonMainnetIntent("pox5-testnet", POX5_TESTNET_CHAIN_ID, action);
}

function claimIntent(): BrowserWalletIntent {
  return {
    ...deployIntent(),
    schemaVersion: 2,
    action: "claim-rewards",
    request: {
      action: "claim-rewards",
      actorPrincipal: admin,
      jobId: "e7c8b4fc-6a8d-40c3-a32a-44fa36b34ea0",
    },
    transaction: {
      method: "stx_callContract",
      params: {
        contract: `${admin}.signer-manager`,
        functionName: "claim-rewards",
        functionArgs: ["0x0b00000000", "0x0100000000000000000000000000000005"],
        network: "mainnet",
        address: admin,
        sponsored: false,
        postConditionMode: "deny",
        postConditions: ["0x0001"],
      },
    },
    review: {
      title: "Claim signer rewards",
      summary: "Perform the exact reviewed claim.",
      expectedPostState: "The existing engine job reconciles the claim.",
      fields: [{ label: "Job ID", value: "e7c8b4fc-6a8d-40c3-a32a-44fa36b34ea0" }],
    },
  } as BrowserWalletIntent;
}

async function sealed(intent: BrowserWalletIntent): Promise<BrowserWalletIntent> {
  return {
    ...intent,
    seal: { ...intent.seal, manifestSha256: await browserWalletManifestSha256(intent) },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function dependencies({
  providerId = LEATHER_PROVIDER_ID,
  address = admin,
  deployResult = { txid, transaction: "raw-signed-deploy" },
  callResult = { txid, transaction: "raw-signed-call" },
}: {
  providerId?: string | null;
  address?: string;
  deployResult?: { txid?: string; transaction?: string };
  callResult?: { txid?: string; transaction?: string };
} = {}): BrowserWalletDependencies {
  return {
    connectWallet: vi.fn().mockResolvedValue({
      addresses: [{ address, publicKey: "02".repeat(33) }],
    }),
    selectedProviderId: vi.fn().mockReturnValue(providerId),
    selectedProvider: vi.fn().mockReturnValue(provider),
    deploy: vi.fn().mockResolvedValue(deployResult),
    call: vi.fn().mockResolvedValue(callResult),
  };
}

describe("browser wallet execution", () => {
  it("defines the exact provider matrix once for every supported action and network", () => {
    const actions: BrowserWalletAction[] = [
      "deploy-manager",
      "register-self",
      "add-admin",
      "remove-admin",
      "update-fees",
      "withdraw-fees",
      "sweep-fee-refunds",
      "claim-rewards",
    ];
    const xverseMainnetActions = new Set<BrowserWalletAction>([
      "register-self",
      "add-admin",
      "remove-admin",
      "update-fees",
    ]);

    for (const action of actions) {
      expect(browserWalletProviderIds(action, "mainnet")).toEqual(
        xverseMainnetActions.has(action)
          ? [LEATHER_PROVIDER_ID, XVERSE_PROVIDER_ID]
          : [LEATHER_PROVIDER_ID],
      );
      for (const network of ["pox5-testnet", "devnet", "regtest"] as const) {
        expect(browserWalletProviderIds(action, network)).toEqual([LEATHER_PROVIDER_ID]);
      }
    }
  });

  it.each([
    "failed",
    "superseded",
  ] as const)("allows a new review after a recorded %s transaction", (status) => {
    expect(canPrepareBrowserWalletIntent(deployIntent({ status, txid }), false)).toBe(true);
  });

  it("blocks a new review while a local wallet broadcast still needs recording", () => {
    expect(canPrepareBrowserWalletIntent(null, true)).toBe(false);
    expect(canPrepareBrowserWalletIntent(deployIntent({ status: "failed", txid }), true)).toBe(
      false,
    );
  });

  it.each([
    "prepared",
    "submitted",
    "mempool",
    "confirmed",
    "complete",
    "reobserve",
  ] as const)("does not prepare over a %s intent", (status) => {
    expect(canPrepareBrowserWalletIntent(deployIntent({ status }), false)).toBe(false);
  });

  it("matches the backend canonical manifest hash vector", async () => {
    await expect(browserWalletManifestSha256(deployIntent())).resolves.toBe(
      "6bc23d72aa8bdbe4fd9ed92892bc860008536bc987f1dbec43e0f57f60bed1b0",
    );
  });

  it("matches native SHA-256 when crypto.subtle is unavailable", async () => {
    const intent = deployIntent();
    const nativeDigest = await browserWalletManifestSha256(intent);
    const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    vi.stubGlobal("crypto", { getRandomValues });

    expect(globalThis.crypto.subtle).toBeUndefined();
    await expect(browserWalletManifestSha256(intent)).resolves.toBe(nativeDigest);
  });

  it("executes a sealed request when crypto.subtle is unavailable", async () => {
    const intent = await sealed(deployIntent());
    const deps = dependencies();
    const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    vi.stubGlobal("crypto", { getRandomValues });

    await expect(
      executeBrowserWalletIntent(intent, deps, new Date("2026-07-18T18:30:00.000Z")),
    ).resolves.toEqual({ txid, sender: admin, providerId: LEATHER_PROVIDER_ID });
    expect(deps.deploy).toHaveBeenCalledOnce();
  });

  it("reconstructs the exact historical V1 manifest after public review defaults", async () => {
    const intent = deployIntent({
      review: {
        title: "Deploy signer manager",
        summary: "Deploy the reviewed manager source.",
        expectedPostState: "The exact manager source is confirmed.",
        fields: [],
      },
    });

    await expect(browserWalletManifestSha256(intent)).resolves.toBe(
      "6bc23d72aa8bdbe4fd9ed92892bc860008536bc987f1dbec43e0f57f60bed1b0",
    );
  });

  it("passes the sealed Clarity 6 deployment unchanged to Leather", async () => {
    const intent = await sealed(deployIntent());
    const deps = dependencies({
      deployResult: { txid: "AB".repeat(32), transaction: "raw-signed-deploy" },
    });

    await expect(
      executeBrowserWalletIntent(intent, deps, new Date("2026-07-18T18:30:00.000Z")),
    ).resolves.toEqual({ txid, sender: admin, providerId: LEATHER_PROVIDER_ID });

    expect(deps.connectWallet).toHaveBeenCalledWith(
      expect.objectContaining({
        approvedProviderIds: [LEATHER_PROVIDER_ID],
        enableLocalStorage: false,
        forceWalletSelect: true,
        network: "mainnet",
      }),
    );
    expect(vi.mocked(deps.connectWallet).mock.calls[0]?.[0]).not.toHaveProperty("walletConnect");
    expect(deps.deploy).toHaveBeenCalledWith(
      expect.objectContaining({ provider }),
      intent.transaction.params,
    );
    expect(JSON.stringify(await executeBrowserWalletIntent(intent, deps))).not.toContain(
      "raw-signed-deploy",
    );
  });

  it("allows Xverse for the exact register-self request", async () => {
    const intent = await sealed(registerIntent());
    const deps = dependencies({ providerId: XVERSE_PROVIDER_ID });

    await expect(executeBrowserWalletIntent(intent, deps)).resolves.toEqual({
      txid,
      sender: admin,
      providerId: XVERSE_PROVIDER_ID,
    });
    expect(deps.connectWallet).toHaveBeenCalledWith(
      expect.objectContaining({
        approvedProviderIds: [LEATHER_PROVIDER_ID, XVERSE_PROVIDER_ID],
      }),
    );
    expect(deps.call).toHaveBeenCalledWith(
      expect.objectContaining({ provider }),
      intent.transaction.params,
    );
  });

  it.each([
    "add-admin",
    "remove-admin",
    "update-fees",
  ] as const)("allows Xverse for a sealed %s call", async (action) => {
    const intent = await sealed(managerActionIntent(action));
    const deps = dependencies({ providerId: XVERSE_PROVIDER_ID });

    await expect(executeBrowserWalletIntent(intent, deps)).resolves.toMatchObject({
      txid,
      sender: admin,
      providerId: XVERSE_PROVIDER_ID,
    });
    expect(deps.call).toHaveBeenCalledWith(
      expect.objectContaining({ provider }),
      intent.transaction.params,
    );
  });

  it.each([
    "deploy-manager",
    "withdraw-fees",
    "sweep-fee-refunds",
    "claim-rewards",
  ] as const)("blocks Xverse from %s before the transaction request", async (action) => {
    const intent = await sealed(
      action === "deploy-manager"
        ? deployIntent()
        : action === "claim-rewards"
          ? claimIntent()
          : managerActionIntent(action),
    );
    const deps = dependencies({ providerId: XVERSE_PROVIDER_ID });

    await expect(executeBrowserWalletIntent(intent, deps)).rejects.toMatchObject({
      code: "unsupported-wallet",
    });
    expect(deps.deploy).not.toHaveBeenCalled();
    expect(deps.call).not.toHaveBeenCalled();
  });

  it.each([
    "withdraw-fees",
    "sweep-fee-refunds",
    "claim-rewards",
  ] as const)("allows Leather for a sealed %s call with one asset postcondition", async (action) => {
    const intent = await sealed(
      action === "claim-rewards" ? claimIntent() : managerActionIntent(action),
    );
    const deps = dependencies();

    await expect(executeBrowserWalletIntent(intent, deps)).resolves.toMatchObject({
      txid,
      providerId: LEATHER_PROVIDER_ID,
    });
    expect(deps.call).toHaveBeenCalledWith(
      expect.objectContaining({ provider }),
      intent.transaction.params,
    );
  });

  it("uses Leather's exact dedicated PoX-5 Testnet custom-network key", async () => {
    const intent = await sealed(pox5Intent());
    const deps = dependencies({ address: testnetAdmin });

    await expect(executeBrowserWalletIntent(intent, deps)).resolves.toEqual({
      txid,
      sender: testnetAdmin,
      providerId: LEATHER_PROVIDER_ID,
    });
    expect(deps.connectWallet).toHaveBeenCalledWith(
      expect.objectContaining({
        approvedProviderIds: [LEATHER_PROVIDER_ID],
        network: "pox5-testnet",
      }),
    );
    expect(deps.call).toHaveBeenCalledWith(
      expect.objectContaining({ provider }),
      intent.transaction.params,
    );
  });

  it.each([
    ["devnet", 0x8000_0000],
    ["regtest", 0x8000_0001],
  ] as const)("uses Leather's exact %s network key and authoritative chain ID", async (network, chainId) => {
    const intent = await sealed(nonMainnetIntent(network, chainId));
    const deps = dependencies({ address: testnetAdmin });

    await expect(executeBrowserWalletIntent(intent, deps)).resolves.toEqual({
      txid,
      sender: testnetAdmin,
      providerId: LEATHER_PROVIDER_ID,
    });
    expect(deps.connectWallet).toHaveBeenCalledWith(
      expect.objectContaining({
        approvedProviderIds: [LEATHER_PROVIDER_ID],
        network,
      }),
    );
    expect(deps.call).toHaveBeenCalledWith(
      expect.objectContaining({ provider }),
      intent.transaction.params,
    );
  });

  it.each([
    {
      name: "ordinary testnet identifier",
      update: (intent: BrowserWalletIntent) => ({
        ...intent,
        network: "testnet",
        transaction: {
          ...intent.transaction,
          params: { ...intent.transaction.params, network: "testnet" },
        },
      }),
    },
    {
      name: "ordinary testnet chain ID",
      update: (intent: BrowserWalletIntent) => ({ ...intent, chainId: 0x80000000 }),
    },
  ])("rejects PoX-5 Testnet intent with $name", async ({ update }) => {
    const deps = dependencies({ address: testnetAdmin });
    const changed = update(await sealed(pox5Intent())) as BrowserWalletIntent;

    await expect(executeBrowserWalletIntent(changed, deps)).rejects.toMatchObject({
      code: "unsupported-network",
    });
    expect(deps.connectWallet).not.toHaveBeenCalled();
    expect(deps.call).not.toHaveBeenCalled();
  });

  it("requires exactly one sealed postcondition for asset-moving operations", async () => {
    for (const postConditions of [[], ["0x0001", "0x0002"]]) {
      const original = managerActionIntent("withdraw-fees");
      if (original.transaction.method !== "stx_callContract") throw new Error("Expected call");
      const intent = await sealed({
        ...original,
        transaction: {
          ...original.transaction,
          params: { ...original.transaction.params, postConditions },
        },
      } as BrowserWalletIntent);
      const deps = dependencies();

      await expect(executeBrowserWalletIntent(intent, deps)).rejects.toMatchObject({
        code: "invalid-intent",
      });
      expect(deps.call).not.toHaveBeenCalled();
    }
  });

  it("rejects an action whose sealed contract function does not match", async () => {
    const original = managerActionIntent("add-admin");
    if (original.transaction.method !== "stx_callContract") throw new Error("Expected call");
    const intent = await sealed({
      ...original,
      transaction: {
        ...original.transaction,
        params: { ...original.transaction.params, functionName: "update-fees" },
      },
    } as BrowserWalletIntent);
    const deps = dependencies();

    await expect(executeBrowserWalletIntent(intent, deps)).rejects.toMatchObject({
      code: "invalid-intent",
    });
    expect(deps.call).not.toHaveBeenCalled();
  });

  it("fails before the transaction request when the selected account is wrong", async () => {
    const deps = dependencies({ address: "SP1111111111111111111111111111111111" });

    await expect(
      executeBrowserWalletIntent(await sealed(deployIntent()), deps),
    ).rejects.toMatchObject({
      code: "address-mismatch",
    });
    expect(deps.deploy).not.toHaveBeenCalled();
    expect(deps.call).not.toHaveBeenCalled();
  });

  it("rejects a policy-valid request whose sealed source was changed in the browser", async () => {
    const intent = await sealed(deployIntent());
    const changed = {
      ...intent,
      transaction: {
        ...intent.transaction,
        params: {
          ...intent.transaction.params,
          clarityCode: "(define-public (changed) (ok true))",
        },
      },
    } as BrowserWalletIntent;
    const deps = dependencies();

    await expect(executeBrowserWalletIntent(changed, deps)).rejects.toMatchObject({
      code: "invalid-intent",
    });
    expect(deps.deploy).not.toHaveBeenCalled();
  });

  it("binds the version 2 action request into the manifest seal", async () => {
    const intent = await sealed(managerActionIntent("update-fees"));
    const changed = {
      ...intent,
      request: { action: "update-fees", actorPrincipal: admin, feeBips: "101" },
    } as BrowserWalletIntent;
    const deps = dependencies();

    await expect(executeBrowserWalletIntent(changed, deps)).rejects.toMatchObject({
      code: "invalid-intent",
    });
    expect(deps.call).not.toHaveBeenCalled();
  });

  it("rejects expired and changed intents before requesting the wallet", async () => {
    const expiredDeps = dependencies();
    await expect(
      executeBrowserWalletIntent(deployIntent(), expiredDeps, new Date("2099-07-18T19:00:00.000Z")),
    ).rejects.toMatchObject({ code: "expired-intent" });
    expect(expiredDeps.connectWallet).not.toHaveBeenCalled();

    const changed = deployIntent({
      requiredSender: "SP1111111111111111111111111111111111",
    });
    await expect(executeBrowserWalletIntent(changed, dependencies())).rejects.toMatchObject({
      code: "invalid-intent",
    });
  });

  it("warns that broadcast status is ambiguous when the wallet omits the txid", async () => {
    const failure = await executeBrowserWalletIntent(
      await sealed(deployIntent()),
      dependencies({ deployResult: { transaction: "raw-signed-only" } }),
    ).catch((error) => error);

    expect(failure).toMatchObject({ code: "missing-txid" });
    expect(String(failure)).toContain("Broadcast status may be ambiguous");
    expect(String(failure)).toContain("Check wallet activity and a Stacks explorer");
    expect(String(failure)).not.toContain("The transaction was not submitted");
  });

  it("treats every failure after invoking the transaction request as ambiguous", async () => {
    const deps = dependencies();
    vi.mocked(deps.deploy).mockRejectedValue({
      code: 4001,
      message: "secret provider diagnostic",
      transaction: "raw-signed-transaction",
    });

    const failure = await executeBrowserWalletIntent(await sealed(deployIntent()), deps).catch(
      (error) => error,
    );
    expect(deps.deploy).toHaveBeenCalledOnce();
    expect(failure).toMatchObject({ code: "request-failed" });
    expect(String(failure)).toContain("Broadcast status may be ambiguous");
    expect(String(failure)).toContain("Check wallet activity and a Stacks explorer");
    expect(String(failure)).not.toContain("secret provider diagnostic");
    expect(String(failure)).not.toContain("raw-signed-transaction");
  });

  it("rechecks expiry after wallet selection and before requesting a signature", async () => {
    const intent = await sealed(deployIntent({ expiresAt: "2026-07-18T18:31:00.000Z" }));
    const deps = dependencies();
    deps.now = () => new Date("2026-07-18T18:31:00.000Z");

    await expect(
      executeBrowserWalletIntent(intent, deps, new Date("2026-07-18T18:30:00.000Z")),
    ).rejects.toMatchObject({ code: "expired-intent" });
    expect(deps.deploy).not.toHaveBeenCalled();
  });

  it("does not request a wallet when server revalidation no longer returns prepared", async () => {
    const intent = await sealed(deployIntent());
    const refreshIntent = vi.fn().mockResolvedValue({ ...intent, status: "superseded" });
    const requestWallet = vi.fn();

    await expect(
      executeRevalidatedBrowserWalletIntent(intent, refreshIntent, requestWallet),
    ).resolves.toMatchObject({ intent: { status: "superseded" }, wallet: null });
    expect(refreshIntent).toHaveBeenCalledWith(intent.id);
    expect(requestWallet).not.toHaveBeenCalled();
  });

  it.each([
    {
      change: "network and chain binding",
      update: (_intent: BrowserWalletIntent) =>
        nonMainnetIntent("devnet", 0x8000_0000) as BrowserWalletIntent,
    },
    {
      change: "required sender",
      update: (intent: BrowserWalletIntent) => {
        if (intent.transaction.method !== "stx_callContract") throw new Error("Expected call");
        return {
          ...intent,
          requiredSender: "SP123",
          request: { action: "update-fees", actorPrincipal: "SP123", feeBips: "100" },
          transaction: {
            ...intent.transaction,
            params: { ...intent.transaction.params, address: "SP123" },
          },
        } as BrowserWalletIntent;
      },
    },
    {
      change: "transaction payload",
      update: (intent: BrowserWalletIntent) => {
        if (intent.transaction.method !== "stx_callContract") throw new Error("Expected call");
        return {
          ...intent,
          transaction: {
            ...intent.transaction,
            params: {
              ...intent.transaction.params,
              functionArgs: ["0x010000000000000065"],
            },
          },
        } as BrowserWalletIntent;
      },
    },
  ])("requires a refreshed prepared intent to preserve the reviewed $change before opening a wallet", async ({
    update,
  }) => {
    const reviewed = await sealed(managerActionIntent("update-fees"));
    const changed = update(reviewed);
    const refreshed = await sealed({
      ...changed,
      seal: { ...changed.seal, factsSha256: "44".repeat(32) },
    } as BrowserWalletIntent);
    const requestWallet = vi.fn();

    await expect(
      executeRevalidatedBrowserWalletIntent(
        reviewed,
        vi.fn().mockResolvedValue(refreshed),
        requestWallet,
      ),
    ).rejects.toMatchObject({
      code: "invalid-intent",
      message: expect.stringContaining("Review the current request again"),
    });
    expect(requestWallet).not.toHaveBeenCalled();
  });

  it.each([
    { action: "deployment", makeIntent: deployIntent },
    { action: "registration", makeIntent: registerIntent },
  ])("revalidates after deferred wallet selection and blocks a superseded $action", async ({
    makeIntent,
  }) => {
    const intent = await sealed(makeIntent());
    const selection = deferred<Awaited<ReturnType<BrowserWalletDependencies["connectWallet"]>>>();
    const deps = dependencies();
    vi.mocked(deps.connectWallet).mockReturnValue(selection.promise);
    const refreshIntent = vi
      .fn()
      .mockResolvedValueOnce(intent)
      .mockResolvedValueOnce({ ...intent, status: "superseded" });

    const execution = executeRevalidatedBrowserWalletIntent(
      intent,
      refreshIntent,
      (current, revalidateBeforeRequest) =>
        executeBrowserWalletIntent(
          current,
          deps,
          new Date("2026-07-18T18:30:00.000Z"),
          revalidateBeforeRequest,
        ),
    );
    const prevented = expect(execution).rejects.toMatchObject({ code: "invalid-intent" });

    await vi.waitFor(() => expect(deps.connectWallet).toHaveBeenCalledOnce());
    expect(refreshIntent).toHaveBeenCalledTimes(1);
    selection.resolve({
      addresses: [{ address: admin, publicKey: "02".repeat(33) }],
    });

    await prevented;
    expect(refreshIntent).toHaveBeenCalledTimes(2);
    expect(deps.deploy).not.toHaveBeenCalled();
    expect(deps.call).not.toHaveBeenCalled();
  });

  it.each([
    {
      change: "ID",
      update: (intent: BrowserWalletIntent) => ({
        ...intent,
        id: "a545c55b-bc60-4f4c-b58f-a1546ec422ef",
      }),
    },
    {
      change: "facts seal",
      update: (intent: BrowserWalletIntent) => ({
        ...intent,
        seal: { ...intent.seal, factsSha256: "33".repeat(32) },
      }),
    },
    {
      change: "manifest seal",
      update: (intent: BrowserWalletIntent) => ({
        ...intent,
        seal: { ...intent.seal, manifestSha256: "44".repeat(32) },
      }),
    },
  ])("blocks a prepared second revalidation with a changed $change", async ({ update }) => {
    const intent = await sealed(deployIntent());
    const deps = dependencies();
    const refreshIntent = vi
      .fn()
      .mockResolvedValueOnce(intent)
      .mockResolvedValueOnce(update(intent));

    await expect(
      executeRevalidatedBrowserWalletIntent(
        intent,
        refreshIntent,
        (current, revalidateBeforeRequest) =>
          executeBrowserWalletIntent(current, deps, new Date(), revalidateBeforeRequest),
      ),
    ).rejects.toMatchObject({ code: "invalid-intent" });
    expect(refreshIntent).toHaveBeenCalledTimes(2);
    expect(deps.deploy).not.toHaveBeenCalled();
    expect(deps.call).not.toHaveBeenCalled();
  });

  it("returns provider capabilities for each supported network binding", () => {
    expect(browserWalletSupport("deploy-manager", "testnet", POX5_TESTNET_CHAIN_ID)).toEqual({
      available: true,
      providerIds: [LEATHER_PROVIDER_ID],
      unavailableReason: null,
    });
    expect(browserWalletSupport("update-fees", "pox5-testnet", POX5_TESTNET_CHAIN_ID)).toEqual({
      available: true,
      providerIds: [LEATHER_PROVIDER_ID],
      unavailableReason: null,
    });
    expect(browserWalletSupport("update-fees", "devnet", 0x80000000)).toEqual({
      available: true,
      providerIds: [LEATHER_PROVIDER_ID],
      unavailableReason: null,
    });
    expect(browserWalletSupport("update-fees", "regtest", 0x80000001)).toEqual({
      available: true,
      providerIds: [LEATHER_PROVIDER_ID],
      unavailableReason: null,
    });
    expect(browserWalletSupport("update-fees", "mainnet", MAINNET_CHAIN_ID)).toEqual({
      available: true,
      providerIds: [LEATHER_PROVIDER_ID, XVERSE_PROVIDER_ID],
      unavailableReason: null,
    });
    expect(browserWalletSupport("deploy-manager", "mainnet", MAINNET_CHAIN_ID)).toEqual({
      available: true,
      providerIds: [LEATHER_PROVIDER_ID],
      unavailableReason: null,
    });
  });

  it("returns one manual fallback for unsupported network bindings", () => {
    expect(browserWalletSupport("update-fees", "mainnet", POX5_TESTNET_CHAIN_ID)).toEqual({
      available: false,
      providerIds: [],
      unavailableReason:
        "Browser wallet signing is unavailable for this network. Use another signing tool.",
    });
  });

  it("returns sanitized cancellation errors", async () => {
    const deps = dependencies();
    vi.mocked(deps.connectWallet).mockRejectedValue({
      code: -31001,
      message: "secret provider diagnostic",
      transaction: "raw-signed-transaction",
    });
    const failure = await executeBrowserWalletIntent(await sealed(deployIntent()), deps).catch(
      (error) => error,
    );
    expect(failure).toBeInstanceOf(BrowserWalletError);
    expect(failure).toMatchObject({ code: "wallet-cancelled" });
    expect(String(failure)).toContain("Wallet signing was cancelled");
    expect(String(failure)).not.toContain("Broadcast status may be ambiguous");
    expect(String(failure)).not.toContain("secret provider diagnostic");
    expect(String(failure)).not.toContain("raw-signed-transaction");
  });
});
