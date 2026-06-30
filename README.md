# StudyShare Bot — Render Backend

Self-contained backend for deploying the StudyShare WhatsApp automation ingest-service to [Render](https://render.com). The Vercel-hosted frontend (`studyshare-bot.vercel.app`) connects to this backend.

---

## Architecture

```
Vercel (Frontend)  ----HTTPS+CORS---->  Render (Backend)
   studyshare-bot.vercel.app              studyshare-bot-backend.onrender.com
                                               |
                                               v
                                       PostgreSQL (Render managed)
```

---

## Prerequisites

1. **Render account** — sign up at [render.com](https://render.com)
2. **StudyShare admin bearer token** — your `STUDYSHARE_ADMIN_BEARER` or `STUDYSHARE_ADMIN_KEY_HASH`
3. **(Optional) Gemini API key** — for LLM-based classification fallback (`GEMINI_API_KEY`)
4. **College ID** — UUID of the college in StudyShare (`STUDYSHARE_ADMIN_DEFAULT_COLLEGE_ID`)

---

## Deploy

### Option A: One-click Deploy (Render Blueprint)

1. Click the **Deploy to Render** button below, or
2. Go to your Render Dashboard → **New +** → **Blueprint** → paste the URL to this repo.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/harshit-siraswal/studyshare-bot)

> If the Blueprint button doesn't work, use **Option B** below.

### Option B: Manual Deploy

#### 1. Create the PostgreSQL database

```
Render Dashboard → New + → PostgreSQL
Name: studyshare-bot-db
Plan: Starter (or higher)
Region: same as your web service
```

Save the **Internal Connection String** for later.

#### 2. Create the Web Service

```
Render Dashboard → New + → Web Service
- Build Source: Existing Image or Dockerfile
- Name: studyshare-bot-backend
- Region: same as your database
- Branch: main
- Root Directory: ./render-backend  (if this folder is in a subdir of your repo)
  OR if this is a separate repo, just point to the repo root.
- Runtime: Docker
- Plan: Standard (or Starter for testing)
```

#### 3. Set environment variables

In the web service **Environment** tab, add:

| Key | Value | Required |
|-----|-------|----------|
| `DATABASE_URL` | *(from your PostgreSQL internal connection string)* | Yes |
| `STUDYSHARE_API_BASE` | `https://api.studyshare.in` | Yes |
| `STUDYSHARE_ADMIN_BEARER` | your admin key hash / bearer | Yes |
| `STUDYSHARE_ADMIN_DEFAULT_COLLEGE_ID` | your college UUID | Yes |
| `STUDYSHARE_ADMIN_APP_BASE` | `https://admin-studyspace-official.vercel.app` | Yes |
| `GEMINI_API_KEY` | your Gemini API key | No |
| `ENABLE_LLM_CLASSIFIER` | `true` | No |
| `AUTO_POST_CONFIDENCE_THRESHOLD` | `0.78` | No |

#### 4. Deploy

Click **Create Web Service**. Render will build the Docker image and start the service.

#### 5. Verify health

```bash
curl https://studyshare-bot-backend.onrender.com/healthz
```

Should return `{"ok":true,...}`.

---

## Connect the Vercel Frontend to Render Backend

After your Render backend is live:

### 1. Set the API base URL in the Vercel frontend

Go to your Vercel project dashboard → **Settings** → **Environment Variables** (or edit `service/chat/index.html` directly in your repo and redeploy).

**Option A: Hardcode in `index.html`**
```html
<meta name="studyshareclaw-api-base" content="https://studyshare-bot-backend.onrender.com" />
```

**Option B: Use the `STUDYSHARECLAW_API_BASE` environment variable** (if you set up build-time injection in Vercel).

### 2. Open the dashboard

```
https://studyshare-bot.vercel.app
```

The connection pill should show **"Connected"** with green.

---

## Database Migration (First Deploy)

The service auto-runs schema creation on startup via `ensureRuntimeSchema()` in `db.ts`. However, you should verify the tables exist:

```bash
# Connect to your Render PostgreSQL via psql or any SQL client
psql $DATABASE_URL -c "\dt"
```

Expected tables:
- `wa_ingest_events`
- `wa_manual_review_queue`
- `wa_group_bindings`

If they don't exist, manually run:
```bash
psql $DATABASE_URL -f db/init/001_schema.sql
```

---

## Post-Deploy Setup

### Add WhatsApp group bindings

After the backend is running, you need to add WhatsApp groups to the `wa_group_bindings` table. Use the PostgreSQL console or any SQL client:

```sql
INSERT INTO wa_group_bindings (
  group_jid, group_title, college_id, department_code,
  default_branch, default_semester, allowed_categories,
  only_useful_resources, is_active
) VALUES (
  '120363424028310177@g.us',
  '1B_CSE(AI&ML)_29',
  'fe2e3b2f-f628-49ef-8fb9-a350c808be2d',
  'aiml',
  'aiml',
  '2',
  ARRAY['resource']::text[],
  true,
  true
);
```

### Set the OpenClaw webhook URL

In your local OpenClaw config, point the webhook to your Render backend:

```bash
# Set the environment variable before starting OpenClaw gateway
export STUDYSHARE_WA_INGEST_WEBHOOK_URL=https://studyshare-bot-backend.onrender.com/v1/ingest
```

Or in your local `.env` file for the OpenClaw gateway.

---

## Local Testing (Optional)

Build and run locally with Docker:

```bash
cd render-backend
cp .env.example .env
# Edit .env with your secrets
docker build -t studyshare-bot-render .
docker run -p 8080:8080 --env-file .env studyshare-bot-render
```

---

## What's Included

| Folder | Purpose |
|--------|---------|
| `src/` | TypeScript source code (ingest-service, review queue, chat, classification) |
| `chat/` | Static dashboard UI files (served at `/chat`) |
| `extractor/` | Python scripts for PDF text extraction + OCR |
| `prompts/` | LLM classification prompts |
| `db/init/` | PostgreSQL schema initialization |
| `Dockerfile` | Production container with Node + Chromium + Python + Tesseract |
| `render.yaml` | Render Blueprint (one-click deploy) |
| `.env.example` | Environment variable template |

---

## Troubleshooting

### "Connecting..." / "Disconnected" on the dashboard
- Check the backend URL is correctly set in the Vercel frontend meta tag
- Check CORS isn't blocking — the backend sends `Access-Control-Allow-Origin: *`
- Check your Render service is not sleeping (Starter plan sleeps after 15 min inactivity)

### WhatsApp PDFs not being ingested
- Verify your local OpenClaw gateway is running and linked to WhatsApp
- Verify the `STUDYSHARE_WA_INGEST_WEBHOOK_URL` env var points to your Render backend
- Verify the group JID is in `wa_group_bindings` and `allowlist.txt`

### Render build fails
- Check `Dockerfile` uses a supported Render runtime (Docker is supported on all plans)
- Check `npm install` succeeds — if not, check Node version compatibility

---

## License

Same as the main project.
