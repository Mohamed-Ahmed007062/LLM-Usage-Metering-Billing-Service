# Usage Metering & Billing Engine

A production-grade, multi-tenant Usage Metering and Billing Engine built with Node.js, TypeScript, Express, and SQLite.

Engineered to solve the three core challenges of SaaS billing:
1. **Exactly-Once Metering**: Guaranteed zero double-counting under retries via cryptographic and database-level idempotency keys.
2. **Honest Quota Enforcement**: Precise boundary limits returning RFC-compliant HTTP `429 Too Many Requests` (with `Retry-After`) and HTTP `402 Payment Required`.
3. **Multi-Category AI Token Money Math**: Exact integer arithmetic (in micro-units: 1 USD = 1,000,000 micro-units, 1 cent = 10,000 micro-units) pricing standard input, cached input (75% discount), output, and reasoning tokens without floating-point rounding drift.
4. **Stripe Test Mode Integration**: Automated subscription checkout and HMAC-SHA256 signature-verified, idempotent webhook processing.
5. **Background Jobs & Quota Alerts**: Asynchronous processing queue for 80% and 100% quota alerts and Stripe subscription state reconciliation.

---

## Architecture Overview

```
                      +---------------------------------------+
                      |             HTTP Clients              |
                      +---------------------------------------+
                                          |
                POST /generate            |  GET /usage
                POST /checkout/session    |  POST /webhooks/stripe
                                          v
                      +---------------------------------------+
                      |        HTTP & Validation Layer        |
                      |   - Express.js Router                 |
                      |   - Zod Boundary Request Validation   |
                      |   - Raw-Body Capture for Webhooks     |
                      +---------------------------------------+
                                          |
                                          v
                      +---------------------------------------+
                      |         Domain & Service Layer        |
                      |   - MeteringService (Idempotency)     |
                      |   - QuotaService (Boundary Checks)    |
                      |   - PricingService (Integer Math)     |
                      |   - StripeService (Checkout & Sync)   |
                      |   - BackgroundWorker (Alerts & Recon) |
                      +---------------------------------------+
                                          |
                                          v
                      +---------------------------------------+
                      |       Data & Persistence Layer        |
                      |   - SQLite (WAL mode, Foreign Keys)   |
                      |   - Tenant, Usage, Idempotency Repos  |
                      |   - Deterministic Migrations & Seed   |
                      +---------------------------------------+
```

---

## Subscription Plans & Limits

| Plan | Monthly Cost | Monthly API Calls Limit | Monthly AI Token Quota | Notes |
| :--- | :--- | :--- | :--- | :--- |
| **Free** | \$0.00 | 1,000 calls | 100,000 tokens | Entry tier; blocked on reaching quota |
| **Pro** | \$29.00 | 50,000 calls | 5,000,000 tokens | Production tier; activated via Stripe Checkout |

---

## Pinned AI Token Pricing Rules

All financial values are calculated and stored in **integer micro-units** ($1 USD = 1,000,000 micro-units; 1 cent = 10,000 micro-units) to eliminate floating-point precision loss:

- **Base API Call**: 1,000 micro-units (\$0.001 per call)
- **Standard Fresh Input Tokens**: 1 micro-unit per token (\$1.00 per 1,000,000 tokens)
- **Cached Input Tokens**: 0.25 micro-units per token (\$0.25 per 1,000,000 tokens — 75% discount)
  - Calculated as: `Math.floor((cached_tokens * 25) / 100)` micro-units
- **Output Tokens**: 4 micro-units per token (\$4.00 per 1,000,000 tokens)
- **Reasoning Tokens**: 4 micro-units per token (counted and priced identically to output tokens)

$$\text{Total Cost} = (\text{API\_Calls} \times 1,000) + (\text{Input} \times 1) + \left\lfloor\frac{\text{Cached} \times 25}{100}\right\rfloor + ((\text{Output} + \text{Reasoning}) \times 4)$$

---

## Quick Start (Clean Machine Setup)

### Prerequisites
- Node.js (v18+)
- npm (v9+)

### 1. Install Dependencies
```bash
npm install
```

### 2. Environment Configuration
Copy the example environment configuration:
```bash
cp .env.example .env
```

### 3. Seed Demo Data
```bash
npm run seed
```
This populates:
- `tenant_free_demo`: Free plan (1,000 calls, 100k tokens)
- `tenant_pro_demo`: Pro plan (50,000 calls, 5M tokens)
- `tenant_quota_boundary`: Free plan with 999 prior calls (ready for boundary testing)
- `tenant_past_due`: Tenant with `past_due` subscription (returns HTTP 402)

### 4. Build & Start the Server
```bash
npm run build
npm start
```
The server starts at `http://localhost:3000`.

---

## Automated Acceptance Test Suite (All 5 Probes)

Run the full deterministic test suite:
```bash
npm test
```

### Acceptance Probes Coverage:
- **PROBE 1**: Same request retried with the same `Idempotency-Key` records **exactly one** usage event; second response mirrors the first with header `Idempotent-Replay: true`.
- **PROBE 2**: At boundary (call 1,000 of 1,000), request is admitted; call 1,001 returns `429 Too Many Requests` with `Retry-After`. Lapsed accounts return `402 Payment Required`.
- **PROBE 3**: Stripe `checkout.session.completed` webhook flips tenant `free -> pro`; `GET /usage` immediately reflects expanded limits.
- **PROBE 4**: Forged webhook returns `400 Bad Request`; replaying a valid webhook returns `200 OK (ignored_duplicate)`.
- **PROBE 5**: Cached input tokens (75% discount) and reasoning tokens (priced as output) produce exact totals matching pinned constants in `GET /usage`.

---

## API Reference

### 1. Billable Action: `POST /generate`
**Headers**:
- `X-Tenant-ID`: Tenant identifier (required)
- `Idempotency-Key`: Unique request key (required)

**Request Body**:
```json
{
  "prompt": "Analyze dataset and summarize findings",
  "simulate_tokens": {
    "input_tokens": 1000,
    "cached_input_tokens": 400,
    "output_tokens": 500,
    "reasoning_tokens": 200
  }
}
```

**Response (HTTP 200 OK)**:
```json
{
  "success": true,
  "event_id": "028ac6df-9e4c-4597-ad14-5a5501f21ea5",
  "tenant_id": "tenant_free_demo",
  "plan": "free",
  "usage_recorded": {
    "api_calls": 1,
    "tokens": {
      "input_tokens": 1000,
      "cached_input_tokens": 400,
      "output_tokens": 500,
      "reasoning_tokens": 200,
      "total_tokens": 2100
    }
  },
  "cost": {
    "total_cost_micro_units": 4900,
    "total_cost_formatted": "$0.0049"
  },
  "quota_remaining": {
    "api_calls": 999,
    "tokens": 97900
  }
}
```

---

### 2. Read Usage Rollup: `GET /usage`
**Query Parameters or Header**: `?tenant_id=tenant_free_demo` or `X-Tenant-ID` header.

**Response (HTTP 200 OK)**:
```json
{
  "tenant_id": "tenant_free_demo",
  "plan": "free",
  "status": "active",
  "billing_period": {
    "year_month": "2026-10",
    "start": "2026-10-01T00:00:00.000Z",
    "end": "2026-10-31T23:59:59.999Z"
  },
  "usage": {
    "api_calls": { "used": 1, "limit": 1000, "remaining": 999, "percent_used": 0.1 },
    "tokens": { "used": 2100, "limit": 100000, "remaining": 97900, "percent_used": 2.1 }
  },
  "cost": {
    "total_cost_micro_units": 4900,
    "total_cost_formatted": "$0.0049"
  }
}
```

---

### 3. Stripe Checkout: `POST /checkout/session`
```json
{
  "tenant_id": "tenant_free_demo"
}
```

---

### 4. Stripe Webhook: `POST /webhooks/stripe`
Receives raw body signed with Stripe HMAC-SHA256 signature (`stripe-signature` header).

---

### 5. Admin Subscription Reconciliation: `POST /admin/reconcile`
Triggers background synchronization between Stripe's subscription state and local tenant records.

---

## Limitations

1. **Stripe Test Mode Only**: This service is configured for Stripe test mode. It does not process real payment credentials or real money.
2. **Single Database Instance**: Designed around SQLite with WAL mode and foreign key enforcement. For multi-region geographically distributed clusters, a distributed database (such as PostgreSQL or Neon) would be substituted with identical repository interfaces.
3. **In-Process Background Worker**: The background worker polls the SQLite job table. For massive horizontal multi-node scaling, a distributed message broker (such as Redis/BullMQ or SQS) can be plugged in.
