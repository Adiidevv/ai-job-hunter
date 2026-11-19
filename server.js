require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Pool } = require('pg');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const WordExtractor = require('word-extractor');
const nodemailer = require('nodemailer');

const app = express();
const PORT = Number(process.env.PORT || 3001);
const JWT_SECRET = process.env.JWT_SECRET || '';
const uploadDir = path.join(__dirname, 'uploads');
if (!process.env.DATABASE_URL) { console.error('Missing DATABASE_URL in .env'); process.exit(1); }
if (JWT_SECRET.length < 32 || JWT_SECRET.includes('replace_with')) { console.error('Set JWT_SECRET to a random value of at least 32 characters.'); process.exit(1); }
fs.mkdirSync(uploadDir, { recursive: true, mode: 0o700 });
const localDb = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: localDb ? false : { rejectUnauthorized: false }, max: 10 });
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"] } } }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });
const assistantLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });
const upload = multer({
  storage: multer.diskStorage({ destination: (_req, _file, cb) => cb(null, uploadDir), filename: (req, file, cb) => cb(null, `${req.user.id}-${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`) }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => ['.pdf', '.docx', '.doc'].includes(path.extname(file.originalname).toLowerCase()) ? cb(null, true) : cb(new Error('Please upload a PDF, DOC, or DOCX file.'))
});
function makeToken(user) { return jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' }); }
function setAuthCookie(res, user) { res.cookie('ajh_session', makeToken(user), { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 86400000, path: '/' }); }
function requireAuth(req, res, next) {
  const token = req.cookies.ajh_session;
  if (!token) return res.status(401).json({ error: 'Please log in first.' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch (_e) { res.clearCookie('ajh_session', { path: '/' }); return res.status(401).json({ error: 'Your session expired. Please log in again.' }); }
}
function safeUser(u) { return { id: u.id, name: u.name, email: u.email, desired_roles: u.desired_roles || '', preferred_location: u.preferred_location || 'Remote, India', email_alerts: Boolean(u.email_alerts) }; }
const SKILLS = [
 ['aws', /\baws\b|amazon web services/i], ['ec2', /\bec2\b/i], ['cloud computing', /cloud computing/i], ['cloud', /\bcloud\b/i], ['linux', /\blinux\b|ubuntu|centos/i], ['networking', /networking|tcp\/ip|\bdns\b|subnet/i], ['troubleshooting', /troubleshoot(?:ing)?/i], ['customer support', /customer support|technical support|help ?desk/i], ['communication', /communicat(?:ion|ions|ing)|interpersonal/i], ['presentation', /presentations?|product demos?|demonstrations?/i], ['javascript', /javascript|\bjs\b/i], ['node.js', /node\.js|\bnodejs\b/i], ['express', /\bexpress(?:\.js)?\b/i], ['rest api', /restful? apis?|\bapis?\b/i], ['git', /\bgit\b|github/i], ['python', /\bpython\b/i], ['java', /\bjava\b/i], ['sql', /\bsql\b|postgres(?:ql)?|mysql/i], ['docker', /\bdocker\b/i], ['kubernetes', /kubernetes|\bk8s\b/i], ['devops', /\bdevops\b/i], ['html', /\bhtml\b/i], ['css', /\bcss\b/i], ['react', /\breact(?:\.js)?\b/i], ['cybersecurity', /cyber ?security|information security|penetration testing/i], ['problem solving', /problem.solving|analytical skills/i], ['database', /databases?|database management/i], ['agile', /\bagile\b|scrum/i], ['sales', /\bsales\b|deal.closing|negotiation/i], ['microsoft office', /microsoft office|excel|powerpoint|word processing/i]
];
function extractSkills(text) { const found = new Set(); for (const [skill, pattern] of SKILLS) if (pattern.test(text)) found.add(skill); return [...found]; }
async function extractResumeText(filePath, ext) {
  if (ext === '.pdf') return String((await pdfParse(fs.readFileSync(filePath))).text || '').replace(/\u0000/g, ' ').trim();
  if (ext === '.docx') return String((await mammoth.extractRawText({ path: filePath })).value || '').replace(/\u0000/g, ' ').trim();
  if (ext === '.doc') return String((await new WordExtractor().extract(filePath)).getBody() || '').replace(/\u0000/g, ' ').trim();
  throw new Error('Unsupported file type.');
}
function textFromHtml(value) { return String(value || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim(); }
function dateOrNull(value) { const d = value ? new Date(value) : null; return d && !Number.isNaN(d.getTime()) ? d : null; }
function cleanString(v, max = 10000) { return String(v ?? '').replace(/\u0000/g, '').trim().slice(0, max); }
function extractJobSkills(title, description, tags = []) { const text = `${title} ${description} ${(tags || []).join(' ')}`; return extractSkills(text); }
function scoreJob(job, roleText, cvSkills) {
  const jobSkills = (job.skills || []).map(s => String(s).toLowerCase());
  const cv = new Set((cvSkills || []).map(s => String(s).toLowerCase()));
  const matched = jobSkills.filter(s => cv.has(s));
  const missing = jobSkills.filter(s => !cv.has(s));
  const roles = String(roleText || '').split(/[,;|]/).map(s => s.trim().toLowerCase()).filter(Boolean);
  const title = String(job.title || '').toLowerCase();
  const roleMatch = roles.some(role => title.includes(role) || role.split(/\s+/).some(word => word.length > 3 && title.includes(word)));
  const skillScore = jobSkills.length ? Math.round((matched.length / jobSkills.length) * 80) : 0;
  const score = Math.min(100, Math.max(0, skillScore + (roleMatch ? 20 : 0)));
  return { match_score: score, matched_skills: matched, missing_skills: missing, match_basis: cv.size ? 'CV skills and target roles (keyword estimate)' : 'Target-role preferences (keyword estimate)' };
}

// Public feeds: retain attribution and canonical provider links. These APIs need no key.
let refreshPromise = null;
let lastRefreshAt = null;
let lastRefreshMessage = 'Job feeds have not been refreshed in this process yet.';
async function getJson(url) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 18000);
  try { const response = await fetch(url, { headers: { 'accept': 'application/json', 'user-agent': 'AIJobHunter/1.0 (personal job discovery tool)' }, signal: controller.signal }); if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`); return await response.json(); }
  finally { clearTimeout(timer); }
}
async function fetchJobicy() {
  const data = await getJson('https://jobicy.com/api/v2/remote-jobs?count=100');
  return (Array.isArray(data.jobs) ? data.jobs : []).map(j => ({ source: 'Jobicy', source_job_id: String(j.id ?? j.jobSlug ?? j.url), title: cleanString(j.jobTitle, 300), company: cleanString(j.companyName || 'Company not specified', 300), location: cleanString(j.jobGeo || 'Remote / not specified', 300), job_type: cleanString([...(j.jobType || []), j.jobLevel].filter(Boolean).join(' · ') || 'Not specified', 150), description: textFromHtml(j.jobExcerpt || j.jobDescription || ''), skills: extractJobSkills(j.jobTitle, textFromHtml(j.jobDescription || j.jobExcerpt), j.jobIndustry || []), apply_url: cleanString(j.url, 2000), source_url: cleanString(j.url, 2000), posted_at: dateOrNull(j.pubDate) } )).filter(j => j.title && /^https:\/\//i.test(j.apply_url));
}
async function fetchRemotive() {
  const data = await getJson('https://remotive.com/api/remote-jobs?limit=100');
  return (Array.isArray(data.jobs) ? data.jobs : []).map(j => ({ source: 'Remotive', source_job_id: String(j.id), title: cleanString(j.title, 300), company: cleanString(j.company_name || 'Company not specified', 300), location: cleanString(j.candidate_required_location || 'Remote', 300), job_type: cleanString(j.job_type || 'Remote', 150), description: textFromHtml(j.description || j.job_description || ''), skills: extractJobSkills(j.title, textFromHtml(j.description || ''), j.tags || []), apply_url: cleanString(j.url, 2000), source_url: cleanString(j.url, 2000), posted_at: dateOrNull(j.publication_date) })).filter(j => j.title && /^https:\/\//i.test(j.apply_url));
}
async function refreshJobs(force = false) {
  if (refreshPromise) return refreshPromise;
  const refreshMinutes = Math.max(60, Number(process.env.JOB_REFRESH_MINUTES || 60));
  if (lastRefreshAt && Date.now() - lastRefreshAt < refreshMinutes * 60000) return { skipped: true, message: 'Job sources were refreshed recently. The providers are checked at most hourly to respect their public API limits.', refreshedAt: lastRefreshAt, count: 0 };
  refreshPromise = (async () => {
    const outcomes = await Promise.allSettled([fetchJobicy(), fetchRemotive()]);
    const successful = outcomes.filter(o => o.status === 'fulfilled').flatMap(o => o.value);
    const errors = outcomes.filter(o => o.status === 'rejected').map(o => o.reason?.message || 'provider error');
    if (!successful.length) { lastRefreshMessage = `No provider returned jobs. ${errors.join(' | ')}`; throw new Error(lastRefreshMessage); }
    let insertedOrUpdated = 0;
    for (const j of successful) {
      const result = await pool.query(`INSERT INTO jobs (source, source_job_id, title, company, location, job_type, description, skills, apply_url, source_url, posted_at, last_seen_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
        ON CONFLICT (source, source_job_id) DO UPDATE SET title=EXCLUDED.title, company=EXCLUDED.company, location=EXCLUDED.location, job_type=EXCLUDED.job_type, description=EXCLUDED.description, skills=EXCLUDED.skills, apply_url=EXCLUDED.apply_url, source_url=EXCLUDED.source_url, posted_at=EXCLUDED.posted_at, last_seen_at=NOW()
        RETURNING id`, [j.source, j.source_job_id, j.title, j.company, j.location, j.job_type, j.description, j.skills, j.apply_url, j.source_url, j.posted_at]);
      if (result.rowCount) insertedOrUpdated++;
    }
    lastRefreshAt = Date.now();
    await pool.query("INSERT INTO job_feed_meta(meta_key,meta_value) VALUES('last_refresh_at',$1) ON CONFLICT(meta_key) DO UPDATE SET meta_value=EXCLUDED.meta_value", [new Date(lastRefreshAt).toISOString()]);
    lastRefreshMessage = `Loaded ${successful.length} real listings from ${outcomes.filter(o => o.status === 'fulfilled').length} provider(s).${errors.length ? ` Provider notes: ${errors.join(' | ')}` : ''}`;
    await sendNewJobAlerts();
    return { skipped: false, message: lastRefreshMessage, refreshedAt: lastRefreshAt, count: successful.length, saved: insertedOrUpdated, providers: outcomes.map((o, i) => ({ source: ['Jobicy', 'Remotive'][i], ok: o.status === 'fulfilled', count: o.status === 'fulfilled' ? o.value.length : 0, error: o.status === 'rejected' ? (o.reason?.message || 'Request failed') : undefined })) };
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
}
async function sendNewJobAlerts() {
  const configured = process.env.SMTP_HOST && process.env.SMTP_FROM;
  if (!configured) return;
  const transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: String(process.env.SMTP_SECURE).toLowerCase() === 'true', auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined });
  const users = await pool.query('SELECT id,name,email,desired_roles FROM users WHERE email_alerts=TRUE');
  for (const u of users.rows) {
    const roles = String(u.desired_roles || '').split(/[,;|]/).map(s => s.trim().toLowerCase()).filter(Boolean);
    const result = await pool.query(`SELECT j.id,j.title,j.company,j.location,j.apply_url,j.source,j.posted_at FROM jobs j
      WHERE NOT EXISTS (SELECT 1 FROM alert_history h WHERE h.user_id=$1 AND h.job_id=j.id)
      AND ($2::text[] = '{}' OR EXISTS (SELECT 1 FROM unnest($2::text[]) r WHERE lower(j.title) LIKE '%'||r||'%'))
      ORDER BY j.posted_at DESC NULLS LAST LIMIT 8`, [u.id, roles]);
    if (!result.rows.length) continue;
    const lines = result.rows.map(j => `${j.title} — ${j.company} (${j.location})\nSource: ${j.source}\n${j.apply_url}`).join('\n\n');
    try {
      await transporter.sendMail({ from: process.env.SMTP_FROM, to: u.email, subject: `AI Job Hunter: ${result.rows.length} new job match(es)`, text: `Hi ${u.name},\n\nNew job listings matching your preferences:\n\n${lines}\n\nReview each employer listing before applying.` });
      await pool.query('INSERT INTO alert_history (user_id, job_id) SELECT $1, unnest($2::bigint[]) ON CONFLICT DO NOTHING', [u.id, result.rows.map(j => j.id)]);
    } catch (e) { console.error('Email alert failed:', e.message); }
  }
}

app.get('/api/health', async (_req, res) => { try { await pool.query('SELECT 1'); res.json({ status: 'ok', database: 'connected', project: 'AI Job Hunter', jobFeeds: ['Jobicy', 'Remotive'], lastRefreshAt: lastRefreshAt ? new Date(lastRefreshAt).toISOString() : null }); } catch (_e) { res.status(503).json({ status: 'error', message: 'Database connection failed.' }); } });
app.post('/api/auth/register', authLimiter, async (req, res) => {
  try { const name = cleanString(req.body.name, 120); const email = cleanString(req.body.email, 254).toLowerCase(); const password = String(req.body.password || '');
    if (name.length < 2) return res.status(400).json({ error: 'Name must be at least 2 characters.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (password.length < 10 || password.length > 128) return res.status(400).json({ error: 'Password must be 10–128 characters.' });
    const hash = await bcrypt.hash(password, 12);
    const r = await pool.query('INSERT INTO users (name,email,password_hash) VALUES ($1,$2,$3) RETURNING id,name,email,desired_roles,preferred_location,email_alerts', [name,email,hash]); setAuthCookie(res, r.rows[0]); res.status(201).json({ user: safeUser(r.rows[0]) });
  } catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'An account with that email already exists.' }); console.error('Register:', e.message); res.status(500).json({ error: 'Could not create account.' }); }
});
app.post('/api/auth/login', authLimiter, async (req,res) => { try { const email=cleanString(req.body.email,254).toLowerCase(); const r=await pool.query('SELECT * FROM users WHERE email=$1',[email]); const u=r.rows[0]; if(!u || !(await bcrypt.compare(String(req.body.password||''),u.password_hash))) return res.status(401).json({error:'Email or password is incorrect.'}); setAuthCookie(res,u); res.json({user:safeUser(u)}); } catch(e){ console.error('Login:',e.message); res.status(500).json({error:'Could not log in.'});} });
app.post('/api/auth/logout', (_req,res)=>{res.clearCookie('ajh_session',{path:'/'});res.json({ok:true});});
app.get('/api/me',requireAuth,async(req,res)=>{const r=await pool.query('SELECT id,name,email,desired_roles,preferred_location,email_alerts FROM users WHERE id=$1',[req.user.id]);if(!r.rows[0])return res.status(404).json({error:'Account not found.'});res.json({user:safeUser(r.rows[0])});});
app.put('/api/profile',requireAuth,async(req,res)=>{const roles=cleanString(req.body.desired_roles,500);const loc=cleanString(req.body.preferred_location||'Remote, India',120);const r=await pool.query('UPDATE users SET desired_roles=$1,preferred_location=$2 WHERE id=$3 RETURNING id,name,email,desired_roles,preferred_location,email_alerts',[roles,loc,req.user.id]);res.json({user:safeUser(r.rows[0])});});
app.put('/api/alerts',requireAuth,async(req,res)=>{const enabled=Boolean(req.body.email_alerts);if(enabled&&!(process.env.SMTP_HOST&&process.env.SMTP_FROM))return res.status(400).json({error:'Email alerts need SMTP settings in .env first. See README.md.'});const r=await pool.query('UPDATE users SET email_alerts=$1 WHERE id=$2 RETURNING id,name,email,desired_roles,preferred_location,email_alerts',[enabled,req.user.id]);if(enabled)await pool.query('INSERT INTO alert_history(user_id,job_id) SELECT $1,id FROM jobs ON CONFLICT DO NOTHING',[req.user.id]);res.json({user:safeUser(r.rows[0]),message:enabled?'Email alerts enabled for future matching jobs.':'Email alerts disabled.'});});
app.get('/api/jobs/status',requireAuth,(_req,res)=>res.json({lastRefreshAt:lastRefreshAt?new Date(lastRefreshAt).toISOString():null,message:lastRefreshMessage,sources:['Jobicy','Remotive'],refreshIntervalMinutes:Math.max(60,Number(process.env.JOB_REFRESH_MINUTES||60))}));
app.post('/api/jobs/refresh',requireAuth,async(_req,res)=>{try{const result=await refreshJobs(true);res.json(result);}catch(e){res.status(502).json({error:e.message||'Could not refresh live job sources.',providers:['Jobicy','Remotive']});}});
app.get('/api/matches',requireAuth,async(req,res)=>{try{const u=(await pool.query('SELECT desired_roles FROM users WHERE id=$1',[req.user.id])).rows[0];const cv=(await pool.query("SELECT extracted_skills FROM cvs WHERE user_id=$1 AND extraction_status='completed' ORDER BY uploaded_at DESC LIMIT 1",[req.user.id])).rows[0];const skills=cv?.extracted_skills||[];const q=await pool.query(`SELECT j.*, EXISTS(SELECT 1 FROM applications a WHERE a.job_id=j.id AND a.user_id=$1) AS saved,
 (SELECT a.status FROM applications a WHERE a.job_id=j.id AND a.user_id=$1 LIMIT 1) AS application_status FROM jobs j WHERE j.source <> 'sample' AND j.apply_url NOT LIKE '%example.com%' ORDER BY j.posted_at DESC NULLS LAST,j.last_seen_at DESC LIMIT 300`,[req.user.id]);const jobs=q.rows.map(j=>({...j,...scoreJob(j,u?.desired_roles,skills)})).sort((a,b)=>b.match_score-a.match_score);res.json({jobs,matching:{hasExtractedCv:Boolean(cv),cvSkills:skills},jobSources:['Jobicy','Remotive']});}catch(e){console.error('Matches:',e.message);res.status(500).json({error:'Could not calculate job matches.'});}});
app.get('/api/jobs/search',requireAuth,async(req,res)=>{const term=cleanString(req.query.q,100).toLowerCase();if(!term)return res.json({jobs:[]});const r=await pool.query(`SELECT * FROM jobs WHERE source <> 'sample' AND apply_url NOT LIKE '%example.com%' AND lower(title||' '||company||' '||location||' '||description) LIKE $1 ORDER BY posted_at DESC NULLS LAST LIMIT 100`,[`%${term}%`]);res.json({jobs:r.rows});});
app.post('/api/cv',requireAuth,(req,res)=>{upload.single('cv')(req,res,async err=>{if(err)return res.status(400).json({error:err.message||'Upload failed.'});try{if(!req.file)return res.status(400).json({error:'Choose a CV file first.'});const ext=path.extname(req.file.originalname).toLowerCase();let extractedText='',skills=[],status='completed',message='CV text extracted successfully.';try{extractedText=await extractResumeText(req.file.path,ext);skills=extractSkills(extractedText);if(extractedText.length<40){status='needs_ocr';message='Very little selectable text was found. A scanned PDF may need OCR.';}else if(!skills.length)message='Text extracted, but no known skills were detected. Review the CV or add skills manually.';}catch(e){status='failed';message='File saved, but extraction failed. Try a text-based PDF or DOCX.';console.error('CV extraction:',e.message);}const r=await pool.query(`INSERT INTO cvs(user_id,original_name,stored_name,mime_type,size_bytes,extracted_text,extracted_skills,extraction_status,extraction_message) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,original_name,size_bytes,uploaded_at,extracted_skills,extraction_status,extraction_message`,[req.user.id,req.file.originalname,req.file.filename,req.file.mimetype,req.file.size,extractedText,skills,status,message]);res.status(201).json({cv:r.rows[0],message,extractedSkills:skills});}catch(e){if(req.file)fs.unlink(req.file.path,()=>{});console.error('CV upload:',e.message);res.status(500).json({error:'Could not save CV details.'});}});});
app.get('/api/cv',requireAuth,async(req,res)=>{const r=await pool.query('SELECT id,original_name,size_bytes,uploaded_at,extracted_skills,extraction_status,extraction_message FROM cvs WHERE user_id=$1 ORDER BY uploaded_at DESC',[req.user.id]);res.json({cvs:r.rows});});
app.delete('/api/cv/:id',requireAuth,async(req,res)=>{const id=Number(req.params.id);const r=await pool.query('DELETE FROM cvs WHERE id=$1 AND user_id=$2 RETURNING stored_name',[id,req.user.id]);if(!r.rows.length)return res.status(404).json({error:'CV not found.'});fs.unlink(path.join(uploadDir,path.basename(r.rows[0].stored_name)),()=>{});res.json({ok:true});});
app.post('/api/applications/:jobId',requireAuth,async(req,res)=>{const id=Number(req.params.jobId);if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:'Invalid job.'});const exists=await pool.query('SELECT id FROM jobs WHERE id=$1',[id]);if(!exists.rows.length)return res.status(404).json({error:'Job not found.'});const r=await pool.query(`INSERT INTO applications(user_id,job_id,status) VALUES($1,$2,'saved') ON CONFLICT(user_id,job_id) DO UPDATE SET updated_at=NOW() RETURNING id,job_id,status,created_at`,[req.user.id,id]);res.status(201).json({application:r.rows[0],message:'Saved to your tracker. This does not submit an application to the employer.'});});
app.get('/api/applications',requireAuth,async(req,res)=>{const r=await pool.query(`SELECT a.id,a.job_id,a.status,a.notes,a.applied_at,a.created_at,j.title,j.company,j.apply_url,j.source FROM applications a JOIN jobs j ON j.id=a.job_id WHERE a.user_id=$1 ORDER BY a.updated_at DESC`,[req.user.id]);res.json({applications:r.rows});});
app.patch('/api/applications/:id',requireAuth,async(req,res)=>{const id=Number(req.params.id);const allowed=['saved','ready_to_apply','applied','interview','rejected','offer'];const status=String(req.body.status||'');const notes=cleanString(req.body.notes,2000);if(!Number.isSafeInteger(id)||id<1||!allowed.includes(status))return res.status(400).json({error:'Invalid application or status.'});const r=await pool.query(`UPDATE applications SET status=$1,notes=$2,applied_at=CASE WHEN $1='applied' AND applied_at IS NULL THEN NOW() ELSE applied_at END,updated_at=NOW() WHERE id=$3 AND user_id=$4 RETURNING id,status,notes,applied_at`,[status,notes,id,req.user.id]);if(!r.rows.length)return res.status(404).json({error:'Application not found.'});res.json({application:r.rows[0]});});
app.delete('/api/applications/:id',requireAuth,async(req,res)=>{const r=await pool.query('DELETE FROM applications WHERE id=$1 AND user_id=$2 RETURNING id',[Number(req.params.id),req.user.id]);if(!r.rows.length)return res.status(404).json({error:'Tracker item not found.'});res.json({ok:true});});

async function assistantText(prompt) {
  if (!process.env.OPENAI_API_KEY) return null;
  const response=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${process.env.OPENAI_API_KEY}`},body:JSON.stringify({model:process.env.OPENAI_MODEL||'gpt-4o-mini',temperature:0.4,messages:[{role:'system',content:'You are a careful job application assistant. Use only facts supplied by the candidate. Never invent qualifications, employers, dates, metrics, or achievements. Keep writing clear, concise, and truthful.'},{role:'user',content:prompt}]}),signal:AbortSignal.timeout(45000)});
  if(!response.ok){const body=await response.text();throw new Error(`AI provider returned HTTP ${response.status}: ${body.slice(0,200)}`);}const data=await response.json();return data.choices?.[0]?.message?.content?.trim()||null;
}
async function getUserCv(userId){return (await pool.query("SELECT extracted_text,extracted_skills FROM cvs WHERE user_id=$1 AND extraction_status='completed' ORDER BY uploaded_at DESC LIMIT 1",[userId])).rows[0]||{extracted_text:'',extracted_skills:[]};}
app.post('/api/assistant/cover-letter',requireAuth,assistantLimiter,async(req,res)=>{try{const jobId=Number(req.body.job_id);const job=(await pool.query('SELECT * FROM jobs WHERE id=$1',[jobId])).rows[0];if(!job)return res.status(404).json({error:'Select a job first.'});const cv=await getUserCv(req.user.id);const prompt=`Write a truthful, tailored cover letter for this candidate. Do not claim experience or skills not supported by the CV.\nCandidate name: ${req.user.name}\nCV text (may be incomplete): ${cv.extracted_text.slice(0,9000)}\nDetected skills: ${(cv.extracted_skills||[]).join(', ')}\nJob title: ${job.title}\nCompany: ${job.company}\nJob details: ${job.description.slice(0,5000)}\nUse 3-4 short paragraphs and a professional tone. If evidence is missing, use cautious wording rather than inventing facts.`;let letter=await assistantText(prompt);if(!letter){const matched=(cv.extracted_skills||[]).filter(s=>(job.skills||[]).includes(s));letter=`Dear Hiring Team,\n\nI am applying for the ${job.title} opportunity at ${job.company}. My background includes ${matched.length?matched.join(', '):((cv.extracted_skills||[]).slice(0,5).join(', ')||'technical learning and project work')}. I am interested in contributing while continuing to develop my skills in a practical team environment.\n\nI would welcome the opportunity to discuss how my background and willingness to learn align with this role. Thank you for your time and consideration.\n\nSincerely,\n${req.user.name}\n\nNote: This is a template draft. Review and personalize it before sending.`;}res.json({text:letter,mode:process.env.OPENAI_API_KEY?'AI-assisted':'local template',disclaimer:'Review for accuracy before use. This does not submit an application.'});}catch(e){console.error('Cover letter:',e.message);res.status(502).json({error:'Could not create the draft. Check AI settings or try again.'});}});
app.post('/api/assistant/application-answer',requireAuth,assistantLimiter,async(req,res)=>{try{const question=cleanString(req.body.question,1200);const jobId=Number(req.body.job_id);if(!question)return res.status(400).json({error:'Enter the application question.'});const job=(await pool.query('SELECT * FROM jobs WHERE id=$1',[jobId])).rows[0];if(!job)return res.status(404).json({error:'Select a job first.'});const cv=await getUserCv(req.user.id);const prompt=`Draft an honest answer to this job application question. Do not invent facts. If the CV does not provide enough evidence, say what the candidate should fill in.\nCandidate: ${req.user.name}\nCV: ${cv.extracted_text.slice(0,9000)}\nDetected skills: ${(cv.extracted_skills||[]).join(', ')}\nRole: ${job.title} at ${job.company}\nQuestion: ${question}\nAnswer in first person, 80-160 words.`;let answer=await assistantText(prompt);if(!answer)answer=`Draft outline for your answer:\n\nFor the ${job.title} role at ${job.company}, connect your relevant skills (${(cv.extracted_skills||[]).slice(0,6).join(', ')||'add your relevant skills'}) to the question. Give one real example from your coursework, internship, or project, explain your contribution, and finish with how it relates to this role.\n\nQuestion: ${question}\n\nAdd your real example before using this draft.`;res.json({text:answer,mode:process.env.OPENAI_API_KEY?'AI-assisted':'guided template',disclaimer:'Check every detail and replace placeholders with true information.'});}catch(e){console.error('Application answer:',e.message);res.status(502).json({error:'Could not create the answer draft.'});}});
app.get('/api/export/tracker',requireAuth,async(req,res)=>{const r=await pool.query(`SELECT j.title,j.company,j.location,j.source,j.apply_url,a.status,a.notes,a.created_at,a.applied_at FROM applications a JOIN jobs j ON j.id=a.job_id WHERE a.user_id=$1 ORDER BY a.created_at DESC`,[req.user.id]);const csvCell=v=>'"'+String(v??'').replace(/"/g,'""')+'"';const rows=[['Title','Company','Location','Source','Job URL','Status','Notes','Saved At','Applied At'],...r.rows.map(x=>[x.title,x.company,x.location,x.source,x.apply_url,x.status,x.notes,x.created_at,x.applied_at])];res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="ai-job-hunter-tracker.csv"');res.send('\uFEFF'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n'));});
app.use((err,_req,res,_next)=>{console.error('Unhandled request error:',err.message);res.status(500).json({error:'Unexpected server error.'});});
async function start(){try{const schema=fs.readFileSync(path.join(__dirname,'sql','schema.sql'),'utf8');await pool.query(schema);await pool.query("DELETE FROM jobs j WHERE (j.source='sample' OR j.apply_url LIKE '%example.com%') AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.job_id=j.id)");const meta=await pool.query("SELECT meta_value FROM job_feed_meta WHERE meta_key='last_refresh_at'");if(meta.rows[0]?.meta_value){const t=Date.parse(meta.rows[0].meta_value);if(Number.isFinite(t))lastRefreshAt=t;}app.listen(PORT,()=>console.log(`AI Job Hunter running at http://localhost:${PORT}`));setTimeout(()=>refreshJobs(false).then(r=>console.log('Initial job refresh:',r.message)).catch(e=>console.warn('Initial job refresh unavailable:',e.message)),1500);const mins=Math.max(60,Number(process.env.JOB_REFRESH_MINUTES||60));setInterval(()=>refreshJobs(false).then(r=>{if(!r.skipped)console.log('Scheduled job refresh:',r.message);}).catch(e=>console.warn('Scheduled job refresh failed:',e.message)),mins*60000).unref();}catch(e){console.error('Startup failed. Check PostgreSQL and DATABASE_URL in .env.');console.error(e.message);process.exit(1);}}
start();
