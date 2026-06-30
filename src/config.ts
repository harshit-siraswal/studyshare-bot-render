import { z } from "zod";

const optionalUrl = z.preprocess((value) => {
  if (typeof value === "string" && value.trim() === "") {
    return undefined;
  }
  return value;
}, z.string().url().optional());

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(8080),
  LOG_LEVEL: z.string().default("info"),
  INGEST_BODY_LIMIT_MB: z.coerce.number().int().positive().default(30),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().optional(),
  STUDYSHARE_API_BASE: z.string().url(),
  STUDYSHARE_ADMIN_BEARER: z.string().min(1),
  STUDYSHARE_POST_MODE: z.enum(["api", "browser"]).default("browser"),
  STUDYSHARE_ADMIN_APP_BASE: z
    .string()
    .url()
    .default("https://admin-studyspace-official.vercel.app"),
  STUDYSHARE_ADMIN_DEFAULT_COLLEGE_ID: z.string().optional(),
  STUDYSHARE_BROWSER_EXECUTABLE_PATH: z.string().optional(),
  STUDYSHARE_BROWSER_HEADLESS: z.string().default("true"),
  STUDYSHARE_BROWSER_TIMEOUT_MS: z.coerce.number().int().positive().default(90000),
  STUDYSHARE_UPLOADS_PRESIGN_PATH: z.string().default("/api/admin/uploads/presign"),
  STUDYSHARE_RESOURCES_PATH: z.string().default("/api/admin/resources"),
  STUDYSHARE_NOTICES_PATH: z.string().default("/api/admin/notices"),
  STUDYSHARE_SYLLABUS_PATH: z.string().default("/api/admin/syllabus"),
  STUDYSHARE_LEGACY_ADMIN_PATH: z.string().default("/api/admin"),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  AUTO_POST_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.78),
  ENABLE_LLM_CLASSIFIER: z.string().default("true"),
  ENABLE_CHAT_AGENT: z.string().default("true"),
  ENABLE_GEMINI_VISION_OCR: z.string().default("true"),
  ENABLE_GOOGLE_VISION_OCR: z.string().default("true"),
  GOOGLE_VISION_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  GOOGLE_CLOUD_VISION_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-1.5-flash"),
  CHAT_AGENT_MODEL: z.string().default("gemini-1.5-flash"),
  GEMINI_VISION_OCR_MAX_PAGES: z.coerce.number().int().min(1).max(6).default(3),
  GOOGLE_VISION_OCR_MAX_PAGES: z.coerce.number().int().min(1).max(6).default(3),
  OPS_ALERT_WEBHOOK_URL: optionalUrl,
  MOLTBOT_CHAT_WEBHOOK_URL: optionalUrl,
  MOLTBOT_REVIEW_NOTIFY_WEBHOOK_URL: optionalUrl,
  PYTHON_BIN: z.string().default("python3"),
});

const parsed = envSchema.parse(process.env);
const resolvedGoogleVisionApiKey =
  parsed.GOOGLE_VISION_API_KEY ??
  parsed.GOOGLE_CLOUD_VISION_API_KEY ??
  parsed.GOOGLE_API_KEY ??
  parsed.GEMINI_API_KEY;

export const config = {
  ...parsed,
  GOOGLE_VISION_API_KEY: resolvedGoogleVisionApiKey,
  enableLlmClassifier: parsed.ENABLE_LLM_CLASSIFIER.toLowerCase() === "true",
  enableChatAgent: parsed.ENABLE_CHAT_AGENT.toLowerCase() === "true",
  enableGeminiVisionOcr: parsed.ENABLE_GEMINI_VISION_OCR.toLowerCase() === "true",
  enableGoogleVisionOcr: parsed.ENABLE_GOOGLE_VISION_OCR.toLowerCase() === "true",
  studysharePostMode: parsed.STUDYSHARE_POST_MODE,
  studyshareBrowserHeadless: parsed.STUDYSHARE_BROWSER_HEADLESS.toLowerCase() === "true",
};
