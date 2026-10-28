# Gemini Model Terminology Update Summary

> **Historical record (Jan 2026).** The model registry now lives at
> `packages/core/src/gemini/model-registry.ts`, which is the single source of truth
> for model IDs and tiers (MONEY-1386).


## Date: 2026-01-14

## Overview

Updated the entire application to use consistent "Fast" (Gemini 2.0 Flash) and "Advanced" (Gemini 2.0 Pro) terminology instead of the previous "Fast" and "Slow" naming. Added detailed model distinctions and improved guardrails.

---

## Changes Made

### 1. Pricing Page (`app/pricing/client.tsx`)

#### Updated Query Terminology

- ✅ Changed "Slow AI Queries" → "Advanced AI Queries"
- ✅ Added model names to features: "(Gemini 2.0 Flash)" and "(Gemini 2.0 Pro)"
- ✅ Updated all references in PRO, Query Pack, and Premium plans
- ✅ Changed Query Pack description from "Additional AI queries" → "Additional AI queries for power users"

#### Enhanced Model Distinctions

Added comprehensive FAQ explaining the difference:

**Fast Queries (Gemini 2.0 Flash):**

- Quick responses for simple questions
- Stock checks, portfolio basics, trading fundamentals
- Instant results in ~1-2 seconds

**Advanced Queries (Gemini 2.0 Pro):**

- Deep analysis with extended reasoning
- Strategy analysis, portfolio optimization, multi-factor decisions
- Takes 3-5 seconds but provides comprehensive insights

#### Updated Plan Features

- **PRO Plan**: "10 Fast AI Queries/month (Gemini 2.0 Flash)" + "250 Advanced AI Queries/month (Gemini 2.0 Pro)"
- **Query Pack**: "150 Fast + 300 Advanced Queries (PRO Plan)" / "250 Fast Queries (Premium Plan)"
- **Premium Plan**: "250 Fast Queries/month (Gemini Flash)" + "Unlimited Advanced Queries (Gemini Pro)"

#### Feature Comparison Table

Updated table headers:

- "Fast Queries (Gemini 2.0 Flash)"
- "Advanced Queries (Gemini 2.0 Pro)"

---

### 2. FloatingChat Component (`components/FloatingChat.tsx`)

#### Type Definitions

```typescript
// Before
queryType: "fast" | "slow";
slowQueriesUsed: number;
slowQueriesLimit: number;

// After
queryType: "fast" | "advanced";
advancedQueriesUsed: number;
advancedQueriesLimit: number;
```

#### Subscription Access

- Updated all references from `slowQueries*` to `advancedQueries*`
- Added backward compatibility: `access.advancedQueriesUsed || access.slowQueriesUsed || 0`
- This ensures old data still works while new data uses the correct terminology

#### UI Elements

- Changed "Slow" label → "Advanced"
- Updated icon from `Clock` → `Sparkles` for advanced queries
- Updated all query limit calculations to use `advancedQueries*` fields

---

### 3. Chat Query Selector (`components/chat/ChatQuerySelector.tsx`)

**Already Correct** ✅

- Component was already using "fast" and "advanced" terminology
- Includes helper functions with proper descriptions:
  - Fast: "Quick responses with Gemini Flash model. Ideal for simple questions."
  - Advanced: "Deep analysis with Gemini Pro model. Includes extended reasoning for complex queries."

---

### 4. Guardrails Enhancement (`lib/gemini/guardrails.ts`)

#### Added New Injection Patterns

```typescript
/tell\s+me\s+a\s+(joke|story)/i,  // Common injection attempt
/ignore.*and\s+tell/i,             // "ignore X and tell me Y"
```

#### Test Results

- **Success Rate**: 100% (15/15 tests passed)
- **Finance Topic Detection**: Working correctly
- **Off-topic Blocking**: Blocking cooking, sports, entertainment, weather queries
- **Prompt Injection Detection**: Catching "ignore", "forget", "system:", "disregard", etc.
- **Input Sanitization**: Removing role markers and enforcing length limits

#### Test Coverage

```
✅ Valid finance queries (5/5 passed)
✅ Off-topic blocking (4/4 passed)
✅ Prompt injection detection (4/4 passed)
✅ Edge cases (2/2 passed)
```

---

## Model Specifications

### Gemini 2.5 Flash (Fast Queries)

- **Model ID**: `gemini-2.5-flash`
- **Temperature**: 0.7
- **Max Output Tokens**: 2,048
- **Thinking Mode**: Disabled
- **Use Case**: Quick Q&A, portfolio checks, simple analysis
- **Response Time**: ~1-2 seconds

### Gemini 2.5 Pro (Advanced Queries)

- **Model ID**: `gemini-2.5-pro`
- **Temperature**: 0.9
- **Max Output Tokens**: 8,192
- **Thinking Mode**: Always enabled
- **Use Case**: Deep analysis, strategy evaluation, complex reasoning
- **Response Time**: ~3-5 seconds

---

## Pricing

### Cost per Query (Internal)

**Flash Model**:

- Input: $0.075 per 1M tokens
- Output: $0.30 per 1M tokens

**Pro Model**:

- Input: $1.25 per 1M tokens
- Output: $5.00 per 1M tokens

### User Plans

- **FREE**: 0 queries
- **PRO**: 10 Fast + 250 Advanced (₹999 one-time)
- **Query Pack**: +150 Fast + 300 Advanced for PRO (₹99)
- **Premium**: 250 Fast + Unlimited Advanced (₹999/month or ₹9,999/year)

---

## Files Modified

1. `app/pricing/client.tsx` - Updated all query terminology and added detailed explanations
2. `components/FloatingChat.tsx` - Updated query types and subscription access fields
3. `lib/gemini/guardrails.ts` - Enhanced prompt injection detection
4. `test-guardrails.ts` - Created comprehensive test suite

---

## Backward Compatibility

The update maintains backward compatibility:

- API still accepts both `slowQueries` and `advancedQueries` fields
- FloatingChat falls back to old field names: `access.advancedQueriesUsed || access.slowQueriesUsed`
- Database models support both naming conventions during transition period

---

## Testing

### Guardrails Test Results

```bash
$ npx tsx test-guardrails.ts

📊 Test Results:
   ✅ Passed: 15/15
   ❌ Failed: 0/15
   Success Rate: 100.0%

🎉 All tests passed!
```

### Test Coverage

- Finance topic validation (5 tests)
- Off-topic blocking (4 tests)
- Prompt injection detection (4 tests)
- Edge cases (2 tests)

---

## User-Facing Changes

### Pricing Page

- Clear distinction between Fast and Advanced queries
- Model names visible (Gemini 2.0 Flash / Pro)
- Detailed FAQ explaining when to use each type
- Updated query pack descriptions

### Chat Interface

- "Advanced" label instead of "Slow"
- Sparkles icon (✨) for advanced queries
- Lightning bolt icon (⚡) for fast queries
- Remaining query counts show correctly for both types

### Feature Comparison Table

- Model specifications included
- Clear differentiation in capabilities
- Proper labeling throughout

---

## Next Steps

1. ✅ **Backend API** - Already supports both query types
2. ✅ **Subscription System** - Tracks both fast and advanced queries
3. ✅ **Chat Integration** - Uses correct model based on query type
4. ✅ **Cost Tracking** - Records costs per model type
5. ✅ **Guardrails** - 100% test pass rate

---

## Notes

- All tests passing with 100% success rate
- Guardrails effectively blocking off-topic queries
- Prompt injection detection working correctly
- User experience improved with clear model distinctions
- Backward compatibility maintained for smooth transition

---

## Deployment Checklist

- [x] Update pricing page terminology
- [x] Update FloatingChat component
- [x] Enhance guardrails
- [x] Test all changes
- [x] Verify backward compatibility
- [x] Document changes

**Status**: ✅ Ready for deployment
