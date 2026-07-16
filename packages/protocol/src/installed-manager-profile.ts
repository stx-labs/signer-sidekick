import { z } from "zod";
import { parseContractPrincipal, validatePrincipal } from "./principals.js";
import { sidekickProtocolNetworkSchema } from "./profile.js";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const uint32Schema = z.number().int().nonnegative().max(0xffff_ffff);
const contractPrincipalSchema = z.string().refine((value) => {
  try {
    parseContractPrincipal(value);
    return true;
  } catch {
    return false;
  }
}, "Invalid contract principal");
const standardPrincipalSchema = z
  .string()
  .refine(
    (value) => !value.includes(".") && validatePrincipal(value),
    "Invalid standard principal",
  );

const commonProfileFields = {
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/),
  managerPrincipal: contractPrincipalSchema,
  network: sidekickProtocolNetworkSchema,
  networkId: uint32Schema.optional(),
  sourceSha256: sha256Schema,
  canonicalSha256: sha256Schema,
  createdAt: z.iso.datetime(),
  proofVersion: z.literal(1),
} as const;

const referenceRenderProfileSchema = z
  .object({
    ...commonProfileFields,
    tier: z.literal("reference-render"),
    reference: z
      .object({
        upstreamProfileId: z.string().min(1).max(100),
        upstream: z
          .object({
            tag: z.string().min(1).max(100),
            commit: z.string().regex(/^[0-9a-f]{40}$/),
            sourceSha256: sha256Schema,
          })
          .strict(),
        pox5: contractPrincipalSchema,
        sbtcDeployer: standardPrincipalSchema,
      })
      .strict(),
  })
  .strict();

const customObserveProfileSchema = z
  .object({
    ...commonProfileFields,
    tier: z.literal("custom-observe"),
  })
  .strict();

export const installedManagerProfileSchema = z
  .discriminatedUnion("tier", [referenceRenderProfileSchema, customObserveProfileSchema])
  .superRefine((profile, context) => {
    const managerNetwork = parseContractPrincipal(profile.managerPrincipal).network;
    const expectedPrincipalNetwork = profile.network === "mainnet" ? "mainnet" : "testnet";
    if (managerNetwork !== expectedPrincipalNetwork) {
      context.addIssue({
        code: "custom",
        path: ["managerPrincipal"],
        message: `Manager principal does not match the ${profile.network} network`,
      });
    }
    if (profile.network === "mainnet" && profile.networkId !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["networkId"],
        message: "A private network ID cannot be assigned to a mainnet profile",
      });
    }
    if (profile.tier === "reference-render") {
      const expectedPox5 =
        profile.network === "mainnet"
          ? "SP000000000000000000002Q6VF78.pox-5"
          : "ST000000000000000000002AMW42H.pox-5";
      if (profile.reference.pox5 !== expectedPox5) {
        context.addIssue({
          code: "custom",
          path: ["reference", "pox5"],
          message: `Expected the canonical ${profile.network} PoX-5 contract ${expectedPox5}`,
        });
      }
      const sbtcIsMainnet = /^(?:SP|SM)/.test(profile.reference.sbtcDeployer);
      if ((profile.network === "mainnet") !== sbtcIsMainnet) {
        context.addIssue({
          code: "custom",
          path: ["reference", "sbtcDeployer"],
          message: `sBTC deployer principal does not match the ${profile.network} network`,
        });
      }
    }
  });

export type InstalledManagerProfile = z.infer<typeof installedManagerProfileSchema>;

export function parseInstalledManagerProfile(input: unknown): InstalledManagerProfile {
  return installedManagerProfileSchema.parse(input);
}
