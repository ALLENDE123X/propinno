/**
 * Recurring-subscription billing lifecycle (2026-08-02).
 *
 * Propinno originally sold two ONE-TIME passes ($39/30-day, $69/90-day) — a
 * fixed access window that simply expired, with no renewal and nothing to
 * cancel. It now sells auto-renewing subscriptions ($9/month, $19/quarter),
 * which means three things the one-time model never needed and which are only
 * correct together:
 *
 *   1. Checkout runs in `mode: 'subscription'` and persists the resulting
 *      Stripe customer + subscription ids onto the user row.
 *   2. Renewal charges must EXTEND access (`invoice.payment_succeeded` with
 *      `billing_reason === 'subscription_cycle'`), and subscription death must
 *      REMOVE it (`customer.subscription.deleted`).
 *   3. "I found a place (Stop texts)" must actually cancel the Stripe
 *      subscription. Under the old model that button only had to stop texts;
 *      under this one, not calling Stripe means silently charging someone every
 *      period after they told the product they no longer want it.
 *
 * This module owns all three so the webhook route and the checkout server
 * actions share one implementation (and so the lifecycle is unit-testable
 * without standing up a route handler).
 *
 * API-VERSION NOTE (`2026-05-27.dahlia`, see lib/stripe.ts): the Invoice object
 * on this version has NO top-level `subscription` field — it moved to
 * `invoice.parent.subscription_details.subscription`. Likewise Subscription has
 * no top-level `current_period_end`; it lives on the subscription ITEM
 * (`subscription.items.data[0].current_period_end`). Both were verified against
 * the installed `stripe@22` type definitions rather than assumed from older
 * Stripe docs — if the pinned apiVersion is ever bumped, re-verify both.
 */

import Stripe from 'stripe'
import { eq } from 'drizzle-orm'
import * as Sentry from '@sentry/nextjs'
import { db } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { stripe } from '@/lib/stripe'
import { logger } from '@/lib/logger'

export type Plan = 'pass_30' | 'pass_90'

/**
 * Billing-period length per plan, used ONLY as a fallback when Stripe's own
 * authoritative period end can't be read. Stripe's value is preferred
 * everywhere because it is absolute (idempotent under duplicate webhook
 * delivery) and already accounts for real month lengths.
 */
export const PLAN_DAYS: Record<Plan, number> = { pass_30: 30, pass_90: 90 }

export function planDays(plan: Plan | null | undefined): number {
  return plan === 'pass_90' ? PLAN_DAYS.pass_90 : PLAN_DAYS.pass_30
}

function addDays(from: Date, days: number): Date {
  const next = new Date(from.getTime())
  next.setDate(next.getDate() + days)
  return next
}

/** Unwrap a Stripe `string | ExpandedObject | null` field down to a plain id. */
function toId(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null
  return typeof value === 'string' ? value : value.id
}

function stripeErrorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}

/**
 * The subscription id that generated an invoice. See the API-VERSION NOTE
 * above — `invoice.subscription` does not exist on this Stripe version.
 */
export function subscriptionIdFromInvoice(invoice: Stripe.Invoice): string | null {
  return toId(invoice.parent?.subscription_details?.subscription ?? null)
}

/**
 * Stripe's authoritative end of the current paid period, as a Date.
 * Returns null (rather than throwing) if Stripe is unreachable or the shape is
 * unexpected — callers fall back to plan-length arithmetic, so a transient
 * Stripe blip degrades the precision of the expiry date instead of failing the
 * whole webhook and leaving a paying user without access.
 */
export async function subscriptionPeriodEnd(subscriptionId: string): Promise<Date | null> {
  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId)
    const periodEnd = subscription.items?.data?.[0]?.current_period_end
    if (typeof periodEnd === 'number' && Number.isFinite(periodEnd)) {
      return new Date(periodEnd * 1000)
    }
    return null
  } catch (err) {
    logger.error({ err, subscriptionId, action: 'stripe_subscription_period_end_failed' })
    return null
  }
}

/**
 * Cancel a Stripe subscription IMMEDIATELY (not at period end) so no further
 * charge is ever attempted. Idempotent: a subscription that is already gone or
 * already canceled resolves successfully rather than throwing, so a user who
 * double-clicks "I found a place" doesn't get an error.
 *
 * Anything else genuinely rethrows — callers MUST NOT record "canceled" state
 * on a failure, because the subscription would still be live and billing.
 */
export async function cancelStripeSubscription(subscriptionId: string): Promise<void> {
  try {
    await stripe.subscriptions.cancel(subscriptionId)
    return
  } catch (err) {
    if (stripeErrorCode(err) === 'resource_missing') return
    // Stripe rejects cancelling an already-canceled subscription. Confirm that
    // is what happened before swallowing the error — never assume it.
    try {
      const existing = await stripe.subscriptions.retrieve(subscriptionId)
      if (existing.status === 'canceled') return
    } catch {
      // fall through and rethrow the original cancel error
    }
    throw err
  }
}

type BillingUser = {
  id: string
  status: 'pending_payment' | 'active' | 'expired' | 'done'
  plan: Plan | null
  accessExpiresAt: Date | null
  stripeSubscriptionId: string | null
}

const billingUserColumns = {
  id: users.id,
  status: users.status,
  plan: users.plan,
  accessExpiresAt: users.accessExpiresAt,
  stripeSubscriptionId: users.stripeSubscriptionId,
}

/**
 * Resolve the user a Stripe event belongs to. Subscription id first (exact),
 * customer id second — the customer is the durable identifier that survives a
 * subscription being replaced, so it rescues events that arrive after we've
 * already nulled out a subscription id.
 */
async function findUserForSubscription(
  subscriptionId: string | null,
  customerId: string | null
): Promise<BillingUser | null> {
  if (subscriptionId) {
    const [bySubscription] = await db.select(billingUserColumns).from(users)
      .where(eq(users.stripeSubscriptionId, subscriptionId)).limit(1)
    if (bySubscription) return bySubscription as BillingUser
  }
  if (customerId) {
    const [byCustomer] = await db.select(billingUserColumns).from(users)
      .where(eq(users.stripeCustomerId, customerId)).limit(1)
    if (byCustomer) return byCustomer as BillingUser
  }
  return null
}

/**
 * Initial activation. Stores the Stripe customer + subscription ids alongside
 * the status/plan/expiry the one-time model already set — without those ids
 * there is no way to later cancel this specific user's subscription.
 *
 * Deliberately activates without gating on `payment_status`/subscription
 * status. If a card fails on the very first charge, Stripe creates the
 * subscription as `incomplete` and this event still fires — so the user gets
 * access before a successful payment, for at most the ~23 hours Stripe waits
 * before cancelling an incomplete subscription, at which point
 * `customer.subscription.deleted` revokes it here. That bounded, self-healing
 * exposure is the better trade: gating activation on payment status instead
 * would strand a genuinely paying customer with no access, because the invoice
 * that eventually settles carries `billing_reason: 'subscription_create'`,
 * which the renewal handler correctly ignores.
 */
async function handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
  const userId = session.client_reference_id
  if (!userId) {
    logger.error({ sessionId: session.id, action: 'stripe_checkout_completed_no_user_ref' })
    return
  }

  const plan = (session.metadata?.plan as Plan | undefined) ?? 'pass_30'
  const subscriptionId = toId(session.subscription)
  const customerId = toId(session.customer)

  const periodEnd = subscriptionId ? await subscriptionPeriodEnd(subscriptionId) : null
  const accessExpiresAt = periodEnd ?? addDays(new Date(), planDays(plan))

  await db.update(users).set({
    status: 'active',
    plan,
    accessExpiresAt,
    ...(customerId ? { stripeCustomerId: customerId } : {}),
    ...(subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
  }).where(eq(users.id, userId))

  logger.info({ userId, plan, subscriptionId, customerId, action: 'stripe_checkout_completed' })
}

/**
 * Renewal. Only `subscription_cycle` invoices reach the extension logic:
 * `subscription_create` is the very first invoice of a brand-new subscription
 * and is already fully handled by checkout.session.completed — extending on
 * both would hand out a free extra period on every signup.
 */
async function handleInvoicePaymentSucceeded(invoice: Stripe.Invoice): Promise<void> {
  if (invoice.billing_reason !== 'subscription_cycle') {
    logger.info({
      invoiceId: invoice.id,
      billingReason: invoice.billing_reason,
      action: 'stripe_invoice_not_a_renewal_cycle',
    })
    return
  }

  const subscriptionId = subscriptionIdFromInvoice(invoice)
  const customerId = toId(invoice.customer)
  const user = await findUserForSubscription(subscriptionId, customerId)

  if (!user) {
    logger.error({ invoiceId: invoice.id, subscriptionId, customerId, action: 'stripe_renewal_user_not_found' })
    return
  }

  // Safety net for the worst failure this model can produce: a user who told us
  // they found a place is still being charged. That can only mean a cancel
  // leaked, so stop the bleeding immediately and page us — never silently
  // reactivate them.
  if (user.status === 'done') {
    logger.error({ userId: user.id, subscriptionId, action: 'stripe_renewal_charged_done_user' })
    Sentry.captureMessage('Stripe renewal charged a user who already marked "found a place"', {
      level: 'error',
      extra: { userId: user.id, subscriptionId, invoiceId: invoice.id },
    })
    if (subscriptionId) await cancelStripeSubscription(subscriptionId)
    await db.update(users).set({ stripeSubscriptionId: null }).where(eq(users.id, user.id))
    return
  }

  const periodEnd = subscriptionId ? await subscriptionPeriodEnd(subscriptionId) : null
  // Stripe's absolute period end is idempotent under duplicate webhook delivery.
  // The fallback extends from whichever is later — the existing expiry or now —
  // so a late webhook can never shorten access and an early one never leaves a gap.
  const now = new Date()
  const extendFrom = user.accessExpiresAt && user.accessExpiresAt > now ? user.accessExpiresAt : now
  const accessExpiresAt = periodEnd ?? addDays(extendFrom, planDays(user.plan))

  await db.update(users).set({
    status: 'active',
    accessExpiresAt,
    ...(subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
  }).where(eq(users.id, user.id))

  logger.info({
    userId: user.id,
    subscriptionId,
    accessExpiresAt: accessExpiresAt.toISOString(),
    action: 'stripe_subscription_renewed',
  })
}

/**
 * Subscription is gone — whether the user cancelled it themselves, we cancelled
 * it for them, or Stripe gave up after repeated payment failures. Access ends.
 *
 * The one status that is NEVER overwritten is 'done': markFoundPlace() cancels
 * the subscription itself, and Stripe's resulting deleted event must not stomp
 * that terminal "congratulations, you found a place" state back to 'expired'.
 */
async function handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
  const customerId = toId(subscription.customer)
  const user = await findUserForSubscription(subscription.id, customerId)

  if (!user) {
    logger.error({ subscriptionId: subscription.id, customerId, action: 'stripe_deleted_sub_user_not_found' })
    return
  }

  const status = user.status === 'done' ? 'done' : 'expired'

  await db.update(users).set({
    status,
    stripeSubscriptionId: null,
  }).where(eq(users.id, user.id))

  logger.info({ userId: user.id, subscriptionId: subscription.id, status, action: 'stripe_subscription_deleted' })
}

/**
 * Webhook fan-out. The live Stripe endpoint must be subscribed to exactly these
 * three event types (see ARCHITECTURE.md §9 — create/modify endpoints via the
 * API, not the dashboard UI, on this account).
 *
 * `invoice.paid` is deliberately NOT also handled: it fires for the same
 * renewal as `invoice.payment_succeeded`, and subscribing to both would just
 * double-process every cycle.
 */
export async function handleStripeWebhookEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session)
      return
    case 'invoice.payment_succeeded':
      await handleInvoicePaymentSucceeded(event.data.object as Stripe.Invoice)
      return
    case 'customer.subscription.deleted':
      await handleSubscriptionDeleted(event.data.object as Stripe.Subscription)
      return
    default:
      logger.info({ eventType: event.type, action: 'stripe_webhook_event_ignored' })
  }
}
