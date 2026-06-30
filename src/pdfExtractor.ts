import { execFile } from "child_process";
import { createHash, randomUUID } from "crypto";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import path from "path";
import { promisify } from "util";
import { config } from "./config.js";
import { OpenClawDocumentEvent } from "./types.js";
import { ExtractedPdf } from "./types.js";

const execFileAsync = promisify(execFile);

interface ExtractResult {
  fileSha256: string;
  extracted: ExtractedPdf;
}

interface PythonExtractResponse {
  ok: boolean;
  error?: string;
  message?: string;
  isEncrypted?: boolean;
  heading?: string;
  textSample?: string;
  fullTextSample?: string;
  textHash?: string | null;
  extractionMode?: "text" | "ocr";
  isEmpty?: boolean;
}

interface RenderPagesResponse {
  ok: boolean;
  error?: string;
  message?: string;
  pages?: string[];
}

interface GeminiVisionResponse {
  heading?: string;
  textSample?: string;
  fullTextSample?: string;
  text?: string;
  isEmpty?: boolean;
}

function textHash(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return createHash("sha256").update(trimmed).digest("hex");
}

function safeSample(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max);
}

function firstHeading(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[0]?.slice(0, 180) ?? "";
}

async function renderPdfPagesForVision(tempPath: string): Promise<string[]> {
  const scriptPath = "/app/extractor/render_pdf_pages.py";
  const { stdout } = await execFileAsync(
    config.PYTHON_BIN,
    [scriptPath, tempPath, String(config.GEMINI_VISION_OCR_MAX_PAGES), "180"],
    {
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  const parsed = JSON.parse(stdout.trim()) as RenderPagesResponse;
  if (!parsed.ok) {
    const code = parsed.error ?? "render_failed";
    throw new Error(code);
  }

  return Array.isArray(parsed.pages)
    ? parsed.pages.filter((entry) => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

async function extractWithGeminiVision(tempPath: string): Promise<ExtractedPdf | null> {
  if (!config.enableGeminiVisionOcr || !config.GEMINI_API_KEY) {
    return null;
  }

  const pages = await renderPdfPagesForVision(tempPath);
  if (!pages.length) {
    return null;
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${config.GEMINI_MODEL}:generateContent?key=${config.GEMINI_API_KEY}`;
  const prompt =
    "Read these PDF page images and perform OCR. Return strict JSON only with keys: heading, textSample, fullTextSample, isEmpty. " +
    "Use plain text with no markdown. heading should be the first meaningful title line.";

  const parts: Array<Record<string, unknown>> = [{ text: prompt }];
  for (const page of pages) {
    parts.push({
      inlineData: {
        mimeType: "image/png",
        data: page,
      },
    });
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`vision_ocr_http_${response.status}`);
  }

  const payload = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const jsonText = payload.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!jsonText) {
    throw new Error("vision_ocr_empty_response");
  }

  let parsed: GeminiVisionResponse;
  try {
    parsed = JSON.parse(jsonText) as GeminiVisionResponse;
  } catch {
    throw new Error("vision_ocr_invalid_json");
  }

  const fullText = safeSample(
    parsed.fullTextSample ?? parsed.textSample ?? parsed.text ?? "",
    16_000,
  );
  const sample = safeSample(parsed.textSample ?? parsed.text ?? fullText, 2_400);
  const heading = (parsed.heading ?? firstHeading(fullText) ?? "").trim().slice(0, 180);
  const empty = parsed.isEmpty === true || !fullText;

  return {
    heading,
    textSample: sample,
    fullTextSample: fullText,
    textHash: textHash(fullText),
    extractionMode: "ocr",
    isEmpty: empty,
  };
}

async function writeBytesToTempFile(bytes: Buffer): Promise<{ tempPath: string; bytes: Buffer }> {
  const tempPath = path.join(tmpdir(), `wa-ingest-${randomUUID()}.pdf`);
  await fs.writeFile(tempPath, bytes);
  return { tempPath, bytes };
}

async function downloadToTempFile(url: string): Promise<{ tempPath: string; bytes: Buffer }> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download_failed:${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const bytes = Buffer.from(arrayBuffer);
  return writeBytesToTempFile(bytes);
}

function decodeBase64ToBuffer(input: string): Buffer {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("download_failed:empty_media_base64");
  }

  if (trimmed.startsWith("data:")) {
    const commaIdx = trimmed.indexOf(",");
    if (commaIdx < 0) {
      throw new Error("download_failed:invalid_data_url");
    }
    const meta = trimmed.slice(0, commaIdx).toLowerCase();
    if (!meta.includes(";base64")) {
      throw new Error("download_failed:data_url_not_base64");
    }
    return Buffer.from(trimmed.slice(commaIdx + 1), "base64");
  }

  return Buffer.from(trimmed, "base64");
}

async function readMediaPathToTempFile(
  mediaPath: string,
): Promise<{ tempPath: string; bytes: Buffer }> {
  try {
    const bytes = await fs.readFile(mediaPath);
    return writeBytesToTempFile(bytes);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "failed to read media path";
    throw new Error(`download_failed:${detail}`);
  }
}

async function resolveEventToTempFile(
  event: OpenClawDocumentEvent,
): Promise<{ tempPath: string; bytes: Buffer }> {
  if (event.mediaBase64) {
    const bytes = decodeBase64ToBuffer(event.mediaBase64);
    return writeBytesToTempFile(bytes);
  }

  if (event.mediaPath) {
    return readMediaPathToTempFile(event.mediaPath);
  }

  if (event.mediaUrl) {
    return downloadToTempFile(event.mediaUrl);
  }

  throw new Error("download_failed:no_media_source");
}

export async function extractPdfFromEvent(
  event: OpenClawDocumentEvent,
  hashFn: (buffer: Buffer) => string,
): Promise<ExtractResult> {
  const { tempPath, bytes } = await resolveEventToTempFile(event);
  const fileSha256 = hashFn(bytes);

  try {
    const scriptPath = "/app/extractor/extract_pdf.py";
    let parsed: PythonExtractResponse | null = null;
    let extractionError: Error | null = null;

    try {
      const { stdout } = await execFileAsync(config.PYTHON_BIN, [scriptPath, tempPath], {
        timeout: 120_000,
        maxBuffer: 5 * 1024 * 1024,
      });
      parsed = JSON.parse(stdout.trim()) as PythonExtractResponse;
    } catch (error) {
      extractionError = error instanceof Error ? error : new Error("extraction_failed");
    }

    if (parsed?.ok && !parsed.isEmpty) {
      return {
        fileSha256,
        extracted: {
          heading: parsed.heading ?? "",
          textSample: parsed.textSample ?? "",
          fullTextSample: parsed.fullTextSample ?? "",
          textHash: parsed.textHash ?? null,
          extractionMode: parsed.extractionMode ?? "text",
          isEmpty: Boolean(parsed.isEmpty),
        },
      };
    }

    const parsedErrorCode = parsed?.ok ? null : (parsed?.error ?? "extraction_failed");
    const canVisionFallback =
      parsedErrorCode !== "pdf_password_protected" &&
      (Boolean(extractionError) ||
        parsed?.isEmpty === true ||
        parsedErrorCode === "extraction_failed");

    if (canVisionFallback) {
      try {
        const visionExtracted = await extractWithGeminiVision(tempPath);
        if (visionExtracted && !visionExtracted.isEmpty) {
          return {
            fileSha256,
            extracted: visionExtracted,
          };
        }
      } catch {
        // Fall through to original extraction result/error handling.
      }
    }

    if (parsed?.ok) {
      return {
        fileSha256,
        extracted: {
          heading: parsed.heading ?? "",
          textSample: parsed.textSample ?? "",
          fullTextSample: parsed.fullTextSample ?? "",
          textHash: parsed.textHash ?? null,
          extractionMode: parsed.extractionMode ?? "text",
          isEmpty: Boolean(parsed.isEmpty),
        },
      };
    }

    if (parsedErrorCode) {
      throw new Error(parsedErrorCode);
    }

    if (extractionError) {
      throw extractionError;
    }

    throw new Error("extraction_failed");
  } finally {
    await fs.unlink(tempPath).catch(() => {
      // Ignore temp cleanup failures.
    });
  }
}
