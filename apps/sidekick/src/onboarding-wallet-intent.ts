/**
 * Compatibility facade for the onboarding service while setup routes remain in Slice 2.
 *
 * Day-2 callers should import the generic wallet-intent service directly. Slice 3 can remove this
 * facade together with the setup-only deployment flow without moving the recurring lifecycle again.
 */
export {
  OnboardingWalletIntentError,
  OnboardingWalletIntentService,
  type WalletFreshState,
  WalletIntentError,
  type WalletIntentRuntimeState,
  WalletIntentService,
} from "./wallet-intent-service.js";
