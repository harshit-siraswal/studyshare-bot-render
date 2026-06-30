import { OpenClawDocumentEvent } from "./types.js";

export interface DrivePathInference {
  isDriveImport: boolean;
  drivePath: string | null;
  tokens: string[];
  branch: string | null;
  semester: string | null;
  subject: string | null;
}

function normalizeForMatch(input: string): string {
  return input
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleCase(input: string): string {
  return input
    .split(" ")
    .filter(Boolean)
    .map((word) => {
      if (word.length <= 4 && /^[a-z]+$/i.test(word)) return word.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

export function normalizeBranchCode(input: string | null | undefined): string | null {
  const normalized = normalizeForMatch(input ?? "");
  if (!normalized) return null;

  if (
    [
      "aiml",
      "ai ml",
      "ai and ml",
      "cse ai ml",
      "cse aiml",
      "cse ai and ml",
      "cse aiml",
      "cse ai ml",
      "cse aiandml",
    ].includes(normalized)
  ) {
    return "aiml";
  }

  if (
    ["cse ai", "cse artificial intelligence", "artificial intelligence", "ai"].includes(normalized)
  ) {
    return "cse_ai";
  }

  if (["cse", "computer science", "computer science engineering"].includes(normalized))
    return "cse";
  if (["it", "information technology", "csit"].includes(normalized)) return "it";
  if (["ds", "data science", "cse ds"].includes(normalized)) return "ds";
  if (["cse cs", "cyber security", "cybersecurity", "cse cybersecurity"].includes(normalized))
    return "cse_cs";
  if (["me", "mechanical", "mechanical engineering"].includes(normalized)) return "me";
  if (["amia", "am ia", "advanced mechatronics and industrial automation"].includes(normalized))
    return "amia";
  if (["elce", "electrical and computer engineering"].includes(normalized)) return "elce";
  if (["eee", "electrical and electronics engineering"].includes(normalized)) return "eee";
  if (["ece", "electronics and communication engineering"].includes(normalized)) return "ece";
  if (["ece vlsi", "vlsi", "ece vlsi design and technology"].includes(normalized))
    return "ece_vlsi";
  if (["ce", "civil engineering"].includes(normalized)) return "ce";

  return normalized.replace(/\s+/g, "_");
}

export function isStructuredDriveImport(event: OpenClawDocumentEvent): boolean {
  const sender = (event.sender ?? "").toLowerCase().trim();
  const caption = (event.caption ?? "").toLowerCase();
  return sender === "gdrive-import@studyshare" && caption.includes("drive path:");
}

function extractDrivePath(caption: string | null | undefined): string | null {
  const raw = String(caption ?? "").trim();
  if (!raw) return null;
  const marker = raw.toLowerCase().indexOf("drive path:");
  if (marker < 0) return null;
  let segment = raw.slice(marker + "drive path:".length).trim();
  segment = segment.replace(/\|\s*auto-imported from google drive folder.*$/i, "").trim();
  return segment || null;
}

function splitPathTokens(path: string | null): string[] {
  if (!path) return [];
  return path
    .split(/[|/\\>]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function detectSemesterFromText(text: string): string | null {
  const normalized = normalizeForMatch(text);
  if (!normalized) return null;

  const semMatch = normalized.match(/\bsem(?:ester)?\s*([1-8])\b/);
  if (semMatch?.[1]) return semMatch[1];

  const ordinalSem = normalized.match(/\b([1-8])(st|nd|rd|th)\s*sem(?:ester)?\b/);
  if (ordinalSem?.[1]) return ordinalSem[1];

  return null;
}

function detectBranchFromTokens(tokens: string[], fallbackBranch?: string | null): string | null {
  for (const token of tokens) {
    const normalized = normalizeBranchCode(token);
    if (!normalized) continue;
    if (
      [
        "aiml",
        "cse_ai",
        "cse",
        "it",
        "ds",
        "cse_cs",
        "me",
        "amia",
        "elce",
        "eee",
        "ece",
        "ece_vlsi",
        "ce",
      ].includes(normalized)
    ) {
      return normalized;
    }
  }
  return normalizeBranchCode(fallbackBranch);
}

const subjectHints: Array<{ pattern: RegExp; subject: string; semester?: string }> = [
  {
    pattern: /\bcfe\b|\bcalculus\b|\bmaths?\b|\bmathematics\b/i,
    subject: "Calculus for Engineers",
    semester: "1",
  },
  { pattern: /\bchem\b|\bchemistry\b/i, subject: "Environmental Chemistry", semester: "2" },
  {
    pattern:
      /\bcold\b|\bco and ld\b|\bco ld\b|\bco&ld\b|\blogic design\b|\bcomputer organization\b/i,
    subject: "Computer Organization and Logic Design",
    semester: "1",
  },
  {
    pattern: /\bdstl\b|\bdiscrete\b|\btheory of logic\b/i,
    subject: "Discrete Structures and Theory of Logic",
    semester: "1",
  },
  {
    pattern: /\bpps\b|\bproblem solving\b|\bc programming\b/i,
    subject: "Programming for Problem Solving",
    semester: "1",
  },
  {
    pattern: /\bspd\b|\bsemiconductor\b/i,
    subject: "Semiconductor Physics and Devices",
    semester: "1",
  },
  {
    pattern: /\blae\b|\blinear algebra\b/i,
    subject: "Linear Algebra for Engineers",
    semester: "2",
  },
  { pattern: /\bpython\b|\bppe\b/i, subject: "Python for Engineers", semester: "2" },
  { pattern: /\bdata structure\b|\bdsa\b/i, subject: "Data Structure", semester: "2" },
  { pattern: /\bintro(duction)? to ai\b/i, subject: "Introduction to AI", semester: "2" },
  { pattern: /\bspanish\b/i, subject: "Basic Proficiency in Spanish", semester: "2" },
  {
    pattern: /\binnovation\b|\bentrepreneurship\b/i,
    subject: "Innovation and Entrepreneurship",
    semester: "2",
  },
  { pattern: /\bdbms\b|\bdatabase management\b/i, subject: "Database Management Systems" },
  { pattern: /\boops?\b|\bobject oriented\b|\bjava\b/i, subject: "Object Oriented Programming" },
  { pattern: /\boperating system\b|\bos\b/i, subject: "Operating Systems" },
  {
    pattern: /\bp\s*&\s*s\b|\bprobability and statistics\b|\bstatistics\b/i,
    subject: "Probability and Statistics",
  },
  { pattern: /\bai\b|\bartificial intelligence\b/i, subject: "Artificial Intelligence" },
];

function detectSubjectFromCorpus(corpus: string): {
  subject: string | null;
  semester: string | null;
} {
  for (const hint of subjectHints) {
    if (hint.pattern.test(corpus)) {
      return { subject: hint.subject, semester: hint.semester ?? null };
    }
  }
  return { subject: null, semester: null };
}

function isGenericPathToken(token: string): boolean {
  const normalized = normalizeForMatch(token);
  if (!normalized) return true;
  if (detectSemesterFromText(normalized)) return true;
  if (/^\d+(st|nd|rd|th)\s*year$/.test(normalized)) return true;
  if (
    [
      "year",
      "first year",
      "second year",
      "third year",
      "fourth year",
      "notes",
      "study material",
      "question bank",
      "practice sheet",
      "practice sheets",
      "model paper",
      "model papers",
      "lab",
      "labs",
      "lab manual",
      "unit 1",
      "unit 2",
      "unit 3",
      "unit 4",
      "unit 5",
    ].includes(normalized)
  ) {
    return true;
  }
  return false;
}

function fallbackSubjectFromTokens(tokens: string[]): string | null {
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const token = tokens[i];
    if (!token || isGenericPathToken(token)) continue;
    if (normalizeBranchCode(token)) continue;
    const clean = token.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
    if (!clean) continue;
    return titleCase(clean);
  }
  return null;
}

export function inferDrivePathMapping(args: {
  event: OpenClawDocumentEvent;
  heading?: string;
  textSample?: string;
  fallbackBranch?: string | null;
}): DrivePathInference {
  const drivePath = extractDrivePath(args.event.caption);
  const tokens = splitPathTokens(drivePath);
  const isDriveImport = isStructuredDriveImport(args.event);

  let semester: string | null = null;
  for (const token of tokens) {
    semester = detectSemesterFromText(token);
    if (semester) break;
  }

  const branch = detectBranchFromTokens(tokens, args.fallbackBranch);

  const corpus = [
    tokens.join(" "),
    args.event.filename ?? "",
    args.heading ?? "",
    args.textSample ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  const subjectFromHints = detectSubjectFromCorpus(corpus);
  const subject = subjectFromHints.subject ?? fallbackSubjectFromTokens(tokens);
  if (!semester && subjectFromHints.semester) {
    semester = subjectFromHints.semester;
  }

  return {
    isDriveImport,
    drivePath,
    tokens,
    branch,
    semester,
    subject,
  };
}
