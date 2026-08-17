import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeSettingsController } from "./runtime-settings.js";
import { SignerGrantService } from "./signer-grant-service.js";

const { prepareSignerGrantMock, runOperatorPreflightMock, verifySignerGrantOutputMock } =
  vi.hoisted(() => ({
    prepareSignerGrantMock: vi.fn(),
    runOperatorPreflightMock: vi.fn(),
    verifySignerGrantOutputMock: vi.fn(),
  }));

vi.mock("./preflight.js", () => ({ runOperatorPreflight: runOperatorPreflightMock }));
vi.mock("./signer-grant.js", () => ({
  prepareSignerGrant: prepareSignerGrantMock,
  verifySignerGrantOutput: verifySignerGrantOutputMock,
}));

const managerPrincipal = "SP000000000000000000002Q6VF78.signer-manager";
const pox5ContractId = "SP000000000000000000002Q6VF78.pox-5";
const node = {};
const api = {};
const config = {};
const runtimeSettings = {
  clients: () => ({ node, api, config }),
} as unknown as RuntimeSettingsController;

function preparation(authId = "8", hash = "07".repeat(32)) {
  return {
    managerPrincipal,
    pox5ContractId,
    authId,
    expectedMessageHashHex: hash,
    command: `stacks-signer generate-staking-signature --auth-id ${authId} --json`,
  };
}

function verifiedGrant(authId = "8") {
  return {
    managerPrincipal,
    pox5ContractId,
    authId,
    signerKeyHex: `02${"11".repeat(32)}`,
    signerSignatureHex: "22".repeat(65),
    expectedMessageHashHex: "07".repeat(32),
    signatureValid: true as const,
    registerSelfCall: {
      contract: managerPrincipal,
      functionName: "register-self" as const,
      arguments: ["0x01"],
      signingPrincipal: managerPrincipal.split(".")[0] ?? "",
      signingAuthority: "external-offline-admin" as const,
    },
  };
}

function service() {
  return new SignerGrantService({ runtimeSettings, managerPrincipal });
}

describe("signer grant service", () => {
  beforeEach(() => {
    prepareSignerGrantMock.mockReset();
    runOperatorPreflightMock.mockReset();
    verifySignerGrantOutputMock.mockReset();
  });

  it("keeps a short-lived external signing ceremony separate from first-run setup", async () => {
    runOperatorPreflightMock.mockResolvedValue({
      status: "pass",
      pox: { pox5ContractId },
    });
    prepareSignerGrantMock.mockResolvedValue(preparation());
    const grants = service();

    await expect(
      grants.prepare({ authId: "8", signerConfigPath: "/etc/stacks-signer/signer.toml" }),
    ).resolves.toMatchObject({
      preparation: { managerPrincipal, pox5ContractId, authId: "8" },
      verified: null,
    });
    expect(prepareSignerGrantMock).toHaveBeenCalledWith(
      node,
      pox5ContractId,
      managerPrincipal,
      "8",
      "/etc/stacks-signer/signer.toml",
    );
    expect(grants.walletState()).toEqual({
      managerPrincipal,
      signerGrant: { verified: null },
    });
  });

  it("blocks grant preparation when the operator chain sources cannot prove PoX-5", async () => {
    runOperatorPreflightMock.mockResolvedValue({ status: "fail", pox: { pox5ContractId: null } });

    await expect(
      service().prepare({ authId: "8", signerConfigPath: "/etc/stacks-signer/signer.toml" }),
    ).rejects.toMatchObject({ responseCode: "signer_grant_sources_incompatible" });
    expect(prepareSignerGrantMock).not.toHaveBeenCalled();
  });

  it("requires a current preparation and exposes only the verified public grant to wallet actions", async () => {
    runOperatorPreflightMock.mockResolvedValue({
      status: "pass",
      pox: { pox5ContractId },
    });
    prepareSignerGrantMock.mockResolvedValue(preparation());
    verifySignerGrantOutputMock.mockResolvedValue(verifiedGrant());
    const grants = service();

    await expect(grants.verify({})).rejects.toMatchObject({
      responseCode: "signer_grant_not_prepared",
    });
    await grants.prepare({ authId: "8", signerConfigPath: "/etc/stacks-signer/signer.toml" });
    await expect(grants.verify({ signerOutput: "external" })).resolves.toMatchObject({
      verified: { managerPrincipal, authId: "8", signatureValid: true },
    });
    expect(grants.walletState().signerGrant.verified).toMatchObject({
      managerPrincipal,
      signerKeyHex: `02${"11".repeat(32)}`,
    });
  });

  it("rejects verification if a newer authorization replaces the in-flight ceremony", async () => {
    runOperatorPreflightMock.mockResolvedValue({
      status: "pass",
      pox: { pox5ContractId },
    });
    prepareSignerGrantMock
      .mockResolvedValueOnce(preparation("8", "07".repeat(32)))
      .mockResolvedValueOnce(preparation("9", "08".repeat(32)));
    let release: ((value: ReturnType<typeof verifiedGrant>) => void) | undefined;
    verifySignerGrantOutputMock.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const grants = service();
    await grants.prepare({ authId: "8", signerConfigPath: "/signer.toml" });
    const verification = grants.verify({ signerOutput: "old" });
    await grants.prepare({ authId: "9", signerConfigPath: "/signer.toml" });
    release?.(verifiedGrant("8"));

    await expect(verification).rejects.toMatchObject({ responseCode: "signer_grant_changed" });
    expect(grants.current()).toMatchObject({ preparation: { authId: "9" }, verified: null });
  });
});
