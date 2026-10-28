# Branch Protection Setup

Configure these settings at: **GitHub → UseMoney-AI/stockbook-monorepo →
Settings → Branches → Add branch protection rule**

## Rule: Protect `main`

| Setting                                       | Value                                                               |
| --------------------------------------------- | ------------------------------------------------------------------- |
| **Branch name pattern**                       | `main`                                                              |
| **Require a pull request before merging**     | ✅ Enabled                                                          |
| **Required approvals**                        | 1                                                                   |
| **Dismiss stale PR reviews**                  | ✅                                                                  |
| **Require review from code owners**           | ✅ (interns onboarded — see CODEOWNERS)                             |
| **Require status checks to pass**             | ✅ Enabled                                                          |
| **Status checks required**                    | `Validate branch naming convention`, `yarn test:smoke`, `yarn test` |
| **Require branches to be up to date**         | ✅                                                                  |
| **Require conversation resolution**           | ✅                                                                  |
| **Do not allow bypassing the above settings** | ❌ (allow owner to bypass)                                          |

## Bypass List (Owner Exempt from Reviews)

Under **"Allow specified actors to bypass required pull requests"**, add:

- **deepshaswat** (GitHub username)

This allows the owner to merge without waiting for reviews while all other
contributors must get approval.

## After Setup

1. Merge this PR first (the one adding these files)
2. The `pr-branch-check` workflow will appear as a status check
3. Select it as a required check
4. Test by creating a PR with a non-compliant branch name
