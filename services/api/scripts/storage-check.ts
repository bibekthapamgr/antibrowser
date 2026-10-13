/**
 * Checks the snapshot storage the API is configured for (OBJECT_STORE_*): creates the buckets when missing, then
 * writes, reads and deletes a probe object with the API's own credentials. Used by scripts/deploy/vps-setup.sh.
 * Usage: node --env-file=<api.env> scripts/storage-check.ts [another-bucket ...]
 */
import { randomBytes } from 'node:crypto';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { loadConfig } from '@pb/config/env';

const config = loadConfig();
const os = config.objectStore;
if (!os) throw new Error('OBJECT_STORE_BUCKET is not set');
const s3 = new S3Client({
  region: os.region,
  forcePathStyle: os.forcePathStyle,
  ...(os.endpoint ? { endpoint: os.endpoint } : {}),
  ...(os.accessKeyId && os.secretAccessKey
    ? { credentials: { accessKeyId: os.accessKeyId, secretAccessKey: os.secretAccessKey } }
    : {}),
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

for (const bucket of [os.bucket, ...process.argv.slice(2)]) {
  let exists = true;
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    exists = false;
  }
  if (!exists) {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    console.log(`created bucket ${bucket}`);
  }
  const key = `probe/${randomBytes(8).toString('hex')}`;
  const body = randomBytes(1024);
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
  const got = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const back = Buffer.from((await got.Body?.transformToByteArray()) ?? []);
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  if (!back.equals(body)) throw new Error(`bucket ${bucket}: the probe object came back different`);
  console.log(`bucket ${bucket}: write, read and delete ok`);
}
