/**
 * Milestone 11: the payment provider client's requests validated against Stripe's own OpenAPI description with
 * stripe-mock (github.com/stripe/stripe-mock), which refuses unknown or malformed parameters. Runs when STRIPE_MOCK_URL
 * is set (CI starts stripe-mock; locally: `stripe-mock -http-port 12111`, STRIPE_MOCK_URL=http://127.0.0.1:12111).
 * stripe-mock checks request shapes and returns fixture objects; it keeps no state, so behaviour is tested against the
 * fake in billing.test.ts and, with real test keys, in stripe-sandbox.test.ts.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { latestPlan, type PlanDefinition } from '@pb/contracts/billing';
import { describe, expect, it } from 'vitest';
import {
  ensurePortalConfiguration,
  lookupKey,
  minorUnits,
  productId,
  StripeSetupError,
  setupStripe,
  stripeCaller,
  writeEnvValues,
} from '../scripts/stripe-setup.ts';
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

describe.runIf(Boolean(base))('Stripe test-mode setup script against stripe-mock', () => {
  it('creates products, prices and the portal configuration with parameters Stripe accepts', async () => {
    const call = stripeCaller(key, base ?? '');
    const plan = latestPlan('team') as PlanDefinition;
    // stripe-mock answers every lookup with a fixture, so the create calls are exercised directly.
    const made = await call('POST', '/v1/products', {
      id: productId(plan),
      name: 'Project Browser Team',
      description: plan.description,
      metadata: { pb_plan: plan.id },
    });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    const price = await call('POST', '/v1/prices', {
      product: productId(plan),
      currency: 'usd',
      unit_amount: 4900,
      recurring: { interval: 'month' },
      lookup_key: lookupKey(plan, 'usd', 'month', 4900),
      metadata: { pb_plan: 'team@1' },
    });
    expect(price.status, JSON.stringify(price.body)).toBe(200);
    expect((await call('GET', '/v1/prices', { lookup_keys: ['x'], active: true, limit: 1 })).status).toBe(
      200,
    );
    const portal = await ensurePortalConfiguration(
      (m, p, params, k) =>
        // Never "found" in stripe-mock's fixture list, so the configuration is created.
        m === 'GET' ? Promise.resolve({ status: 200, body: { data: [] } }) : call(m, p, params, k),
      [{ product: 'prod_1Mock', price: 'price_1Mock' }],
    );
    expect(portal).toMatch(/^bpc_/);
    const session = await createStripe({ secretKey: key, apiBase: base ?? '' }).createPortalSession({
      customer: 'cus_1Mock',
      returnUrl: 'https://example.com/v1/billing/return',
      configuration: portal,
    });
    expect(session).toMatch(/^https:\/\//);
  });
});

describe('Stripe test-mode setup script', () => {
  it('turns amounts into minor units of the currency', () => {
    expect(minorUnits('49', 'usd')).toBe(4900);
    expect(minorUnits('49.5', 'usd')).toBe(4950);
    expect(minorUnits('1900', 'jpy')).toBe(1900);
    expect(() => minorUnits('49.999', 'usd')).toThrow(StripeSetupError);
    expect(() => minorUnits('0', 'usd')).toThrow(StripeSetupError);
    expect(() => minorUnits('-5', 'usd')).toThrow(StripeSetupError);
  });

  it('refuses live keys and plans that are not sold', async () => {
    const live = `sk_${'live'}_abcdefgh`;
    await expect(
      setupStripe({
        key: live,
        apiBase: 'http://127.0.0.1:1',
        currency: 'usd',
        interval: 'month',
        amounts: {},
      }),
    ).rejects.toThrow(/test-mode keys only/);
    await expect(
      setupStripe({
        key: `sk_${'test'}_abcdefgh`,
        apiBase: 'http://127.0.0.1:1',
        currency: 'usd',
        interval: 'month',
        amounts: { internal: 100 },
      }),
    ).rejects.toThrow(/not a purchasable plan/);
  });

  it('updates the settings file in place and keeps the rest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pb-billing-env-'));
    const file = join(dir, 'billing.env');
    writeFileSync(file, '# comment\nSTRIPE_SECRET_KEY=kept\n# STRIPE_PORTAL_CONFIGURATION=\n');
    writeEnvValues(file, {
      BILLING_STRIPE_PRICES: `'{"team@1":"price_1"}'`,
      STRIPE_PORTAL_CONFIGURATION: 'bpc_123456789',
    });
    expect(readFileSync(file, 'utf8')).toBe(
      `# comment\nSTRIPE_SECRET_KEY=kept\nSTRIPE_PORTAL_CONFIGURATION=bpc_123456789\nBILLING_STRIPE_PRICES='{"team@1":"price_1"}'\n`,
    );
    rmSync(dir, { recursive: true, force: true });
  });
});
