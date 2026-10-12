import { ErrorBody, ID_PATTERN, type Profile } from '@pb/contracts';
import Type, { type Static } from 'typebox';
import { ts } from '../db.ts';

/** Every route declares error responses so the serializer can never emit unexpected fields. */
export const errors = { '4xx': ErrorBody, '5xx': ErrorBody } as const;

export const OrgParams = Type.Object(
  { orgId: Type.String({ pattern: ID_PATTERN('org') }) },
  { additionalProperties: false },
);
export const ProfileParams = Type.Object(
  {
    orgId: Type.String({ pattern: ID_PATTERN('org') }),
    profileId: Type.String({ pattern: ID_PATTERN('prf') }),
  },
  { additionalProperties: false },
);

export const PROFILE_COLUMNS = `id, org_id, name, client_label, folder_label, notes, version,
  ${ts('created_at')} as created_at, ${ts('updated_at')} as updated_at`;

export type ProfileRow = Static<typeof Profile>;

export const LEASE_COLUMNS = `profile_id, holder_device_id, holder_user_id, fencing_token::text as fencing_token,
  ${ts('acquired_at')} as acquired_at, ${ts('expires_at')} as expires_at`;
