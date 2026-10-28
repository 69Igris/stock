/**
 * User preferences - barrel export.
 *
 * Each feature owns a namespace under `User.preferences`. Today:
 *   - research → research-preferences.ts (MONEY-219)
 *
 * Add new feature buckets here and update the JSON shape comment on the
 * `User.preferences` field in schema.prisma.
 */

export {
  getResearchPreferences,
  setResearchPreferences,
  researchPreferencesSchema,
  RESEARCH_STYLES,
  RESEARCH_SKILL_IDS,
  RESEARCH_SKILL_LABELS,
  RESEARCH_SKILL_DESCRIPTIONS,
  RESEARCH_PRESETS,
  RESEARCH_PRESET_DEFS,
  RESEARCH_DEFAULT_MODEL,
  SKILL_ID_ALIASES,
  expandSkillAliases,
  resolveEffectiveSkills,
  DEFAULT_RESEARCH_PREFERENCES,
  // MONEY-794 (C1c): institutional run-parameters
  RESEARCH_HORIZONS,
  RESEARCH_BENCHMARKS,
  RESEARCH_REPORT_LENGTHS,
  BENCHMARK_SYMBOLS,
  resolveBenchmarkSymbol,
  researchAssumptionsSchema,
  researchVarConfigSchema,
  type ResearchPreferences,
  type ResearchPreferencesInput,
  type ResearchStyle,
  type ResearchSkillId,
  type ResearchPresetId,
  type ResearchPresetDef,
  type ResearchHorizon,
  type ResearchBenchmark,
  type ResearchReportLength,
  type ResearchAssumptions,
  type ResearchVarConfig,
} from "./research-preferences";

export {
  getComposerPreferences,
  setComposerPreferences,
  recordRecentInstrument,
  buildComposerResetPatch,
  DEFAULT_COMPOSER_PREFERENCES,
  DEFAULT_CONNECTOR_PREFERENCES,
  DEFAULT_SOURCE_PREFERENCES,
  DEFAULT_TOOLS_PREFERENCES,
  DEFAULT_INSTRUMENT_BASKET,
  INDICATOR_IDS,
  PERSONA_IDS,
  PERSONA_PROMPTS,
  connectorPreferencesSchema,
  sourcePreferencesSchema,
  toolsPreferencesSchema,
  instrumentBasketSchema,
  thinkingPreferenceSchema,
  readThinkingPreference,
  mergeThinkingPreference,
  type ComposerPreferences,
  type ConnectorPreferences,
  type SourcePreferences,
  type ToolsPreferences,
  type InstrumentBasket,
  type IndicatorId,
  type PersonaId,
} from "./composer-preferences";
