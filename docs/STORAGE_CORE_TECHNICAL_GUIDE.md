# Storage Core technical guide

`@sentinel/storage-core` is a shared TypeScript I/O library used by an ingestion service such as `poll-orchestrator`. It does not start an HTTP server, run a poll loop, or own credential storage. The caller supplies source credentials and the process supplies landing/Kafka configuration through environment variables.

## Responsibilities and boundaries

The library has three public operations:

| Operation | Purpose |
| --- | --- |
| `listNewFiles(input)` | Select a source reader and return normalized file descriptors. |
| `readFromSource(input)` | Select a source reader and return a Node.js `Readable`. |
| `writeToLanding(stream, input)` | Select a landing writer, stream the file to storage, and publish an ingestion event. |

The package does not delete or move source files, persist polling cursors, retry failed source scans, or persist Kafka events. Cursor updates and orchestration belong to the caller.

## Repository structure

```text
src/
├── index.ts                 Public exports
├── types.ts                 Reader, writer, descriptor, and event contracts
├── reader.ts                Source-provider dispatcher
├── writer.ts                Landing-provider dispatcher and event creation
├── kafka-client.ts          Cached Kafka producer for ingestion-events
└── drivers/
    ├── reader/              FTP, SFTP, object-store, and email readers
    │   └── email-utils/     IMAP parsing, filtering, naming, and PDF helpers
    └── writer/              MinIO and S3 writers; GCP/Azure placeholders
```

The package is compiled from `src` to `dist` with TypeScript declarations and source maps. `src/index.ts` is the supported import surface; driver files are implementation details.

## Public API

```ts
import {
  listNewFiles,
  readFromSource,
  writeToLanding,
  type ReadInput,
  type WriteInput,
} from '@sentinel/storage-core'
```

### `listNewFiles`

```ts
const files = await listNewFiles({
  orgId: 'org-123',
  fileName: '',
  mimeType: '',
  fileSizeBytes: 0,
  sourceChannel: 'FTP_INGESTION',
  sourceCredentials: { provider: 'FTP', /* provider fields */ },
})
```

The dispatcher reads `sourceCredentials.provider`, trims it, uppercases it, and selects one of `FTP`, `SFTP`, `MINIO`, `EMAIL`, `S3`, `GCP`, or `AZURE`. Missing or unsupported providers fail immediately.

The returned `FileDescriptor` contains `orgId`, `insuranceCompanyCode`, `claimFolder`, `fileName`, `filePath`, `fileSizeBytes`, and a MIME type. MIME detection is intentionally minimal: `.pdf` becomes `application/pdf`; every other file becomes `application/octet-stream` (except email attachments, which retain their MIME type).

### `readFromSource`

```ts
const stream = await readFromSource({
  ...readInput,
  filePath: descriptor.filePath,
})
```

For FTP and SFTP, the returned stream owns an active download and closes the client when it finishes or errors. Object-store readers return the provider stream directly. The caller must consume or destroy the stream and handle stream errors.

Email is the exception: `EMAIL` downloads content while listing, because IMAP access requires the mailbox lock. Do not call `readFromSource` for an email descriptor. Use:

```ts
import { Readable } from 'node:stream'

const stream = Readable.from(descriptor.emailMeta!.bufferedContent)
```

### `writeToLanding`

The landing provider is selected from `STORAGE_PROVIDER`; the default is `S3`. The object key is generated as:

```text
{orgId}/{insuranceCompanyCode}/{YYYY-MM-DD}/{sourceChannel-without-_ingestion}/{contextFolder}/{fileName}
```

The date is generated at upload time using `new Date().toISOString()` (UTC). `sourceChannel` is lowercased and a trailing `_ingestion` substring is removed. The writer sets the uploaded object's content type to `input.mimeType`.

After a successful upload, the library publishes a metadata-only Kafka message. If Kafka publishing fails, the upload is retained, the error is logged, and `writeToLanding` still returns the upload result. Storage upload failures are propagated.

## Source readers

All source credentials are passed as the raw `sourceCredentials` object. Every reader requires `insuranceCompanyCode` (or the legacy alias `insurance_company_code`) for descriptor construction.

| Provider | Required credential fields | Listing behavior |
| --- | --- | --- |
| FTP | `host`, `user`, `password`, `insuranceCompanyCode` | Connects to `bucket` or `/`, optionally enters `source_prefix`, and recursively scans only today’s date folder. Default port is `21`. |
| SFTP | `host`, `user`, `password`, `insuranceCompanyCode` | Connects to `source_prefix`, or `${cwd}/${bucket}`, or the current directory. Recursively scans only today’s date folder. Default port is `22`. |
| MINIO | `endpoint`, `access_key`, `secret_key`, `bucket`, `insuranceCompanyCode` | Recursively lists the entire bucket and interprets keys with at least six path segments. |
| S3 | `access_key`, `secret_key`, `region`, `bucket`, `insuranceCompanyCode` | Lists only prefixes for today in `DD-MM-YY` and `DD-MM-YYYY` forms. Optional `endpoint` supports S3-compatible services. |
| GCP | `project_id`, `bucket_name`, `google_application_credentials`, `insuranceCompanyCode` | Lists the entire bucket, optionally filters by `source_prefix`, and accepts credentials as an object or JSON string. |
| AZURE | `account_name`, `account_key`, `container`, `insuranceCompanyCode` | Lists the container and filters to today’s `DD-MM-YY` or `DD-MM-YYYY` first-level folder. Optional `endpoint` overrides the default Azure Blob endpoint. |
| EMAIL | IMAP email/password/host/port plus `insuranceCompanyCode` | Polls the configured mailbox, filters messages by claim keywords, generates a transcript PDF, and buffers supported attachments. |

For FTP, SFTP, S3, GCP, and Azure, a date folder is recognized in either `DD-MM-YY` or `DD-MM-YYYY` format. The object-store implementations differ: S3 and Azure actively restrict listing to today, while GCP and MinIO do not apply the date filter. FTP/SFTP skip older date directories only at their source root.

Common optional source fields include `source_prefix` for FTP/SFTP/S3/GCP/Azure and `bucket` for FTP/SFTP. Source prefixes are provider-specific paths and should not be assumed to include or omit a leading slash without checking the provider convention.

## Email reader behavior

The email reader uses IMAP over TLS and defaults to mailbox `INBOX` (`IMAP_POLL_MAILBOX` can override it). It reads a cursor from credentials:

- `lastProcessedUid` or `last_processed_uid`, default `0`.
- `lastUidValidity`, used to detect an IMAP UID-space reset.

Messages are processed newest-first, up to 50 per call. `pollMaxMessages` can lower this cap. Claim matching scans the subject, plain-text body, and HTML body after basic tag stripping. Default keywords are `Claims`, `Claim`, `Health`, and `Claim-Form`; `claimKeywords` replaces them when supplied.

A matching email always produces a transcript descriptor, even if it has no attachments. Attachments are filtered by `attachmentExtensions` when configured, otherwise common document/image types are accepted. Filenames matching `skipAttachmentKeywords` (for example `logo`, `signature`, or `tracking-pixel`) are excluded. Duplicate attachment bytes within one message are removed by SHA-256.

Email descriptor details:

- `claimFolder`: sanitized subject plus `__uid-{uid}__vv-{uidValidity}`.
- Transcript: `email-transcript-{timestamp}-uid-{uid}.pdf`.
- Attachment: sanitized original name plus timestamp, UID, and attachment index before the extension.
- `emailMeta.bufferedContent`: the bytes to upload.
- `emailMeta.isTranscript`, `matchedKeywords`, `imapUid`, `uidValidity`, and optional message/attachment identifiers.

The body included in a transcript is capped by `bodyStoreMaxChars`, defaulting to 262,144 characters. In non-production environments IMAP certificate verification is relaxed by default; production verifies certificates unless `ALLOW_INSECURE_IMAP_TLS=true` is explicitly set.

## Landing writers and environment

### S3 (`STORAGE_PROVIDER=S3`, default)

Required environment variables: `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_BUCKET`. `AWS_ENDPOINT` is optional. Uploads use the AWS SDK multipart `Upload` helper and stream the input body.

### MinIO (`STORAGE_PROVIDER=MINIO`)

Required environment variables: `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, and `MINIO_BUCKET`. A bare endpoint uses `MINIO_PORT` (default `9000`) and `MINIO_USE_SSL`; an `http://` or `https://` endpoint derives host, port, and TLS settings.

### GCP and Azure

The dispatcher recognizes `GCP` and `AZURE`, but their landing drivers currently throw `S3/GCP/Azure writer not yet implemented`. Their source readers are implemented; their landing writers are not.

## Kafka event contract

`writeToLanding` publishes to topic `ingestion-events` with the organization ID as the message key. `KAFKA_BROKER` is a required comma-separated list of broker addresses. A producer is cached and shared within the process; a disconnected producer is reset and retried once.

The JSON value has this shape:

```json
{
  "eventId": "uuid",
  "timestamp": "ISO-8601 timestamp",
  "orgId": "org-123",
  "insuranceCompanyCode": "ACME",
  "sourceChannel": "FTP_INGESTION",
  "payload": {
    "fileName": "claim.pdf",
    "storageProvider": "S3",
    "bucketName": "sentinel-landing",
    "objectKey": "org-123/ACME/2026-09-10/ftp/claim/claim.pdf",
    "fileSizeBytes": 1234,
    "mimeType": "application/pdf"
  }
}
```

The event is metadata-only; file bytes are never sent to Kafka. There is no transactional coupling between storage and Kafka, so consumers should treat the upload result as authoritative and design for possible event retry/reconciliation.

## Typical orchestration flow

```text
KMS credentials
      │
      ▼
listNewFiles ──► FileDescriptor[]
      │                  │
      │                  └─ EMAIL: bufferedContent
      ▼
readFromSource ──► Readable ──► writeToLanding ──► landing object
                                      │
                                      └─► ingestion-events metadata
```

For email, replace `readFromSource` with `Readable.from(emailMeta.bufferedContent)`. The caller should update its source cursor only according to its own delivery/acknowledgement policy; this library does not do so.

## Development

```bash
npm install
npm run typecheck
npm run build
```

There are currently no test or lint scripts in `package.json`. Provider integration tests should use isolated test buckets/mailboxes and mock or local implementations for FTP, IMAP, Kafka, and object storage.

## Operational considerations

- Do not log or commit source credentials, service-account private keys, or access keys.
- Listing can materialize many descriptors; MinIO and GCP scan full buckets, and email buffers transcript/attachment bytes in memory.
- `fileSizeBytes` must be a non-negative finite number for landing uploads.
- A successful upload followed by a Kafka failure is an expected partial outcome; monitor the logged `[storage-core] Kafka publish failed` message and reconcile as needed.
- The package uses the caller’s local process time zone only indirectly: source date-folder checks use `new Date()` local calendar fields, while landing object keys use UTC ISO dates. Run the caller with an explicitly understood time zone when date-folder boundaries matter.
