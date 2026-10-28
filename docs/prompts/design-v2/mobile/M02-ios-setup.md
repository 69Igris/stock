# M02 · iOS — Xcode toolchain, native config, APNs via FCM, capabilities, local archive/TestFlight, App Store readiness

Read `docs/prompts/design-v2/00-shared-context.md` — it is part of this prompt. Prerequisite: M00. Local builds only (no EAS). Development machine: macOS (Apple silicon), paid Apple Developer team.

**Ticket:** `MONEY-{n}` "Mobile — iOS setup" → `chore/MONEY-{n}`.
**Design sources:** `docs/design/v2-bundle/frames/ios-frame.jsx` (402×874 frame, 56 px top inset, home indicator — use real safe-area insets), `assets/usemoney-mark.svg` (icon), `src/screens-auth.jsx` (`AppleSoonBtn` — "Continue with Apple · SOON": **see the store-review note below**), `baseline/UseMoney iOS App.html` (reference only).

## Read first
- `apps/mobile/app.config.ts`, `apps/mobile/CLAUDE.md` (from M00), A01 (APNs-via-FCM contract), A02 (StoreKit 2 contract), `apps/web/app/sso-callback/*` + Clerk config (which OAuth providers are enabled: Google today; Apple pending).

## Build
1. **Toolchain (record versions in `apps/mobile/CLAUDE.md`):** Xcode (latest stable) + Command Line Tools, iOS SDK, CocoaPods (or the Expo-managed pod install), `xcode-select` path, at least one simulator (iPhone 16/17, latest iOS) and one physical device registered in the team; Ruby/CocoaPods via the system or `rbenv` — document which. Commit `ios/Podfile.lock` **is not possible with CNG**; pin JS deps and record `pod --version` + `xcodebuild -version`.
2. **App config (iOS section of `app.config.ts`):** `bundleIdentifier: "ai.usemoney.app"`, `buildNumber` from CI env (monotonic), `supportsTablet: false` (phone-first; iPad runs in compatibility mode — must not crash), icons (light/dark/tinted variants from the U mark on paper), splash, `infoPlist`: `NSFaceIDUsageDescription` ("Unlock UseMoney with Face ID"), `NSPhotoLibraryUsageDescription` only if the document picker needs it (it doesn't — omit), `ITSAppUsesNonExemptEncryption: false`, `UIBackgroundModes: ["remote-notification"]`, ATS default (HTTPS only; no exceptions), `LSApplicationQueriesSchemes` for broker apps if deep-linking to them (none in v1); `associatedDomains: ["applinks:usemoney.ai"]`; scheme `usemoney`; `usesAppleSignIn` — see note.
3. **Apple App Site Association:** serve `apps/web/public/.well-known/apple-app-site-association` (JSON, no extension, `application/json`) with `applinks` for `/app/*` and the team id + bundle id; verify with the AASA validator and a tapped link on device.
4. **Capabilities (via the Expo config plugin / entitlements):** Push Notifications, Associated Domains, In-App Purchase, Sign in with Apple (if enabled — see note), Keychain Sharing (Clerk secure store), Background Modes (remote notifications). Provisioning: automatic signing for dev; a distribution profile for archive (managed by Xcode's "Automatically manage signing" with the team — document the manual fallback).
5. **APNs via FCM:** create an APNs auth key (`.p8`) in the developer portal, upload it to the Firebase project's iOS app (Cloud Messaging → APNs auth key), add the iOS app (`GoogleService-Info.plist`, gitignored, injected in CI); `expo-notifications` requests permission at the right moment (after first sync, never on launch — M11/M19 own the prompt); test a QA push (A01) on a **physical device** (simulators receive APNs only on Apple-silicon Macs with iOS 16+ simulators — try, else device).
6. **Privacy manifest:** `PrivacyInfo.xcprivacy` declaring required-reason APIs used by deps (UserDefaults, file timestamps, system boot time, disk space — from the Expo/RN defaults) and collected data types matching the App Privacy labels; run `xcodebuild` with the privacy report to confirm no missing declarations.
7. **Builds:** `npx expo prebuild --platform ios --clean` → `npx expo run:ios` (simulator) / `--device`; release archive without EAS: `xcodebuild -workspace ios/UseMoney.xcworkspace -scheme UseMoney -configuration Release -archivePath build/UseMoney.xcarchive archive` → `xcodebuild -exportArchive -exportOptionsPlist ios/ExportOptions.plist` (method `app-store-connect`) → upload with `xcrun altool --upload-app` (or Transporter); document an `ios/ExportOptions.plist` template; Hermes on; dSYMs uploaded to Datadog RUM if enabled.
8. **StoreKit 2 (A02 client prerequisites):** IAP library (same choice as M01), products created in App Store Connect (ids from `store-products.ts`), a local `UseMoney.storekit` configuration for simulator testing, sandbox tester accounts, App Store Server Notifications V2 URL pointing at A02's webhook.
9. **App Store readiness checklist** (`docs/reference/mobile-store-ios.md`, generated, not submitted): listing copy, screenshots per required display size (6.9"/6.5"/5.5" as currently required — verify), App Privacy labels (Contact info: email/name; Financial info: portfolio; Identifiers: device token; Usage data; all linked to identity; none used for tracking), Sign-in guideline, account deletion path (Settings → Delete account, in-app — required since 2022), export compliance answer, age rating, review notes with a demo account (demo mode covers it), support URL, EULA (standard), IAP review screenshots.

### Store-review note (raise with Shaswat before submission)
App Store Review Guideline 4.8: an app that offers a third-party login (Google) **must also offer Sign in with Apple** (or an equivalent privacy-preserving login). The design marks Apple as "SOON". Either enable Apple OAuth in Clerk before the first iOS submission (Clerk supports it; `usesAppleSignIn: true`) or ship iOS with email/phone + Google **and** Apple. Do not ship the "SOON" badge to the store.

## Non-goals
EAS, watchOS/widgets, iPad layouts, App Clips.

## Acceptance
- Fresh clone → documented commands produce a simulator build and a device build; a Release archive exports and uploads to TestFlight (internal testers) without EAS; versions recorded in `apps/mobile/CLAUDE.md`.
- Universal link `https://usemoney.ai/app/stock/INFY` opens the stock route on device; AASA validates.
- A QA push arrives on a device via APNs-through-FCM and deep-links on tap; permission prompt not shown at launch.
- Privacy manifest passes the Xcode privacy report; ATS has no exceptions; no debug logging in Release.
- Checklist doc committed with the Sign in with Apple decision recorded; `verify:push` green; `/code-review`.
