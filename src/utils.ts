import { createHash } from "crypto";

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function safeLower(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export function isPdfFilename(filename: string): boolean {
  return safeLower(filename).endsWith(".pdf");
}

export function extractYoutubeUrl(text: string | null | undefined): string | null {
  if (!text || typeof text !== "string") return null;
  const match = text.match(
    /(https?:\/\/(?:www\.)?(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?)\/|\S*?[?&]v=)|youtu\.be\/)[a-zA-Z0-9_-]{11})/i,
  );
  return match ? match[1] : null;
}

export function buildIdempotencyKey(
  groupJid: string,
  messageId: string,
  fileSha256: string,
): string {
  return `wa:${groupJid}:${messageId}:${fileSha256}`;
}

export function clampConfidence(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
