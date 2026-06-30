import { config } from "./config.js";

async function postWebhook(url: string, payload: Record<string, unknown>): Promise<void> {
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function sendOpsAlert(
  message: string,
  context?: Record<string, unknown>,
): Promise<void> {
  if (!config.OPS_ALERT_WEBHOOK_URL) {
    return;
  }

  const payload = {
    text: `[studyshare-wa-automation] ${message}`,
    context: context ?? {},
    timestamp: new Date().toISOString(),
  };

  try {
    await postWebhook(config.OPS_ALERT_WEBHOOK_URL, payload);
  } catch (error) {
    console.error("[alert] failed to send alert", error);
  }
}

interface ReviewNotificationInput {
  reviewId: string;
  eventId: string;
  reason: string;
  groupJid: string;
  groupTitle?: string | null;
  fileName: string;
  category: string;
  confidence: number;
}

export async function sendReviewApprovalRequest(input: ReviewNotificationInput): Promise<void> {
  const text = [
    "[studyshare-wa-automation] Approval required",
    `Review ID: ${input.reviewId}`,
    `Event ID: ${input.eventId}`,
    `Group: ${input.groupTitle || input.groupJid}`,
    `File: ${input.fileName}`,
    `Category: ${input.category}`,
    `Confidence: ${input.confidence.toFixed(2)}`,
    `Reason: ${input.reason}`,
    `Action: /approve ${input.reviewId}  |  /reject ${input.reviewId}`,
  ].join("\n");

  const payload = {
    text,
    message: text,
    type: "manual_review_required",
    reviewId: input.reviewId,
    eventId: input.eventId,
    reason: input.reason,
    timestamp: new Date().toISOString(),
  };

  const targetWebhook = config.MOLTBOT_REVIEW_NOTIFY_WEBHOOK_URL || config.OPS_ALERT_WEBHOOK_URL;
  if (!targetWebhook) return;

  try {
    await postWebhook(targetWebhook, payload);
  } catch (error) {
    console.error("[alert] failed to send review notification", error);
  }
}
