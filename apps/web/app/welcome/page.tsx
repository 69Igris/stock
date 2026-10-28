import WelcomeWizardClient from "./client";

export const metadata = {
  // Root layout template appends `| UseMoney`.
  title: "Welcome",
  description: "Set up your investor profile so UseMoney fits how you invest.",
};

/**
 * /welcome — used ONLY during the initial onboarding sequence
 * (new sign-up or users who have never set their investor profile).
 *
 * If a returning user navigates here directly (e.g. old bookmark),
 * WelcomeWizardClient will show a "Cancel → /settings" button and
 * pre-fill their existing answers, so they're never left stranded.
 *
 * From Settings, the "Edit profile" button now goes to
 * /settings/investor-profile (in-shell, sidebar visible) — this
 * full-screen page is intentionally kept for the onboarding flow only.
 */
export default function WelcomePage() {
  return <WelcomeWizardClient />;
}
