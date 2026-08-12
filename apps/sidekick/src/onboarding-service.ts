import { parseContractPrincipal } from "@stx-labs/signer-sidekick-protocol/principals";
import { z } from "zod";
import {
  type ActivationPlan,
  activationPlanSchema,
  createAttachActivationPlan,
  createFreshActivationPlan,
} from "./activation-plan.js";
import {
  assertManagerRenderPreflight,
  buildManagerDeploymentArtifact,
  type ManagerDeploymentManifest,
  managerDeploymentManifestSchema,
} from "./manager-render.js";
import type { ManagerVerificationContext } from "./manager-verification.js";
import {
  compatibilityProfileByIdentity,
  loadNetworkCompatibilityProfiles,
} from "./network-compatibility-store.js";
import {
  OnboardingWalletIntentService,
  type WalletFreshState,
} from "./onboarding-wallet-intent.js";
import { type PreflightResult, runOperatorPreflight } from "./preflight.js";
import type { RuntimeSettingsController } from "./runtime-settings.js";
import { readSetupSnapshot } from "./setup-snapshot.js";
import type { PoolSetupStatus } from "./setup-status.js";
import {
  prepareSignerGrant,
  type SignerGrantPreparation,
  type VerifiedSignerGrant,
  verifySignerGrantOutput,
} from "./signer-grant.js";
import type { SidekickStore } from "./storage/store.js";
import type { ManagerClaimWalletAuthoritativeObservation } from "./transaction-engine/manager-claim-wallet-intent.js";
import { OperatorWorkflowError } from "./workflow-error.js";

const freshInputSchema = z
  .object({
    adminPrincipal: z.string().trim().min(1).max(64),
    contractName: z
      .string()
      .trim()
      .regex(/^[a-zA-Z][a-zA-Z0-9-]{0,39}$/),
    authId: z.string().regex(/^(0|[1-9][0-9]*)$/),
    signerConfigPath: z.string().trim().min(1).max(500).default("<SIGNER_CONFIG_PATH>"),
  })
  .strict();

const managerSignerGrantInputSchema = z
  .object({
    authId: z.string().regex(/^(0|[1-9][0-9]*)$/),
    signerConfigPath: z.string().trim().min(1).max(500).default("<SIGNER_CONFIG_PATH>"),
  })
  .strict();

type FreshInput = z.infer<typeof freshInputSchema>;

const signerGrantPreparationStorageSchema = z
  .object({
    managerPrincipal: z.string().min(1),
    pox5ContractId: z.string().min(1),
    authId: z.string().regex(/^(0|[1-9][0-9]*)$/),
    expectedMessageHashHex: z.string().regex(/^[0-9a-f]{64}$/),
    command: z.string().min(1),
  })
  .strict();

const verifiedSignerGrantStorageSchema = z
  .object({
    managerPrincipal: z.string().min(1),
    pox5ContractId: z.string().min(1),
    authId: z.string().regex(/^(0|[1-9][0-9]*)$/),
    signerKeyHex: z.string().regex(/^(02|03)[0-9a-f]{64}$/),
    signerSignatureHex: z.string().regex(/^[0-9a-f]{130}$/),
    expectedMessageHashHex: z.string().regex(/^[0-9a-f]{64}$/),
    signatureValid: z.literal(true),
    registerSelfCall: z
      .object({
        contract: z.string().min(1),
        functionName: z.literal("register-self"),
        arguments: z.array(z.string()).length(4),
        signingPrincipal: z.string().min(1),
        signingAuthority: z.literal("external-offline-admin"),
      })
      .strict(),
  })
  .strict();

const persistedOnboardingDataSchema = z
  .object({
    schemaVersion: z.literal(1),
    managerPrincipal: z.string().min(1),
    activationPlan: activationPlanSchema.nullable(),
    freshInput: freshInputSchema.nullable(),
    managerArtifact: z
      .object({
        source: z.string(),
        manifest: managerDeploymentManifestSchema,
      })
      .strict()
      .nullable(),
    signerGrant: z
      .object({
        preparation: z
          .custom<SignerGrantPreparation>(
            (value) =>
              value === null || signerGrantPreparationStorageSchema.safeParse(value).success,
          )
          .nullable(),
        verified: z
          .custom<VerifiedSignerGrant>(
            (value) => value === null || verifiedSignerGrantStorageSchema.safeParse(value).success,
          )
          .nullable(),
      })
      .strict(),
  })
  .strict();

type PersistedOnboardingData = z.infer<typeof persistedOnboardingDataSchema>;

export interface PublicOnboardingState {
  schemaVersion: 1;
  path: "attach" | "fresh";
  status: "in-progress" | "blocked" | "complete";
  currentStep: string;
  managerPrincipal: string;
  updatedAt: string;
  activationPlan: ActivationPlan | null;
  freshInput: FreshInput | null;
  artifact: {
    available: boolean;
    sourceFile: string | null;
    manifestFile: string | null;
    manifest: ManagerDeploymentManifest | null;
  };
  signerGrant: PersistedOnboardingData["signerGrant"];
  audit: Array<{
    action: string;
    path: "attach" | "fresh";
    currentStep: string;
    status: "in-progress" | "blocked" | "complete";
    changedAt: string;
  }>;
  safety: {
    acceptsManagerAdminKey: false;
    acceptsSignerPrivateKey: false;
    signsTransactions: false;
    broadcastsTransactions: false;
  };
}

export interface PublicOnboardingWizardState {
  dismissed: boolean;
  dismissedAt: string | null;
  updatedAt: string | null;
  audit: Array<{
    action: "dismissed" | "resumed";
    changedAt: string;
  }>;
}

export interface FreshOnboardingRefresh {
  onboarding: PublicOnboardingState;
  preflight: PreflightResult;
  setup: PoolSetupStatus;
}

function statusFor(plan: ActivationPlan | null): PublicOnboardingState["status"] {
  if (!plan) return "in-progress";
  if (plan.status === "blocked") return "blocked";
  return plan.status === "complete" ? "complete" : "in-progress";
}

function firstIncompleteStep(plan: ActivationPlan | null): string {
  return plan?.steps.find(({ status }) => status !== "complete")?.id ?? "complete";
}

function planStatus(steps: ActivationPlan["steps"]): ActivationPlan["status"] {
  if (steps.some(({ status }) => status === "blocked")) return "blocked";
  if (steps.some(({ status }) => status === "attention")) return "attention";
  if (steps.every(({ status }) => status === "complete")) return "complete";
  return "ready";
}

export class OnboardingService {
  readonly wallet: OnboardingWalletIntentService;

  constructor(
    private readonly options: {
      store: SidekickStore;
      runtimeSettings: RuntimeSettingsController;
      managerPrincipal: string;
      contractsDirectory: string;
      managerVerification?: ManagerVerificationContext;
      transactionEngineRequestedMode?: "observe" | "assist";
      observeManagerClaimWalletJob?: (
        jobId: string,
      ) => Promise<ManagerClaimWalletAuthoritativeObservation>;
    },
  ) {
    this.wallet = new OnboardingWalletIntentService({
      store: options.store,
      runtimeSettings: options.runtimeSettings,
      ...(options.managerVerification ? { managerVerification: options.managerVerification } : {}),
      ...(options.transactionEngineRequestedMode
        ? { transactionEngineRequestedMode: options.transactionEngineRequestedMode }
        : {}),
      ...(options.observeManagerClaimWalletJob
        ? { observeManagerClaimWalletJob: options.observeManagerClaimWalletJob }
        : {}),
      readFreshState: () => {
        const { data } = this.readData("fresh");
        return {
          managerPrincipal: data.managerPrincipal,
          freshInput: data.freshInput,
          managerArtifact: data.managerArtifact,
          signerGrant: data.signerGrant,
        };
      },
      readWalletState: () => this.readWalletState(),
    });
  }

  private readWalletState(): WalletFreshState {
    const data = this.managerOperationData().data;
    return {
      managerPrincipal: data.managerPrincipal,
      freshInput: data.freshInput,
      managerArtifact: data.managerArtifact,
      signerGrant: data.signerGrant,
    };
  }

  wizardState(): PublicOnboardingWizardState {
    const preference = this.options.store.getOnboardingWizardPreference();
    return {
      dismissed: Boolean(preference?.dismissedAt),
      dismissedAt: preference?.dismissedAt ?? null,
      updatedAt: preference?.updatedAt ?? null,
      audit: this.options.store.listOnboardingWizardAudit(),
    };
  }

  dismissWizard(observedAt = new Date().toISOString()): PublicOnboardingWizardState {
    this.options.store.setOnboardingWizardDismissed(true, observedAt);
    return this.wizardState();
  }

  resumeWizard(observedAt = new Date().toISOString()): PublicOnboardingWizardState {
    this.options.store.setOnboardingWizardDismissed(false, observedAt);
    return this.wizardState();
  }

  get(): PublicOnboardingState | null {
    const stored = this.options.store.getOnboardingState();
    if (!stored) return null;
    const parsed = persistedOnboardingDataSchema.safeParse(stored.state);
    if (!parsed.success) return null;
    const data = parsed.data;
    const contractName = data.managerArtifact?.manifest.transaction.contractName ?? null;
    return {
      schemaVersion: 1,
      path: stored.path,
      status: stored.status,
      currentStep: stored.currentStep,
      managerPrincipal: data.managerPrincipal,
      updatedAt: stored.updatedAt,
      activationPlan: data.activationPlan,
      freshInput: data.freshInput,
      artifact: {
        available: Boolean(data.managerArtifact),
        sourceFile: data.managerArtifact?.manifest.artifact.sourceFile ?? null,
        manifestFile: contractName ? `${contractName}.deployment.json` : null,
        manifest: data.managerArtifact?.manifest ?? null,
      },
      signerGrant: data.signerGrant,
      audit: this.options.store.listOnboardingAudit(),
      safety: {
        acceptsManagerAdminKey: false,
        acceptsSignerPrivateKey: false,
        signsTransactions: false,
        broadcastsTransactions: false,
      },
    };
  }

  start(
    pathInput: unknown,
    reset = false,
    observedAt = new Date().toISOString(),
  ): PublicOnboardingState {
    const path = z.enum(["attach", "fresh"]).parse(pathInput);
    const current = this.get();
    if (current?.path === path) return current;
    if (current && !reset) {
      throw new OperatorWorkflowError(
        409,
        "onboarding_reset_confirmation_required",
        "Switching onboarding paths requires explicit reset confirmation",
      );
    }
    this.save(
      path,
      "preflight",
      "in-progress",
      {
        schemaVersion: 1,
        managerPrincipal: this.options.managerPrincipal,
        activationPlan: null,
        freshInput: null,
        managerArtifact: null,
        signerGrant: { preparation: null, verified: null },
      },
      observedAt,
      current ? "path-reset" : "path-started",
    );
    return this.getOrThrow();
  }

  async verifyAttach(
    managerInput: unknown,
    observedAt = new Date().toISOString(),
  ): Promise<PublicOnboardingState> {
    const managerPrincipal = z.string().trim().min(1).parse(managerInput);
    if (managerPrincipal !== this.options.managerPrincipal) {
      throw new OperatorWorkflowError(
        422,
        "attach_manager_mismatch",
        "Attach verification must match SIDEKICK_MANAGER_PRINCIPAL for this deployment",
      );
    }
    const { config, node, api } = this.options.runtimeSettings.clients();
    const { preflight, manager, registration, setup } = await readSetupSnapshot({
      config,
      node,
      api,
      managerPrincipal,
      managerVerification: this.options.managerVerification,
    });
    const activationPlan = createAttachActivationPlan(preflight, manager, registration, setup);
    const data: PersistedOnboardingData = {
      schemaVersion: 1,
      managerPrincipal,
      activationPlan,
      freshInput: null,
      managerArtifact: null,
      signerGrant: { preparation: null, verified: null },
    };
    this.save(
      "attach",
      firstIncompleteStep(activationPlan),
      statusFor(activationPlan),
      data,
      observedAt,
      "attach-verified",
    );
    return this.getOrThrow();
  }

  async prepareFresh(
    input: unknown,
    observedAt = new Date().toISOString(),
  ): Promise<PublicOnboardingState> {
    const parsed = freshInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new OperatorWorkflowError(
        400,
        "invalid_fresh_setup_input",
        "Enter a valid admin principal, contract name, authorization ID, and signer configuration path",
      );
    }
    const freshInput = parsed.data;
    const managerPrincipal = `${freshInput.adminPrincipal}.${freshInput.contractName}`;
    try {
      parseContractPrincipal(managerPrincipal);
    } catch {
      throw new OperatorWorkflowError(
        400,
        "invalid_fresh_setup_input",
        "The admin principal is invalid for the selected network",
      );
    }
    if (managerPrincipal !== this.options.managerPrincipal) {
      throw new OperatorWorkflowError(
        422,
        "fresh_manager_mismatch",
        "Fresh setup principal must match SIDEKICK_MANAGER_PRINCIPAL for this deployment",
      );
    }
    const { config, node, api } = this.options.runtimeSettings.clients();
    const preflight = await runOperatorPreflight(config, node, api);
    try {
      assertManagerRenderPreflight(config.network, preflight);
    } catch {
      throw new OperatorWorkflowError(
        422,
        "fresh_setup_sources_incompatible",
        "Fresh setup is blocked by node, API, PoX-5, or network compatibility checks. Review preflight, resolve the failures, and retry",
      );
    }
    const compatibilityStore = await loadNetworkCompatibilityProfiles({
      ...(config.compatibilityProfilesDirectory
        ? { directory: config.compatibilityProfilesDirectory }
        : {}),
    });
    const compatibilityProfile = compatibilityProfileByIdentity(
      compatibilityStore,
      preflight.compatibility.profileId,
      preflight.compatibility.profileRevision,
    )?.profile;
    const activationPlan = createFreshActivationPlan({
      network: config.network,
      preflight,
      adminPrincipal: freshInput.adminPrincipal,
      contractName: freshInput.contractName,
      outputDirectory: "<BROWSER_DOWNLOAD>",
      authId: freshInput.authId,
      signerConfigPath: freshInput.signerConfigPath,
    });
    const managerArtifact = await buildManagerDeploymentArtifact({
      network: config.network,
      adminPrincipal: freshInput.adminPrincipal,
      contractName: freshInput.contractName,
      contractsDirectory: this.options.contractsDirectory,
      ...(compatibilityProfile ? { compatibilityProfile } : {}),
    });
    const steps = activationPlan.steps.map((step) =>
      step.id === "render-manager" ? { ...step, status: "complete" as const } : step,
    );
    const plan = activationPlanSchema.parse({
      ...activationPlan,
      steps,
      status: planStatus(steps),
    });
    const data: PersistedOnboardingData = {
      schemaVersion: 1,
      managerPrincipal,
      activationPlan: plan,
      freshInput,
      managerArtifact,
      signerGrant: { preparation: null, verified: null },
    };
    this.save(
      "fresh",
      firstIncompleteStep(plan),
      statusFor(plan),
      data,
      observedAt,
      "fresh-prepared",
    );
    return this.getOrThrow();
  }

  async prepareGrant(observedAt = new Date().toISOString()): Promise<PublicOnboardingState> {
    const { data } = this.readData("fresh");
    if (!data.freshInput || !data.activationPlan) {
      throw new OperatorWorkflowError(
        409,
        "fresh_setup_not_prepared",
        "Prepare the fresh manager artifact before starting the signer grant",
      );
    }
    const { config, node, api } = this.options.runtimeSettings.clients();
    const preflight = await runOperatorPreflight(config, node, api);
    if (preflight.status === "fail" || !preflight.pox.pox5ContractId) {
      throw new OperatorWorkflowError(
        422,
        "signer_grant_sources_incompatible",
        "Signer grant preparation is blocked by node, API, or PoX-5 compatibility checks. Review preflight, resolve the failures, and retry",
      );
    }
    const preparation = await prepareSignerGrant(
      node,
      preflight.pox.pox5ContractId,
      data.managerPrincipal,
      data.freshInput.authId,
      data.freshInput.signerConfigPath,
    );
    const steps = data.activationPlan.steps.map((step) =>
      step.id === "prepare-signer-grant" ? { ...step, status: "complete" as const } : step,
    );
    const plan = activationPlanSchema.parse({
      ...data.activationPlan,
      steps,
      status: planStatus(steps),
    });
    const next = {
      ...data,
      activationPlan: plan,
      signerGrant: { ...data.signerGrant, preparation },
    };
    this.save("fresh", "verify-signer-grant", statusFor(plan), next, observedAt, "grant-prepared");
    return this.getOrThrow();
  }

  async verifyGrant(
    signerOutput: unknown,
    observedAt = new Date().toISOString(),
  ): Promise<PublicOnboardingState> {
    const { data } = this.readData("fresh");
    if (!data.freshInput || !data.signerGrant.preparation || !data.activationPlan) {
      throw new OperatorWorkflowError(
        409,
        "signer_grant_not_prepared",
        "Prepare the signer grant before verifying signer output",
      );
    }
    const { node } = this.options.runtimeSettings.clients();
    const verified = await verifySignerGrantOutput(
      node,
      data.signerGrant.preparation.pox5ContractId,
      data.managerPrincipal,
      data.freshInput.authId,
      signerOutput,
    );
    const steps = data.activationPlan.steps.map((step) =>
      step.id === "verify-signer-grant" ? { ...step, status: "complete" as const } : step,
    );
    const plan = activationPlanSchema.parse({
      ...data.activationPlan,
      steps,
      status: planStatus(steps),
    });
    const next = {
      ...data,
      activationPlan: plan,
      signerGrant: { ...data.signerGrant, verified },
    };
    this.save("fresh", "register-manager", statusFor(plan), next, observedAt, "grant-verified");
    return this.getOrThrow();
  }

  async prepareManagerSignerGrant(
    input: unknown,
    observedAt = new Date().toISOString(),
  ): Promise<PublicOnboardingState> {
    const value = managerSignerGrantInputSchema.parse(input);
    const current = this.managerOperationData();
    const data = current.data;
    const { node, api, config } = this.options.runtimeSettings.clients();
    const preflight = await runOperatorPreflight(config, node, api);
    if (preflight.status === "fail" || !preflight.pox.pox5ContractId) {
      throw new OperatorWorkflowError(
        422,
        "signer_grant_sources_incompatible",
        "Signer grant preparation is blocked by node, API, or PoX-5 compatibility checks. Review preflight, resolve the failures, and retry",
      );
    }
    const preparation = await prepareSignerGrant(
      node,
      preflight.pox.pox5ContractId,
      data.managerPrincipal,
      value.authId,
      value.signerConfigPath,
    );
    this.save(
      current.stored?.path ?? "attach",
      current.stored?.currentStep ?? "preflight",
      current.stored?.status ?? "in-progress",
      {
        ...data,
        signerGrant: { preparation, verified: null },
      },
      observedAt,
      "manager-grant-prepared",
    );
    return this.getOrThrow();
  }

  async verifyManagerSignerGrant(
    signerOutput: unknown,
    observedAt = new Date().toISOString(),
  ): Promise<PublicOnboardingState> {
    const { stored, data } = this.managerOperationData();
    if (!stored) {
      throw new OperatorWorkflowError(
        409,
        "signer_grant_not_prepared",
        "Prepare a fresh signer grant before verifying signer output",
      );
    }
    const preparation = data.signerGrant.preparation;
    if (!preparation)
      throw new OperatorWorkflowError(
        409,
        "signer_grant_not_prepared",
        "Prepare a fresh signer grant before verifying signer output",
      );
    const { node } = this.options.runtimeSettings.clients();
    const verified = await verifySignerGrantOutput(
      node,
      preparation.pox5ContractId,
      data.managerPrincipal,
      preparation.authId,
      signerOutput,
    );
    this.save(
      stored.path,
      stored.currentStep,
      stored.status,
      {
        ...data,
        signerGrant: { preparation, verified },
      },
      observedAt,
      "manager-grant-verified",
    );
    return this.getOrThrow();
  }

  async refreshFresh(observedAt = new Date().toISOString()): Promise<FreshOnboardingRefresh> {
    const { data } = this.readData("fresh");
    if (!data.activationPlan) {
      throw new OperatorWorkflowError(
        409,
        "fresh_setup_not_prepared",
        "Prepare the fresh setup before refreshing it",
      );
    }
    const { config, node, api } = this.options.runtimeSettings.clients();
    const { preflight, manager, registration, setup } = await readSetupSnapshot({
      config,
      node,
      api,
      managerPrincipal: data.managerPrincipal,
      managerVerification: this.options.managerVerification,
      reportMissingManager: true,
    });
    const steps = data.activationPlan.steps.map((step) => {
      if (step.id === "deploy-manager") {
        const managerNotDeployed =
          manager.publishHeight === 0 &&
          manager.reasons.includes("Manager contract is not deployed yet");
        return {
          ...step,
          status: manager.attachAllowed
            ? ("complete" as const)
            : managerNotDeployed
              ? ("pending" as const)
              : ("blocked" as const),
          detail: manager.attachAllowed
            ? `Manager source verified at Stacks block ${manager.publishHeight}`
            : managerNotDeployed
              ? "Manager contract is not deployed at the local node anchor yet. Submit or wait for the deployment transaction, then verify again."
              : manager.reasons.join("; "),
        };
      }
      if (step.id === "register-manager") {
        return {
          ...step,
          status: registration?.registered ? ("complete" as const) : ("pending" as const),
        };
      }
      if (step.id === "verify-setup") {
        return {
          ...step,
          status:
            setup.status === "ready"
              ? ("complete" as const)
              : setup.status === "blocked"
                ? ("blocked" as const)
                : ("attention" as const),
          detail:
            setup.checks.find(({ status }) => status !== "pass")?.message ??
            "Registration, grant, and eligibility are verified",
        };
      }
      if (step.id === "publish-enrollment-info" && setup.status === "ready") {
        return { ...step, status: "ready" as const };
      }
      return step;
    });
    const plan = activationPlanSchema.parse({
      ...data.activationPlan,
      steps,
      status: planStatus(steps),
    });
    const next = { ...data, activationPlan: plan };
    this.save(
      "fresh",
      firstIncompleteStep(plan),
      statusFor(plan),
      next,
      observedAt,
      "chain-refreshed",
    );
    return {
      onboarding: this.getOrThrow(),
      preflight,
      setup,
    };
  }

  setCurrentStep(stepInput: unknown, observedAt = new Date().toISOString()): PublicOnboardingState {
    const step = z.string().min(1).parse(stepInput);
    const { stored, data } = this.readData();
    if (step !== "complete" && !data.activationPlan?.steps.some(({ id }) => id === step)) {
      throw new OperatorWorkflowError(
        400,
        "invalid_onboarding_step",
        "The selected setup step is not part of the current onboarding plan. Refresh setup and retry",
      );
    }
    this.save(stored.path, step, stored.status, data, observedAt, "step-selected");
    return this.getOrThrow();
  }

  artifact(kind: "source" | "manifest"): { filename: string; contentType: string; body: string } {
    const { data } = this.readData("fresh");
    if (!data.managerArtifact) {
      throw new OperatorWorkflowError(
        404,
        "artifact_not_found",
        "The manager deployment files have not been generated. Prepare fresh setup first",
      );
    }
    if (kind === "source") {
      return {
        filename: data.managerArtifact.manifest.artifact.sourceFile,
        contentType: "text/plain; charset=utf-8",
        body: data.managerArtifact.source,
      };
    }
    return {
      filename: `${data.managerArtifact.manifest.transaction.contractName}.deployment.json`,
      contentType: "application/json; charset=utf-8",
      body: `${JSON.stringify(data.managerArtifact.manifest, null, 2)}\n`,
    };
  }

  private readData(expectedPath?: "attach" | "fresh"): {
    stored: NonNullable<ReturnType<SidekickStore["getOnboardingState"]>>;
    data: PersistedOnboardingData;
  } {
    const stored = this.options.store.getOnboardingState();
    if (!stored) {
      throw new OperatorWorkflowError(
        409,
        "onboarding_not_started",
        "Setup has not started. Choose an onboarding path first",
      );
    }
    if (expectedPath && stored.path !== expectedPath) {
      throw new OperatorWorkflowError(
        409,
        "onboarding_path_conflict",
        "This action belongs to the other onboarding path. Return to Initial Setup and choose the intended path",
      );
    }
    const data = persistedOnboardingDataSchema.safeParse(stored.state);
    if (!data.success) throw new Error("Stored onboarding state is invalid; restart onboarding");
    return { stored, data: data.data };
  }

  private managerOperationData(): {
    stored: ReturnType<SidekickStore["getOnboardingState"]>;
    data: PersistedOnboardingData;
  } {
    const stored = this.options.store.getOnboardingState();
    if (!stored) return { stored: null, data: this.minimalAttachData() };
    const current = this.readData();
    if (current.data.managerPrincipal !== this.options.managerPrincipal) {
      return { stored: null, data: this.minimalAttachData() };
    }
    return current;
  }

  private minimalAttachData(): PersistedOnboardingData {
    return {
      schemaVersion: 1,
      managerPrincipal: this.options.managerPrincipal,
      activationPlan: null,
      freshInput: null,
      managerArtifact: null,
      signerGrant: { preparation: null, verified: null },
    };
  }

  private save(
    path: "attach" | "fresh",
    currentStep: string,
    status: PublicOnboardingState["status"],
    data: PersistedOnboardingData,
    updatedAt: string,
    auditAction: string,
  ): void {
    this.options.store.putOnboardingState({
      path,
      currentStep,
      status,
      state: data,
      updatedAt,
      auditAction,
    });
  }

  private getOrThrow(): PublicOnboardingState {
    const value = this.get();
    if (!value) throw new Error("Onboarding state was not persisted");
    return value;
  }
}
