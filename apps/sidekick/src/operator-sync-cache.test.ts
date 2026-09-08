import { afterEach, describe, expect, it, vi } from "vitest";
import type { StacksApiClient, StacksNodeClient } from "./chain-clients.js";
import type { SidekickConfig } from "./config.js";
import { syncManagerEvents } from "./manager-event-sync.js";
import { readOperatorAnchorSnapshot } from "./operator-anchor-snapshot.js";
import { OperatorService } from "./operator-service.js";
import { createChainSourceId, openSidekickStore, type SidekickStore } from "./storage/store.js";

vi.mock("./operator-anchor-snapshot.js", async (original) => ({
  ...(await original<typeof import("./operator-anchor-snapshot.js")>()),
  readOperatorAnchorSnapshot: vi.fn(),
}));
vi.mock("./manager-event-sync.js", async (original) => ({
  ...(await original<typeof import("./manager-event-sync.js")>()),
  syncManagerEvents: vi.fn(),
}));
const stores: SidekickStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.resetAllMocks();
});
const manager = "SP000000000000000000002Q6VF78.signer-manager";
const now = "2026-09-08T12:00:00.000Z";
const events = {
  stream: "test",
  resumed: false,
  pagesProcessed: 1,
  eventsProcessed: 1,
  newEvents: 0,
  replayedEvents: 1,
  decodeFailures: 0,
  reorgedEvents: 0,
  nodeVerifiedTransactions: 0,
  stoppedAtKnownOverlap: true,
};

async function fixture() {
  const { store } = await openSidekickStore(":memory:");
  stores.push(store);
  const config = {
    network: "mainnet",
    nodeRpcUrl: "http://node.invalid",
    apiUrl: "http://api.invalid",
    apiKeyHeader: "x-api-key",
    eventPageLimit: 100,
  } as SidekickConfig;
  vi.mocked(readOperatorAnchorSnapshot).mockResolvedValue({
    preflight: { checks: [], api: { available: true }, node: { networkId: 1 } },
    manager: {
      attachAllowed: true,
      source: {
        tier: "unrecognized",
        profileId: null,
        origin: null,
        sha256: "aa".repeat(32),
        canonicalSha256: "bb".repeat(32),
      },
      automationEligible: false,
      automationEligibilityReason: "Observe only",
      capabilities: { eventVocabulary: { normalizationAvailable: false, adapter: null } },
    },
  } as unknown as Awaited<ReturnType<typeof readOperatorAnchorSnapshot>>);
  vi.mocked(syncManagerEvents).mockResolvedValue(events);
  const service = new OperatorService({
    config,
    store,
    managerPrincipal: manager,
    node: {} as StacksNodeClient,
    api: {} as StacksApiClient,
    nodeTransactions: {} as NonNullable<
      ConstructorParameters<typeof OperatorService>[0]["nodeTransactions"]
    >,
    now: () => Date.parse(now),
  });
  const load = vi.fn().mockResolvedValue({
    generatedAt: now,
    network: "mainnet",
    roster: [],
    chainAnchor: { stacksBlockHeight: 100, burnBlockHeight: 200 },
    rewardOutlook: null,
  });
  (service as unknown as { load: typeof load }).load = load;
  await service.synchronizeManagerActivity(); // establish first-observed trust state
  await service.refreshSnapshot();
  return { store, service, load, sourceId: createChainSourceId("mainnet", config.apiUrl) };
}

describe("sync cache invalidation", () => {
  it("retains a warm snapshot across a genuine overlap/no-op sync", async () => {
    const { service, load } = await fixture();
    const before = service.storedSupportSnapshot();
    await service.synchronizeManagerActivity();
    await service.snapshot();
    expect(load).toHaveBeenCalledTimes(1);
    expect(service.storedSupportSnapshot()?.freshness).toMatchObject({
      status: "current",
      snapshotGeneratedAt: before?.freshness.snapshotGeneratedAt,
      reason: null,
    });
  });

  it("invalidates when an empty roster first becomes authoritative, not on later run IDs", async () => {
    const { service, store, load } = await fixture();
    const completed = vi.spyOn(store, "getLatestCompletedSignerStakerRun");
    vi.mocked(syncManagerEvents).mockImplementationOnce(async () => {
      completed.mockReturnValue({ authoritative: true } as NonNullable<
        ReturnType<typeof store.getLatestCompletedSignerStakerRun>
      >);
      return events;
    });
    await service.synchronizeManagerActivity();
    expect(service.storedSupportSnapshot()?.freshness.status).toBe("stale");
    await service.refreshBackgroundSnapshot();
    await service.synchronizeManagerActivity();
    await service.snapshot();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it.each([
    "replay",
    "coverage",
    "partial-failure",
  ])("invalidates %s with no new event identities while retaining labelled data", async (mode) => {
    const { service, store, sourceId, load } = await fixture();
    vi.mocked(syncManagerEvents).mockImplementationOnce(async () => {
      if (mode !== "replay")
        store.chainState.putCursor({
          sourceId,
          stream: "reinterpreted",
          cursor: "page-2",
          lastBlockHeight: 100,
          lastIndexBlockHash: null,
          updatedAt: now,
        });
      if (mode === "partial-failure") throw new Error("page two unavailable");
      return mode === "replay" ? { ...events, stoppedAtKnownOverlap: false } : events;
    });
    if (mode === "partial-failure")
      await expect(service.synchronizeManagerActivity()).rejects.toThrow("page two");
    else await service.synchronizeManagerActivity();
    expect(service.storedSupportSnapshot()?.freshness.status).toBe("stale");
    expect(load).toHaveBeenCalledTimes(1);
    await service.refreshBackgroundSnapshot();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("drops known noncanonical projections and cannot republish an in-flight pre-sync read", async () => {
    const { service, load } = await fixture();
    let release!: (value: unknown) => void;
    load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = service.refreshSnapshot();
    vi.mocked(syncManagerEvents).mockResolvedValueOnce({ ...events, reorgedEvents: 1 });
    await service.synchronizeManagerActivity();
    expect(service.storedSupportSnapshot()).toBeNull();
    release({ generatedAt: now, chainAnchor: {}, roster: [] });
    await expect(pending).rejects.toThrow("Projection inputs changed");
    expect(service.storedSupportSnapshot()).toBeNull();
  });
});
