# storage-core

Shared TypeScript I/O library used by `poll-orchestrator`. It has no server or standalone runtime.

## Public API

```ts
import { listNewFiles, readFromSource, writeToLanding } from '@sentinel/storage-core'
```

- `listNewFiles(input)` selects a source driver from `input.sourceCredentials.provider`.
- `readFromSource(input)` returns a readable stream for a source file.
- `writeToLanding(stream, input)` selects the landing writer from `STORAGE_PROVIDER`, uploads the stream, and publishes an `ingestion-events` metadata message.

## Provider support

| Capability | Implemented | Provider values |
|---|---:|---|
| Source reader | yes | `FTP`, `SFTP`, `MINIO`, `S3`, `GCP`, `AZURE` |
| Email listing/attachment extraction | yes | `EMAIL` |
| Landing writer | yes | `MINIO`, `S3` |
| Landing writer placeholder | no | `GCP`, `AZURE` |

Email attachments and generated transcripts are buffered during listing; callers should use the returned `emailMeta.bufferedContent` rather than call `readFromSource` for email files.

Generated email transcript filenames use the format `email-transcript-{timestamp}-uid-{imapUid}.pdf`. Attachment filenames use their sanitized original name with a timestamp, IMAP UID, and attachment index added before the extension.

## Build

```bash
npm install
npm run typecheck
npm run build
```

The package reads landing credentials from the caller process. MinIO uses `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, and `MINIO_BUCKET`. S3 uses `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_BUCKET`; `AWS_ENDPOINT` is optional for S3-compatible endpoints.

See [docs/STORAGE_CORE_TECHNICAL_GUIDE.md](docs/STORAGE_CORE_TECHNICAL_GUIDE.md) for the complete API, credential contracts, provider behavior, email flow, object-key format, and Kafka event contract.
