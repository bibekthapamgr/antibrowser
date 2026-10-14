/**
 * R2 self-service onboarding (ADR-0021): the status a signed-in person sees and the one call that completes
 * onboarding. Browser-safe: no Node imports.
 *
 * Identity always comes from the verified sign-in (issuer + subject, verified e-mail); the body never names a
 * user, a role or an e-mail. A plan is an intent (an id from the catalog), never a price.
 */
import Type, { type Static, type TSchema } from 'typebox';
import { ID_PATTERN } from './ids.ts';
import { INVITATION_TOKEN_PATTERN, ROLES } from './resources.ts';
import { ONBOARDING_STATES } from './workspace.ts';

const Id = (prefix: Parameters<typeof ID_PATTERN>[0]) => Type.String({ pattern: ID_PATTERN(prefix) });
const Timestamp = Type.String({ format: 'date-time', description: 'UTC, RFC 3339' });
const Nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()]);
const PlanId = Type.String({ pattern: '^[a-z][a-z0-9_]{1,31}$' });
const TermsVersion = Type.String({ pattern: '^[A-Za-z0-9._-]{1,32}$' });

export const ONBOARDING_OUTCOMES = [
  /** Nothing to do: the default workspace is set and still reachable. */
  'existing',
  /** A personal workspace (owner, trial) was created. */
  'created',
  /** An invitation was accepted; its workspace is the default. */
  'joined',
  /** The person chose among their workspaces. */
  'chosen',
  /** An existing workspace was selected automatically (returning user). */
  'selected',
  /** Several owned workspaces: call again with `choose_org_id` (asked once). */
  'choice_required',
  /** Invitations for this verified address are waiting: accept one, or pass `create_own`. */
  'invitations_pending',
  /** The current terms must be accepted before a workspace is created. */
  'terms_required',
] as const;
export type OnboardingOutcome = (typeof ONBOARDING_OUTCOMES)[number];

export const OnboardingWorkspace = Type.Object(
  {
    org_id: Id('org'),
    name: Type.String(),
    role: Type.Enum(ROLES),
    suspended: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const OnboardingStatus = Type.Object(
  {
    state: Type.Enum(ONBOARDING_STATES),
    /** The workspace the apps open first (null until onboarding completes, or when it must be chosen). */
    default_org_id: Nullable(Id('org')),
    /** The personal workspace onboarding created, if any (at most one per person). */
    bootstrap_org_id: Nullable(Id('org')),
    /** Every workspace the person belongs to (the apps show a team switcher only when there is more than one). */
    workspaces: Type.Array(OnboardingWorkspace, { maxItems: 200 }),
    /** From the identity provider's verified claims at the last sign-in, never from the client. */
    email_verified: Type.Boolean(),
    terms: Type.Object(
      { current_version: TermsVersion, accepted_version: Nullable(TermsVersion) },
      { additionalProperties: false },
    ),
    marketing_consent: Type.Boolean(),
    plan_intent: Nullable(PlanId),
    /** Open invitations addressed to this verified e-mail. */
    pending_invitations: Type.Array(
      Type.Object(
        { org_name: Type.String(), role: Type.Enum(ROLES), expires_at: Timestamp },
        { additionalProperties: false },
      ),
      { maxItems: 20 },
    ),
    /** Whether a new workspace of this person would start a fresh trial (false: it shares the earlier trial clock). */
    trial_available: Type.Boolean(),
    /** E-mails still queued for this person's onboarding (welcome); retried by the worker. */
    pending_tasks: Type.Array(
      Type.Object(
        { kind: Type.Enum(['welcome']), state: Type.Enum(['pending', 'sent', 'failed', 'skipped']) },
        { additionalProperties: false },
      ),
    ),
    attempts: Type.Integer({ minimum: 0 }),
    last_error: Nullable(Type.String({ pattern: '^[A-Z0-9_]{1,64}$' })),
    completed_at: Nullable(Timestamp),
  },
  { additionalProperties: false },
);
export type OnboardingStatus = Static<typeof OnboardingStatus>;

export const OnboardingComplete = Type.Object(
  {
    /** Accept these terms (must be the current version). Recorded once per version. */
    accept_terms_version: Type.Optional(TermsVersion),
    /** Optional, separate from the terms; can be changed later. */
    marketing_consent: Type.Optional(Type.Boolean()),
    /** Name for a personal workspace, when one is created (default: "<name>'s workspace"). */
    workspace_name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    /** A plan chosen on the website (validated against the catalog; checkout continues later). */
    plan_intent: Type.Optional(Nullable(PlanId)),
    /** Accept this invitation first (invitations take priority over a personal workspace). */
    invitation_token: Type.Optional(Type.String({ pattern: INVITATION_TOKEN_PATTERN })),
    /** The workspace to open by default (must be one of the person's, not suspended). */
    choose_org_id: Type.Optional(Id('org')),
    /** Explicitly create an own workspace although the person already belongs to others or has invitations. */
    create_own: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type OnboardingComplete = Static<typeof OnboardingComplete>;

export const OnboardingResult = Type.Object(
  { outcome: Type.Enum(ONBOARDING_OUTCOMES), status: OnboardingStatus },
  { additionalProperties: false },
);
export type OnboardingResult = Static<typeof OnboardingResult>;

// ---------------------------------------------------------------- web portal session (backend-for-frontend)
export const WEB_SESSION_COOKIE = 'pb_web';
export const WEB_CSRF_HEADER = 'x-csrf-token';
export const WebSession = Type.Object(
  {
    user: Type.Object(
      {
        id: Id('usr'),
        display_name: Type.String(),
        email: Nullable(Type.String()),
        email_verified: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    /** Send it back in the x-csrf-token header with every change (POST, PUT, PATCH, DELETE). */
    csrf_token: Type.String({ pattern: '^[A-Za-z0-9_-]{43}$' }),
    expires_at: Timestamp,
  },
  { additionalProperties: false },
);
export type WebSession = Static<typeof WebSession>;
