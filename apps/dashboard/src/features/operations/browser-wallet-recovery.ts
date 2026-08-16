import {
  type BrowserWalletIntent,
  type BrowserWalletIntentNetwork,
  browserWalletIntentActionSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import {
  type BrowserWalletAction,
  type BrowserWalletRecoveryScope,
  type BrowserWalletResult,
  browserWalletIntentNetwork,
  browserWalletRecoveryScope,
  isBrowserWalletProviderSupported,
  MAINNET_CHAIN_ID,
  POX5_TESTNET_CHAIN_ID,
} from "./browser-wallet.js";

export interface PendingBrowserWalletBroadcast extends BrowserWalletResult {
  intentId: string;
}

export interface ScopedPendingBrowserWalletBroadcast extends PendingBrowserWalletBroadcast {
  network: BrowserWalletIntentNetwork;
  chainId: number;
  managerPrincipal: string;
  action: BrowserWalletAction;
}

export interface BrowserWalletRecoverySelector {
  network: string;
  chainId: number;
  managerPrincipal: string;
  action: BrowserWalletAction;
  intentId?: string;
}

interface RecoveryStorage {
  readonly length?: number;
  key?(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface PendingBroadcastBackend {
  getIntent(intentId: string): Promise<BrowserWalletIntent>;
  recordTxid(intentId: string, txid: string): Promise<BrowserWalletIntent>;
}

export interface PendingBroadcastRecovery {
  intent: BrowserWalletIntent;
  pending: ScopedPendingBrowserWalletBroadcast;
  outcome: "already-recorded" | "recorded" | "conflict";
}

const storagePrefix = "signer-sidekick:browser-wallet:pending:v3:";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const txidPattern = /^0x[0-9a-f]{64}$/;
const mainnetAddressPattern = /^S[PM][0-9A-Z]{20,50}$/;
const testnetAddressPattern = /^S[TN][0-9A-Z]{20,50}$/;
const contractNamePattern = /^[a-zA-Z][a-zA-Z0-9-_]{0,127}$/;
const actionIds = new Set<BrowserWalletAction>(browserWalletIntentActionSchema.options);
const recoveryInFlight = new Map<string, Promise<PendingBroadcastRecovery>>();

function validNetworkBinding(network: BrowserWalletIntentNetwork, chainId: number): boolean {
  if (!Number.isInteger(chainId) || chainId < 0 || chainId > 0xffff_ffff) return false;
  if (network === "mainnet") return chainId === MAINNET_CHAIN_ID;
  if (network === "pox5-testnet") return chainId === POX5_TESTNET_CHAIN_ID;
  return true;
}

function normalizedManagerPrincipal(
  value: string,
  network: BrowserWalletIntentNetwork,
): string | null {
  const separator = value.indexOf(".");
  if (separator <= 0 || separator === value.length - 1 || value.indexOf(".", separator + 1) >= 0) {
    return null;
  }
  const address = value.slice(0, separator).toUpperCase();
  const contractName = value.slice(separator + 1);
  const addressPattern = network === "mainnet" ? mainnetAddressPattern : testnetAddressPattern;
  if (!addressPattern.test(address) || !contractNamePattern.test(contractName)) return null;
  return `${address}.${contractName}`;
}

function normalizedSelector(
  value: BrowserWalletRecoverySelector,
): BrowserWalletRecoverySelector | null {
  if (!actionIds.has(value.action)) return null;
  const network = browserWalletIntentNetwork(value.network);
  const managerPrincipal = network
    ? normalizedManagerPrincipal(value.managerPrincipal, network)
    : null;
  if (
    !network ||
    !validNetworkBinding(network, value.chainId) ||
    !managerPrincipal ||
    (value.intentId !== undefined && !uuidPattern.test(value.intentId))
  ) {
    return null;
  }
  return {
    network,
    chainId: value.chainId,
    managerPrincipal,
    action: value.action,
    ...(value.intentId === undefined ? {} : { intentId: value.intentId.toLowerCase() }),
  };
}

function resolveSelector(
  input: BrowserWalletRecoverySelector,
  pending?: PendingBrowserWalletBroadcast,
): BrowserWalletRecoverySelector | null {
  const intentId = input.intentId ?? pending?.intentId;
  return normalizedSelector({
    ...input,
    ...(intentId ? { intentId } : {}),
  });
}

function storageKey(scope: BrowserWalletRecoveryScope): string {
  const chainId = scope.chainId.toString(16).padStart(8, "0");
  return `${storagePrefix}${scope.network}:${chainId}:${encodeURIComponent(scope.managerPrincipal)}:${scope.action}:${scope.intentId.toLowerCase()}`;
}

function keyForSelector(selector: BrowserWalletRecoverySelector): string | null {
  if (!selector.intentId) return null;
  return storageKey(selector as BrowserWalletRecoveryScope);
}

function browserStorages(): RecoveryStorage[] {
  const storages: RecoveryStorage[] = [];
  try {
    if (typeof localStorage !== "undefined") storages.push(localStorage);
  } catch {
    // Storage access can be blocked by browser policy. Session storage is the fallback.
  }
  try {
    if (typeof sessionStorage !== "undefined" && !storages.includes(sessionStorage)) {
      storages.push(sessionStorage);
    }
  } catch {
    // The caller still retains the pending broadcast in memory for this page.
  }
  return storages;
}

function parsePending(value: string | null): ScopedPendingBrowserWalletBroadcast | null {
  if (value === null || value.length > 2_048) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return null;
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !==
      "action,chainId,intentId,managerPrincipal,network,providerId,sender,txid" ||
    typeof record.intentId !== "string" ||
    !uuidPattern.test(record.intentId) ||
    typeof record.txid !== "string" ||
    !txidPattern.test(record.txid) ||
    typeof record.chainId !== "number" ||
    typeof record.network !== "string" ||
    typeof record.action !== "string" ||
    !actionIds.has(record.action as BrowserWalletAction) ||
    typeof record.managerPrincipal !== "string" ||
    typeof record.sender !== "string"
  ) {
    return null;
  }
  const network = browserWalletIntentNetwork(record.network);
  if (!network || network !== record.network || !validNetworkBinding(network, record.chainId)) {
    return null;
  }
  const action = record.action as BrowserWalletAction;
  const managerPrincipal = normalizedManagerPrincipal(record.managerPrincipal, network);
  const sender = record.sender.toUpperCase();
  const addressPattern = network === "mainnet" ? mainnetAddressPattern : testnetAddressPattern;
  if (
    !managerPrincipal ||
    !addressPattern.test(sender) ||
    !isBrowserWalletProviderSupported(record.providerId, action, network)
  ) {
    return null;
  }
  return {
    intentId: record.intentId.toLowerCase(),
    network,
    chainId: record.chainId,
    managerPrincipal,
    action,
    txid: record.txid,
    sender,
    providerId: record.providerId,
  };
}

function samePending(
  left: PendingBrowserWalletBroadcast,
  right: PendingBrowserWalletBroadcast,
): boolean {
  return (
    left.intentId.toLowerCase() === right.intentId.toLowerCase() &&
    left.txid === right.txid &&
    left.sender.toUpperCase() === right.sender.toUpperCase() &&
    left.providerId === right.providerId
  );
}

function matchesSelector(
  pending: ScopedPendingBrowserWalletBroadcast,
  selector: BrowserWalletRecoverySelector,
): boolean {
  return (
    pending.network === selector.network &&
    pending.chainId === selector.chainId &&
    pending.managerPrincipal === selector.managerPrincipal &&
    pending.action === selector.action &&
    (selector.intentId === undefined || pending.intentId === selector.intentId)
  );
}

function storageKeys(storage: RecoveryStorage): string[] {
  if (typeof storage.length !== "number" || typeof storage.key !== "function") return [];
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(storagePrefix)) keys.push(key);
  }
  return keys;
}

function recordsForSelector(
  input: BrowserWalletRecoverySelector,
  storages: readonly RecoveryStorage[],
): Array<{ key: string; pending: ScopedPendingBrowserWalletBroadcast }> {
  const selector = normalizedSelector(input);
  if (!selector) return [];
  const exactKey = keyForSelector(selector);
  const records = new Map<string, { key: string; pending: ScopedPendingBrowserWalletBroadcast }>();
  for (const storage of storages) {
    try {
      const keys = exactKey ? [exactKey] : storageKeys(storage);
      for (const key of keys) {
        const pending = parsePending(storage.getItem(key));
        if (!pending || storageKey(pending) !== key || !matchesSelector(pending, selector)) {
          continue;
        }
        records.set(`${key}:${pending.txid}:${pending.sender}:${pending.providerId}`, {
          key,
          pending,
        });
      }
    } catch {
      // Try the next browser storage implementation.
    }
  }
  return [...records.values()];
}

export function persistPendingBrowserWalletBroadcast(
  scopeInput: BrowserWalletRecoverySelector,
  pending: PendingBrowserWalletBroadcast,
  storages: readonly RecoveryStorage[] = browserStorages(),
): boolean {
  const selector = resolveSelector(scopeInput, pending);
  if (!selector?.intentId || selector.intentId !== pending.intentId.toLowerCase()) return false;
  const validated = parsePending(
    JSON.stringify({
      ...pending,
      intentId: pending.intentId.toLowerCase(),
      network: selector.network,
      chainId: selector.chainId,
      managerPrincipal: selector.managerPrincipal,
      action: selector.action,
      sender: pending.sender.toUpperCase(),
    }),
  );
  if (!validated) return false;
  const key = storageKey(validated);
  const encoded = JSON.stringify(validated);
  let persisted = false;
  for (const storage of storages) {
    try {
      storage.setItem(key, encoded);
      persisted = true;
    } catch {
      // Try the next browser storage implementation.
    }
  }
  return persisted;
}

export function loadPendingBrowserWalletBroadcast(
  scopeInput: BrowserWalletRecoverySelector,
  storages: readonly RecoveryStorage[] = browserStorages(),
): ScopedPendingBrowserWalletBroadcast | null {
  const records = loadPendingBrowserWalletBroadcasts(scopeInput, storages);
  return records.length === 1 ? (records[0] ?? null) : null;
}

export function loadPendingBrowserWalletBroadcasts(
  scopeInput: BrowserWalletRecoverySelector,
  storages: readonly RecoveryStorage[] = browserStorages(),
): ScopedPendingBrowserWalletBroadcast[] {
  return recordsForSelector(scopeInput, storages).map(({ pending }) => pending);
}

export function clearPendingBrowserWalletBroadcast(
  scopeInput: BrowserWalletRecoverySelector,
  expected: PendingBrowserWalletBroadcast,
  storages: readonly RecoveryStorage[] = browserStorages(),
): void {
  const records = recordsForSelector(scopeInput, storages).filter(({ pending }) =>
    samePending(pending, expected),
  );
  for (const storage of storages) {
    for (const { key } of records) {
      try {
        const current = parsePending(storage.getItem(key));
        if (current && samePending(current, expected)) storage.removeItem(key);
      } catch {
        // A blocked storage does not prevent clearing another available copy.
      }
    }
  }
}

function matchesIntent(
  pending: ScopedPendingBrowserWalletBroadcast,
  intent: BrowserWalletIntent,
): boolean {
  try {
    const scope = browserWalletRecoveryScope(intent);
    return (
      scope.network === pending.network &&
      scope.chainId === pending.chainId &&
      scope.managerPrincipal === pending.managerPrincipal &&
      scope.action === pending.action &&
      scope.intentId.toLowerCase() === pending.intentId &&
      intent.network === pending.network &&
      intent.transaction.params.network === pending.network &&
      intent.requiredSender.toUpperCase() === pending.sender
    );
  } catch {
    return false;
  }
}

export function recoverSpecificPendingBrowserWalletBroadcast(
  expected: ScopedPendingBrowserWalletBroadcast,
  backend: PendingBroadcastBackend,
  storages: readonly RecoveryStorage[] = browserStorages(),
): Promise<PendingBroadcastRecovery | null> {
  const pending = recordsForSelector(expected, storages)
    .map(({ pending: candidate }) => candidate)
    .find((candidate) => samePending(candidate, expected));
  if (!pending) return Promise.resolve(null);
  const recoveryKey = `${storageKey(pending)}:${pending.txid}`;
  const existing = recoveryInFlight.get(recoveryKey);
  if (existing) return existing;

  const recovery = (async (): Promise<PendingBroadcastRecovery> => {
    const current = await backend.getIntent(pending.intentId);
    if (!matchesIntent(pending, current)) {
      return { intent: current, pending, outcome: "conflict" };
    }
    if (current.txid === pending.txid) {
      clearPendingBrowserWalletBroadcast(pending, pending, storages);
      return { intent: current, pending, outcome: "already-recorded" };
    }
    if (current.txid !== null) return { intent: current, pending, outcome: "conflict" };

    const recorded = await backend.recordTxid(pending.intentId, pending.txid);
    if (recorded.txid !== pending.txid || !matchesIntent(pending, recorded)) {
      return { intent: recorded, pending, outcome: "conflict" };
    }
    clearPendingBrowserWalletBroadcast(pending, pending, storages);
    return { intent: recorded, pending, outcome: "recorded" };
  })();
  recoveryInFlight.set(recoveryKey, recovery);
  const release = () => {
    if (recoveryInFlight.get(recoveryKey) === recovery) recoveryInFlight.delete(recoveryKey);
  };
  void recovery.then(release, release);
  return recovery;
}

export function recoverPendingBrowserWalletBroadcast(
  scopeInput: BrowserWalletRecoverySelector,
  backend: PendingBroadcastBackend,
  storages: readonly RecoveryStorage[] = browserStorages(),
): Promise<PendingBroadcastRecovery | null> {
  const pending = loadPendingBrowserWalletBroadcast(scopeInput, storages);
  if (!pending) return Promise.resolve(null);
  return recoverSpecificPendingBrowserWalletBroadcast(pending, backend, storages);
}
