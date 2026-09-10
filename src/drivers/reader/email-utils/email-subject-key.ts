/**
 * Helpers that turn raw email subject lines and attachment filenames into
 * S3/MinIO object-key-safe segments for the email-to-ftp landing path.
 *
 * Output charset is restricted to [A-Za-z0-9._-] so the resulting key is safe
 * across MinIO, S3, and downstream consumers that may URL-encode keys.
 */

const SUBJECT_MAX_LEN = 80;
const FILENAME_MAX_LEN = 120;
const SUBJECT_FALLBACK = "no-subject";
const FILENAME_FALLBACK = "attachment.pdf";
const UIDVALIDITY_MAX_LEN = 40;
const UIDVALIDITY_FALLBACK = "na";

/**
 * IMAP UIDVALIDITY as a single path segment (digits only in practice; strip anything else).
 */
export function sanitizeUidValidityForSegment(uidValidity: string | null | undefined): string {
  if (!uidValidity) {
    return UIDVALIDITY_FALLBACK;
  }
  const trimmed = uidValidity.trim();
  if (trimmed.length === 0) {
    return UIDVALIDITY_FALLBACK;
  }
  const safe = trimmed.replace(/[^A-Za-z0-9._-]+/g, "").slice(0, UIDVALIDITY_MAX_LEN);
  return safe.length > 0 ? safe : UIDVALIDITY_FALLBACK;
}

/**
 * Slugify an email subject for use as a folder segment.
 * - Replaces any char not in [A-Za-z0-9._-] with `-`.
 * - Collapses runs of `-` and trims leading/trailing `-` and `.`.
 * - Caps length at 80 chars.
 * - Returns `no-subject` when empty after sanitization.
 */
export function sanitizeSubjectForKey(subject: string | null | undefined): string {
  if (!subject) {
    return SUBJECT_FALLBACK;
  }
  const trimmed = subject.trim();
  if (trimmed.length === 0) {
    return SUBJECT_FALLBACK;
  }

  const replaced = trimmed.replace(/[^A-Za-z0-9._-]+/g, "-");
  const collapsed = replaced.replace(/-+/g, "-");
  const stripped = collapsed.replace(/^[-.]+|[-.]+$/g, "");
  if (stripped.length === 0) {
    return SUBJECT_FALLBACK;
  }

  const capped = stripped.slice(0, SUBJECT_MAX_LEN).replace(/[-.]+$/g, "");
  return capped.length === 0 ? SUBJECT_FALLBACK : capped;
}

/**
 * Normalize an attachment filename for safe use as the trailing object-key segment.
 * - Strips control chars, maps whitespace to `_`.
 * - Replaces any char not in [A-Za-z0-9._-] with `_`.
 * - Preserves the original extension when possible.
 * - Caps total length at 120 chars.
 * - Returns `attachment.pdf` when empty after sanitization.
 */
export function sanitizeAttachmentFilename(name: string | null | undefined): string {
  if (!name) {
    return FILENAME_FALLBACK;
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return FILENAME_FALLBACK;
  }

  const noControl = trimmed.replace(/[\x00-\x1f\x7f]/g, "");
  const spaceMapped = noControl.replace(/\s+/g, "_");
  const safe = spaceMapped.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/_+/g, "_");
  const cleaned = safe.replace(/^[._-]+|[._-]+$/g, "");
  if (cleaned.length === 0) {
    return FILENAME_FALLBACK;
  }

  if (cleaned.length <= FILENAME_MAX_LEN) {
    return cleaned;
  }

  const dot = cleaned.lastIndexOf(".");
  if (dot > 0 && dot >= cleaned.length - 10) {
    const ext = cleaned.slice(dot);
    const base = cleaned.slice(0, FILENAME_MAX_LEN - ext.length).replace(/[._-]+$/g, "");
    return `${base}${ext}`;
  }
  return cleaned.slice(0, FILENAME_MAX_LEN).replace(/[._-]+$/g, "");
}
