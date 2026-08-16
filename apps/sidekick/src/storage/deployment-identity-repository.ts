import type { DatabaseSync } from "node:sqlite";
import {
  type LocalNodeAuthority,
  localNodeAuthoritySchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import { validatePrincipal } from "@stx-labs/signer-sidekick-protocol/principals";
import { z } from "zod";
import type { SidekickNetwork } from "../config.js";

const networkSchema = z.enum(["mainnet", "testnet", "devnet", "regtest"]);
const networkIdSchema = z.number().int().nonnegative().max(0xffff_ffff);
const principalSchema = z.string().refine(validatePrincipal, "Invalid Stacks principal");

export interface StoredDeploymentIdentity {
  schemaVersion: 1;
  network: SidekickNetwork;
  networkId: number;
  parentNetworkId: number | null;
  managerPrincipal: string;
  bindingSource: "new" | "legacy-evidence";
  boundAt: string;
  lastVerifiedAt: string;
  lastStacksTipHeight: number;
  lastBurnBlockHeight: number;
  lastPox5ContractId: string;
}

export interface LegacyDeploymentEvidence {
  networks: SidekickNetwork[];
  networkIds: number[];
  managerPrincipals: string[];
}

export interface DeploymentIdentityBinding {
  network: SidekickNetwork;
  networkId: number;
  parentNetworkId: number | null;
  managerPrincipal: string;
  bindingSource: "new" | "legacy-evidence";
  verifiedAt: string;
  stacksTipHeight: number;
  burnBlockHeight: number;
  pox5ContractId: string;
}

export type DeploymentIdentityVerification = Omit<DeploymentIdentityBinding, "bindingSource">;

export class DeploymentIdentityRepository {
  constructor(private readonly db: DatabaseSync) {}

  get(): StoredDeploymentIdentity | null {
    const row = this.db
      .prepare(
        `SELECT schema_version, network, network_id, parent_network_id, manager_principal,
          binding_source, bound_at, last_verified_at, last_stacks_tip_height,
          last_burn_block_height, last_pox5_contract_id
         FROM deployment_identity WHERE singleton_id = 1`,
      )
      .get() as
      | {
          schema_version: number;
          network: string;
          network_id: number;
          parent_network_id: number | null;
          manager_principal: string;
          binding_source: string;
          bound_at: string;
          last_verified_at: string;
          last_stacks_tip_height: number;
          last_burn_block_height: number;
          last_pox5_contract_id: string;
        }
      | undefined;
    if (!row) return null;
    return {
      schemaVersion: z.literal(1).parse(row.schema_version),
      network: networkSchema.parse(row.network),
      networkId: networkIdSchema.parse(row.network_id),
      parentNetworkId: networkIdSchema.nullable().parse(row.parent_network_id),
      managerPrincipal: principalSchema.parse(row.manager_principal),
      bindingSource: z.enum(["new", "legacy-evidence"]).parse(row.binding_source),
      boundAt: z.iso.datetime().parse(row.bound_at),
      lastVerifiedAt: z.iso.datetime().parse(row.last_verified_at),
      lastStacksTipHeight: z.number().int().nonnegative().parse(row.last_stacks_tip_height),
      lastBurnBlockHeight: z.number().int().nonnegative().parse(row.last_burn_block_height),
      lastPox5ContractId: principalSchema.parse(row.last_pox5_contract_id),
    };
  }

  getLocalNodeAuthority(managerPrincipal: string): LocalNodeAuthority | null {
    const manager = principalSchema.parse(managerPrincipal);
    const row = this.db
      .prepare(
        `SELECT schema_version, status, observed_at, stacks_tip_height,
          highest_proven_current_stacks_tip_height, consecutive_current_observations, reason
         FROM local_node_authority WHERE manager_principal = ?`,
      )
      .get(manager) as
      | {
          schema_version: number;
          status: string;
          observed_at: string;
          stacks_tip_height: number;
          highest_proven_current_stacks_tip_height: number | null;
          consecutive_current_observations: number;
          reason: string;
        }
      | undefined;
    if (!row) return null;
    return localNodeAuthoritySchema.parse({
      schemaVersion: row.schema_version,
      status: row.status,
      observedAt: row.observed_at,
      stacksTipHeight: row.stacks_tip_height,
      highestProvenCurrentStacksTipHeight: row.highest_proven_current_stacks_tip_height,
      consecutiveCurrentObservations: row.consecutive_current_observations,
      reason: row.reason,
    });
  }

  putLocalNodeAuthority(
    managerPrincipal: string,
    authority: LocalNodeAuthority,
  ): LocalNodeAuthority {
    const manager = principalSchema.parse(managerPrincipal);
    const value = localNodeAuthoritySchema.parse(authority);
    this.db
      .prepare(
        `INSERT INTO local_node_authority (
          manager_principal, schema_version, status, observed_at, stacks_tip_height,
          highest_proven_current_stacks_tip_height, consecutive_current_observations, reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(manager_principal) DO UPDATE SET
          schema_version = excluded.schema_version,
          status = excluded.status,
          observed_at = excluded.observed_at,
          stacks_tip_height = excluded.stacks_tip_height,
          highest_proven_current_stacks_tip_height =
            excluded.highest_proven_current_stacks_tip_height,
          consecutive_current_observations = excluded.consecutive_current_observations,
          reason = excluded.reason`,
      )
      .run(
        manager,
        value.schemaVersion,
        value.status,
        value.observedAt,
        value.stacksTipHeight,
        value.highestProvenCurrentStacksTipHeight,
        value.consecutiveCurrentObservations,
        value.reason,
      );
    const stored = this.getLocalNodeAuthority(manager);
    if (!stored) throw new Error("Local node authority was not persisted");
    return stored;
  }

  inspectLegacyEvidence(): LegacyDeploymentEvidence {
    const networks = this.db
      .prepare(
        `SELECT network FROM chain_sources
         UNION SELECT network FROM browser_wallet_intents
         ORDER BY network`,
      )
      .all()
      .map((row) => networkSchema.parse((row as { network: unknown }).network));
    const networkIds = this.db
      .prepare(
        `SELECT chain_id AS network_id FROM chain_events
         UNION SELECT chain_id AS network_id FROM manager_activity_events
         UNION SELECT chain_id AS network_id FROM browser_wallet_intents
         ORDER BY network_id`,
      )
      .all()
      .map((row) => networkIdSchema.parse((row as { network_id: unknown }).network_id));
    const managerPrincipals = this.db
      .prepare(
        `SELECT manager_principal FROM ingestion_runs
         UNION SELECT manager_principal FROM stakers
         UNION SELECT manager_principal FROM stake_positions
         UNION SELECT manager_principal FROM cycle_memberships
         UNION SELECT manager_principal FROM staker_position_observations
         UNION SELECT manager_principal FROM pool_cycle_snapshots
         UNION SELECT manager_principal FROM reward_cycle_snapshots
         UNION SELECT manager_principal FROM staker_reward_cycle_snapshots
         UNION SELECT manager_principal FROM manager_activity_events
         UNION SELECT manager_principal FROM manager_trust_state
         UNION SELECT manager_principal FROM manager_trust_audit
         UNION SELECT manager_principal FROM transaction_jobs
         UNION SELECT json_extract(state_json, '$.managerPrincipal') AS manager_principal
           FROM onboarding_state
           WHERE json_type(state_json, '$.managerPrincipal') = 'text'
         ORDER BY manager_principal`,
      )
      .all()
      .map((row) =>
        z
          .string()
          .min(1)
          .parse((row as { manager_principal: unknown }).manager_principal),
      );
    const walletIntentManagers = this.db
      .prepare("SELECT DISTINCT scope FROM browser_wallet_intents ORDER BY scope")
      .all()
      .map((row) =>
        z
          .string()
          .min(1)
          .parse((row as { scope: unknown }).scope),
      )
      .filter((scope) => scope.includes(".") && validatePrincipal(scope));
    return {
      networks,
      networkIds,
      managerPrincipals: [...new Set([...managerPrincipals, ...walletIntentManagers])].sort(),
    };
  }

  bind(input: DeploymentIdentityBinding): StoredDeploymentIdentity {
    if (this.get()) throw new Error("Deployment identity is already bound");
    const network = networkSchema.parse(input.network);
    const networkId = networkIdSchema.parse(input.networkId);
    const parentNetworkId = networkIdSchema.nullable().parse(input.parentNetworkId);
    const managerPrincipal = principalSchema.parse(input.managerPrincipal);
    const bindingSource = z.enum(["new", "legacy-evidence"]).parse(input.bindingSource);
    const verifiedAt = z.iso.datetime().parse(input.verifiedAt);
    const stacksTipHeight = z.number().int().nonnegative().parse(input.stacksTipHeight);
    const burnBlockHeight = z.number().int().nonnegative().parse(input.burnBlockHeight);
    const pox5ContractId = principalSchema.parse(input.pox5ContractId);
    this.db
      .prepare(
        `INSERT INTO deployment_identity (
          singleton_id, schema_version, network, network_id, parent_network_id,
          manager_principal, binding_source, bound_at, last_verified_at,
          last_stacks_tip_height, last_burn_block_height, last_pox5_contract_id
        ) VALUES (1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        network,
        networkId,
        parentNetworkId,
        managerPrincipal,
        bindingSource,
        verifiedAt,
        verifiedAt,
        stacksTipHeight,
        burnBlockHeight,
        pox5ContractId,
      );
    const stored = this.get();
    if (!stored) throw new Error("Deployment identity binding was not persisted");
    return stored;
  }

  recordVerification(input: DeploymentIdentityVerification): StoredDeploymentIdentity {
    const verifiedAt = z.iso.datetime().parse(input.verifiedAt);
    const result = this.db
      .prepare(
        `UPDATE deployment_identity SET
          last_verified_at = ?, last_stacks_tip_height = ?, last_burn_block_height = ?,
          last_pox5_contract_id = ?
         WHERE singleton_id = 1 AND network = ? AND network_id = ?
           AND parent_network_id IS ? AND manager_principal = ?`,
      )
      .run(
        verifiedAt,
        z.number().int().nonnegative().parse(input.stacksTipHeight),
        z.number().int().nonnegative().parse(input.burnBlockHeight),
        principalSchema.parse(input.pox5ContractId),
        networkSchema.parse(input.network),
        networkIdSchema.parse(input.networkId),
        networkIdSchema.nullable().parse(input.parentNetworkId),
        principalSchema.parse(input.managerPrincipal),
      );
    if (result.changes !== 1) {
      throw new Error("Deployment identity does not match the verified connection");
    }
    const stored = this.get();
    if (!stored) throw new Error("Deployment identity disappeared after verification");
    return stored;
  }
}
