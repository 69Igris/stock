// TypeScript declarations for Dodo Payments Checkout SDK

interface DodoCheckoutEvent {
  name:
    | "checkout.loaded"
    | "checkout.completed"
    | "checkout.failed"
    | "checkout.closed"
    | "checkout.breakdown";
  data?: any;
}

interface DodoPaymentsSDK {
  Initialize: (config: {
    mode: "test" | "live";
    onEvent: (event: DodoCheckoutEvent) => void;
    displayType?: "overlay" | "inline";
    showTimer?: boolean;
    showSecurityBadge?: boolean;
    disableRedirect?: boolean;
    theme?: {
      primaryColor?: string;
      backgroundColor?: string;
      textColor?: string;
      borderRadius?: string;
    };
  }) => void;
  Checkout: {
    open: (options: { checkoutUrl: string; elementId?: string }) => void;
    close: () => void;
  };
}

declare global {
  interface Window {
    DodoPayments?: DodoPaymentsSDK;
  }
}

export {};
