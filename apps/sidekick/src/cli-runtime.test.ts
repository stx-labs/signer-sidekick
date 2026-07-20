import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runOperatorPreflight: vi.fn(),
}));

vi.mock("./preflight.js", () => ({ runOperatorPreflight: mocks.runOperatorPreflight }));

import { type CliOutput, dispatchCli, withConnectedContext, withStore } from "./cli-runtime.js";
import { executeCliCommand } from "./main.js";

function captureOutput(): {
  output: CliOutput;
  stdout: () => string;
  stderr: () => string;
  exitCodes: () => number[];
} {
  let stdout = "";
  let stderr = "";
  const exitCodes: number[] = [];
  return {
    output: {
      stdout: (value) => {
        stdout += value;
      },
      stderr: (value) => {
        stderr += value;
      },
      setExitCode: (code) => {
        exitCodes.push(code);
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
    exitCodes: () => exitCodes,
  };
}

const connectedEnvironment = {
  STACKS_NODE_RPC_URL: "http://127.0.0.1:20443/",
  STACKS_API_KEY: "secret-key",
  SIDEKICK_DATABASE_PATH: ":memory:",
};

describe("CLI dispatch", () => {
  beforeEach(() => {
    mocks.runOperatorPreflight.mockReset();
  });

  it("routes an empty invocation to the stable help document", async () => {
    const capture = captureOutput();

    const result = await dispatchCli([], executeCliCommand, {
      env: {},
      output: capture.output,
    });

    expect(capture.stdout()).toMatchInlineSnapshot(`
      "Signer Sidekick

      Usage:
        sidekick serve    Start the loopback-only local API
        sidekick config validate  Validate and print redacted endpoint configuration
        sidekick doctor  Open, migrate, and verify the local SQLite store
        sidekick database backup <output.sqlite>  Create and integrity-check an online backup
        sidekick init fresh <admin> <name> <output-dir> <auth-id> [signer-config]
        sidekick init attach <manager>  Build an activation plan from a running manager
        sidekick preflight  Verify node, API, network, lag, and PoX-5 readiness
        sidekick attach <manager>  Verify and attach an existing manager in Observe mode
        sidekick manager verify <manager>  Verify deployed source and interface compatibility
        sidekick setup status <manager>  Verify registration and current/next eligibility
        sidekick setup record <manager> <pool-config.json> [record-metadata.json]
        sidekick pool enrollment-info <manager> <pool-config.json>
        sidekick pool sync-stakers <manager>  Reconcile API discoveries with PoX-5 node state
        sidekick events sync <manager>  Backfill and update canonical manager events
        sidekick pool status <manager>  Reconcile current and future pool totals
        sidekick rewards status <manager> [cycle]  Read STX reward and payout state
        sidekick export support-bundle <manager> [pool-config.json] [record-metadata.json]
        sidekick manager render <admin> <name> <output-dir>
        sidekick manager trust <manager> --output <profile.json> [--observe-only]
        sidekick signer-grant prepare <manager> <auth-id> [signer-config]
        sidekick signer-grant verify <manager> <auth-id> <signer-output.json>

      Environment:
        STACKS_NODE_RPC_URL  Required node RPC base URL for connected commands
        SIDEKICK_NETWORK     mainnet (default), pox5-testnet, devnet, or regtest
        STACKS_API_URL       Optional for mainnet/PoX-5 Testnet; defaults to Hiro
        STACKS_API_KEY       Optional API key; never included in output
        SIDEKICK_DATABASE_PATH  Optional SQLite path; defaults to data/sidekick.sqlite
        SIDEKICK_FORECAST_HORIZON_CYCLES  Optional forecast horizon; defaults to 6
        SIDEKICK_STATIC_DIRECTORY  Optional compiled dashboard directory override
        SIDEKICK_CONTRACTS_DIR  Optional path to the pinned contracts directory
        SIDEKICK_TRUSTED_MANAGER_PROFILES_DIR  Optional read-only installed profile directory
      "
    `);
    expect(capture.stderr()).toBe("");
    expect(capture.exitCodes()).toEqual([]);
    expect(result).toEqual({ exitCode: 0 });
  });

  it("writes stable redacted JSON for config validation", async () => {
    const capture = captureOutput();

    const result = await dispatchCli(["config", "validate"], executeCliCommand, {
      env: connectedEnvironment,
      output: capture.output,
    });

    expect(capture.stdout()).toMatchInlineSnapshot(`
      "{
        "valid": true,
        "config": {
          "network": "mainnet",
          "nodeRpcUrl": "http://127.0.0.1:20443",
          "apiUrl": "https://api.mainnet.hiro.so",
          "apiKeyHeader": "x-api-key",
          "maxApiBurnBlockLag": 12,
          "forecastHorizonCycles": 6,
          "stakerPageLimit": 200,
          "eventPageLimit": 100,
          "databasePath": ":memory:",
          "hiroReferenceApiUrl": "https://api.mainnet.hiro.so",
          "apiKeyConfigured": true
        }
      }
      "
    `);
    expect(capture.stdout()).not.toContain("secret-key");
    expect(capture.stderr()).toBe("");
    expect(result).toEqual({ exitCode: 0 });
  });

  it("reports command guards on stderr with exit code 1", async () => {
    const capture = captureOutput();

    const result = await dispatchCli(["database", "backup"], executeCliCommand, {
      env: {},
      output: capture.output,
    });

    expect(capture.stdout()).toBe("");
    expect(capture.stderr()).toBe("Usage: sidekick database backup <output.sqlite>\n");
    expect(capture.exitCodes()).toEqual([1]);
    expect(result).toEqual({ exitCode: 1 });
  });

  it("preserves an explicit attention exit code without contacting an endpoint", async () => {
    mocks.runOperatorPreflight.mockResolvedValue({ status: "fail" });
    const capture = captureOutput();

    const result = await dispatchCli(["preflight"], executeCliCommand, {
      env: connectedEnvironment,
      output: capture.output,
    });

    expect(JSON.parse(capture.stdout())).toMatchObject({
      config: { network: "mainnet", apiKeyConfigured: true },
      result: { status: "fail" },
    });
    expect(capture.stderr()).toBe("");
    expect(capture.exitCodes()).toEqual([2]);
    expect(result).toEqual({ exitCode: 2 });
    expect(mocks.runOperatorPreflight).toHaveBeenCalledOnce();
  });
});

describe("CLI lifecycle helpers", () => {
  it("closes an opened store after success", async () => {
    const close = vi.fn();

    await expect(
      withStore(
        async () => ({ store: { close }, backupPath: null }),
        async ({ backupPath }) => backupPath ?? "complete",
      ),
    ).resolves.toBe("complete");
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes an opened store after command failure", async () => {
    const close = vi.fn();

    await expect(
      withStore(
        async () => ({ store: { close }, backupPath: null }),
        async () => {
          throw new Error("command failed");
        },
      ),
    ).rejects.toThrow("command failed");
    expect(close).toHaveBeenCalledOnce();
  });

  it("surfaces close failures after a successful command", async () => {
    const close = vi.fn(() => {
      throw new Error("close failed");
    });

    await expect(
      withStore(
        async () => ({ store: { close }, backupPath: null }),
        async () => "complete",
      ),
    ).rejects.toThrow("close failed");
    expect(close).toHaveBeenCalledOnce();
  });

  it("surfaces a close failure when both command and cleanup fail", async () => {
    const close = vi.fn(() => {
      throw new Error("close failed");
    });

    await expect(
      withStore(
        async () => ({ store: { close }, backupPath: null }),
        async () => {
          throw new Error("command failed");
        },
      ),
    ).rejects.toThrow("close failed");
    expect(close).toHaveBeenCalledOnce();
  });

  it("builds one canonical connected setup snapshot before running a command", async () => {
    const config = { network: "mainnet" };
    const node = { kind: "node" };
    const api = { kind: "api" };
    const managerVerification = { kind: "verification" };
    const readSetupSnapshot = vi.fn(async () => ({
      preflight: { status: "pass" },
      chainAnchor: { rewardCycle: 91 },
    }));

    const result = await withConnectedContext(
      "SP000.manager",
      {
        loadConfig: () => config,
        clientsFromConfig: () => ({ node, api }),
        verificationContext: async () => managerVerification,
        readSetupSnapshot,
      },
      (context) => ({
        network: context.config.network,
        rewardCycle: context.chainAnchor.rewardCycle,
      }),
    );

    expect(readSetupSnapshot).toHaveBeenCalledWith({
      config,
      node,
      api,
      managerPrincipal: "SP000.manager",
      managerVerification,
    });
    expect(result).toEqual({ network: "mainnet", rewardCycle: 91 });
  });
});
