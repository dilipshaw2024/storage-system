/**
 * Source reader implementation for storage-core.
 */
import { createHash } from 'crypto'
import { Readable } from 'stream'
import type { FileDescriptor, ReaderDriver } from '../../types'
import { findMatchedClaimKeywords, stripHtmlForScan } from './email-utils/claim-text'
import {
  sanitizeAttachmentFilename,
  sanitizeSubjectForKey,
  sanitizeUidValidityForSegment,
} from './email-utils/email-subject-key'
import {
  buildEmailTranscriptPdfBuffer,
  formatEnvelopeFromForTranscript,
  type TranscriptAddressLike,
} from './email-utils/email-transcript-pdf'
import { createImapFlowClient } from './email-utils/imap-flow-factory'
import { splitPollParts } from './email-utils/imap-claim-parts'
import { getImapPollMailboxPath } from './email-utils/imap-mailbox-cursor'

const EMAIL_TRANSCRIPT_PREFIX = 'email-transcript'
/** Mirrors email-to-ftp-server config defaults (EMAIL_CLAIM_KEYWORDS / EMAIL_POLL_MAX_MESSAGES / EMAIL_CLAIM_BODY_STORE_MAX). */
const DEFAULT_CLAIM_KEYWORDS = ['Claims', 'Claim', 'Health', 'Claim-Form']
/** Attachment filename fragments that identify common inline email noise. */
const DEFAULT_SKIP_ATTACHMENT_KEYWORDS = [
  'logo',
  'signature',
  'disclaimer',
  'footer',
  'banner',
  'social-icon',
  'tracking-pixel',
  'stamp',
  'watermark',
  'advertisement',
  'unsubscribe',
  'header',
  'icon',
  'confidentiality',
]
const DEFAULT_POLL_MAX_MESSAGES = 50
const DEFAULT_BODY_STORE_MAX_CHARS = 262144

function requireString(c: Record<string, any>, key: string): string {
  const v = c[key]
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`Email reader sourceCredentials.${key} is missing or empty.`)
  }
  return v.trim()
}

function requireInsuranceCompanyCode(c: Record<string, any>): string {
  const raw = c.insuranceCompanyCode ?? c.insurance_company_code
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('Email reader sourceCredentials.insuranceCompanyCode is missing or empty.')
  }
  return raw.trim()
}

function resolvePort(c: Record<string, any>): number {
  const raw = c.imap_port ?? c.imps_port ?? c.port
  const port = typeof raw === 'number' ? raw : parseInt(String(raw), 10)
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error('Email reader sourceCredentials.imap_port is missing or invalid.')
  }
  return port
}

export const emailReaderDriver: ReaderDriver = {
  async listNewFiles(orgId: string, credentials: Record<string, any>): Promise<FileDescriptor[]> {
    // Normalize common credential aliases so the reader works with both
    // legacy configurations and standard IMAP field names. SMTP-only fields
    // are intentionally excluded because this reader connects over IMAP.
    const normalizedCredentials = {
      ...credentials,
      email:
        credentials.email ??
        credentials.email_address ??
        credentials.username ??
        credentials.imap_username ??
        credentials.imap_user ??
        credentials.user,
      password:
        credentials.password ?? credentials.imap_password ?? credentials.pass,
      imap_host:
        credentials.imap_host ?? credentials.imps_host ?? credentials.host,
      imap_port: credentials.imap_port ?? credentials.imps_port ?? credentials.port,
    }
    const email = requireString(normalizedCredentials, 'email')
    const password = requireString(normalizedCredentials, 'password')
    const host = requireString(normalizedCredentials, 'imap_host')
    const port = resolvePort(normalizedCredentials)

    const lastProcessedUid = Number(
      credentials.lastProcessedUid ?? credentials.last_processed_uid ?? 0,
    )
    const lastUidValidity =
      typeof credentials.lastUidValidity === 'string' && credentials.lastUidValidity.trim() !== ''
        ? credentials.lastUidValidity.trim()
        : null
    const keywords: string[] = Array.isArray(credentials.claimKeywords)
      ? credentials.claimKeywords
      : DEFAULT_CLAIM_KEYWORDS
    const attachmentExtensions: string[] = Array.isArray(credentials.attachmentExtensions)
      ? credentials.attachmentExtensions
      : []
    const skipAttachmentKeywords: string[] = Array.isArray(credentials.skipAttachmentKeywords)
      ? credentials.skipAttachmentKeywords
      : DEFAULT_SKIP_ATTACHMENT_KEYWORDS
    const insuranceCompanyCode = requireInsuranceCompanyCode(credentials)
    const bodyStoreMax = Number(credentials.bodyStoreMaxChars ?? DEFAULT_BODY_STORE_MAX_CHARS)
    const requestedMax = Number(credentials.pollMaxMessages ?? DEFAULT_POLL_MAX_MESSAGES)
    const cap = Math.min(Math.max(requestedMax, 1), DEFAULT_POLL_MAX_MESSAGES)

    const mailboxPath = getImapPollMailboxPath()
    console.log('[email-reader] polling mailbox', {
      orgId,
      mailboxPath,
      host,
      port,
      lastProcessedUid,
      lastUidValidity,
      keywords,
      attachmentExtensions,
      skipAttachmentKeywords,
      pollMaxMessages: cap,
    })
    const client = createImapFlowClient({ host, port, user: email, pass: password })
    await client.connect()

    const descriptors: FileDescriptor[] = []

    try {
      const lock = await client.getMailboxLock(mailboxPath, { readOnly: true })
      try {
        const uidValidity =
          client.mailbox && typeof client.mailbox !== 'boolean'
            ? String(client.mailbox.uidValidity)
            : null

        const searchResult = await client.search({ all: true }, { uid: true })
        const allUids = Array.isArray(searchResult) ? searchResult : []
        // UIDs are only valid within a UIDVALIDITY generation (RFC 3501). If the observed UIDVALIDITY
        // differs from the one stored at the last poll, the UID space was reset (mailbox recreated,
        // GreenMail restart, etc.) and the stored cursor is meaningless — resync from 0. We only reset
        // on a real UIDVALIDITY change, never by guessing from inbox size (which mis-fires on deletes).
        const uidValidityChanged =
          lastUidValidity !== null && uidValidity !== null && uidValidity !== lastUidValidity
        const effectiveLastProcessedUid = uidValidityChanged ? 0 : lastProcessedUid
        // Process the newest messages first. This is important for mailboxes
        // containing a large historical backlog: a low cursor must not cause
        // the reader to repeatedly inspect only the oldest messages.
        const newUids = allUids
          .filter((u) => u > effectiveLastProcessedUid)
          .sort((a, b) => b - a)
          .slice(0, cap)

        console.log('[email-reader] mailbox scan', {
          mailboxPath,
          uidValidity,
          uidValidityChanged,
          effectiveLastProcessedUid,
          totalMessageCount: allUids.length,
          newUidCount: newUids.length,
          newUids,
        })

        if (newUids.length === 0) {
          console.log('[email-reader] no new UIDs found', {
            mailboxPath,
            lastProcessedUid,
            totalMessageCount: allUids.length,
          })
          return descriptors
        }

        for (const uid of newUids) {
          const msg = await client.fetchOne(
            String(uid),
            { envelope: true, bodyStructure: true, internalDate: true, uid: true },
            { uid: true },
          )

          if (!msg || !msg.bodyStructure) {
            console.log('[email-reader] skipped message without body structure', { uid })
            continue
          }

          const { textPart, htmlPart, attachmentParts } = splitPollParts(
            msg.bodyStructure,
            attachmentExtensions,
          )
          const textPartsOnly = [textPart, htmlPart].filter((x): x is string => Boolean(x))
          let textBody = ''
          let htmlRaw = ''
          if (textPartsOnly.length > 0) {
            const partial = await client.downloadMany(String(uid), textPartsOnly, { uid: true })
            if (textPart) {
              const b = partial[textPart]?.content
              if (b) textBody = b.toString('utf8')
            }
            if (htmlPart) {
              const b = partial[htmlPart]?.content
              if (b) htmlRaw = b.toString('utf8')
            }
          }

          const subject = msg.envelope?.subject ?? ''
          const combinedForMatch = [subject, textBody, stripHtmlForScan(htmlRaw)]
            .filter(Boolean)
            .join('\n')
          const matchedKw = findMatchedClaimKeywords(combinedForMatch, keywords)
          const hasClaimKeywords = matchedKw.length > 0
          if (!hasClaimKeywords) {
            console.log('[email-reader] skipped message: no matching claim keyword', {
              uid,
              subject,
              keywords,
            })
            continue
          }

          // A keyword match is sufficient to process the email. Attachments are
          // optional: the transcript is retained for both message-only and
          // message-with-attachments claim emails.
          const hasSupportedAttachments = attachmentParts.length > 0
          if (!hasSupportedAttachments) {
            console.log('[email-reader] processing claim email without attachments', {
              uid,
              subject,
              matchedKeywords: matchedKw,
            })
          }

          console.log('[email-reader] processing claim email', {
            uid,
            subject,
            matchedKeywords: matchedKw,
            attachmentCount: hasSupportedAttachments ? attachmentParts.length : 0,
          })

          const rfcMessageId = msg.envelope?.messageId ?? null
          const sanitizedSubject = sanitizeSubjectForKey(subject)
          const bodyPlainForTranscript = [textBody, stripHtmlForScan(htmlRaw)]
            .filter(Boolean)
            .join('\n')
            .slice(0, bodyStoreMax)

          // Exclude inline assets before downloading them from IMAP. This avoids
          // unnecessary network, memory, and hashing work for non-claim files.
          const claimAttachmentParts = attachmentParts.filter((attachment) => {
            const skippedByKeywords = findMatchedClaimKeywords(
              attachment.filename,
              skipAttachmentKeywords,
            )
            if (skippedByKeywords.length === 0) return true

            console.log('[email-reader] skipped attachment by filename keyword', {
              uid,
              filename: attachment.filename,
              matchedKeywords: skippedByKeywords,
            })
            return false
          })

          const downloaded =
            claimAttachmentParts.length > 0
              ? await client.downloadMany(
                  String(uid),
                  claimAttachmentParts.map((p) => p.part),
                  { uid: true },
                )
              : {}

          const vvSeg = sanitizeUidValidityForSegment(uidValidity)
          const claimFolder = `${sanitizedSubject}__uid-${uid}__vv-${vvSeg}`

          const internalDateRaw = (msg as { internalDate?: Date | string | null }).internalDate
          const dateLine =
            internalDateRaw != null
              ? new Date(internalDateRaw).toISOString()
              : msg.envelope?.date != null
                ? String(msg.envelope.date)
                : null

          const transcriptBuf = await buildEmailTranscriptPdfBuffer({
            subject,
            bodyPlain: bodyPlainForTranscript,
            fromLine: formatEnvelopeFromForTranscript(
              msg.envelope?.from as TranscriptAddressLike[] | undefined,
            ),
            dateLine,
            messageIdLine: rfcMessageId,
          })
          // Include the creation timestamp and IMAP UID so transcript names remain
          // unique even when multiple emails have the same subject.
          const transcriptFileName = `${EMAIL_TRANSCRIPT_PREFIX}-${Date.now()}-uid-${uid}.pdf`

          descriptors.push({
            orgId,
            insuranceCompanyCode,
            claimFolder,
            fileName: transcriptFileName,
            filePath: `email://${email}/imap/${mailboxPath}/uid/${uid}/${transcriptFileName}`,
            fileSizeBytes: transcriptBuf.length,
            mimeType: 'application/pdf',
            emailMeta: {
              imapUid: uid,
              uidValidity,
              rfcMessageId,
              matchedKeywords: matchedKw,
              isTranscript: true,
              bufferedContent: transcriptBuf,
            },
          })

          /** Same bytes can appear under multiple MIME leaves (e.g. inline + attachment); dedup within this UID by sha. */
          const uploadedAttachmentShaInThisUid = new Set<string>()

          for (const [attachmentIndex, attachment] of claimAttachmentParts.entries()) {
            const buf = downloaded[attachment.part]?.content
            if (!buf || buf.length === 0) {
              continue
            }

            const attachmentSha256 = createHash('sha256').update(buf).digest('hex')
            if (uploadedAttachmentShaInThisUid.has(attachmentSha256)) {
              continue
            }
            uploadedAttachmentShaInThisUid.add(attachmentSha256)

            const safeAttachmentName = sanitizeAttachmentFilename(attachment.filename)
            const extensionStart = safeAttachmentName.lastIndexOf('.')
            const attachmentBaseName =
              extensionStart > 0 ? safeAttachmentName.slice(0, extensionStart) : safeAttachmentName
            const attachmentExtension = extensionStart > 0 ? safeAttachmentName.slice(extensionStart) : ''
            const attachmentFileName = `${attachmentBaseName}-${Date.now()}-uid-${uid}-${attachmentIndex}${attachmentExtension}`

            descriptors.push({
              orgId,
              insuranceCompanyCode,
              claimFolder,
              fileName: attachmentFileName,
              filePath: `email://${email}/imap/${mailboxPath}/uid/${uid}/${attachment.filename}`,
              fileSizeBytes: buf.length,
              mimeType: attachment.mimeType || 'application/octet-stream',
              emailMeta: {
                imapUid: uid,
                uidValidity,
                rfcMessageId,
                matchedKeywords: matchedKw,
                isTranscript: false,
                attachmentSha256,
                bufferedContent: buf,
              },
            })
          }
        }
      } finally {
        lock.release()
      }
    } finally {
      await client.logout()
    }

    return descriptors
  },

  async readFile(_credentials: Record<string, any>, _filePath: string): Promise<Readable> {
    // Email content retrieval happens entirely within listNewFiles: IMAP requires a
    // fetch-then-read round trip under an open mailbox lock, and IMAP UIDs are not stable
    // filePath-style identifiers for re-fetching once the lock is released. The downloaded
    // bytes are therefore attached to each FileDescriptor.emailMeta.bufferedContent.
    // Callers must wrap that buffer in a stream (e.g. Readable.from(descriptor.emailMeta.bufferedContent))
    // rather than calling readFile for the EMAIL provider.
    throw new Error(
      'Email reader: use FileDescriptor.emailMeta.bufferedContent (downloaded during listNewFiles); readFile is not supported for the EMAIL provider.',
    )
  },
}
