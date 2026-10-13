/**
 * Private S3-compatible object storage for encrypted snapshots (milestone 07). The bucket only ever receives
 * ciphertext. Devices never get storage credentials: they get short-lived signed URLs for exactly one upload part or
 * one object, issued after authorization (see routes/snapshots.ts).
 */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { AppConfig } from '@pb/config/env';
import { ApiError } from '@pb/contracts';

export interface UploadedPart {
  part_number: number;
  size: number;
  etag: string;
}

export interface StoredObject {
  key: string;
  lastModified: Date;
}

export interface ObjectStore {
  createUpload(key: string): Promise<string>;
  partUrl(key: string, uploadId: string, partNumber: number, ttlSeconds: number): Promise<string>;
  listParts(key: string, uploadId: string): Promise<UploadedPart[]>;
  completeUpload(
    key: string,
    uploadId: string,
    parts: { part_number: number; etag: string }[],
  ): Promise<void>;
  /** Idempotent: an upload that no longer exists is fine. */
  abortUpload(key: string, uploadId: string): Promise<void>;
  head(key: string): Promise<{ size: number } | null>;
  read(key: string): Promise<Readable>;
  readRange(key: string, start: number, endInclusive: number): Promise<Buffer>;
  downloadUrl(key: string, ttlSeconds: number): Promise<string>;
  /** Idempotent: a missing object is fine. */
  remove(key: string): Promise<void>;
  list(prefix: string, after: string | null): Promise<{ objects: StoredObject[]; next: string | null }>;
}

/** ETags are compared without quotes (S3 returns them quoted). */
export const normalizeEtag = (etag: string): string => etag.replace(/^W\//, '').replace(/^"|"$/g, '');

function unavailable(err: unknown): never {
  if (err instanceof ApiError) throw err;
  throw new ApiError('STORAGE_UNAVAILABLE', 'Snapshot storage is unavailable; try again later');
}

const isMissing = (err: unknown) => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.name === 'NoSuchKey' ||
    e?.name === 'NotFound' ||
    e?.name === 'NoSuchUpload' ||
    e?.$metadata?.httpStatusCode === 404
  );
};

export function s3ObjectStore(cfg: NonNullable<AppConfig['objectStore']>): ObjectStore {
  const base = {
    region: cfg.region,
    forcePathStyle: cfg.forcePathStyle,
    ...(cfg.accessKeyId && cfg.secretAccessKey
      ? { credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } }
      : {}),
    // Integrity is checked end to end (SHA-256 of the sealed file, verified by the worker); request checksums are
    // only sent where the operation requires them, so signed part URLs work with any S3-compatible store.
    requestChecksumCalculation: 'WHEN_REQUIRED' as const,
    responseChecksumValidation: 'WHEN_REQUIRED' as const,
  };
  const internal = new S3Client({ ...base, ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}) });
  const publicClient = new S3Client({
    ...base,
    ...(cfg.publicEndpoint ? { endpoint: cfg.publicEndpoint } : {}),
  });
  const Bucket = cfg.bucket;

  return {
    async createUpload(key) {
      try {
        const res = await internal.send(
          new CreateMultipartUploadCommand({ Bucket, Key: key, ContentType: 'application/octet-stream' }),
        );
        if (!res.UploadId) throw new Error('no upload id');
        return res.UploadId;
      } catch (err) {
        unavailable(err);
      }
    },
    async partUrl(key, uploadId, partNumber, ttlSeconds) {
      return getSignedUrl(
        publicClient,
        new UploadPartCommand({ Bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
        { expiresIn: ttlSeconds },
      );
    },
    async listParts(key, uploadId) {
      const out: UploadedPart[] = [];
      let marker: string | undefined;
      try {
        for (;;) {
          const res = await internal.send(
            new ListPartsCommand({ Bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker }),
          );
          for (const p of res.Parts ?? []) {
            if (p.PartNumber && p.ETag) {
              out.push({ part_number: p.PartNumber, size: Number(p.Size ?? 0), etag: normalizeEtag(p.ETag) });
            }
          }
          if (!res.IsTruncated || !res.NextPartNumberMarker) break;
          marker = String(res.NextPartNumberMarker);
        }
      } catch (err) {
        if (isMissing(err)) return [];
        unavailable(err);
      }
      return out.sort((a, b) => a.part_number - b.part_number);
    },
    async completeUpload(key, uploadId, parts) {
      try {
        await internal.send(
          new CompleteMultipartUploadCommand({
            Bucket,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: {
              Parts: parts.map((p) => ({ PartNumber: p.part_number, ETag: `"${normalizeEtag(p.etag)}"` })),
            },
          }),
        );
      } catch (err) {
        if (isMissing(err) || (err as { name?: string }).name === 'InvalidPart') {
          throw new ApiError('UPLOAD_INCOMPLETE', 'The uploaded parts do not match');
        }
        unavailable(err);
      }
    },
    async abortUpload(key, uploadId) {
      try {
        await internal.send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId }));
      } catch (err) {
        if (!isMissing(err)) unavailable(err);
      }
    },
    async head(key) {
      try {
        const res = await internal.send(new HeadObjectCommand({ Bucket, Key: key }));
        return { size: Number(res.ContentLength ?? 0) };
      } catch (err) {
        if (isMissing(err)) return null;
        unavailable(err);
      }
    },
    async read(key) {
      try {
        const res = await internal.send(new GetObjectCommand({ Bucket, Key: key }));
        if (!(res.Body instanceof Readable)) throw new Error('no body');
        return res.Body;
      } catch (err) {
        unavailable(err);
      }
    },
    async readRange(key, start, endInclusive) {
      try {
        const res = await internal.send(
          new GetObjectCommand({ Bucket, Key: key, Range: `bytes=${start}-${endInclusive}` }),
        );
        if (!res.Body) throw new Error('no body');
        return Buffer.from(await res.Body.transformToByteArray());
      } catch (err) {
        unavailable(err);
      }
    },
    async downloadUrl(key, ttlSeconds) {
      return getSignedUrl(publicClient, new GetObjectCommand({ Bucket, Key: key }), {
        expiresIn: ttlSeconds,
      });
    },
    async remove(key) {
      try {
        await internal.send(new DeleteObjectCommand({ Bucket, Key: key }));
      } catch (err) {
        if (!isMissing(err)) unavailable(err);
      }
    },
    async list(prefix, after) {
      try {
        const res = await internal.send(
          new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken: after ?? undefined }),
        );
        return {
          objects: (res.Contents ?? []).flatMap((o) =>
            o.Key ? [{ key: o.Key, lastModified: o.LastModified ?? new Date(0) }] : [],
          ),
          next: res.IsTruncated ? (res.NextContinuationToken ?? null) : null,
        };
      } catch (err) {
        unavailable(err);
      }
    },
  };
}

/**
 * In-memory store for tests: behaves like S3 for the operations above; signed URLs are opaque `memory://` strings
 * that tests "use" through putPart/putObject. Exposes the bytes so tests can tamper with stored objects.
 */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, { bytes: Buffer; lastModified: Date }>();
  readonly uploads = new Map<string, { key: string; parts: Map<number, Buffer> }>();
  failNext: string | null = null;
  private seq = 0;

  private maybeFail(op: string) {
    if (this.failNext === op) {
      this.failNext = null;
      throw new ApiError('STORAGE_UNAVAILABLE', 'Snapshot storage is unavailable; try again later');
    }
  }
  static etag(bytes: Buffer): string {
    return createHash('md5').update(bytes).digest('hex');
  }
  /** What a device does with a part URL. */
  putPart(uploadId: string, partNumber: number, bytes: Buffer): string {
    const u = this.uploads.get(uploadId);
    if (!u) throw new Error('no such upload');
    u.parts.set(partNumber, bytes);
    return MemoryObjectStore.etag(bytes);
  }
  async createUpload(key: string) {
    this.maybeFail('createUpload');
    const id = `upload-${++this.seq}`;
    this.uploads.set(id, { key, parts: new Map() });
    return id;
  }
  async partUrl(key: string, uploadId: string, partNumber: number, ttlSeconds: number) {
    return `memory://${encodeURIComponent(key)}?upload=${uploadId}&part=${partNumber}&ttl=${ttlSeconds}`;
  }
  async listParts(_key: string, uploadId: string) {
    const u = this.uploads.get(uploadId);
    if (!u) return [];
    return [...u.parts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([n, b]) => ({ part_number: n, size: b.length, etag: MemoryObjectStore.etag(b) }));
  }
  async completeUpload(key: string, uploadId: string, parts: { part_number: number; etag: string }[]) {
    this.maybeFail('completeUpload');
    const u = this.uploads.get(uploadId);
    if (!u || u.key !== key) throw new ApiError('UPLOAD_INCOMPLETE', 'The uploaded parts do not match');
    const chunks: Buffer[] = [];
    for (const p of parts) {
      const b = u.parts.get(p.part_number);
      if (!b || MemoryObjectStore.etag(b) !== normalizeEtag(p.etag)) {
        throw new ApiError('UPLOAD_INCOMPLETE', 'The uploaded parts do not match');
      }
      chunks.push(b);
    }
    this.objects.set(key, { bytes: Buffer.concat(chunks), lastModified: new Date() });
    this.uploads.delete(uploadId);
  }
  async abortUpload(_key: string, uploadId: string) {
    this.uploads.delete(uploadId);
  }
  async head(key: string) {
    this.maybeFail('head');
    const o = this.objects.get(key);
    return o ? { size: o.bytes.length } : null;
  }
  async read(key: string) {
    this.maybeFail('read');
    const o = this.objects.get(key);
    if (!o) throw new ApiError('STORAGE_UNAVAILABLE', 'missing');
    return Readable.from([o.bytes]);
  }
  async readRange(key: string, start: number, endInclusive: number) {
    const o = this.objects.get(key);
    if (!o) throw new ApiError('STORAGE_UNAVAILABLE', 'missing');
    return o.bytes.subarray(start, endInclusive + 1);
  }
  async downloadUrl(key: string, ttlSeconds: number) {
    return `memory://${encodeURIComponent(key)}?get&ttl=${ttlSeconds}`;
  }
  async remove(key: string) {
    this.objects.delete(key);
  }
  async list(prefix: string, _after: string | null) {
    return {
      objects: [...this.objects.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, o]) => ({ key, lastModified: o.lastModified })),
      next: null,
    };
  }
}
