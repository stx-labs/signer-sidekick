import { z } from "zod";
import { isHttpUrl, type SidekickNetwork } from "./config.js";
import type { ManagerVerificationReport } from "./manager-verification.js";
import type { PreflightResult } from "./preflight.js";
import type { RegistrationVerification } from "./registration-verification.js";
import type { PoolCycleEligibility, PoolSetupStatus } from "./setup-status.js";

const contactSchema = z
  .object({
    email: z.email().optional(),
    url: z.string().refine(isHttpUrl, "Expected an HTTP(S) URL").optional(),
  })
  .strict()
  .refine((contact) => Boolean(contact.email || contact.url), {
    message: "Support contact requires an email or URL",
  });

export const poolEnrollmentConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    displayName: z.string().trim().min(1).max(80),
    websiteUrl: z.string().refine(isHttpUrl, "Expected an HTTP(S) URL").optional(),
    support: contactSchema.optional(),
    currentFeeBips: z.number().int().min(0).max(10_000),
    rewardDestinations: z
      .object({
        directSbtc: z.literal(true),
        bitcoinL1: z.boolean(),
      })
      .strict(),
    durationPolicy: z
      .object({
        minimumCycles: z.number().int().min(1).max(96),
        maximumCycles: z.number().int().min(1).max(96),
      })
      .strict(),
    officialPlatforms: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(40),
            label: z.string().trim().min(1).max(80),
            url: z.string().refine(isHttpUrl, "Expected an HTTP(S) URL"),
          })
          .strict(),
      )
      .min(1)
      .max(10)
      .optional(),
  })
  .strict()
  .refine(({ durationPolicy }) => durationPolicy.maximumCycles >= durationPolicy.minimumCycles, {
    message: "maximumCycles must be greater than or equal to minimumCycles",
    path: ["durationPolicy", "maximumCycles"],
  });

export type PoolEnrollmentConfig = z.infer<typeof poolEnrollmentConfigSchema>;

const unsignedIntegerSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const signedIntegerSchema = z.string().regex(/^(0|[1-9][0-9]*|-[1-9][0-9]*)$/);

const publicEligibilitySchema = z
  .object({
    cycleId: z.number().int().nonnegative(),
    delegatedUstx: unsignedIntegerSchema,
    thresholdUstx: unsignedIntegerSchema,
    marginUstx: signedIntegerSchema,
    meetsThreshold: z.boolean(),
    inSignerSet: z.boolean(),
    thresholdAndMembershipAgree: z.boolean(),
  })
  .strict();

export const poolEnrollmentDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    documentType: z.literal("stx-only-pool-enrollment-info"),
    pool: z
      .object({
        displayName: z.string(),
        websiteUrl: z.string().refine(isHttpUrl, "Expected an HTTP(S) URL").optional(),
        support: contactSchema.optional(),
      })
      .strict(),
    chain: z
      .object({
        network: z.enum(["mainnet", "testnet", "devnet", "regtest"]),
        burnBlockHeight: z.number().int().nonnegative(),
        stacksTipHeight: z.number().int().nonnegative(),
        rewardCycleId: z.number().int().nonnegative(),
        pox5ContractId: z.string(),
      })
      .strict(),
    manager: z
      .object({
        principal: z.string(),
        profileId: z.string().nullable(),
        sourceMatch: z.enum(["exact", "canonical", "unknown"]),
        sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
        sourceRecognized: z.boolean(),
      })
      .strict(),
    signer: z
      .object({
        publicKeyHex: z
          .string()
          .regex(/^[0-9a-f]{66}$/)
          .nullable(),
        registered: z.boolean(),
        grantValid: z.boolean().nullable(),
      })
      .strict(),
    fee: z
      .object({
        currentConfiguredBips: z.number().int().min(0).max(10_000),
        source: z.literal("operator-config"),
        effectiveFeePolicy: z.literal(
          "The manager snapshots the effective fee for a reward cycle when it first claims that cycle; an existing snapshot is not overwritten by later fee changes.",
        ),
      })
      .strict(),
    rewardDestinations: z
      .object({
        directSbtc: z.literal(true),
        bitcoinL1: z.boolean(),
      })
      .strict(),
    durationPolicy: z
      .object({
        minimumCycles: z.number().int().min(1).max(96),
        maximumCycles: z.number().int().min(1).max(96),
      })
      .strict(),
    enrollmentWindow: z
      .object({
        status: z.enum(["open", "prepare-phase", "unknown"]),
        targetCycleId: z.number().int().nonnegative().nullable(),
        preparePhaseStartBurnHeight: z.number().int().nonnegative().nullable(),
        blocksUntilPreparePhase: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    eligibility: z
      .object({
        current: publicEligibilitySchema.nullable(),
        next: publicEligibilitySchema.nullable(),
      })
      .strict(),
    readiness: z
      .object({
        setupStatus: z.enum(["ready", "attention", "blocked"]),
        enrollmentReady: z.boolean(),
        notices: z.array(z.string()),
      })
      .strict(),
    links: z
      .object({
        managerExplorer: z.string().refine(isHttpUrl, "Expected an HTTP(S) URL"),
        officialPlatforms: z.array(
          z
            .object({
              id: z.string(),
              label: z.string(),
              url: z.string().refine(isHttpUrl, "Expected an HTTP(S) URL"),
              integration: z.literal("link-only"),
            })
            .strict(),
        ),
      })
      .strict(),
    userInteraction: z
      .object({
        collectsAmount: z.literal(false),
        collectsBitcoinAddress: z.literal(false),
        connectsWallet: z.literal(false),
        signsTransactions: z.literal(false),
        submitsTransactions: z.literal(false),
      })
      .strict(),
  })
  .strict();

export type PoolEnrollmentDocument = z.infer<typeof poolEnrollmentDocumentSchema>;

function explorerChain(network: SidekickNetwork): "mainnet" | "testnet" {
  return network === "mainnet" ? "mainnet" : "testnet";
}

function publicEligibility(value: PoolCycleEligibility | null) {
  return value
    ? {
        cycleId: value.cycleId,
        delegatedUstx: value.delegatedUstx,
        thresholdUstx: value.thresholdUstx,
        marginUstx: value.marginUstx,
        meetsThreshold: value.meetsThreshold,
        inSignerSet: value.inSignerSet,
        thresholdAndMembershipAgree: value.thresholdAndMembershipAgree,
      }
    : null;
}

export function createPoolEnrollmentDocument(
  configInput: unknown,
  preflight: PreflightResult,
  manager: ManagerVerificationReport,
  registration: RegistrationVerification | null,
  setup: PoolSetupStatus,
): PoolEnrollmentDocument {
  const config = poolEnrollmentConfigSchema.parse(configInput);
  if (!preflight.pox.pox5ContractId) {
    throw new Error("Pool enrollment information requires an active PoX-5 contract");
  }

  const notices = setup.checks
    .filter((check) => check.status !== "pass")
    .map((check) => check.message);
  const enrollmentReady = Boolean(
    preflight.status !== "fail" &&
      manager.attachAllowed &&
      registration?.registered &&
      registration.signerKeyGrantValid,
  );
  const document = {
    schemaVersion: 1 as const,
    documentType: "stx-only-pool-enrollment-info" as const,
    pool: {
      displayName: config.displayName,
      ...(config.websiteUrl ? { websiteUrl: config.websiteUrl } : {}),
      ...(config.support ? { support: config.support } : {}),
    },
    chain: {
      network: preflight.network,
      burnBlockHeight: preflight.node.burnBlockHeight,
      stacksTipHeight: preflight.node.stacksTipHeight,
      rewardCycleId: preflight.pox.rewardCycleId,
      pox5ContractId: preflight.pox.pox5ContractId,
    },
    manager: {
      principal: manager.managerPrincipal,
      profileId: manager.source.profileId,
      sourceMatch: manager.source.match,
      sourceSha256: manager.source.sha256,
      sourceRecognized: manager.source.recognized,
    },
    signer: {
      publicKeyHex: registration?.signerKeyHex ?? null,
      registered: registration?.registered ?? false,
      grantValid: registration?.signerKeyGrantValid ?? null,
    },
    fee: {
      currentConfiguredBips: config.currentFeeBips,
      source: "operator-config" as const,
      effectiveFeePolicy:
        "The manager snapshots the effective fee for a reward cycle when it first claims that cycle; an existing snapshot is not overwritten by later fee changes." as const,
    },
    rewardDestinations: config.rewardDestinations,
    durationPolicy: config.durationPolicy,
    enrollmentWindow: setup.enrollmentWindow,
    eligibility: {
      current: publicEligibility(setup.eligibility.current),
      next: publicEligibility(setup.eligibility.next),
    },
    readiness: {
      setupStatus: setup.status,
      enrollmentReady,
      notices,
    },
    links: {
      managerExplorer: `https://explorer.hiro.so/address/${encodeURIComponent(manager.managerPrincipal)}?chain=${explorerChain(preflight.network)}`,
      officialPlatforms: (
        config.officialPlatforms ?? [
          {
            id: "leather",
            label: "Leather Stacking",
            url: "https://earn.leather.io",
          },
        ]
      ).map((platform) => ({ ...platform, integration: "link-only" as const })),
    },
    userInteraction: {
      collectsAmount: false as const,
      collectsBitcoinAddress: false as const,
      connectsWallet: false as const,
      signsTransactions: false as const,
      submitsTransactions: false as const,
    },
  };

  return poolEnrollmentDocumentSchema.parse(document);
}
