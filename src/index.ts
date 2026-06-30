import express, { NextFunction, Request, Response } from "express";
import { runResourceBackfill } from "./backfillService.js";
import { handleChatMessage } from "./chatService.js";
import { config } from "./config.js";
import {
  ensureRuntimeSchema,
  getIngestDashboardStats,
  getIngestSourceBreakdown,
  getLiveActivity,
  getRecentPostedResources,
  markPostedResourceRetracted,
  getPendingReviews,
} from "./db.js";
import { ingestOpenClawEvent } from "./ingestService.js";
import { approveReview, rejectReview } from "./reviewService.js";
import { deleteAdminResource, getResourceMetadataByIds } from "./studyshareClient.js";

const app = express();

// CORS for Vercel-hosted dashboard accessing local backend
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, PATCH, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.sendStatus(200);
    return;
  }
  next();
});

app.use(express.json({ limit: `${config.INGEST_BODY_LIMIT_MB}mb` }));
app.use("/chat", express.static("/app/chat"));

app.get("/", (_req, res) => {
  res.redirect("/chat");
});

app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    service: "studyshare-whatsapp-ingest",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
  });
});

app.get("/v1/dashboard", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Number(req.query.limit ?? 10);
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 50) : 10;
    const liveLimit = Number(req.query.liveLimit ?? 30);
    const safeLiveLimit = Number.isFinite(liveLimit) ? Math.min(Math.max(liveLimit, 5), 100) : 30;
    const [stats, pending, live, sources] = await Promise.all([
      getIngestDashboardStats(),
      getPendingReviews(safeLimit),
      getLiveActivity(safeLiveLimit),
      getIngestSourceBreakdown(24),
    ]);

    const resourceIds = live
      .filter(
        (item) =>
          item.posted_entity_id &&
          (item.posted_entity_type === "resource" || item.posted_entity_type === "resource_update"),
      )
      .map((item) => item.posted_entity_id as string);

    const resourceMeta = await getResourceMetadataByIds(resourceIds);
    const enrichedLive = live.map((item) => ({
      ...item,
      app_resource: item.posted_entity_id ? (resourceMeta[item.posted_entity_id] ?? null) : null,
    }));

    res.json({
      ok: true,
      stats,
      pending,
      live: enrichedLive,
      sources,
      uptimeSeconds: Math.floor(process.uptime()),
      llmEnabled: config.enableLlmClassifier,
      chatWebhookConfigured: Boolean(config.MOLTBOT_CHAT_WEBHOOK_URL),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/v1/ingest", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await ingestOpenClawEvent(req.body);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/v1/review/pending", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Number(req.query.limit ?? 20);
    const rows = await getPendingReviews(
      Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 20,
    );
    res.json({ items: rows });
  } catch (error) {
    next(error);
  }
});

app.post("/v1/review/:id/approve", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const reviewId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const reviewer = (req.body?.reviewer as string | undefined) ?? "n8n-operator";
    const result = await approveReview(reviewId, reviewer, req.body?.overrides);
    res.json({ success: true, result });
  } catch (error) {
    next(error);
  }
});

app.post("/v1/review/:id/reject", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const reviewId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const reviewer = (req.body?.reviewer as string | undefined) ?? "n8n-operator";
    const note = req.body?.note as string | undefined;
    await rejectReview(reviewId, reviewer, note);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.post("/v1/chat", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const message = (req.body?.message as string | undefined) ?? "";
    const reply = await handleChatMessage(message);
    res.json(reply);
  } catch (error) {
    next(error);
  }
});

app.post(
  "/v1/backfill/resources/remap",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await runResourceBackfill(req.body ?? {});
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

app.post("/v1/retract/resource/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const resourceId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const reviewer = (req.body?.reviewer as string | undefined) ?? "chat-ui";
    const collegeId = (req.body?.collegeId as string | undefined) ?? null;

    await deleteAdminResource({
      resourceId,
      collegeId,
      idempotencyKey: `retract:${resourceId}:${Date.now()}`,
    });

    const touched = await markPostedResourceRetracted(resourceId, reviewer);
    res.json({ success: true, resourceId, touchedEvents: touched });
  } catch (error) {
    next(error);
  }
});

app.post("/v1/retract/recent", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limitRaw = Number(req.body?.limit ?? 5);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 30) : 5;
    const reviewer = (req.body?.reviewer as string | undefined) ?? "chat-ui";
    const dryRun = Boolean(req.body?.dryRun);
    const source = typeof req.body?.source === "string" ? req.body.source.trim() : "";
    const senderLike = source || null;

    const candidates = await getRecentPostedResources(limit, senderLike);
    if (dryRun) {
      res.json({
        success: true,
        dryRun: true,
        requestedLimit: limit,
        matched: candidates.length,
        items: candidates,
      });
      return;
    }

    const results: Array<{
      resourceId: string;
      title: string | null;
      touchedEvents: number;
      ok: boolean;
      error?: string;
    }> = [];

    for (let i = 0; i < candidates.length; i += 1) {
      const item = candidates[i];
      try {
        await deleteAdminResource({
          resourceId: item.resource_id,
          collegeId: null,
          idempotencyKey: `retract:recent:${item.resource_id}:${Date.now()}:${i}`,
        });
        const touched = await markPostedResourceRetracted(item.resource_id, reviewer);
        results.push({
          resourceId: item.resource_id,
          title: item.title ?? null,
          touchedEvents: touched,
          ok: true,
        });
      } catch (error) {
        results.push({
          resourceId: item.resource_id,
          title: item.title ?? null,
          touchedEvents: 0,
          ok: false,
          error: error instanceof Error ? error.message : "unknown_error",
        });
      }
    }

    const deleted = results.filter((row) => row.ok).length;
    const failed = results.length - deleted;
    res.json({
      success: failed === 0,
      requestedLimit: limit,
      matched: candidates.length,
      deleted,
      failed,
      results,
    });
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const detail = error instanceof Error ? error.message : "unknown_error";
  const status = detail.includes("not_found")
    ? 404
    : detail.includes("not_pending")
      ? 409
      : detail.includes("ZodError")
        ? 400
        : 500;

  console.error("[ingest-service] request failed", error);
  res.status(status).json({ error: detail });
});

async function bootstrap() {
  await ensureRuntimeSchema();
  app.listen(config.PORT, () => {
    console.log(`[ingest-service] listening on :${config.PORT}`);
  });
}

bootstrap().catch((error) => {
  console.error("[ingest-service] startup failed", error);
  process.exit(1);
});
