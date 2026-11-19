# AI Job Hunter — Final Local Release

A local-first job-search workspace with real public job feeds, CV text extraction, explainable CV/role matching, an application tracker, application-draft helper, CSV export, and optional email alerts.

## Included features

- Multi-user accounts with bcrypt password hashing, rate-limited login/register, HttpOnly session cookies, and per-user CV/tracker data.
- PDF, DOCX, and DOC CV text extraction (5 MB upload limit), detected-skill list, and user-controlled CV deletion.
- Live listings from **Jobicy** and **Remotive** public APIs. Listings preserve source names and canonical source links; no fake/example.com jobs are seeded. A feed refresh is limited to at most once per hour to respect provider guidance.
- Transparent keyword match estimates with matched/missing skill details. These are not hiring predictions and do not guarantee eligibility.
- Search by job title, employer, location, and description.
- Application tracker with status, notes, removal, and CSV export.
- Cover-letter and application-question drafts. If `OPENAI_API_KEY` is configured, it uses the configured OpenAI API model; otherwise it supplies a local guided/template draft. AI provider usage can incur charges; the local template mode does not call an AI API.
- Optional scheduled email alerts. Configure an SMTP provider before enabling alerts in the UI. Job feed refresh runs on a schedule (60-minute minimum by default); email alerts only send for new feed items and are not enabled by default.
- PostgreSQL schema creation and migrations for the previous MVP database.
- Health endpoint: `/api/health`.

## Important facts about real job vacancies

The app retrieves listings from public APIs, not from every employer or job board on the internet. The feed contents, geographic eligibility, posting date, and whether a role is still open depend on the provider. Remotive says its public feed is delayed by about 24 hours. Jobicy's public feed focuses on recent remote listings. Always follow the source link, verify the employer and location eligibility, and confirm the vacancy is still open before applying. This app does not submit applications automatically.

Jobicy requires attribution and retention of its canonical listing URL, and its public API guidance asks clients not to poll more frequently than hourly. Remotive requires the source name and link to be retained and states that public API listings are delayed. This project keeps source labels and links and schedules feed checks no more frequently than hourly. Provider terms may change; review the current terms before public/commercial deployment.

Sources/docs:
- Jobicy API: https://jobicy.com/jobs-rss-feed
- Remotive API and terms: https://remotive.com/remote-jobs/api

## Requirements

- Node.js 20 or newer (Node 24 is fine)
- PostgreSQL 14+ running locally, or a compatible hosted PostgreSQL database
- macOS, Linux, or Windows

## Install or update on your Mac

**If you already have the working AI Job Hunter folder:** make a backup first. Extract this ZIP and copy its files over your existing project, replacing matching application files. Keep your existing `.env` and `uploads/` folder. This release includes database migrations and will hide old `sample` / `example.com` demo jobs from live search and matching and remove unused demo rows; tracker-linked historical demo entries are preserved so application records are not lost. Do not copy a `.env` file from another computer.

1. Open Terminal and enter your project directory, for example:
   ```bash
   cd ~/ai-job-hunter
   ```
2. Check `.env` exists and contains your existing database URL and a private random JWT secret. If you are starting fresh, copy `.env.example` to `.env`.
3. Generate a secret if you need one:
   ```bash
   openssl rand -hex 32
   ```
   Put that value after `JWT_SECRET=` in `.env`. Never paste it into chats or commit it to GitHub.
4. Check your local database name is `ai_job_hunter`. A typical local connection string is:
   ```text
   DATABASE_URL=postgres://localhost:5432/ai_job_hunter
   ```
   If your local PostgreSQL needs a username/password, use your actual local credentials in the URL.
5. Install the packages:
   ```bash
   npm install
   ```
6. Start the app:
   ```bash
   npm run dev
   ```
7. Open `http://localhost:3001/api/health`. Then open `http://localhost:3001` and log in with your existing account or create one.

The first job feed refresh starts shortly after launch. If the provider APIs are unavailable, the app keeps working with previously stored listings and shows a source/refresh message. Use **Refresh live jobs** to request a refresh; providers are checked at most hourly.

## Optional AI drafting

Without a key, the app uses a basic local template/guided outline. To use AI-generated drafts, configure `OPENAI_API_KEY` in `.env` and optionally `OPENAI_MODEL`. This uses the OpenAI API and may cost money according to your account and model pricing. Do not put API keys in frontend code or GitHub. Restart the server after editing `.env`.

## Optional email alerts

Email alerts are off by default. Configure all necessary SMTP settings in `.env`:

```text
SMTP_HOST=your-smtp-host
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-smtp-username
SMTP_PASS=your-smtp-password-or-app-password
SMTP_FROM=AI Job Hunter <your-verified-sender@example.com>
```

The exact values come from your email/SMTP provider. Restart the server, log in, and enable **Email job alerts**. Do not use your normal email password unless the provider explicitly supports it; prefer an app password or service credential. The app does not send alerts until SMTP is configured and alerts are enabled by the account owner.

## API/health checks

- `GET /api/health` — server/database status
- `GET /api/jobs/status` — job feed refresh state
- `POST /api/jobs/refresh` — request a live feed refresh (subject to hourly limits)

## Privacy and deployment warning

This is a personal/local release, not a security audit or a promise of production readiness. Uploaded CV files and extracted CV text are sensitive personal data. Files are stored under `uploads/`; PostgreSQL stores extracted text and skill metadata. Do not expose this app to the public internet yet. Before AWS/public deployment, add/review HTTPS, secure secrets, CSRF protection appropriate to the deployment, account recovery, file malware scanning, stricter production headers, privacy notice/consent, deletion/export policies, database backups, monitoring, and provider terms. For production PostgreSQL, use a managed secret store and validate TLS settings rather than copying local settings blindly.

## Troubleshooting

- **Database connection error:** check PostgreSQL is running and `DATABASE_URL` points to an existing database.
- **JWT secret error:** make sure `JWT_SECRET` is at least 32 characters and is not the example placeholder.
- **No live jobs:** check internet access and `/api/jobs/status`; public providers can be temporarily unavailable or have no current results. The app does not make up listings as a fallback.
- **Refresh says recently refreshed:** this is expected; providers are limited to an hourly refresh interval.
- **CV says needs OCR:** scanned/image-only PDFs may contain no selectable text. Use a text-based PDF or add OCR separately.
- **Email alerts unavailable:** fill in SMTP values in `.env`, restart, and try enabling again.
- **AI assistant uses a template:** set `OPENAI_API_KEY` if you want to use the optional API-based drafting mode.
- **Port 3001 already in use:** stop the other server with `Control+C` or change `PORT` in `.env`.
