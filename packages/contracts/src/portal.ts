/**
 * R4 (ADR-0023): the public website and the customer portal. Browser-safe: no Node imports.
 *
 * - The public plan catalog is the server's configured catalog (packages/contracts billing.ts) with prices read from
 *   the payment provider. A plan whose price is not configured or cannot be verified is shown without a price and
 *   cannot start checkout; nothing is ever shown as free because a price is missing.
 * - Downloads come from the signed stable update channel only (milestone 12). Internal or test builds never appear;
 *   without a verified stable release the answer is "not yet available".
 */
import Type, { type Static, type TSchema } from 'typebox';
import { Features, Limits, PRICE_INTERVALS } from './billing.ts';

const Timestamp = Type.String({ format: 'date-time', description: 'UTC, RFC 3339' });
const Nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()]);

// ================================================================ public plans
export const TAX_DISPLAY = ['inclusive', 'exclusive', 'automatic', 'unspecified'] as const;
export const PublicPrice = Type.Object(
  {
    interval: Type.Enum(PRICE_INTERVALS),
    amount_minor: Type.Integer({ minimum: 0, description: 'In the currency’s smallest unit.' }),
    currency: Type.String({ pattern: '^[a-z]{3}$' }),
    /**
     * How tax relates to the amount: included, added on top, calculated at checkout from the address (`automatic`),
     * or not stated by the provider (`unspecified`: "plus any applicable tax").
     */
    tax: Type.Enum(TAX_DISPLAY),
    /** When this price was last read from the payment provider. */
    verified_at: Timestamp,
  },
  { additionalProperties: false },
);
export type PublicPrice = Static<typeof PublicPrice>;

export const PublicPlan = Type.Object(
  {
    id: Type.String({ pattern: '^[a-z][a-z0-9_]{1,31}$' }),
    version: Type.Integer({ minimum: 1 }),
    name: Type.String(),
    description: Type.String(),
    /** `null`: no limit. Seats count every member, the owner included. */
    limits: Limits,
    features: Features,
    /** Verified prices, one per configured interval (empty: the price could not be verified right now). */
    prices: Type.Array(PublicPrice, { maxItems: 2 }),
    /** Whether checkout can start for it now (a verified price and billing configured). */
    available: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type PublicPlan = Static<typeof PublicPlan>;

export const PublicPlans = Type.Object(
  {
    /** Changes whenever the catalog or a configured price changes (cache key for the website). */
    catalog_version: Type.String({ pattern: '^[0-9a-f]{16}$' }),
    generated_at: Timestamp,
    /** Days of the free trial every new workspace starts with (no payment details needed). */
    trial_days: Type.Integer({ minimum: 0 }),
    /** Whether checkout is set up on this server at all. */
    checkout: Type.Boolean(),
    items: Type.Array(PublicPlan, { maxItems: 20 }),
  },
  { additionalProperties: false },
);
export type PublicPlans = Static<typeof PublicPlans>;

// ================================================================ downloads
export const DOWNLOAD_PLATFORMS = ['windows-x64', 'macos-arm64'] as const;
export type DownloadPlatform = (typeof DOWNLOAD_PLATFORMS)[number];
export const PublicDownloads = Type.Object(
  {
    channel: Type.Literal('stable'),
    /** `available`: a verified stable release; `paused`: offering stopped by the publisher; else not yet available. */
    status: Type.Enum(['available', 'paused', 'not_available']),
    version: Nullable(Type.String()),
    published_at: Nullable(Timestamp),
    notes_url: Nullable(Type.String({ format: 'uri' })),
    platforms: Type.Array(
      Type.Object(
        {
          platform: Type.Enum(DOWNLOAD_PLATFORMS),
          label: Type.String(),
          /** `installer`: Windows setup; `disk-image`: macOS .dmg. */
          kind: Type.Enum(['installer', 'disk-image']),
          url: Type.String({ format: 'uri' }),
          sha256: Nullable(Type.String({ pattern: '^[0-9a-f]{64}$' })),
          size_bytes: Nullable(Type.Integer({ minimum: 1 })),
        },
        { additionalProperties: false },
      ),
      { maxItems: 4 },
    ),
    /** When the stable channel was last checked. */
    checked_at: Nullable(Timestamp),
  },
  { additionalProperties: false },
);
export type PublicDownloads = Static<typeof PublicDownloads>;

// ================================================================ contact
export const CONTACT_TOPICS = ['sales', 'support', 'billing', 'security', 'privacy', 'other'] as const;
export const ContactRequest = Type.Object(
  {
    topic: Type.Enum(CONTACT_TOPICS),
    name: Type.String({ minLength: 1, maxLength: 120 }),
    email: Type.String({ minLength: 3, maxLength: 254, format: 'email' }),
    message: Type.String({ minLength: 10, maxLength: 4000 }),
    /** Left empty by people; filled by simple bots (the request is then accepted and dropped). */
    website: Type.Optional(Type.String({ maxLength: 200 })),
  },
  { additionalProperties: false },
);
export type ContactRequest = Static<typeof ContactRequest>;

// ================================================================ account
export const NotificationSettings = Type.Object(
  {
    /** Product news (optional, opt-in, one-click unsubscribe in every such e-mail). */
    marketing: Type.Boolean(),
    /** Trial-ending and renewal reminders for workspaces this person pays for. */
    billing_reminders: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type NotificationSettings = Static<typeof NotificationSettings>;
export const NotificationSettingsUpdate = Type.Partial(NotificationSettings, { additionalProperties: false });

export const DeletionStatus = Type.Object(
  {
    /** The newest request, if any. Staff process requests (R5); the policy is shown before asking. */
    request: Nullable(
      Type.Object(
        {
          state: Type.Enum(['pending', 'withdrawn', 'completed', 'rejected']),
          created_at: Timestamp,
          decided_at: Nullable(Timestamp),
        },
        { additionalProperties: false },
      ),
    ),
    /** Workspaces this person is the only owner of: ownership must move, or the workspace close, first. */
    sole_owner_of: Type.Array(
      Type.Object({ org_id: Type.String(), name: Type.String() }, { additionalProperties: false }),
    ),
  },
  { additionalProperties: false },
);
export type DeletionStatus = Static<typeof DeletionStatus>;
export const DeletionRequestCreate = Type.Object(
  {
    /** Must be true: the person read the policy shown before asking. */
    confirm: Type.Literal(true),
    note: Type.Optional(Type.String({ maxLength: 1000 })),
  },
  { additionalProperties: false },
);
