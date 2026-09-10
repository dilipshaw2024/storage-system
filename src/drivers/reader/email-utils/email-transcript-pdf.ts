/**
 * Source reader implementation for storage-core.
 */
import PDFDocument from "pdfkit";

/** Max chars of subject written into the transcript PDF (full subject still used for folder slug separately). */
const TRANSCRIPT_SUBJECT_MAX_CHARS = 4096;

export interface BuildEmailTranscriptPdfParams {
  subject: string;
  bodyPlain: string;
  fromLine?: string | null;
  dateLine?: string | null;
  messageIdLine?: string | null;
}

/** Minimal shape for IMAP envelope address entries (avoids coupling to imapflow exports). */
export interface TranscriptAddressLike {
  name?: string;
  address?: string;
}

function formatAddressList(addresses: TranscriptAddressLike[] | undefined): string | null {
  if (!addresses || addresses.length === 0) {
    return null;
  }
  const parts = addresses.map((a) => {
    const addr = a.address ?? "";
    const name = typeof a.name === "string" && a.name.trim().length > 0 ? a.name.trim() : "";
    return name ? `${name} <${addr}>` : addr;
  });
  const joined = parts.filter(Boolean).join(", ");
  return joined.length > 0 ? joined : null;
}

/** Public helper for ingestion: envelope From line. */
export function formatEnvelopeFromForTranscript(from: TranscriptAddressLike[] | undefined): string | null {
  return formatAddressList(from);
}

/**
 * Plain-text email transcript as a PDF (pdfkit — no headless browser).
 * Caller caps `bodyPlain` length; subject is capped here for PDF layout safety.
 */
export async function buildEmailTranscriptPdfBuffer(params: BuildEmailTranscriptPdfParams): Promise<Buffer> {
  const subject = params.subject.slice(0, TRANSCRIPT_SUBJECT_MAX_CHARS);
  const body = params.bodyPlain;

  const chunks: Buffer[] = [];

  return await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    doc.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    doc.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    doc.on("error", reject);

    doc.fontSize(14).text("Subject");
    doc.moveDown(0.25);
    doc.fontSize(11).text(subject.length > 0 ? subject : "(empty)", { width: 500 });
    doc.moveDown(0.75);

    if (params.fromLine) {
      doc.fontSize(10).text(`From: ${params.fromLine}`, { width: 500 });
      doc.moveDown(0.35);
    }
    if (params.dateLine) {
      doc.fontSize(10).text(`Date: ${params.dateLine}`, { width: 500 });
      doc.moveDown(0.35);
    }
    if (params.messageIdLine) {
      doc.fontSize(10).text(`Message-ID: ${params.messageIdLine}`, { width: 500 });
      doc.moveDown(0.5);
    }

    doc.fontSize(12).text("Body");
    doc.moveDown(0.25);
    doc.fontSize(10).text(body.length > 0 ? body : "(empty)", { width: 500, align: "left" });

    doc.end();
  });
}
