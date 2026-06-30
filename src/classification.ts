import { promises as fs } from "fs";
import { z } from "zod";
import { config } from "./config.js";
import { ClassificationResult, DocCategory, GroupBinding, OpenClawDocumentEvent } from "./types.js";
import { clampConfidence, safeLower } from "./utils.js";

const llmSchema = z.object({
  category: z.enum(["syllabus", "resource", "notice"]),
  confidence: z.number().min(0).max(1),
  title: z.string().min(1).max(220),
  summary: z.string().max(280).default(""),
  department: z.string().nullable(),
  branch: z.string().nullable(),
  semester: z.string().nullable(),
  subject: z.string().nullable(),
  priority: z.enum(["low", "normal", "high"]),
});

type WeightedSignal = { keyword: string; weight: number };

const syllabusWeightedSignals: WeightedSignal[] = [
  { keyword: "syllabus", weight: 5 },
  { keyword: "curriculum", weight: 4 },
  { keyword: "course structure", weight: 4 },
  { keyword: "scheme of examination", weight: 4 },
  { keyword: "paper pattern", weight: 3 },
  { keyword: "module wise", weight: 3 },
];

const noticeWeightedSignals: WeightedSignal[] = [
  { keyword: "notice", weight: 5 },
  { keyword: "circular", weight: 4 },
  { keyword: "exam schedule", weight: 5 },
  { keyword: "examination schedule", weight: 5 },
  { keyword: "deadline", weight: 4 },
  { keyword: "registration date", weight: 4 },
  { keyword: "important announcement", weight: 4 },
  { keyword: "result declared", weight: 4 },
  { keyword: "holiday", weight: 3 },
];

const resourceWeightedSignals: WeightedSignal[] = [
  { keyword: "notes", weight: 4 },
  { keyword: "lecture", weight: 3 },
  { keyword: "study material", weight: 4 },
  { keyword: "question bank", weight: 4 },
  { keyword: "assignment", weight: 3 },
  { keyword: "pyq", weight: 4 },
  { keyword: "handout", weight: 3 },
  { keyword: "slides", weight: 3 },
  { keyword: "chapter", weight: 2 },
  { keyword: "unit", weight: 2 },
];

const antiSyllabusPhrases = ["as per syllabus"];

const subjectAliasOverrides: Record<string, string[]> = {
  "calculus for engineers": ["cfe", "maths", "mathematics"],
  "basic proficiency in spanish": ["basic spanish", "spanish"],
  "computer organization and logic design": [
    "co and ld",
    "co ld",
    "co&ld",
    "cold",
    "logic design",
    "computer organization",
  ],
  "computer organization and logic design lab": [
    "co and ld lab",
    "co ld lab",
    "co&ld lab",
    "cold lab",
    "logic design lab",
    "computer organization lab",
  ],
  "data structure": ["data structures", "data structure and algorithm", "dsa", "ds"],
  "discrete structures and theory of logic": [
    "discrete structures",
    "theory of logic",
    "dstl",
    "discrete maths",
  ],
  "programming for problem solving": [
    "problem solving",
    "programming fundamentals",
    "programming in c",
    "c programming",
    "pps",
  ],
  "programming for problem solving lab": ["pps lab", "problem solving lab"],
  "design thinking": ["design-thinking", "dt"],
  "design and realization": ["design realization", "d and r"],
  "introduction to iot": ["intro to iot", "iot basics", "internet of things"],
  "environmental chemistry": ["chemistry", "chem"],
  "linear algebra for engineers": ["linear algebra", "lae"],
  "differential equations and complex integration": [
    "differential equations",
    "complex integration",
  ],
  "engineering mechanics": ["engg mechanics"],
  "fundamentals of mechatronics and industrial automation": [
    "mechatronics",
    "industrial automation",
  ],
  "explorations in electrical engineering": [
    "electrical engineering exploration",
    "eee exploration",
  ],
  "explorations in electrical engineering lab": ["electrical engineering lab", "eee lab"],
  "computer aided electrical design": ["caed", "electrical design"],
  "digital logic design": ["dld"],
  "digital logic design using hdl": ["dld using hdl", "hdl logic design"],
  "digital logic design using hdl lab": ["hdl lab", "dld lab"],
  "basic electronics engineering": ["bee"],
  "intelligent health care systems": ["health care systems", "ihcs"],
  "intelligent health care systems lab": ["ihcs lab", "health care lab"],
  "introduction to data science": ["intro to data science", "data science basics"],
  "introduction to cyber security": ["intro to cyber security", "cybersecurity basics"],
  "python for engineers": ["python", "python programming", "ppe"],
  "web designing": ["web design"],
  "communication skills": ["communication", "soft skills"],
  "foreign language": ["foreign lang", "language"],
  "indian knowledge system": ["iks", "indian knowledge"],
  "innovation and entrepreneurship": ["innovation entrepreneurship", "entrepreneurship"],
  "introduction to ai": ["intro to ai", "fundamentals of ai", "ai basics"],
  "semiconductor physics and devices": ["spd", "semiconductor devices", "semiconductor physics"],
  "semiconductor physics and devices lab": ["spd lab", "semiconductor lab"],
};

function normalizeForMatch(input: string): string {
  return input
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildSubjectAliases(subject: string): string[] {
  const normalized = normalizeForMatch(subject);
  const aliases = new Set<string>([normalized]);
  aliases.add(normalized.replace(/\bfor engineers\b/g, "").trim());
  aliases.add(normalized.replace(/\bintroduction to\b/g, "").trim());
  aliases.add(normalized.replace(/\blab\b/g, "").trim());

  const overrides = subjectAliasOverrides[normalized] ?? [];
  for (const entry of overrides) {
    aliases.add(normalizeForMatch(entry));
  }

  // Keep short academic abbreviations like "ds", "ai", "cfe", "pps", "spd", "lae".
  return [...aliases].filter((entry) => entry.length >= 2);
}

function findSubjectInCatalog(
  textParts: string[],
  catalog: string[] | null | undefined,
): string | null {
  if (!catalog?.length) return null;
  const normalizedText = normalizeForMatch(textParts.filter(Boolean).join(" "));
  if (!normalizedText) return null;

  let best: { subject: string; score: number } | null = null;
  for (const subject of catalog) {
    const aliases = buildSubjectAliases(subject);
    let score = 0;
    for (const alias of aliases) {
      if (!alias) continue;
      const pattern = new RegExp(`(?:^|\\s)${escapeRegex(alias)}(?:\\s|$)`, "i");
      if (pattern.test(normalizedText)) {
        score = Math.max(score, alias.split(" ").length * 10);
      }
    }

    if (score > 0 && (!best || score > best.score)) {
      best = { subject, score };
    }
  }

  return best?.subject ?? null;
}

function normalizeSubjectToCatalog(
  subject: string | null | undefined,
  catalog: string[] | null | undefined,
): string | null {
  if (!subject || !catalog?.length) return null;
  const normalized = normalizeForMatch(subject);
  if (!normalized) return null;

  for (const candidate of catalog) {
    const aliases = buildSubjectAliases(candidate);
    if (aliases.includes(normalized)) {
      return candidate;
    }
  }

  for (const candidate of catalog) {
    const aliases = buildSubjectAliases(candidate);
    if (aliases.some((alias) => normalized.includes(alias) || alias.includes(normalized))) {
      return candidate;
    }
  }

  return null;
}

function weightedKeywordScore(text: string, keywords: WeightedSignal[]): number {
  const normalized = safeLower(text);
  let score = 0;
  for (const { keyword, weight } of keywords) {
    if (normalized.includes(keyword)) {
      score += weight;
    }
  }
  return score;
}

function deriveCategoryFromSignals(args: {
  focusText: string;
  captionText: string;
  sampleText: string;
}): { category: DocCategory; score: number; margin: number } | null {
  const focus = args.focusText;
  const caption = args.captionText;
  const sample = args.sampleText;

  const scores: Record<DocCategory, number> = {
    syllabus: 0,
    notice: 0,
    resource: 0,
  };

  // Highest trust: filename + first heading.
  scores.syllabus += weightedKeywordScore(focus, syllabusWeightedSignals) * 4;
  scores.notice += weightedKeywordScore(focus, noticeWeightedSignals) * 4;
  scores.resource += weightedKeywordScore(focus, resourceWeightedSignals) * 4;

  // Medium trust: caption.
  scores.syllabus += weightedKeywordScore(caption, syllabusWeightedSignals) * 2;
  scores.notice += weightedKeywordScore(caption, noticeWeightedSignals) * 2;
  scores.resource += weightedKeywordScore(caption, resourceWeightedSignals) * 2;

  // Lowest trust: body sample can be noisy but still useful.
  scores.syllabus += weightedKeywordScore(sample, syllabusWeightedSignals);
  scores.notice += weightedKeywordScore(sample, noticeWeightedSignals);
  scores.resource += weightedKeywordScore(sample, resourceWeightedSignals);

  if (antiSyllabusPhrases.some((phrase) => sample.includes(phrase))) {
    scores.syllabus = Math.max(0, scores.syllabus - 6);
  }

  const ranked = (Object.entries(scores) as Array<[DocCategory, number]>).sort(
    (a, b) => b[1] - a[1],
  );
  const [topCategory, topScore] = ranked[0];
  const secondScore = ranked[1]?.[1] ?? 0;
  const margin = topScore - secondScore;

  if (topScore <= 0) return null;
  return {
    category: topCategory,
    score: topScore,
    margin,
  };
}

function deriveRuleClassification(
  event: OpenClawDocumentEvent,
  heading: string,
  groupBinding: GroupBinding,
): ClassificationResult | null {
  const focusText = safeLower(`${event.filename} ${heading}`.trim());
  const signal = deriveCategoryFromSignals({
    focusText,
    captionText: "",
    sampleText: "",
  });
  if (!signal) {
    return null;
  }
  if (signal.score < 10 || signal.margin < 3) {
    return null;
  }
  const category = signal.category;
  const title = heading || event.filename.replace(/\.pdf$/i, "").trim();

  return {
    category,
    confidence: category === "resource" ? 0.84 : 0.9,
    title: title.slice(0, 220),
    summary: `Auto-classified from filename/heading in ${groupBinding.group_title}`.slice(0, 280),
    department: groupBinding.department_code,
    branch: groupBinding.default_branch,
    semester: groupBinding.default_semester,
    subject: groupBinding.default_subject,
    priority: category === "notice" ? "high" : "normal",
    source: "rules",
  };
}

function deriveHeuristicFallbackClassification(
  input: LlmInput,
  reason: string,
): ClassificationResult {
  const signal = deriveCategoryFromSignals({
    focusText: safeLower(`${input.event.filename} ${input.heading}`.trim()),
    captionText: safeLower(input.event.caption ?? ""),
    sampleText: safeLower(`${input.textSample} ${input.fullTextSample}`.trim()),
  });

  const fallbackCategory: DocCategory = signal?.category ?? "resource";
  const baseConfidence =
    fallbackCategory === "resource" ? 0.46 : fallbackCategory === "notice" ? 0.52 : 0.55;
  const confidenceBoost = signal ? Math.min(0.22, signal.score / 100 + signal.margin / 25) : 0;
  const confidence = clampConfidence(baseConfidence + confidenceBoost);

  return {
    category: fallbackCategory,
    confidence,
    title: (input.heading || input.event.filename.replace(/\.pdf$/i, "")).slice(0, 220),
    summary: `Fallback classification used (${reason})`.slice(0, 280),
    department: input.groupBinding.department_code,
    branch: input.groupBinding.default_branch,
    semester: input.groupBinding.default_semester,
    subject: input.groupBinding.default_subject,
    priority: fallbackCategory === "notice" ? "high" : "normal",
    source: "rules",
  };
}

interface LlmInput {
  event: OpenClawDocumentEvent;
  heading: string;
  textSample: string;
  fullTextSample: string;
  groupBinding: GroupBinding;
  subjectCatalog: string[] | null | undefined;
}

import path from "path";
import { fileURLToPath } from "url";

const thisDir = path.dirname(fileURLToPath(import.meta.url));

async function readPrompt(fileName: string): Promise<string> {
  const dockerPath = `/app/prompts/${fileName}`;
  try {
    return await fs.readFile(dockerPath, "utf8");
  } catch {
    const localPath = path.resolve(thisDir, "../../prompts", fileName);
    return await fs.readFile(localPath, "utf8");
  }
}

async function classifyWithLlm(input: LlmInput): Promise<ClassificationResult> {
  if (!config.enableLlmClassifier || !config.GEMINI_API_KEY) {
    throw new Error("llm_disabled");
  }

  const [systemPrompt, userTemplate] = await Promise.all([
    readPrompt("classifier-system.txt"),
    readPrompt("classifier-user-template.txt"),
  ]);

  const userPrompt = userTemplate
    .replace("{{group_title}}", input.groupBinding.group_title)
    .replace("{{filename}}", input.event.filename)
    .replace("{{caption}}", input.event.caption ?? "")
    .replace("{{first_page_heading}}", input.heading)
    .replace("{{first_page_text_sample}}", input.textSample)
    .replace("{{full_text_sample}}", input.fullTextSample)
    .replace(
      "{{subject_catalog}}",
      input.subjectCatalog?.length ? input.subjectCatalog.join(" | ") : "none",
    );

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${config.GEMINI_MODEL}:generateContent?key=${config.GEMINI_API_KEY}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: systemPrompt }],
      },
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`llm_http_${response.status}`);
  }

  const payload = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };

  const jsonText = payload.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!jsonText) {
    throw new Error("llm_empty_response");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error("llm_invalid_json");
  }

  const validated = llmSchema.parse(parsed);

  return {
    ...validated,
    confidence: clampConfidence(validated.confidence),
    source: "llm",
  };
}

interface ClassifyInput {
  event: OpenClawDocumentEvent;
  heading: string;
  textSample: string;
  fullTextSample: string;
  groupBinding: GroupBinding;
}

export async function classifyDocument(input: ClassifyInput): Promise<ClassificationResult> {
  const subjectCatalog = input.groupBinding.subject_catalog;
  const signalParts = [
    input.event.filename,
    input.event.caption ?? "",
    input.heading,
    input.textSample,
    input.fullTextSample,
  ];

  const ruleHit = deriveRuleClassification(input.event, input.heading, input.groupBinding);
  if (ruleHit) {
    const normalizedSubject =
      normalizeSubjectToCatalog(ruleHit.subject, subjectCatalog) ??
      findSubjectInCatalog(signalParts, subjectCatalog) ??
      ruleHit.subject;
    return {
      ...ruleHit,
      subject: normalizedSubject,
    };
  }

  let llmResult: ClassificationResult;
  try {
    llmResult = await classifyWithLlm({
      event: input.event,
      heading: input.heading,
      textSample: input.textSample,
      fullTextSample: input.fullTextSample,
      groupBinding: input.groupBinding,
      subjectCatalog,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "llm_unavailable";
    const fallbackSubject = findSubjectInCatalog(signalParts, subjectCatalog);
    const heuristic = deriveHeuristicFallbackClassification(
      {
        event: input.event,
        heading: input.heading,
        textSample: input.textSample,
        fullTextSample: input.fullTextSample,
        groupBinding: input.groupBinding,
        subjectCatalog,
      },
      reason,
    );
    return {
      ...heuristic,
      subject: fallbackSubject ?? heuristic.subject,
    };
  }

  const normalizedSubject =
    normalizeSubjectToCatalog(llmResult.subject, subjectCatalog) ??
    findSubjectInCatalog(signalParts, subjectCatalog) ??
    llmResult.subject;

  return {
    ...llmResult,
    subject: normalizedSubject,
  };
}

export function detectSubjectFromCatalog(
  textParts: string[],
  catalog: string[] | null | undefined,
): string | null {
  return findSubjectInCatalog(textParts, catalog);
}

export function normalizeSubjectFromCatalog(
  subject: string | null | undefined,
  catalog: string[] | null | undefined,
): string | null {
  return normalizeSubjectToCatalog(subject, catalog);
}
