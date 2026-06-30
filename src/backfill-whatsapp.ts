import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import {
  makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
  WAMessage,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import dotenv from "dotenv";
import pg from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env from studyshare-whatsapp-automation/.env
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const logger = {
  level: "silent",
  child: () => logger,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
} as any;
const authDir = path.resolve(__dirname, "../../openclaw-state/whatsapp/studyshare");
const allowlistFile = path.resolve(
  __dirname,
  "../../openclaw-workspace/hooks/whatsapp-pdf-forwarder/allowlist.txt",
);

// Parse Postgres DB URL
let dbUrl = process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/studyshare_wa";
if (dbUrl.includes("@postgres:")) {
  dbUrl = dbUrl.replace("@postgres:", "@localhost:");
}

const pool = new pg.Pool({ connectionString: dbUrl });

const YOUTUBE_REGEX =
  /(https?:\/\/(?:www\.)?(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?)\/|\S*?[?&]v=)|youtu\.be\/)[a-zA-Z0-9_-]{11})/i;

function extractYoutubeUrl(text: string | null | undefined): string | null {
  if (!text || typeof text !== "string") return null;
  const match = text.match(YOUTUBE_REGEX);
  return match ? match[1] : null;
}

async function loadAllowlist(): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(allowlistFile, "utf8");
    return new Set(
      raw
        .split(/\r?\n/g)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#")),
    );
  } catch (error) {
    console.error(`Failed to read allowlist.txt:`, error);
    return new Set();
  }
}

async function isMessageAlreadyIngested(groupJid: string, messageId: string): Promise<boolean> {
  const result = await pool.query(
    "SELECT 1 FROM wa_ingest_events WHERE group_jid = $1 AND wa_message_id = $2 LIMIT 1",
    [groupJid, messageId],
  );
  return result.rowCount ? result.rowCount > 0 : false;
}

async function postToIngestService(payload: any) {
  const url = `http://127.0.0.1:${process.env.PORT || 8080}/v1/ingest`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ingest HTTP error ${response.status}: ${text}`);
  }
  return response.json();
}

async function runBackfill() {
  const allowlist = await loadAllowlist();
  if (allowlist.size === 0) {
    console.error("Allowlist is empty. Add group JIDs to allowlist.txt");
    process.exit(1);
  }

  console.log(`Loaded ${allowlist.size} group(s) from allowlist.txt:`, [...allowlist]);
  console.log(`Connecting to WhatsApp with auth directory: ${authDir}...`);

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    version,
    logger,
    browser: ["openclaw", "cli", "2026.3.3"],
    syncFullHistory: true, // We want history to sync on connect
  });

  sock.ev.on("creds.update", saveCreds);

  await new Promise<void>((resolve, reject) => {
    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === "open") {
        console.log("WhatsApp connection opened successfully.");
        resolve();
      } else if (connection === "close") {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        console.log(`Connection closed with code: ${statusCode}`);
        if (statusCode === 401) {
          reject(new Error("WhatsApp session unauthorized or logged out. Please log in first."));
        }
      }
    });
  });

  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  console.log(`Backfill window start date: ${oneYearAgo.toISOString()}`);

  // We set up a general messaging-history listener that will accumulate messages for our chats
  const historyStore = new Map<string, any[]>();

  sock.ev.on("messaging-history.set", ({ messages, syncType }) => {
    console.log(
      `Received history sync batch of ${messages.length} messages (SyncType: ${syncType})`,
    );
    for (const msg of messages) {
      const jid = msg.key.remoteJid;
      if (jid && allowlist.has(jid)) {
        const list = historyStore.get(jid) || [];
        list.push(msg);
        historyStore.set(jid, list);
      }
    }
  });

  // Wait 15 seconds to allow the initial messaging history sync to deliver standard/full history
  console.log("Waiting 15 seconds for initial WhatsApp history sync to complete...");
  await new Promise((r) => setTimeout(r, 15000));

  for (const groupJid of allowlist) {
    console.log(`\n==========================================`);
    console.log(`Processing Group JID: ${groupJid}`);
    console.log(`==========================================`);

    let groupMessages = historyStore.get(groupJid) || [];
    console.log(`Initially synced messages for this group: ${groupMessages.length}`);

    let oldestKey = null;
    let oldestTimestamp = Date.now();

    if (groupMessages.length > 0) {
      // Sort in descending order of timestamp (newest to oldest)
      groupMessages.sort((a, b) => (b.messageTimestamp as number) - (a.messageTimestamp as number));
      const oldestMsg = groupMessages[groupMessages.length - 1];
      oldestKey = oldestMsg.key;
      oldestTimestamp = (oldestMsg.messageTimestamp as number) * 1000;
    } else {
      console.log(
        `No initial messages found for group ${groupJid}. Sending a temp message to anchor history...`,
      );
      try {
        const tempMsg = await sock.sendMessage(groupJid, {
          text: "🔄 OpenClaw backfill anchoring...",
        });
        if (tempMsg) {
          console.log(`Sent anchor message: ${tempMsg.key.id}`);
          oldestKey = tempMsg.key;
          oldestTimestamp = (tempMsg.messageTimestamp as number) * 1000;

          // Delete the anchor message immediately to keep the chat clean
          try {
            await sock.sendMessage(groupJid, { delete: tempMsg.key });
            console.log(`Deleted anchor message: ${tempMsg.key.id}`);
          } catch (delErr) {
            console.warn(`Failed to delete anchor message:`, delErr);
          }
        }
      } catch (sendErr) {
        console.error(`Failed to send anchor message to group ${groupJid}:`, sendErr);
      }
    }

    let page = 1;
    let newMessagesFound = true;

    while (oldestTimestamp > oneYearAgo.getTime() && newMessagesFound) {
      console.log(
        `[Page ${page}] Fetching history older than ${new Date(oldestTimestamp).toISOString()}...`,
      );

      const onBatchPromise = new Promise<{ oldestMsgKey: any; oldestTime: number; count: number }>(
        (resolve) => {
          const handler = ({ messages, syncType }: any) => {
            if (syncType !== "ON_DEMAND") return;
            const filtered = messages.filter((m: any) => m.key.remoteJid === groupJid);
            if (filtered.length === 0) return;

            // Find the oldest message in the batch
            filtered.sort(
              (a: any, b: any) => (a.messageTimestamp as number) - (b.messageTimestamp as number),
            );
            const oldest = filtered[0];
            const oldestTime = (oldest.messageTimestamp as number) * 1000;

            sock.ev.off("messaging-history.set", handler);
            resolve({
              oldestMsgKey: oldest.key,
              oldestTime,
              count: filtered.length,
            });
          };

          sock.ev.on("messaging-history.set", handler);

          // Timeout fallback
          setTimeout(() => {
            sock.ev.off("messaging-history.set", handler);
            resolve({ oldestMsgKey: null, oldestTime: 0, count: 0 });
          }, 8000);
        },
      );

      try {
        await sock.fetchMessageHistory(
          groupJid,
          50,
          oldestKey || undefined,
          Math.floor(oldestTimestamp / 1000),
        );
        const batchResult = await onBatchPromise;

        if (batchResult.count === 0 || !batchResult.oldestMsgKey) {
          console.log(
            `No more historical messages returned for group ${groupJid} on page ${page}.`,
          );
          newMessagesFound = false;
          break;
        }

        oldestKey = batchResult.oldestMsgKey;
        oldestTimestamp = batchResult.oldestTime;
        console.log(
          `Received ${batchResult.count} messages. Oldest timestamp is now ${new Date(oldestTimestamp).toISOString()}`,
        );
        page++;
      } catch (err) {
        console.error(`Error fetching message history:`, err);
        newMessagesFound = false;
        break;
      }
    }

    // Now re-fetch all historical messages accumulated for this group, filter, and process them
    const allGroupMessages = historyStore.get(groupJid) || [];
    // Sort oldest to newest for chronological processing
    allGroupMessages.sort(
      (a, b) => (a.messageTimestamp as number) - (b.messageTimestamp as number),
    );

    console.log(`Total messages retrieved for group ${groupJid}: ${allGroupMessages.length}`);
    let pdfCount = 0;
    let youtubeCount = 0;

    for (const msg of allGroupMessages) {
      const msgTime = new Date((msg.messageTimestamp as number) * 1000);
      if (msgTime < oneYearAgo) continue;

      const messageId = msg.key.id;
      if (!messageId) continue;

      // 1. Check if message is already in our DB
      const alreadyIngested = await isMessageAlreadyIngested(groupJid, messageId);
      if (alreadyIngested) {
        continue;
      }

      // Check content
      const content = msg.message;
      if (!content) continue;

      const docMessage = content.documentMessage;
      const text =
        content.conversation || content.extendedTextMessage?.text || docMessage?.caption || "";
      const youtubeUrl = extractYoutubeUrl(text);

      if (
        docMessage &&
        (docMessage.mimetype?.includes("pdf") ||
          docMessage.fileName?.toLowerCase().endsWith(".pdf"))
      ) {
        // PDF document found
        console.log(
          `Found PDF: "${docMessage.fileName || "Untitled"}" at ${msgTime.toISOString()}`,
        );
        try {
          console.log(`Downloading PDF bytes for message ${messageId}...`);
          const buffer = await downloadMediaMessage(
            msg as WAMessage,
            "buffer",
            {},
            {
              reuploadRequest: sock.updateMediaMessage,
              logger,
            },
          );

          const payload = {
            messageId,
            groupJid,
            sender: msg.key.participant || msg.key.fromMe ? "me" : undefined,
            filename: docMessage.fileName || "document.pdf",
            mimeType: docMessage.mimetype || "application/pdf",
            caption: text.trim() || undefined,
            mediaBase64: buffer.toString("base64"),
            timestamp: msgTime.toISOString(),
          };

          const res = await postToIngestService(payload);
          console.log(`Successfully ingested PDF: status=${res.status} eventId=${res.eventId}`);
          pdfCount++;
        } catch (err) {
          console.error(`Failed to download/ingest PDF:`, err);
        }
      } else if (youtubeUrl) {
        // YouTube link found
        console.log(`Found YouTube link: "${youtubeUrl}" at ${msgTime.toISOString()}`);
        try {
          const payload = {
            messageId,
            groupJid,
            sender: msg.key.participant || msg.key.fromMe ? "me" : undefined,
            filename: "youtube-video",
            mimeType: "text/plain",
            caption: text.trim() || undefined,
            mediaUrl: youtubeUrl,
            timestamp: msgTime.toISOString(),
          };

          const res = await postToIngestService(payload);
          console.log(
            `Successfully ingested YouTube video: status=${res.status} eventId=${res.eventId}`,
          );
          youtubeCount++;
        } catch (err) {
          console.error(`Failed to ingest YouTube video:`, err);
        }
      }
    }

    console.log(
      `Group ${groupJid} processing complete. Ingested PDFs: ${pdfCount}, YouTube Videos: ${youtubeCount}`,
    );
  }

  console.log("\nAll group backfills complete. Exiting WhatsApp socket connection...");
  sock.end(undefined);
  await pool.end();
  console.log("Done.");
}

runBackfill().catch((err) => {
  console.error("Fatal backfill error:", err);
  pool.end();
  process.exit(1);
});
