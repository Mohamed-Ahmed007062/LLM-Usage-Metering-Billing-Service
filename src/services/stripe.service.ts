import { Database } from 'better-sqlite3';
import Stripe from 'stripe';
import { CONFIG } from '../config/index.js';
import { TenantRepository } from '../repositories/tenant.repository.js';
import { WebhookRepository } from '../repositories/webhook.repository.js';
import { TenantStatus } from '../types/index.js';

export interface WebhookProcessingResult {
  status: 'processed' | 'ignored_duplicate';
  eventId: string;
  eventType: string;
  tenantId?: string;
  updatedPlan?: string;
}

export class StripeService {
  private stripe: Stripe;
  private tenantRepo: TenantRepository;
  private webhookRepo: WebhookRepository;

  constructor(private db: Database, stripeClient?: Stripe) {
    this.stripe = stripeClient || new Stripe(CONFIG.stripeSecretKey, {
      apiVersion: '2025-02-24.acacia' as any,
    });
    this.tenantRepo = new TenantRepository(db);
    this.webhookRepo = new WebhookRepository(db);
  }

  async createCheckoutSession(
    tenantId: string,
    successUrl = 'https://example.com/success?session_id={CHECKOUT_SESSION_ID}',
    cancelUrl = 'https://example.com/cancel'
  ): Promise<{ sessionId: string; checkoutUrl: string }> {
    const tenant = this.tenantRepo.findById(tenantId);
    if (!tenant) {
      throw new Error(`Tenant '${tenantId}' not found`);
    }

    // In local / test mode without real network calls, simulate if secret key is mock
    if (CONFIG.stripeSecretKey.startsWith('sk_test_placeholder') || CONFIG.nodeEnv === 'test') {
      const mockSessionId = `cs_test_${tenantId}_${Date.now()}`;
      return {
        sessionId: mockSessionId,
        checkoutUrl: `https://checkout.stripe.com/pay/${mockSessionId}`,
      };
    }

    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      client_reference_id: tenantId,
      metadata: { tenant_id: tenantId },
      line_items: [
        {
          price: CONFIG.stripeProPriceId,
          quantity: 1,
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    return {
      sessionId: session.id,
      checkoutUrl: session.url || '',
    };
  }

  handleWebhookPayload(
    rawBody: Buffer | string,
    signatureHeader: string
  ): WebhookProcessingResult {
    let event: Stripe.Event;

    try {
      event = this.stripe.webhooks.constructEvent(
        rawBody,
        signatureHeader,
        CONFIG.stripeWebhookSecret
      );
    } catch (err: any) {
      const error = new Error(`Stripe signature verification failed: ${err.message}`);
      (error as any).statusCode = 400;
      throw error;
    }

    // Deduplication check: Has this event already been processed?
    if (this.webhookRepo.isEventProcessed(event.id)) {
      return {
        status: 'ignored_duplicate',
        eventId: event.id,
        eventType: event.type,
      };
    }

    let affectedTenantId: string | undefined;
    let newPlan: string | undefined;

    // Process event types
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const tenantId = session.client_reference_id || session.metadata?.tenant_id;

        if (tenantId) {
          affectedTenantId = tenantId;
          newPlan = 'pro';
          const customerId = typeof session.customer === 'string' ? session.customer : null;
          const subscriptionId = typeof session.subscription === 'string' ? session.subscription : null;

          this.tenantRepo.updatePlanAndSubscription(
            tenantId,
            'pro',
            'active',
            customerId,
            subscriptionId
          );
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        const tenant = this.tenantRepo.findByStripeSubscriptionId(subscription.id) ||
                       (subscription.customer ? this.tenantRepo.findByStripeCustomerId(String(subscription.customer)) : null);

        if (tenant) {
          affectedTenantId = tenant.id;
          let status: TenantStatus = 'active';
          if (subscription.status === 'past_due' || subscription.status === 'unpaid') {
            status = 'past_due';
          } else if (subscription.status === 'canceled' || subscription.status === 'incomplete_expired') {
            status = 'canceled';
          }
          this.tenantRepo.updateStatus(tenant.id, status);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        const tenant = this.tenantRepo.findByStripeSubscriptionId(subscription.id) ||
                       (subscription.customer ? this.tenantRepo.findByStripeCustomerId(String(subscription.customer)) : null);

        if (tenant) {
          affectedTenantId = tenant.id;
          newPlan = 'free';
          // Downgrade back to free plan
          this.tenantRepo.updatePlanAndSubscription(tenant.id, 'free', 'active', null, null);
        }
        break;
      }

      default:
        // Other events acknowledged safely
        break;
    }

    // Atomic insert into processed_webhook_events
    this.webhookRepo.markEventProcessed(event.id, event.type);

    return {
      status: 'processed',
      eventId: event.id,
      eventType: event.type,
      tenantId: affectedTenantId,
      updatedPlan: newPlan,
    };
  }

  async reconcileTenantSubscriptions(): Promise<{ checked: number; updated: number; errors: string[] }> {
    const tenants = this.tenantRepo.listAll();
    let checked = 0;
    let updated = 0;
    const errors: string[] = [];

    for (const tenant of tenants) {
      if (!tenant.stripe_subscription_id) continue;
      checked++;

      try {
        if (CONFIG.stripeSecretKey.startsWith('sk_test_placeholder') || CONFIG.nodeEnv === 'test') {
          continue; // Skip external Stripe calls in offline test mode
        }

        const sub = await this.stripe.subscriptions.retrieve(tenant.stripe_subscription_id);
        let expectedStatus: TenantStatus = 'active';
        if (sub.status === 'past_due' || sub.status === 'unpaid') {
          expectedStatus = 'past_due';
        } else if (sub.status === 'canceled') {
          expectedStatus = 'canceled';
        }

        if (tenant.status !== expectedStatus) {
          this.tenantRepo.updateStatus(tenant.id, expectedStatus);
          updated++;
        }
      } catch (err: any) {
        errors.push(`Tenant ${tenant.id}: ${err.message}`);
      }
    }

    return { checked, updated, errors };
  }
}
