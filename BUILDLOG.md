# BUILDLOG.md — AI-Assisted Engineering Log

This log documents the architecture decisions, AI tool assistance, corrections, and modifications made throughout the development of the Usage Metering & Billing Engine.

---

## Phase 1: Architecture, Design & Schema Formulation

### Where AI Helped
- Formulated the layered architecture (HTTP & boundary validation -> Service layer -> Persistence layer) ensuring clear separation of concerns.
- Drafted the database schema in `DESIGN.md` including table relations, indices for fast usage rollups, and atomic idempotency key tracking.
- Outlined the exact-once idempotency flow handling concurrent in-flight requests, replays, and failures.

### Corrections & Adjustments Made
- **Folder naming vs npm init**: Initial `npm init` failed due to the ampersand `&` in the project directory name. Adjusted package naming to `flyrank-capstone-metering-billing` directly in `package.json`.
- **Money Math Precision**: Avoided floating-point arithmetic for pricing calculations. Formulated pricing in integer micro-units ($1 USD = 1,000,000 micro-units, 1 cent = 10,000 micro-units) so that token discounts and multipliers never introduce rounding drift.
- **Quota Boundary Definition**: Clarified exact boundary semantics: if quota is 1,000, the 1,000th call is admitted (boundary honest), while subsequent calls or calls exceeding limits return HTTP `429 Too Many Requests` (or HTTP `402 Payment Required` if subscription payment has lapsed).

---

## Phase 2: Core Billing Logic (Idempotency & Quotas)

### Where AI Helped
- Implemented `MeteringService` and `IdempotencyRepository` ensuring atomic `IN_PROGRESS` reservations followed by `COMPLETED` cache writes.
- Implemented `QuotaService` evaluating calendar month billing boundaries and quota limits.
- Built Zod schema validation middleware returning clean HTTP 400 Bad Request responses on schema violations, protecting internal services from unhandled 500 exceptions.

### Corrections & Adjustments Made
- **Windows Command Line Ampersand Parsing**: On Windows, directory paths containing `&` cause `cmd.exe` to treat `&` as a command separator, breaking standard `.bin` wrappers. Solved this by executing Node binaries directly (`node ./node_modules/vitest/vitest.mjs run`, `node ./node_modules/tsx/dist/cli.mjs`) in `package.json` scripts.
- **Quota Exceeded Retry Caching**: Ensured that when a request is rejected with HTTP 429, the idempotency record stores the 429 response so that client retries receive identical HTTP 429 responses.

---

## Phase 3: Stripe Integration & Webhook Security

### Where AI Helped
- Implemented `StripeService` supporting test mode checkout session creation and raw-body webhook signature verification (`stripe.webhooks.constructEvent`).
- Implemented `WebhookRepository` maintaining the `processed_webhook_events` table for exact-once event processing and idempotent webhook replays.
- Automated tenant upgrade lifecycle: flipping `free` to `pro` plan upon receipt of verified `checkout.session.completed` events.

### Corrections & Adjustments Made
- **Raw Body Handling in Express**: Standard `express.json()` consumes the stream and changes byte representation, breaking HMAC-SHA256 signature verification. Mounted `express.raw({ type: 'application/json' })` specifically on `/webhooks/stripe` before the general `express.json()` middleware.
- **Stripe SDK v23 Type Adjustments**: Removed deprecated `payment_method_types` property from `sessions.create` call to conform to strict TypeScript definitions in newer Stripe SDK versions.

---

## Phase 4: Multi-Category AI Pricing, Background Jobs & Evidence

### Where AI Helped
- Implemented `PricingService` with multi-category token arithmetic: standard fresh input ($1.00/1M), cached input (75% discount: $0.25/1M), output ($4.00/1M), and reasoning tokens (priced identically to output tokens).
- Built `BackgroundWorkerService` with an asynchronous job queue for quota threshold alerting (80% and 100%) and nightly Stripe subscription state reconciliation.
- Created `tests/probes.test.ts` and `src/scripts/verify_evidence.ts` executing live acceptance probes and capturing empirical transcripts for `EVIDENCE.md`.

### Corrections & Adjustments Made
- **Relative Import Resolution**: Fixed script import paths in `verify_evidence.ts` to correctly reference sibling directories under `src/`.
- **Deduplication of Usage Alerts**: Added a unique composite constraint `UNIQUE(tenant_id, threshold_percent, billing_period)` to prevent duplicate alert notifications within the same calendar billing cycle.
