/**
 * The env suffix, spelled ONCE. MONEY-1506 (data-platform B4).
 *
 * `workflow_settings.yaml` carries BOTH `defaultDataset: lake_gold_qa` and
 * `vars.env: qa`, and a run can override them independently. Two
 * mechanisms for one fact is how a prod run reads QA silver and writes prod
 * gold — cross-environment, silent, and correct-looking in every counter. So
 * every model and every declaration derives its dataset from `vars.env` through
 * these two functions, and `defaultDataset` is left as the fallback nothing
 * uses.
 *
 * Layer names come from `LAKE_DATASETS` in packages/core/src/ops/lake-layout.ts
 * and are held in agreement with it by
 * `packages/core/__tests__/ops/dataform-agreement.test.ts`.
 */

/** `lake_silver_qa` | `lake_silver_prod` — read-only to this project. */
function silver() {
  return `lake_silver_${dataform.projectConfig.vars.env}`;
}

/** `lake_gold_qa` | `lake_gold_prod` — everything this project writes. */
function gold() {
  return `lake_gold_${dataform.projectConfig.vars.env}`;
}

module.exports = { silver, gold };
