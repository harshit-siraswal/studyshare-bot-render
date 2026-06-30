import { z } from "zod";
import { config } from "./config.js";

const plannerOutputSchema = z
  .object({
    type: z.enum(["command", "answer"]),
    command: z.string().optional(),
    answer: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.type === "command" && (!value.command || !value.command.trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "command_required_for_command_type",
      });
    }

    if (value.type === "answer" && (!value.answer || !value.answer.trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "answer_required_for_answer_type",
      });
    }
  });

export interface ChatAgentContext {
  stats?: {
    received24h?: number;
    posted24h?: number;
    failed24h?: number;
    pendingReviews?: number;
  } | null;
}

export interface ChatAgentPlan {
  type: "command" | "answer";
  command?: string;
  answer?: string;
  confidence?: number;
}

function extractFirstJsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("chat_agent_invalid_json_block");
  }
  return text.slice(start, end + 1);
}

const SYSTEM_PROMPT = `
You are StudyShareClaw Command Planner.

Goal:
- Convert a user's plain-language admin request into either:
  1) one supported slash command, or
  2) a concise direct answer when no command should run.

Rules:
- Never invent unsupported commands.
- Prefer command execution for operational tasks.
- Only use one command at a time.
- If request is ambiguous or unsafe, answer with clarification.
- Keep answers concise and actionable.

Supported commands:
- /help
- /health
- /status
- /pending
- /review <reviewId>
- /view <reviewId>
- /duplicates [strict|file|loose|ocr] [recent <count>]
- /duplicates delete [strict|file|loose|ocr] [maxDeletes] [recent <count>]
- /approve <reviewId>
- /reject <reviewId> [note]
- /retract <resourceId>
- /retract last [count] [source]

Output format:
- Return JSON only.
- Schema:
{
  "type": "command" | "answer",
  "command": "/status",
  "answer": "string",
  "confidence": 0.0
}
`;

export async function planChatAction(
  message: string,
  context: ChatAgentContext,
): Promise<ChatAgentPlan> {
  if (!config.enableChatAgent) {
    throw new Error("chat_agent_disabled");
  }
  if (!config.GEMINI_API_KEY) {
    throw new Error("chat_agent_key_missing");
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${config.CHAT_AGENT_MODEL}:generateContent?key=${config.GEMINI_API_KEY}`;
  const userPrompt = [
    "User message:",
    message,
    "",
    "Context snapshot:",
    JSON.stringify(context ?? {}, null, 2),
  ].join("\n");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: SYSTEM_PROMPT }],
      },
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`chat_agent_http_${response.status}`);
  }

  const payload = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const rawText = payload.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  if (!rawText.trim()) {
    throw new Error("chat_agent_empty_response");
  }

  const jsonText = extractFirstJsonObject(rawText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error("chat_agent_invalid_json");
  }

  const plan = plannerOutputSchema.parse(parsed);
  if (plan.type === "command") {
    const command = String(plan.command ?? "").trim();
    if (!command.startsWith("/")) {
      throw new Error("chat_agent_command_missing_slash");
    }
  }

  return {
    type: plan.type,
    command: plan.command?.trim(),
    answer: plan.answer?.trim(),
    confidence: plan.confidence,
  };
}
