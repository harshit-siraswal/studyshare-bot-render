const chatWindow = document.getElementById("chat-window");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const quickActions = document.querySelectorAll("button[data-command]");
const sidebarLinks = document.querySelectorAll(".sidebar-link[data-target]");
const refreshPendingButton = document.getElementById("refresh-pending");
const refreshLiveButton = document.getElementById("refresh-live");
const clearHistoryButton = document.getElementById("clear-history");
const pendingList = document.getElementById("pending-list");
const sourceBreakdown = document.getElementById("source-breakdown");
const runtimeStream = document.getElementById("runtime-stream");
const liveFeed = document.getElementById("live-feed");
const liveFilterStatus = document.getElementById("live-filter-status");
const liveFilterSource = document.getElementById("live-filter-source");
const liveFilterCategory = document.getElementById("live-filter-category");
const liveFilterText = document.getElementById("live-filter-text");
const liveFilterCount = document.getElementById("live-filter-count");
const liveFilterClear = document.getElementById("live-filter-clear");
const connectionPill = document.getElementById("connection-pill");
const uptimeLabel = document.getElementById("uptime-label");
const lastSyncLabel = document.getElementById("last-sync-label");

const pendingFilterCategory = document.getElementById("pending-filter-category");
const pendingFilterText = document.getElementById("pending-filter-text");
const pendingFilterCount = document.getElementById("pending-filter-count");
const pendingFilterClear = document.getElementById("pending-filter-clear");

const metricReceived = document.getElementById("metric-received");
const metricPosted = document.getElementById("metric-posted");
const metricPending = document.getElementById("metric-pending");
const metricFailed = document.getElementById("metric-failed");
const opsActive = document.getElementById("ops-active");
const opsAwaiting = document.getElementById("ops-awaiting");
const opsPosted = document.getElementById("ops-posted");
const opsFailed = document.getElementById("ops-failed");
const duplicateModeSelect = document.getElementById("dup-mode");
const duplicateRecentInput = document.getElementById("dup-recent");
const duplicateDeleteCountInput = document.getElementById("dup-delete-count");
const duplicateScanButton = document.getElementById("run-dup-scan");
const duplicateDeleteButton = document.getElementById("run-dup-delete");
const retractSourceSelect = document.getElementById("retract-source");
const retractCountInput = document.getElementById("retract-count");
const retractLastButton = document.getElementById("run-retract-last");
const directRetractInput = document.getElementById("direct-retract-id");
const directRetractButton = document.getElementById("direct-retract-btn");
const autoRefreshToggle = document.getElementById("auto-refresh-toggle");
const pollIntervalSelect = document.getElementById("poll-interval-select");
const apiBaseMeta = document.querySelector('meta[name="studyshareclaw-api-base"]');

const API_BASE = (apiBaseMeta?.content || "").trim().replace(/\/+$/, "");

const CHAT_HISTORY_KEY = "studyshareclaw-chat-history-v1";
const MAX_HISTORY_ITEMS = 180;
const DEFAULT_DASHBOARD_POLL_MS = 15000;
const DEFAULT_HEALTH_POLL_MS = 10000;

let dashboardInterval = null;
let healthInterval = null;
let liveRowsCache = [];
let pendingRowsCache = [];
let dashboardPollMs = DEFAULT_DASHBOARD_POLL_MS;
let pollingEnabled = true;

function nowLabel() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function setConnectionState(state, detail = "") {
  connectionPill.className =
    state === "ok" ? "pill pill-ok" : state === "error" ? "pill pill-error" : "pill pill-warn";
  connectionPill.textContent =
    state === "ok" ? "Connected" : state === "error" ? "Disconnected" : "Connecting...";

  if (detail) {
    uptimeLabel.textContent = detail;
  }
}

function pushHistory(item) {
  try {
    const existing = JSON.parse(localStorage.getItem(CHAT_HISTORY_KEY) || "[]");
    const next = [...existing, item].slice(-MAX_HISTORY_ITEMS);
    localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(next));
  } catch {
    // ignore persistence issues
  }
}

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(CHAT_HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
}

function addMessage(role, text, opts = {}) {
  const wrapper = document.createElement("div");
  wrapper.className = `message ${role}`;
  wrapper.textContent = text;

  if (role !== "system") {
    const meta = document.createElement("div");
    meta.className = "message-meta";
    meta.textContent = opts.time || nowLabel();
    wrapper.appendChild(meta);
  }

  chatWindow.appendChild(wrapper);
  chatWindow.scrollTop = chatWindow.scrollHeight;

  if (!opts.skipPersist) {
    pushHistory({ role, text, time: opts.time || nowLabel() });
  }
}

function restoreHistory() {
  const history = loadHistory();
  if (!history.length) {
    addMessage(
      "bot",
      "StudyShareClaw is ready. Use /help, /duplicates, /pending, /review, /view.",
      {
        skipPersist: true,
      },
    );
    return;
  }

  for (const item of history) {
    addMessage(item.role || "bot", item.text || "", {
      time: item.time || nowLabel(),
      skipPersist: true,
    });
  }
}

async function apiJson(path, options = {}) {
  const target = `${API_BASE}${path}`;
  const response = await fetch(target, options);
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : { text: await response.text() };

  if (!response.ok) {
    const message = payload?.error || payload?.text || response.statusText;
    throw new Error(message);
  }

  return payload;
}

async function sendMessage(text) {
  addMessage("user", text);

  const typingNode = document.createElement("div");
  typingNode.className = "message system";
  typingNode.textContent = "StudyShareClaw is thinking...";
  chatWindow.appendChild(typingNode);
  chatWindow.scrollTop = chatWindow.scrollHeight;

  try {
    const payload = await apiJson("/v1/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: text }),
    });

    typingNode.remove();
    addMessage("bot", payload.text || "(empty response)");
    setConnectionState("ok", `Last response: ${nowLabel()}`);
  } catch (error) {
    typingNode.remove();
    const detail = error instanceof Error ? error.message : "unknown error";
    addMessage("bot", `Error: ${detail}`);
    setConnectionState("error", `Last error: ${nowLabel()}`);
  }
}

function formatPendingItemTitle(item) {
  const payload = item.payload_json || {};
  const fromPayload = payload.title || payload?.proposedMapping?.title || payload?.event?.filename;
  return fromPayload || "Untitled review item";
}

function formatPendingReason(item) {
  const reason = item?.payload_json?.reason || "manual_review";
  return String(reason).replace(/_/g, " ");
}

function formatPendingFile(item) {
  const file = item?.payload_json?.event?.filename || item?.payload_json?.current?.title || "";
  return file || "Unknown file";
}

function formatRelativeTime(ts) {
  if (!ts) return "--";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return String(ts);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function statusClassName(status) {
  return String(status || "unknown")
    .replace(/[^a-z0-9_]+/gi, "_")
    .toLowerCase();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parsePositiveInt(raw, fallback, min = 1, max = 9999) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

function sourceOf(senderRaw) {
  const sender = String(senderRaw || "").toLowerCase();
  if (!sender) return "unknown";
  if (sender.includes("gdrive") || sender.includes("drive")) return "drive";
  if (sender.includes("whatsapp") || sender.includes("@s.whatsapp.net") || sender.includes("@g.us"))
    return "whatsapp";
  return "unknown";
}

function attachmentLabelFrom(item) {
  const appResource = item?.app_resource || {};
  const fileName = String(item?.file_name || appResource?.fileName || "").trim();
  return fileName || "Attachment available";
}

function activateSidebarLink(targetId) {
  sidebarLinks.forEach((link) => {
    const isActive = link.getAttribute("data-target") === targetId;
    link.classList.toggle("is-active", isActive);
  });
}

function resolvePendingViewUrl(item) {
  const payload = item?.payload_json || {};
  const event = payload?.event || {};
  const current = payload?.current || {};
  const proposed = payload?.proposedMapping || {};

  const candidates = [
    event.mediaUrl,
    current.fileUrl,
    current.file_url,
    proposed.fileUrl,
    proposed.file_url,
  ];
  for (const candidate of candidates) {
    const value = typeof candidate === "string" ? candidate.trim() : "";
    if (/^https?:\/\//i.test(value)) {
      return value;
    }
  }

  const mediaBase64 = typeof event.mediaBase64 === "string" ? event.mediaBase64.trim() : "";
  if (mediaBase64) {
    if (mediaBase64.startsWith("data:")) {
      return mediaBase64;
    }
    const mimeType =
      typeof event.mimeType === "string" && event.mimeType.trim()
        ? event.mimeType.trim()
        : "application/pdf";
    return `data:${mimeType};base64,${mediaBase64}`;
  }

  return null;
}

function openViewUrl(reviewId, viewUrl) {
  if (!viewUrl) {
    addMessage("bot", `No direct view URL found for ${reviewId}. Try /review ${reviewId}.`);
    return;
  }

  const opened = window.open(viewUrl, "_blank", "noopener,noreferrer");
  if (!opened) {
    addMessage("bot", `Popup blocked. Open manually:\n${viewUrl}`);
    return;
  }

  addMessage("bot", `Opened review ${reviewId} in a new tab.`);
}

function createOverrideForm(item, card) {
  const payload = item?.payload_json || {};
  const mapping = payload?.proposedMapping || {};
  const current = payload?.current || {};
  const classification = payload?.classification || {};

  const form = document.createElement("div");
  form.className = "override-form";
  form.innerHTML = `
    <div class="override-grid">
      <label>
        <span>Category</span>
        <select data-field="category">
          <option value="">(keep)</option>
          <option value="resource">resource</option>
          <option value="syllabus">syllabus</option>
          <option value="notice">notice</option>
        </select>
      </label>
      <label>
        <span>Branch</span>
        <input data-field="branch" type="text" value="${escapeHtml(
          mapping.branch || current.branch || classification.branch || "",
        )}" />
      </label>
      <label>
        <span>Semester</span>
        <input data-field="semester" type="text" value="${escapeHtml(
          mapping.semester || current.semester || classification.semester || "",
        )}" />
      </label>
      <label>
        <span>Subject</span>
        <input data-field="subject" type="text" value="${escapeHtml(
          mapping.subject || current.subject || classification.subject || "",
        )}" />
      </label>
      <label>
        <span>Title</span>
        <input data-field="title" type="text" value="${escapeHtml(
          mapping.title || current.title || classification.title || payload?.event?.filename || "",
        )}" />
      </label>
      <label>
        <span>Priority</span>
        <select data-field="priority">
          <option value="">(keep)</option>
          <option value="low">low</option>
          <option value="normal">normal</option>
          <option value="high">high</option>
        </select>
      </label>
    </div>
    <label>
      <span class="muted">Summary override (optional)</span>
      <textarea data-field="summary" placeholder="Short summary...">${escapeHtml(
        classification.summary || current.description || "",
      )}</textarea>
    </label>
    <div class="override-actions">
      <button type="button" class="btn-override-cancel">Cancel</button>
      <button type="button" class="btn-override-apply">Approve With Overrides</button>
    </div>
  `;

  const categorySelect = form.querySelector('[data-field="category"]');
  const prioritySelect = form.querySelector('[data-field="priority"]');
  if (categorySelect && item?.proposed_category) {
    categorySelect.value = String(item.proposed_category);
  }
  if (prioritySelect && classification?.priority) {
    prioritySelect.value = String(classification.priority);
  }

  const cancelBtn = form.querySelector(".btn-override-cancel");
  const applyBtn = form.querySelector(".btn-override-apply");

  cancelBtn?.addEventListener("click", () => {
    form.remove();
  });

  applyBtn?.addEventListener("click", async () => {
    const fields = form.querySelectorAll("[data-field]");
    const overrides = {};
    for (const field of fields) {
      const key = field.getAttribute("data-field");
      if (!key) continue;
      const raw = typeof field.value === "string" ? field.value.trim() : "";
      if (!raw) continue;
      overrides[key] = key === "confidence" ? Number(raw) : raw;
    }
    await approveReview(item.id, card, overrides);
  });

  return form;
}

function createPendingCard(item) {
  const card = document.createElement("article");
  card.className = "pending-card";

  const title = document.createElement("div");
  title.className = "pending-title";
  title.textContent = `${item.proposed_category || "resource"} | confidence ${item.confidence ?? "n/a"}`;
  card.appendChild(title);

  const id = document.createElement("div");
  id.className = "pending-id";
  id.textContent = item.id;
  card.appendChild(id);

  const body = document.createElement("div");
  body.className = "pending-body";
  body.textContent = formatPendingItemTitle(item);
  card.appendChild(body);

  const mapping = item?.payload_json?.proposedMapping || {};
  const mappingBits = [];
  if (mapping.branch) mappingBits.push(String(mapping.branch).toUpperCase());
  if (mapping.semester) mappingBits.push(`SEM ${mapping.semester}`);
  if (mapping.subject) mappingBits.push(String(mapping.subject));
  if (mappingBits.length) {
    const chips = document.createElement("div");
    chips.className = "pending-mapping";
    chips.innerHTML = mappingBits
      .map((bit) => `<span class="pending-chip">${escapeHtml(bit)}</span>`)
      .join("");
    card.appendChild(chips);
  }

  const meta = document.createElement("div");
  meta.className = "pending-meta";
  meta.innerHTML = `<div>Reason: ${formatPendingReason(item)}</div><div>File: ${formatPendingFile(item)}</div>`;
  card.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "pending-actions";

  const viewBtn = document.createElement("button");
  viewBtn.className = "btn-view";
  viewBtn.type = "button";
  viewBtn.textContent = "View";
  viewBtn.addEventListener("click", () => {
    openViewUrl(item.id, resolvePendingViewUrl(item));
  });

  const approveBtn = document.createElement("button");
  approveBtn.className = "btn-approve";
  approveBtn.type = "button";
  approveBtn.textContent = "Approve";
  approveBtn.addEventListener("click", async () => {
    await approveReview(item.id, card);
  });

  const approveEditBtn = document.createElement("button");
  approveEditBtn.className = "btn-approve-edit";
  approveEditBtn.type = "button";
  approveEditBtn.textContent = "Approve + Edit";
  approveEditBtn.addEventListener("click", () => {
    const existing = card.querySelector(".override-form");
    if (existing) {
      existing.remove();
      return;
    }
    card.appendChild(createOverrideForm(item, card));
  });

  const rejectBtn = document.createElement("button");
  rejectBtn.className = "btn-reject";
  rejectBtn.type = "button";
  rejectBtn.textContent = "Reject";
  rejectBtn.addEventListener("click", async () => {
    await rejectReview(item.id, card);
  });

  actions.appendChild(viewBtn);
  actions.appendChild(approveBtn);
  actions.appendChild(approveEditBtn);
  actions.appendChild(rejectBtn);
  card.appendChild(actions);

  return card;
}

async function approveReview(reviewId, cardNode, overrides = null) {
  cardNode.classList.add("loading");
  try {
    const body = { reviewer: "chat-ui" };
    if (overrides && Object.keys(overrides).length) {
      body.overrides = overrides;
    }

    const payload = await apiJson(`/v1/review/${reviewId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    addMessage(
      "bot",
      `Approved ${reviewId}: ${payload?.result?.entityType || "entity"} ${payload?.result?.entityId || ""}`,
    );
    await refreshDashboard();
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    addMessage("bot", `Approve failed for ${reviewId}: ${detail}`);
  } finally {
    cardNode.classList.remove("loading");
  }
}

async function rejectReview(reviewId, cardNode) {
  const note =
    window.prompt("Reject note (optional):", "Rejected from chat console") ||
    "Rejected from chat console";
  cardNode.classList.add("loading");
  try {
    await apiJson(`/v1/review/${reviewId}/reject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reviewer: "chat-ui", note }),
    });

    addMessage("bot", `Rejected ${reviewId}`);
    await refreshDashboard();
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    addMessage("bot", `Reject failed for ${reviewId}: ${detail}`);
  } finally {
    cardNode.classList.remove("loading");
  }
}

async function retractPostedResource(resourceId, liveNode) {
  if (!resourceId) return;
  const confirmed = window.confirm(`Retract/delete resource ${resourceId}?`);
  if (!confirmed) return;

  if (liveNode) {
    liveNode.classList.add("loading");
  }

  try {
    const payload = await apiJson(`/v1/retract/resource/${resourceId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reviewer: "chat-ui" }),
    });
    addMessage(
      "bot",
      `Retracted resource ${resourceId} (events updated: ${payload?.touchedEvents ?? 0})`,
    );
    await refreshDashboard();
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    addMessage("bot", `Retract failed for ${resourceId}: ${detail}`);
  } finally {
    if (liveNode) {
      liveNode.classList.remove("loading");
    }
  }
}

async function retractRecentResources(limit, source) {
  const safeLimit = parsePositiveInt(limit, 5, 1, 30);
  const sourceValue = typeof source === "string" && source !== "all" ? source : "";
  const sourceLabel = sourceValue || "all sources";
  const confirmed = window.confirm(`Retract last ${safeLimit} resources from ${sourceLabel}?`);
  if (!confirmed) return;

  try {
    const payload = await apiJson("/v1/retract/recent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        limit: safeLimit,
        source: sourceValue,
        reviewer: "chat-ui",
      }),
    });
    addMessage(
      "bot",
      `Retract last ${safeLimit} (${sourceLabel}) complete. deleted=${payload?.deleted ?? 0}, failed=${payload?.failed ?? 0}`,
    );
    await refreshDashboard();
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    addMessage("bot", `Retract last failed: ${detail}`);
  }
}

function applyPendingFilters(items) {
  const rows = Array.isArray(items) ? items : [];
  const category = String(pendingFilterCategory?.value || "all").toLowerCase();
  const query = String(pendingFilterText?.value || "")
    .trim()
    .toLowerCase();

  return rows.filter((item) => {
    const itemCategory = String(item?.proposed_category || "").toLowerCase();
    const mapping = item?.payload_json?.proposedMapping || {};
    const haystack = [
      formatPendingItemTitle(item),
      formatPendingFile(item),
      formatPendingReason(item),
      mapping?.branch,
      mapping?.semester,
      mapping?.subject,
      item?.id,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    if (category !== "all" && itemCategory !== category) return false;
    if (query && !haystack.includes(query)) return false;
    return true;
  });
}

function renderPending(items) {
  pendingList.innerHTML = "";

  if (!Array.isArray(items) || !items.length) {
    const empty = document.createElement("div");
    empty.className = "pending-empty";
    empty.textContent = "No pending items.";
    pendingList.appendChild(empty);
    if (pendingFilterCount) pendingFilterCount.textContent = "Pending 0";
    return;
  }

  if (pendingFilterCount) pendingFilterCount.textContent = `Pending ${items.length}`;

  for (const item of items) {
    pendingList.appendChild(createPendingCard(item));
  }
}

function renderSources(items) {
  if (!sourceBreakdown) return;
  sourceBreakdown.innerHTML = "";

  if (!Array.isArray(items) || !items.length) {
    const empty = document.createElement("div");
    empty.className = "pending-empty";
    empty.textContent = "No source activity in last 24h.";
    sourceBreakdown.appendChild(empty);
    return;
  }

  for (const item of items) {
    const card = document.createElement("article");
    card.className = "source-item";
    card.innerHTML = `
      <div class="source-title">${item.sender || "unknown"}</div>
      <div class="source-metrics">
        <span>Total: ${item.total ?? 0}</span>
        <span>Posted: ${item.posted ?? 0}</span>
        <span>Queued: ${item.queued_review ?? 0}</span>
        <span>Ignored: ${item.ignored ?? 0}</span>
        <span>Failed: ${item.failed ?? 0}</span>
      </div>
    `;
    sourceBreakdown.appendChild(card);
  }
}

function renderRuntime(items) {
  if (!runtimeStream) return;
  runtimeStream.innerHTML = "";

  const rows = Array.isArray(items) ? [...items] : [];
  rows.sort((a, b) => {
    const ta = new Date(a?.timestamp || 0).getTime();
    const tb = new Date(b?.timestamp || 0).getTime();
    return tb - ta;
  });

  const latest = rows.slice(0, 12);
  if (!latest.length) {
    const empty = document.createElement("div");
    empty.className = "pending-empty";
    empty.textContent = "No runtime events yet.";
    runtimeStream.appendChild(empty);
    return;
  }

  for (const item of latest) {
    const status = String(item?.status || "unknown");
    const statusClass = statusClassName(status);
    const title = item?.app_resource?.title || item?.title || item?.file_name || "Untitled event";
    const row = document.createElement("article");
    row.className = "runtime-item";
    row.innerHTML = `
      <div class="runtime-top">
        <span class="runtime-status ${statusClass}">${escapeHtml(status)}</span>
        <span class="mini">${formatRelativeTime(item?.timestamp)}</span>
      </div>
      <div class="runtime-title">${escapeHtml(title)}</div>
      <div class="runtime-meta">${escapeHtml(sourceOf(item?.sender))} | ${escapeHtml(item?.category || "uncategorized")}</div>
    `;
    runtimeStream.appendChild(row);
  }
}

function renderLive(items) {
  if (!liveFeed) return;
  liveFeed.innerHTML = "";

  if (!Array.isArray(items) || !items.length) {
    const empty = document.createElement("div");
    empty.className = "pending-empty";
    empty.textContent = "No live activity yet.";
    liveFeed.appendChild(empty);
    return;
  }

  const activeStatus = String(liveFilterStatus?.value || "all").toLowerCase();
  const activeSource = String(liveFilterSource?.value || "all").toLowerCase();
  const activeCategory = String(liveFilterCategory?.value || "all").toLowerCase();
  const query = String(liveFilterText?.value || "")
    .trim()
    .toLowerCase();

  const filtered = items.filter((item) => {
    const status = String(item?.status || "").toLowerCase();
    const category = String(item?.category || "").toLowerCase();
    const source = sourceOf(item?.sender);
    const appResource = item?.app_resource || {};
    const haystack = [
      appResource?.title,
      item?.title,
      item?.file_name,
      appResource?.branch,
      appResource?.semester,
      appResource?.subject,
      item?.sender,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    if (activeStatus !== "all" && status !== activeStatus) return false;
    if (activeSource !== "all" && source !== activeSource) return false;
    if (activeCategory !== "all" && category !== activeCategory) return false;
    if (query && !haystack.includes(query)) return false;
    return true;
  });

  if (liveFilterCount) {
    liveFilterCount.textContent = `Showing ${filtered.length} of ${items.length}`;
  }

  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "pending-empty";
    empty.textContent = "No events match the selected filters.";
    liveFeed.appendChild(empty);
    return;
  }

  for (const item of filtered) {
    const node = document.createElement("article");
    node.className = "live-item";

    const status = String(item.status || "unknown");
    const statusClass = statusClassName(status);
    const reason = item.error_code ? ` | ${item.error_code}` : "";
    const sender = item.sender || "unknown";
    const category = item.category ? ` | ${item.category}` : "";
    const reviewer = item.reviewer ? ` | by ${item.reviewer}` : "";
    const file = item.file_name || "(no file)";
    const summary = item.summary ? String(item.summary).trim() : "";
    const postedType = String(item.posted_entity_type || "").toLowerCase();
    const postedId = String(item.posted_entity_id || "").trim();
    const appResource = item.app_resource || null;
    const displayTitle = appResource?.title || item.title || file;
    const branch = appResource?.branch || "";
    const semester = appResource?.semester || "";
    const subject = appResource?.subject || "";
    const appType = appResource?.type || "";
    const viewUrl = appResource?.fileUrl || null;
    const hasAttachment = Boolean(viewUrl);
    const mappingBadge = [];
    if (branch) mappingBadge.push(branch.toUpperCase());
    if (semester) mappingBadge.push(`SEM ${semester}`);
    if (subject) mappingBadge.push(subject);
    if (appType) mappingBadge.push(appType);
    if (hasAttachment) mappingBadge.push("Attachment");
    if (!mappingBadge.length && item.category) mappingBadge.push(String(item.category));

    node.innerHTML = `
      <div class="live-item-top">
        <span class="live-status ${statusClass}">${status}</span>
        <span class="live-time">${formatRelativeTime(item.timestamp)}</span>
      </div>
      <div class="live-main-title">${escapeHtml(displayTitle)}</div>
      <div class="live-text">${escapeHtml(file)}</div>
      <div class="live-badges">${mappingBadge.map((badge) => `<span class="live-chip">${escapeHtml(badge)}</span>`).join("")}</div>
      ${hasAttachment ? `<div class="live-attachment">${escapeHtml(attachmentLabelFrom(item))}</div>` : ""}
      <div class="live-meta">
        <div>Source: ${escapeHtml(sender)}${escapeHtml(category)}${escapeHtml(reviewer)}</div>
        ${summary ? `<div>Note: ${escapeHtml(summary)}</div>` : ""}
      </div>
      <details class="live-debug">
        <summary>Debug details</summary>
        <div class="live-meta">
          <div>Group: ${escapeHtml(item.group_jid || "-")}</div>
          <div>Event ID: ${escapeHtml(item.id || "-")}</div>
          <div>Posted ID: ${escapeHtml(postedId || "-")}</div>
          ${reason ? `<div>Error: ${escapeHtml(reason.replace("|", "").trim())}</div>` : ""}
        </div>
      </details>
    `;

    const canRetract =
      (status === "posted" || status === "review_approved") &&
      postedId.length > 0 &&
      (postedType === "resource" || postedType === "resource_update");

    if (viewUrl || canRetract) {
      const actions = document.createElement("div");
      actions.className = "live-actions";
      if (viewUrl) {
        const openBtn = document.createElement("button");
        openBtn.className = "btn-open";
        openBtn.type = "button";
        openBtn.textContent = "View File";
        openBtn.addEventListener("click", () => {
          window.open(viewUrl, "_blank", "noopener,noreferrer");
        });
        actions.appendChild(openBtn);
      }

      if (canRetract) {
        const retractBtn = document.createElement("button");
        retractBtn.className = "btn-retract";
        retractBtn.type = "button";
        retractBtn.textContent = "Retract From App";
        retractBtn.addEventListener("click", async () => {
          await retractPostedResource(postedId, node);
        });
        actions.appendChild(retractBtn);
      }
      node.appendChild(actions);
    }

    liveFeed.appendChild(node);
  }
}

function renderStats(stats) {
  metricReceived.textContent = String(stats?.received24h ?? "--");
  metricPosted.textContent = String(stats?.posted24h ?? "--");
  metricPending.textContent = String(stats?.pendingReviews ?? "--");
  metricFailed.textContent = String(stats?.failed24h ?? "--");
}

function renderOps(items) {
  const rows = Array.isArray(items) ? items : [];
  const activeStatuses = new Set(["received", "classification_pending", "posting"]);
  const awaitingStatuses = new Set(["queued_review"]);
  const postedStatuses = new Set(["posted", "review_approved"]);
  const failedStatuses = new Set(["failed", "review_rejected"]);

  let active = 0;
  let awaiting = 0;
  let posted = 0;
  let failed = 0;

  for (const row of rows) {
    const status = String(row?.status || "");
    if (activeStatuses.has(status)) active += 1;
    if (awaitingStatuses.has(status)) awaiting += 1;
    if (postedStatuses.has(status)) posted += 1;
    if (failedStatuses.has(status)) failed += 1;
  }

  if (opsActive) opsActive.textContent = String(active);
  if (opsAwaiting) opsAwaiting.textContent = String(awaiting);
  if (opsPosted) opsPosted.textContent = String(posted);
  if (opsFailed) opsFailed.textContent = String(failed);
}

function formatUptime(seconds) {
  if (!Number.isFinite(seconds)) return "--";
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

async function refreshDashboard() {
  try {
    const payload = await apiJson("/v1/dashboard?limit=25&liveLimit=120");
    renderStats(payload.stats || {});
    pendingRowsCache = Array.isArray(payload.pending) ? payload.pending : [];
    renderPending(applyPendingFilters(pendingRowsCache));
    renderSources(payload.sources || []);
    liveRowsCache = Array.isArray(payload.live) ? payload.live : [];
    renderLive(liveRowsCache);
    renderRuntime(liveRowsCache);
    renderOps(liveRowsCache);
    uptimeLabel.textContent = `Uptime: ${formatUptime(payload.uptimeSeconds)} | Updated ${nowLabel()}`;
    if (lastSyncLabel) {
      lastSyncLabel.textContent = `Last sync: ${nowLabel()}`;
    }
    setConnectionState("ok");
  } catch {
    setConnectionState("error", `Dashboard unavailable | ${nowLabel()}`);
  }
}

async function refreshHealth() {
  try {
    const payload = await apiJson("/healthz");
    const uptime = `Uptime: ${formatUptime(payload.uptimeSeconds)} | ${nowLabel()}`;
    setConnectionState("ok", uptime);
  } catch {
    setConnectionState("error", `Health check failed | ${nowLabel()}`);
  }
}

function stopPolling() {
  if (dashboardInterval) clearInterval(dashboardInterval);
  if (healthInterval) clearInterval(healthInterval);
  dashboardInterval = null;
  healthInterval = null;
}

function startPolling() {
  stopPolling();
  if (!pollingEnabled) return;

  dashboardInterval = setInterval(refreshDashboard, dashboardPollMs);
  healthInterval = setInterval(refreshHealth, Math.min(dashboardPollMs, DEFAULT_HEALTH_POLL_MS));
}

function updatePollingConfigFromUi() {
  pollingEnabled = Boolean(autoRefreshToggle?.checked ?? true);
  dashboardPollMs = parsePositiveInt(
    pollIntervalSelect?.value,
    DEFAULT_DASHBOARD_POLL_MS,
    5000,
    60000,
  );
  startPolling();
}

async function runDuplicateScan() {
  const mode = String(duplicateModeSelect?.value || "file").toLowerCase();
  const recent = parsePositiveInt(duplicateRecentInput?.value, 20, 1, 500);
  await sendMessage(`/duplicates ${mode} recent ${recent}`);
  await refreshDashboard();
}

async function runDuplicateDelete() {
  const mode = String(duplicateModeSelect?.value || "file").toLowerCase();
  const recent = parsePositiveInt(duplicateRecentInput?.value, 20, 1, 500);
  const maxDeletes = parsePositiveInt(duplicateDeleteCountInput?.value, 10, 1, 200);
  const confirmed = window.confirm(
    `Delete duplicates with mode=${mode}, recent=${recent}, maxDeletes=${maxDeletes}?`,
  );
  if (!confirmed) return;
  await sendMessage(`/duplicates delete ${mode} ${maxDeletes} recent ${recent}`);
  await refreshDashboard();
}

function clearLiveFilters() {
  if (liveFilterStatus) liveFilterStatus.value = "all";
  if (liveFilterSource) liveFilterSource.value = "all";
  if (liveFilterCategory) liveFilterCategory.value = "all";
  if (liveFilterText) liveFilterText.value = "";
  renderLive(liveRowsCache);
}

function clearPendingFilters() {
  if (pendingFilterCategory) pendingFilterCategory.value = "all";
  if (pendingFilterText) pendingFilterText.value = "";
  renderPending(applyPendingFilters(pendingRowsCache));
}

chatForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = "";
  await sendMessage(text);
  await refreshDashboard();
});

quickActions.forEach((button) => {
  button.addEventListener("click", async () => {
    const command = button.getAttribute("data-command");
    if (!command) return;
    await sendMessage(command);
    await refreshDashboard();
  });
});

refreshPendingButton?.addEventListener("click", async () => {
  await refreshDashboard();
});

refreshLiveButton?.addEventListener("click", async () => {
  await refreshDashboard();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    refreshHealth();
    refreshDashboard();
  }
});

window.addEventListener("online", () => {
  setConnectionState("warn", `Reconnecting | ${nowLabel()}`);
  refreshHealth();
  refreshDashboard();
});

window.addEventListener("offline", () => {
  setConnectionState("error", "Browser offline");
});

restoreHistory();
updatePollingConfigFromUi();
refreshHealth();
refreshDashboard();

clearHistoryButton?.addEventListener("click", () => {
  localStorage.removeItem(CHAT_HISTORY_KEY);
  chatWindow.innerHTML = "";
  addMessage("system", "Chat history cleared.");
  addMessage("bot", "StudyShareClaw is ready. Use /help, /duplicates, /pending, /review, /view.");
});

duplicateScanButton?.addEventListener("click", runDuplicateScan);
duplicateDeleteButton?.addEventListener("click", runDuplicateDelete);

retractLastButton?.addEventListener("click", async () => {
  const limit = parsePositiveInt(retractCountInput?.value, 5, 1, 30);
  const source = String(retractSourceSelect?.value || "all").toLowerCase();
  await retractRecentResources(limit, source);
});

directRetractButton?.addEventListener("click", async () => {
  const resourceId = String(directRetractInput?.value || "").trim();
  if (!resourceId) {
    addMessage("bot", "Provide a resource ID to retract.");
    return;
  }
  await retractPostedResource(resourceId, null);
  if (directRetractInput) {
    directRetractInput.value = "";
  }
});

pendingFilterCategory?.addEventListener("change", () => {
  renderPending(applyPendingFilters(pendingRowsCache));
});

pendingFilterText?.addEventListener("input", () => {
  renderPending(applyPendingFilters(pendingRowsCache));
});

pendingFilterClear?.addEventListener("click", clearPendingFilters);

const liveFilterInputs = [
  liveFilterStatus,
  liveFilterSource,
  liveFilterCategory,
  liveFilterText,
].filter(Boolean);
for (const input of liveFilterInputs) {
  const eventName = input === liveFilterText ? "input" : "change";
  input.addEventListener(eventName, () => {
    renderLive(liveRowsCache);
  });
}

liveFilterClear?.addEventListener("click", clearLiveFilters);

autoRefreshToggle?.addEventListener("change", () => {
  updatePollingConfigFromUi();
  addMessage("system", pollingEnabled ? "Auto refresh enabled." : "Auto refresh paused.");
});

pollIntervalSelect?.addEventListener("change", () => {
  updatePollingConfigFromUi();
  addMessage("system", `Polling interval set to ${Math.round(dashboardPollMs / 1000)}s.`);
});

sidebarLinks.forEach((link) => {
  link.addEventListener("click", () => {
    const targetId = link.getAttribute("data-target");
    if (!targetId) return;
    const node = document.getElementById(targetId);
    if (!node) return;
    activateSidebarLink(targetId);
    node.scrollIntoView({ behavior: "smooth", block: "start" });
  });
});

if (typeof IntersectionObserver !== "undefined") {
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible?.target?.id) return;
      activateSidebarLink(visible.target.id);
    },
    {
      rootMargin: "-15% 0px -55% 0px",
      threshold: [0.2, 0.45, 0.7],
    },
  );

  ["overview-section", "ops-section", "chat-section", "activity-section", "review-section"].forEach(
    (id) => {
      const node = document.getElementById(id);
      if (node) observer.observe(node);
    },
  );
}
