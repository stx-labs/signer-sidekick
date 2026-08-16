import { sha256 } from "@noble/hashes/sha2";
import type { MethodParams, StacksProvider } from "@stacks/connect";
import type {
  BrowserWalletIntent,
  BrowserWalletIntentNetwork,
} from "@stx-labs/signer-sidekick-api-contracts";
import { isStacksAddress, isStacksAddressForNetwork } from "../../shared/principal.js";

export const LEATHER_PROVIDER_ID = "LeatherProvider";
export const XVERSE_PROVIDER_ID = "XverseProviders.BitcoinProvider";
export const MAINNET_CHAIN_ID = 0x0000_0001;
export const POX5_TESTNET_CHAIN_ID = 0x8000_0005;
export const POX5_TESTNET_CONNECT_NETWORK = "pox5-testnet";
const MAX_CHAIN_ID = 0xffff_ffff;

export type BrowserWalletAction = BrowserWalletIntent["action"];
export type BrowserWalletProviderId = typeof LEATHER_PROVIDER_ID | typeof XVERSE_PROVIDER_ID;

export interface BrowserWalletResult {
  txid: string;
  sender: string;
  providerId: BrowserWalletProviderId;
}

export interface BrowserWalletRecoveryScope {
  network: BrowserWalletIntentNetwork;
  chainId: number;
  managerPrincipal: string;
  action: BrowserWalletAction;
  intentId: string;
}

interface ConnectResponse {
  addresses: Array<{ address: string; publicKey: string }>;
}

type TransactionResponse = { txid?: string };
interface ConnectOptions {
  provider?: StacksProvider;
  forceWalletSelect?: boolean;
  persistWalletSelect?: boolean;
  enableOverrides?: boolean;
  enableLocalStorage?: boolean;
  approvedProviderIds?: string[];
  network?: string;
}

type MaybePromise<T> = T | Promise<T>;

export interface BrowserWalletDependencies {
  connectWallet(options: ConnectOptions & { network: string }): Promise<ConnectResponse>;
  selectedProviderId(): MaybePromise<string | null | undefined>;
  selectedProvider(): MaybePromise<StacksProvider | null | undefined>;
  deploy(
    options: ConnectOptions,
    params: MethodParams<"stx_deployContract">,
  ): Promise<TransactionResponse>;
  call(
    options: ConnectOptions,
    params: MethodParams<"stx_callContract">,
  ): Promise<TransactionResponse>;
  now?(): Date;
}

let connectModule: Promise<typeof import("@stacks/connect")> | null = null;

function loadConnect(): Promise<typeof import("@stacks/connect")> {
  connectModule ??= import("@stacks/connect");
  return connectModule;
}

const defaultDependencies: BrowserWalletDependencies = {
  connectWallet: async (options) => (await loadConnect()).connect(options),
  selectedProviderId: async () => (await loadConnect()).getSelectedProviderId(),
  selectedProvider: async () => (await loadConnect()).getSelectedProvider(),
  deploy: async (options, params) =>
    (await loadConnect()).request(options, "stx_deployContract", params),
  call: async (options, params) =>
    (await loadConnect()).request(options, "stx_callContract", params),
};

export type BrowserWalletErrorCode =
  | "unsupported-network"
  | "expired-intent"
  | "invalid-intent"
  | "wallet-cancelled"
  | "wallet-unavailable"
  | "unsupported-wallet"
  | "address-mismatch"
  | "missing-txid"
  | "request-failed";

export class BrowserWalletError extends Error {
  constructor(
    readonly code: BrowserWalletErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BrowserWalletError";
  }
}

const XVERSE_MAINNET_ACTIONS = new Set<BrowserWalletAction>([
  "register-self",
  "add-admin",
  "remove-admin",
  "update-fees",
]);

export function browserWalletProviderIds(
  action: BrowserWalletAction,
  network: BrowserWalletIntentNetwork,
): BrowserWalletProviderId[] {
  return network === "mainnet" && XVERSE_MAINNET_ACTIONS.has(action)
    ? [LEATHER_PROVIDER_ID, XVERSE_PROVIDER_ID]
    : [LEATHER_PROVIDER_ID];
}

export function browserWalletProviderNames(
  providerIds: readonly BrowserWalletProviderId[],
): string {
  const names = providerIds.map((providerId) =>
    providerId === LEATHER_PROVIDER_ID ? "Leather" : "Xverse",
  );
  if (names.length === 0) return "a supported wallet";
  return names.length === 1 ? (names[0] ?? "a supported wallet") : names.join(" or ");
}

export function isBrowserWalletProviderSupported(
  providerId: unknown,
  action: BrowserWalletAction,
  network: BrowserWalletIntentNetwork,
): providerId is BrowserWalletProviderId {
  return browserWalletProviderIds(action, network).some((candidate) => candidate === providerId);
}

export function browserWalletIntentNetwork(network: string): BrowserWalletIntentNetwork | null {
  if (network === "testnet") return POX5_TESTNET_CONNECT_NETWORK;
  if (
    network === "mainnet" ||
    network === POX5_TESTNET_CONNECT_NETWORK ||
    network === "devnet" ||
    network === "regtest"
  ) {
    return network;
  }
  return null;
}

function validChainId(network: BrowserWalletIntentNetwork, chainId: number): boolean {
  if (!Number.isInteger(chainId) || chainId < 0 || chainId > MAX_CHAIN_ID) return false;
  if (network === "mainnet") return chainId === MAINNET_CHAIN_ID;
  if (network === POX5_TESTNET_CONNECT_NETWORK) return chainId === POX5_TESTNET_CHAIN_ID;
  return true;
}

export function browserWalletSupport(
  action: BrowserWalletAction,
  network: string,
  chainId: number,
): {
  available: boolean;
  providerIds: BrowserWalletProviderId[];
  unavailableReason: string | null;
} {
  const walletNetwork = browserWalletIntentNetwork(network);
  if (!walletNetwork || !validChainId(walletNetwork, chainId)) {
    return {
      available: false,
      providerIds: [],
      unavailableReason:
        "Browser wallet signing is unavailable for this network. Use another signing tool.",
    };
  }
  return {
    available: true,
    providerIds: browserWalletProviderIds(action, walletNetwork),
    unavailableReason: null,
  };
}

export function canPrepareBrowserWalletIntent(
  intent: BrowserWalletIntent | null,
  hasUnrecordedWalletResult: boolean,
): boolean {
  if (hasUnrecordedWalletResult) return false;
  return (
    intent === null ||
    intent.status === "expired" ||
    intent.status === "superseded" ||
    intent.status === "failed"
  );
}

export async function executeRevalidatedBrowserWalletIntent(
  intent: BrowserWalletIntent,
  refreshIntent: (intentId: string) => Promise<BrowserWalletIntent>,
  executeIntent: (
    current: BrowserWalletIntent,
    revalidateBeforeRequest: () => Promise<BrowserWalletIntent>,
  ) => Promise<BrowserWalletResult> = (current, revalidateBeforeRequest) =>
    executeBrowserWalletIntent(current, defaultDependencies, new Date(), revalidateBeforeRequest),
): Promise<{ intent: BrowserWalletIntent; wallet: BrowserWalletResult | null }> {
  const current = await refreshIntent(intent.id);
  if (current.status !== "prepared") return { intent: current, wallet: null };
  assertSamePreparedIntent(intent, current);
  return {
    intent: current,
    wallet: await executeIntent(current, () => refreshIntent(current.id)),
  };
}

function isExpired(expiresAt: string, now: Date): boolean {
  const expiry = Date.parse(expiresAt);
  return !Number.isFinite(expiry) || expiry <= now.getTime();
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new BrowserWalletError(
    "invalid-intent",
    "The transaction request is invalid. Prepare it again.",
  );
}

function normalizedContractPrincipal(value: string): string | null {
  const separator = value.indexOf(".");
  if (separator <= 0 || separator === value.length - 1 || value.indexOf(".", separator + 1) >= 0) {
    return null;
  }
  const address = value.slice(0, separator).toUpperCase();
  const contractName = value.slice(separator + 1);
  if (!isStacksAddress(address) || !/^[a-zA-Z][a-zA-Z0-9-_]{0,127}$/.test(contractName)) {
    return null;
  }
  return `${address}.${contractName}`;
}

export function browserWalletManagerPrincipal(intent: BrowserWalletIntent): string {
  const candidate =
    intent.transaction.method === "stx_deployContract"
      ? `${intent.requiredSender}.${intent.transaction.params.name}`
      : intent.transaction.params.contract;
  const principal = normalizedContractPrincipal(candidate);
  if (!principal) {
    throw new BrowserWalletError(
      "invalid-intent",
      "The prepared wallet request has an invalid manager target. Prepare it again.",
    );
  }
  return principal;
}

export function browserWalletRecoveryScope(
  intent: BrowserWalletIntent,
): BrowserWalletRecoveryScope {
  return {
    network: intent.network,
    chainId: intent.chainId,
    managerPrincipal: browserWalletManagerPrincipal(intent),
    action: intent.action as BrowserWalletAction,
    intentId: intent.id,
  };
}

export async function browserWalletManifestSha256(intent: BrowserWalletIntent): Promise<string> {
  const manifest = {
    schemaVersion: intent.schemaVersion,
    id: intent.id,
    action: intent.action,
    network: intent.network,
    chainId: intent.chainId,
    requiredSender: intent.requiredSender,
    createdAt: intent.createdAt,
    expiresAt: intent.expiresAt,
    transaction: intent.transaction,
    ...(intent.schemaVersion === 2 ? { request: intent.request } : {}),
    ...(intent.binding ? { binding: intent.binding } : {}),
    review:
      intent.schemaVersion === 1
        ? {
            title: intent.review.title,
            summary: intent.review.summary,
            expectedPostState: intent.review.expectedPostState,
          }
        : intent.review,
    seal: { factsSha256: intent.seal.factsSha256 },
  };
  const bytes = new TextEncoder().encode(canonicalJson(manifest));
  const digest = globalThis.crypto?.subtle
    ? new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes))
    : sha256(bytes);
  return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
}

interface WalletNetworkBinding {
  sidekickNetwork: BrowserWalletIntentNetwork;
  chainId: number;
  connectNetwork: BrowserWalletIntentNetwork;
}

function walletNetworkBinding(intent: BrowserWalletIntent): WalletNetworkBinding {
  const sidekickNetwork = String(intent.network);
  const connectNetwork = String(intent.transaction.params.network);
  if (
    (sidekickNetwork === "mainnet" ||
      sidekickNetwork === POX5_TESTNET_CONNECT_NETWORK ||
      sidekickNetwork === "devnet" ||
      sidekickNetwork === "regtest") &&
    connectNetwork === sidekickNetwork &&
    validChainId(sidekickNetwork, intent.chainId)
  ) {
    return {
      sidekickNetwork,
      chainId: intent.chainId,
      connectNetwork,
    };
  }
  throw new BrowserWalletError(
    "unsupported-network",
    "This transaction's network does not match Sidekick's configured network. Prepare it again or use the manual transaction details.",
  );
}

const ACTION_FUNCTIONS: Readonly<Record<Exclude<BrowserWalletAction, "deploy-manager">, string>> = {
  "register-self": "register-self",
  "add-admin": "update-admin",
  "remove-admin": "update-admin",
  "update-fees": "update-fees",
  "withdraw-fees": "withdraw-fees",
  "claim-staker-rewards": "claim-staker-rewards",
  "sweep-fee-refunds": "sweep-fee-refunds",
  "claim-rewards": "claim-rewards",
  "calculate-rewards": "calculate-rewards",
};

const ASSET_POSTCONDITION_ACTIONS = new Set<BrowserWalletAction>([
  "withdraw-fees",
  "sweep-fee-refunds",
  "claim-rewards",
]);

async function assertSealedRequest(intent: BrowserWalletIntent): Promise<WalletNetworkBinding> {
  const { params } = intent.transaction;
  const action = intent.action as BrowserWalletAction;
  const network = walletNetworkBinding(intent);
  const postConditions = params.postConditions;
  const requiresAssetPostconditions = ASSET_POSTCONDITION_ACTIONS.has(action);
  const managerPrincipal = browserWalletManagerPrincipal(intent);
  const managerAddress = managerPrincipal.slice(0, managerPrincipal.indexOf("."));
  if (
    params.address !== intent.requiredSender ||
    !isStacksAddressForNetwork(intent.requiredSender, network.sidekickNetwork) ||
    !isStacksAddressForNetwork(managerAddress, network.sidekickNetwork) ||
    params.sponsored !== false ||
    params.postConditionMode !== "deny" ||
    !Array.isArray(postConditions) ||
    (requiresAssetPostconditions ? postConditions.length !== 1 : postConditions.length !== 0) ||
    (intent.schemaVersion === 1 &&
      (network.sidekickNetwork !== "mainnet" ||
        (action !== "deploy-manager" && action !== "register-self"))) ||
    (intent.schemaVersion === 2 &&
      (intent.request?.action !== action || !Array.isArray(intent.review.fields)))
  ) {
    throw new BrowserWalletError(
      "invalid-intent",
      "The transaction request failed validation. Prepare it again.",
    );
  }
  if ((await browserWalletManifestSha256(intent)) !== intent.seal.manifestSha256) {
    throw new BrowserWalletError(
      "invalid-intent",
      "The prepared wallet request failed its integrity check. Prepare it again.",
    );
  }
  if (action === "deploy-manager") {
    if (
      intent.transaction.method !== "stx_deployContract" ||
      intent.transaction.params.clarityVersion !== 6
    ) {
      throw new BrowserWalletError(
        "invalid-intent",
        "The prepared wallet request does not match the requested operation. Prepare it again.",
      );
    }
  } else if (
    intent.transaction.method !== "stx_callContract" ||
    String(intent.transaction.params.functionName) !== ACTION_FUNCTIONS[action]
  ) {
    throw new BrowserWalletError(
      "invalid-intent",
      "The prepared wallet request does not match the requested operation. Prepare it again.",
    );
  }
  return network;
}

function assertSamePreparedIntent(
  expected: BrowserWalletIntent,
  current: BrowserWalletIntent,
): void {
  if (current.status !== "prepared" || canonicalJson(current) !== canonicalJson(expected)) {
    throw new BrowserWalletError(
      "invalid-intent",
      "The prepared wallet request changed after you reviewed it. Review the current request again before signing.",
    );
  }
}

function exactStxAddress(response: ConnectResponse, requiredSender: string): string {
  const sender = response.addresses.find(
    ({ address }) => address.toUpperCase() === requiredSender.toUpperCase(),
  )?.address;
  if (!sender?.toUpperCase().startsWith("S")) {
    throw new BrowserWalletError(
      "address-mismatch",
      `The selected wallet account is not the required address ${requiredSender}. Switch accounts and try again.`,
    );
  }
  return sender.toUpperCase();
}

function normalizedTxid(txid: string | undefined): string {
  const value = txid?.trim().replace(/^0x/i, "") ?? "";
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new BrowserWalletError(
      "missing-txid",
      "Broadcast status may be ambiguous because the wallet did not return a usable transaction ID. Check wallet activity and a Stacks explorer before retrying or using the manual path.",
    );
  }
  return `0x${value.toLowerCase()}`;
}

function sanitizedWalletFailure(cause: unknown, requestInvoked: boolean): BrowserWalletError {
  if (requestInvoked) {
    if (cause instanceof BrowserWalletError && cause.code === "missing-txid") return cause;
    return new BrowserWalletError(
      "request-failed",
      "Broadcast status may be ambiguous because the wallet request ended without a confirmed transaction ID. Check wallet activity and a Stacks explorer before retrying or using the manual path.",
    );
  }
  if (cause instanceof BrowserWalletError) return cause;
  const code =
    typeof cause === "object" && cause !== null && "code" in cause
      ? Number((cause as { code?: unknown }).code)
      : null;
  if (code === -31001 || code === -32002 || code === 4001) {
    return new BrowserWalletError(
      "wallet-cancelled",
      "Wallet signing was cancelled. The manual transaction path remains available.",
    );
  }
  if (typeof window === "undefined") {
    return new BrowserWalletError(
      "wallet-unavailable",
      "A supported browser wallet is not available in this environment.",
    );
  }
  return new BrowserWalletError(
    "request-failed",
    "The wallet request did not complete. No transaction was submitted; try again or use the manual path.",
  );
}

export async function executeBrowserWalletIntent(
  intent: BrowserWalletIntent,
  dependencies: BrowserWalletDependencies = defaultDependencies,
  now = new Date(),
  revalidateBeforeRequest?: () => Promise<BrowserWalletIntent>,
): Promise<BrowserWalletResult> {
  let requestInvoked = false;
  try {
    if (intent.status !== "prepared") {
      throw new BrowserWalletError(
        "invalid-intent",
        "This wallet request is no longer ready to sign. Prepare a new request.",
      );
    }
    if (isExpired(intent.expiresAt, now)) {
      throw new BrowserWalletError(
        "expired-intent",
        "This wallet request expired. Prepare a new request before signing.",
      );
    }
    const network = await assertSealedRequest(intent);

    const action = intent.action as BrowserWalletAction;
    const approvedProviderIds = browserWalletProviderIds(action, network.sidekickNetwork);
    const addresses = await dependencies.connectWallet({
      approvedProviderIds,
      enableLocalStorage: false,
      enableOverrides: true,
      forceWalletSelect: true,
      network: network.connectNetwork,
      persistWalletSelect: true,
    });
    const sender = exactStxAddress(addresses, intent.requiredSender);
    const providerId = await dependencies.selectedProviderId();
    const provider = await dependencies.selectedProvider();
    if (
      !isBrowserWalletProviderSupported(providerId, action, network.sidekickNetwork) ||
      !provider
    ) {
      const supportedWallets = browserWalletProviderNames(approvedProviderIds);
      throw new BrowserWalletError(
        "unsupported-wallet",
        approvedProviderIds.length === 1
          ? `This transaction supports ${supportedWallets} only. Select ${supportedWallets} or use the manual transaction details.`
          : `This transaction supports ${supportedWallets}. Select one or use the manual transaction details.`,
      );
    }
    const current = revalidateBeforeRequest ? await revalidateBeforeRequest() : intent;
    assertSamePreparedIntent(intent, current);
    await assertSealedRequest(current);
    if (isExpired(current.expiresAt, dependencies.now?.() ?? new Date())) {
      throw new BrowserWalletError(
        "expired-intent",
        "This wallet request expired before signing. Prepare a new request.",
      );
    }

    const requestOptions: ConnectOptions = {
      approvedProviderIds,
      enableLocalStorage: false,
      enableOverrides: true,
      forceWalletSelect: false,
      persistWalletSelect: false,
      provider,
    };
    requestInvoked = true;
    const response =
      current.transaction.method === "stx_deployContract"
        ? await dependencies.deploy(
            requestOptions,
            current.transaction.params as MethodParams<"stx_deployContract">,
          )
        : await dependencies.call(
            requestOptions,
            current.transaction.params as MethodParams<"stx_callContract">,
          );
    const txid = normalizedTxid(response.txid);
    return {
      txid,
      sender,
      providerId: providerId as BrowserWalletResult["providerId"],
    };
  } catch (cause) {
    throw sanitizedWalletFailure(cause, requestInvoked);
  }
}
