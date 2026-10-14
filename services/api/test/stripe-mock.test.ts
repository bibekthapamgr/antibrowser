/**
 * Milestone 11: the payment provider client's requests validated against Stripe's own OpenAPI description with
 * stripe-mock (github.com/stripe/stripe-mock), which refuses unknown or malformed parameters. Runs when STRIPE_MOCK_URL
 * is set (CI starts stripe-mock; locally: `stripe-mock -http-port 12111`, STRIPE_MOCK_URL=http://127.0.0.1:12111).
 * stripe-mock checks request shapes and returns fixture objects; it keeps no state, so behaviour is tested against the
 * fake in billing.test.ts and, with real test keys, in stripe-sandbox.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { createStripe, formEncode, StripeError } from '../src/billing/stripe.ts';

const base = process.env.STRIPE_MOCK_URL;
const key = `sk_${'test'}_mockmockmock`;

describe.runIf(Boolean(base))('Stripe client against stripe-mock', () => {
  const stripe = createStripe({ secretKey: key, apiBase: base ?? '' });

  it('creates customers, checkout and portal sessions with parameters Stripe accepts', async () => {
    const customer = await stripe.createCustomer(
      { orgId: 'org_01J9ZSEEDACME000000000000', name: 'Acme', email: 'owner@acme.test' },
      'pb-customer-mock',
    );
    expect(customer).toMatch(/^cus_/);
    for (const automaticTax of [false, true]) {
      const session = await stripe.createCheckoutSession(
        {
          customer,
          price: 'price_1MockPrice',
          orgId: 'org_01J9ZSEEDACME000000000000',
          successUrl: 'https://example.com/v1/billing/return?result=success',
          cancelUrl: 'https://example.com/v1/billing/return?result=canceled',
          automaticTax,
        },
        `pb-checkout-mock-${automaticTax}`,
      );
      expect(session.id).toMatch(/^cs_/);
    }
    const portal = await stripe.createPortalSession({
      customer,
      returnUrl: 'https://example.com/v1/billing/return',
    });
    expect(portal).toMatch(/^https:\/\//);
  });

  it('reads subscriptions, sessions, invoices, prices, charges and disputes into the reduced shapes', async () => {
    const sub = await stripe.getSubscription('sub_1Mock');
    expect(sub).toMatchObject({ id: expect.stringMatching(/^sub_/), status: expect.any(String) });
    expect(typeof sub.created).toBe('number');
    expect((await stripe.listSubscriptions('cus_1Mock')).every((s) => s.id.startsWith('sub_'))).toBe(true);
    expect((await stripe.getCheckoutSession('cs_test_1Mock')).id).toMatch(/^cs_/);
    const inv = await stripe.getInvoice('in_1Mock');
    expect(inv.id).toMatch(/^in_/);
    expect((await stripe.listInvoices('cus_1Mock', 24)).every((i) => i.id.startsWith('in_'))).toBe(true);
    expect((await stripe.getPrice('price_1Mock')).id).toMatch(/^price_/);
    await stripe.customerOfCharge('ch_1Mock');
    await stripe.customerOfDispute('dp_1Mock');
  });

  it('reports refused requests as provider errors (not retried)', async () => {
    const err = await stripe.getSubscription('').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StripeError);
    expect((err as StripeError).transient).toBe(false);
  });
});

describe('form encoding', () => {
  it('uses Stripe’s bracket notation and leaves out nulls', () => {
    expect(
      formEncode({
        a: 'x y',
        metadata: { org_id: 'org_1' },
        line_items: [{ price: 'p', quantity: 1 }],
        skip: null,
      }),
    ).toBe(
      'a=x%20y&metadata%5Borg_id%5D=org_1&line_items%5B0%5D%5Bprice%5D=p&line_items%5B0%5D%5Bquantity%5D=1',
    );
  });
});
