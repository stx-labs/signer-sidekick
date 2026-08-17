import { managerSignerGrantPrepareRequestSchema } from "@stx-labs/signer-sidekick-api-contracts";
import { runOperatorPreflight } from "./preflight.js";
import type { RuntimeSettingsController } from "./runtime-settings.js";
import {
  prepareSignerGrant,
  type SignerGrantPreparation,
  type VerifiedSignerGrant,
  verifySignerGrantOutput,
} from "./signer-grant.js";
import type { WalletIntentRuntimeState } from "./wallet-intent-service.js";
import { OperatorWorkflowError } from "./workflow-error.js";

export interface SignerGrantSession {
  preparation: SignerGrantPreparation | null;
  verified: VerifiedSignerGrant | null;
}

/**
 * Holds the short-lived public artifacts needed to rotate or repair a signer registration.
 *
 * The signer and manager-admin keys stay external. A process restart intentionally clears this
 * session; the operator can safely generate a new authorization ID and repeat the ceremony.
 */
export class SignerGrantService {
  private session: SignerGrantSession = { preparation: null, verified: null };

  constructor(
    private readonly options: {
      runtimeSettings: RuntimeSettingsController;
      managerPrincipal: string;
    },
  ) {}

  current(): SignerGrantSession {
    return structuredClone(this.session);
  }

  walletState(): WalletIntentRuntimeState {
    return {
      managerPrincipal: this.options.managerPrincipal,
      signerGrant: { verified: this.session.verified },
    };
  }

  async prepare(input: unknown): Promise<SignerGrantSession> {
    const value = managerSignerGrantPrepareRequestSchema.parse(input);
    const { node, api, config } = this.options.runtimeSettings.clients();
    const preflight = await runOperatorPreflight(config, node, api);
    if (preflight.status === "fail" || !preflight.pox.pox5ContractId) {
      throw new OperatorWorkflowError(
        422,
        "signer_grant_sources_incompatible",
        "Signer grant preparation is blocked by node or PoX-5 compatibility checks. Review operator readiness and retry",
      );
    }
    const preparation = await prepareSignerGrant(
      node,
      preflight.pox.pox5ContractId,
      this.options.managerPrincipal,
      value.authId,
      value.signerConfigPath,
    );
    this.session = { preparation, verified: null };
    return this.current();
  }

  async verify(signerOutput: unknown): Promise<SignerGrantSession> {
    const preparation = this.session.preparation;
    if (!preparation) {
      throw new OperatorWorkflowError(
        409,
        "signer_grant_not_prepared",
        "Generate a signer command before verifying its output",
      );
    }
    const { node } = this.options.runtimeSettings.clients();
    const verified = await verifySignerGrantOutput(
      node,
      preparation.pox5ContractId,
      this.options.managerPrincipal,
      preparation.authId,
      signerOutput,
    );
    if (this.session.preparation?.expectedMessageHashHex !== preparation.expectedMessageHashHex) {
      throw new OperatorWorkflowError(
        409,
        "signer_grant_changed",
        "A newer signer command replaced this authorization. Verify the latest command output",
      );
    }
    this.session = { preparation, verified };
    return this.current();
  }
}
