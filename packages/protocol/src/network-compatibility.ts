import { z } from "zod";
import { parseContractPrincipal } from "./principals.js";
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

/**
 * Data-only description of a network deployment that Sidekick knows how to inspect.
 * Node versions are intentionally evidence, not compatibility gates: compatibility is
 * established from network identity, live contracts, and required response capabilities.
 */
export const networkCompatibilityProfileSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/),
    revision: z.number().int().positive(),
    publishedAt: z.iso.datetime(),
    label: z.string().min(1).max(100),
    network: sidekickProtocolNetworkSchema,
    networkId: uint32Schema,
    pox5: z
      .object({
        contractId: contractPrincipalSchema,
        sourceSha256: sha256Schema,
        activationBurnHeight: z.number().int().nonnegative().optional(),
        firstRewardCycleId: z.number().int().nonnegative().optional(),
      })
      .strict(),
    sbtc: z
      .object({
        tokenContract: contractPrincipalSchema,
        registryContract: contractPrincipalSchema,
      })
      .strict(),
    referenceManager: z
      .object({
        profileId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/),
        upstream: z
          .object({
            tag: z.string().min(1).max(100),
            commit: z.string().regex(/^[0-9a-f]{40}$/),
            sourceSha256: sha256Schema,
          })
          .strict(),
        expectedReplacements: z
          .object({
            pox5: z.number().int().positive(),
            sbtcDeployer: z.number().int().positive(),
          })
          .strict(),
        sourceSha256: sha256Schema,
        canonicalSha256: sha256Schema,
      })
      .strict(),
    capabilities: z
      .object({
        pox5SbtcContractFields: z.literal(true),
      })
      .strict(),
    provenance: z
      .object({
        stacksCoreTag: z.string().min(1).max(100),
        stacksCoreCommit: z.string().regex(/^[0-9a-f]{7,40}$/),
        notes: z.string().max(500).optional(),
      })
      .strict(),
    testedNodeBuilds: z.array(z.string().min(1).max(200)).max(20),
  })
  .strict()
  .superRefine((profile, context) => {
    const expectedAddressNetwork = profile.network === "mainnet" ? "mainnet" : "testnet";
    for (const [field, principal] of [
      ["pox5.contractId", profile.pox5.contractId],
      ["sbtc.tokenContract", profile.sbtc.tokenContract],
      ["sbtc.registryContract", profile.sbtc.registryContract],
    ] as const) {
      if (parseContractPrincipal(principal).network !== expectedAddressNetwork) {
        context.addIssue({
          code: "custom",
          path: field.split("."),
          message: `Contract principal does not match the ${profile.network} network`,
        });
      }
    }
  });

export type NetworkCompatibilityProfile = z.infer<typeof networkCompatibilityProfileSchema>;

export function parseNetworkCompatibilityProfile(input: unknown): NetworkCompatibilityProfile {
  return networkCompatibilityProfileSchema.parse(input);
}
