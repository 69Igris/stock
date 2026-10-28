/**
 * Payments Module
 *
 * Provides payment processing through Dodo Payments.
 * Plan configuration and feature access are in the subscription module.
 */

// Dodo Payments client
export {
  getDodoClient,
  resetDodoClient,
  isDodoConfigured,
  isLiveMode,
  getDodoMode,
  getDodoSdkMode,
  DODO_SDK_MODE,
  dodoClient,
} from "./dodo";
