/**
 * Source reader implementation for storage-core.
 */
import { createImapFlowClient, type ImapAuthConfig } from "./imap-flow-factory";

/** Same mailbox path as poll (`ingestion.service.ts`). */
export function getImapPollMailboxPath(): string {
  return process.env.IMAP_POLL_MAILBOX?.trim() || "INBOX";
}

/**
 * Largest UID present in the mailbox, or 0 if empty.
 * Used at registration to set `last_processed_uid` so polling skips messages already in the box.
 */
export async function getMaxUidForMailbox(creds: ImapAuthConfig): Promise<number> {
  const mailboxPath = getImapPollMailboxPath();
  const client = createImapFlowClient(creds);
  await client.connect();
  try {
    const lock = await client.getMailboxLock(mailboxPath, { readOnly: true });
    try {
      const searchResult = await client.search({ all: true }, { uid: true });
      const allUids = Array.isArray(searchResult) ? searchResult : [];
      if (allUids.length === 0) {
        return 0;
      }
      return Math.max(...allUids);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}
