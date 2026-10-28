# Gemini API Quota Request - UseMoney Scalable System

> GCP quota request values for Google Gemini models across three scale tiers.
> All models are text-only (image/video/audio = 0). Context window:
> `>=200k tokens`. Batch requests: Off. Priority requests: Off.

---

## Current Model Roles

| Model                     | Role in UseMoney                                                              | Mode       |
| ------------------------- | ----------------------------------------------------------------------------- | ---------- |
| **Gemini 2.5 Flash**      | Chat (fast mode), research planner, LLM narrative, conversation summarization | Production |
| **Gemini 2.5 Pro**        | Chat (advanced mode), research synthesis (L2/L3), portfolio roast             | Production |
| **Gemini 2.5 Flash Lite** | Intent classification, tier detection (planned migration from 2.5 Flash)      | Planned    |
| **Gemini 3.0 Pro**        | Future L3/L4 deep analysis, complex multi-step reasoning                      | Future     |
| **Gemini 3.0 Flash**      | Future fast-mode replacement with better quality                              | Future     |
| **Gemini 2.0 Flash**      | Legacy fallback model                                                         | Fallback   |

---

## Table 1 - 100 Daily Active Users

| Model                 | Context Window | RPD   | Avg Input Tokens (text) | Avg Output Tokens (text) |
| --------------------- | -------------- | ----- | ----------------------- | ------------------------ |
| Gemini 2.5 Flash      | >=200k         | 2,000 | 2,500                   | 500                      |
| Gemini 2.5 Pro        | >=200k         | 500   | 12,000                  | 4,000                    |
| Gemini 2.5 Flash Lite | >=200k         | 1,500 | 1,500                   | 100                      |
| Gemini 3.0 Pro        | >=200k         | 200   | 20,000                  | 8,000                    |
| Gemini 3.0 Flash      | >=200k         | 500   | 2,500                   | 500                      |
| Gemini 2.0 Flash      | >=200k         | 500   | 2,500                   | 500                      |

---

## Table 2 - 1,000 Daily Active Users

| Model                 | Context Window | RPD    | Avg Input Tokens (text) | Avg Output Tokens (text) |
| --------------------- | -------------- | ------ | ----------------------- | ------------------------ |
| Gemini 2.5 Flash      | >=200k         | 20,000 | 2,500                   | 500                      |
| Gemini 2.5 Pro        | >=200k         | 5,000  | 12,000                  | 4,000                    |
| Gemini 2.5 Flash Lite | >=200k         | 15,000 | 1,500                   | 100                      |
| Gemini 3.0 Pro        | >=200k         | 1,000  | 20,000                  | 8,000                    |
| Gemini 3.0 Flash      | >=200k         | 5,000  | 2,500                   | 500                      |
| Gemini 2.0 Flash      | >=200k         | 2,000  | 2,500                   | 500                      |

---

## Table 3 - 10,000 Daily Active Users

| Model                 | Context Window | RPD     | Avg Input Tokens (text) | Avg Output Tokens (text) |
| --------------------- | -------------- | ------- | ----------------------- | ------------------------ |
| Gemini 2.5 Flash      | >=200k         | 200,000 | 2,500                   | 500                      |
| Gemini 2.5 Pro        | >=200k         | 50,000  | 12,000                  | 4,000                    |
| Gemini 2.5 Flash Lite | >=200k         | 150,000 | 1,500                   | 100                      |
| Gemini 3.0 Pro        | >=200k         | 10,000  | 20,000                  | 8,000                    |
| Gemini 3.0 Flash      | >=200k         | 50,000  | 2,500                   | 500                      |
| Gemini 2.0 Flash      | >=200k         | 10,000  | 2,500                   | 500                      |

---

## Estimation Assumptions

| Parameter                        | Value  | Rationale                                                |
| -------------------------------- | ------ | -------------------------------------------------------- |
| Avg messages per user per day    | 15     | Power users: 30-50, casual: 5-10                         |
| Fast mode usage                  | 80%    | Most queries are quick lookups / L1-L2                   |
| Advanced mode usage              | 20%    | Deep analysis, roast, L3 research                        |
| Flash calls per message          | 1.3x   | Classifier + responder/narrative                         |
| Pro calls per message (advanced) | 1.0x   | Synthesis call only                                      |
| Peak RPM multiplier              | 3x avg | Assumes burst during market hours (9:15-15:30 IST)       |
| Daily cost limit per user        | $2.00  | Enforced in code (~650 Flash queries or ~16 Pro queries) |

### Per-Request Token Breakdown

**Gemini 2.5 Flash (fast mode):**

| Call Type                          | Input Tokens | Output Tokens |
| ---------------------------------- | ------------ | ------------- |
| Intent classification              | ~1,500       | ~100          |
| L1 Flash responder (definitions)   | ~2,000       | ~500          |
| Chat narrative (fast tool summary) | ~3,000       | ~400          |
| Research planner                   | ~2,500       | ~800          |
| Conversation summarization         | ~4,000       | ~1,000        |
| **Weighted average**               | **~2,500**   | **~500**      |

**Gemini 2.5 Pro (advanced mode):**

| Call Type               | Input Tokens | Output Tokens |
| ----------------------- | ------------ | ------------- |
| Advanced chat response  | ~8,000       | ~2,000        |
| Research synthesis (L2) | ~12,000      | ~4,000        |
| Research synthesis (L3) | ~25,000      | ~8,000        |
| Portfolio roast         | ~15,000      | ~6,000        |
| **Weighted average**    | **~12,000**  | **~4,000**    |

**Gemini 3.0 Pro (future deep analysis):**

| Call Type                      | Input Tokens | Output Tokens |
| ------------------------------ | ------------ | ------------- |
| L3 deep analysis synthesis     | ~20,000      | ~8,000        |
| L4 advanced research synthesis | ~25,000      | ~10,000       |
| **Estimated average**          | **~20,000**  | **~8,000**    |

---

## Notes

- **Context window >=200k** is sufficient. The 1M context window is only needed
  for extreme edge cases (full conversation history replay). Our conversation
  budget is capped at 16K tokens with auto-summarization at 80%.
- **Gemini 3.0 models** are requested for future-proofing. Current production
  uses 2.5 Flash + 2.5 Pro exclusively.
- **Flash Lite migration** for intent classification would reduce Flash RPD by
  ~40% at lower cost.
- **Image/video/audio tokens** are 0 across all models - UseMoney is text-only.
- **Region:** us-central1 (match your Vertex AI endpoint).

---

_Last Updated: March 2026_
