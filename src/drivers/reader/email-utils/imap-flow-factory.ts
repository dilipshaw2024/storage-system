/**
 * Source reader implementation for storage-core.
 */
import { ImapFlow } from "imapflow";

export interface ImapAuthConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
}

/**
 * Shared TLS/auth settings for GreenMail/local (self-signed) vs production.
 */
export function createImapFlowClient(config: ImapAuthConfig): ImapFlow {
  const allowInsecureTls =
    process.env.ALLOW_INSECURE_IMAP_TLS === "true" || process.env.NODE_ENV !== "production";

  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: true,
    tls: {
      rejectUnauthorized: !allowInsecureTls,
    },
    auth: {
      user: config.user,
      pass: config.pass,
    },
    logger: false,
  });

  // ImapFlow emits asynchronous connection errors. Without a listener,
  // Node treats a read timeout or remote disconnect as an uncaught exception
  // and terminates the whole storage process.
  client.on("error", (error) => {
    console.error("[imap] connection error", {
      host: config.host,
      port: config.port,
      code: error instanceof Error && "code" in error ? (error as Error & { code?: string }).code : undefined,
      message: error instanceof Error ? error.message : String(error),
    });
  });

  return client;
}
