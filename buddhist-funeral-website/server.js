/**
 * Singapore Buddhist Funeral Services
 * Public website + admin backend (edit copy, upload images).
 *
 * Data is stored in data/content.json. Uploaded images live in public/uploads.
 * No database required.
 */

const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // behind Nginx — enables req.secure and real req.ip from X-Forwarded-*

// ---- Security headers (every response) -------------------------------------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; base-uri 'self'; frame-ancestors 'self'; " +
      "img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; " +
      "connect-src 'self'; form-action 'self'"
  );
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
});

// CSRF defense for state-changing POSTs: the request's Origin/Referer must be this site.
function sameOriginPost(req, res, next) {
  const host = req.headers.host;
  const src = req.headers.origin || req.headers.referer;
  if (src) {
    try { if (new URL(src).host === host) return next(); } catch (e) { /* malformed */ }
    return res.status(403).send('Request blocked (cross-origin).');
  }
  return next(); // no Origin/Referer (rare); SameSite=lax cookie still applies
}

// ---- Config ----------------------------------------------------------------
// App runs on a port in the 20201–20300 range. Override with the PORT env var (any value in that range).
const PORT = process.env.PORT || 20201;
// Change the admin password here or via the ADMIN_PASSWORD environment variable.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-secret-in-production';

// ---- Contact form / email config ------------------------------------------
// Where enquiries are sent. Override with CONTACT_TO.
const CONTACT_TO = process.env.CONTACT_TO || 'fudunchuan.rsn@gmail.com';
// SMTP server used to send mail. Defaults to Gmail. To actually send email you
// must set SMTP_USER and SMTP_PASS (for Gmail, use an "App Password" — see README).
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;
const MAIL_ENABLED = Boolean(SMTP_USER && SMTP_PASS);

// ---- Chatbot (Anthropic Claude) config -------------------------------------
// API key lives only in the server-managed ecosystem.config.js (git-ignored).
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
// Chat is on only when not explicitly disabled AND a key is configured.
const CHAT_ENABLED = process.env.CHAT_ENABLED !== '0' && !!ANTHROPIC_API_KEY;
const CHAT_MAX_CONCURRENT = Number(process.env.CHAT_MAX_CONCURRENT || 4); // API-bound, not CPU
let chatInFlight = 0;

const DATA_FILE = path.join(__dirname, 'data', 'content.json');
// Seed/template content shipped in the repo. The live, admin-edited content lives
// in content.json, which is NOT tracked by git so deploys never overwrite it.
const DATA_DEFAULT_FILE = path.join(__dirname, 'data', 'content.default.json');
const ENQUIRIES_FILE = path.join(__dirname, 'data', 'enquiries.json');
const ADMINS_FILE = path.join(__dirname, 'data', 'admins.json'); // [{username, hash}]
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// On first run (e.g. a fresh deploy), create the live content from the seed.
if (!fs.existsSync(DATA_FILE) && fs.existsSync(DATA_DEFAULT_FILE)) {
  fs.copyFileSync(DATA_DEFAULT_FILE, DATA_FILE);
  console.log('Seeded data/content.json from content.default.json');
}

// Fill in any NEW fields/sections added to the seed since the live content was
// created — without overwriting existing (admin-edited) values. Lets new sections
// (e.g. About Us) appear on deploy while preserving the client's edits.
function fillMissing(target, defaults) {
  let changed = false;
  for (const key of Object.keys(defaults)) {
    if (!(key in target)) {
      target[key] = defaults[key];
      changed = true;
    } else if (
      defaults[key] && typeof defaults[key] === 'object' && !Array.isArray(defaults[key]) &&
      target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])
    ) {
      changed = fillMissing(target[key], defaults[key]) || changed;
    }
    // Arrays and primitives that already exist are left as-is (client's data wins).
  }
  return changed;
}
if (fs.existsSync(DATA_FILE) && fs.existsSync(DATA_DEFAULT_FILE)) {
  try {
    const live = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const defaults = JSON.parse(fs.readFileSync(DATA_DEFAULT_FILE, 'utf8'));
    if (fillMissing(live, defaults)) {
      fs.writeFileSync(DATA_FILE, JSON.stringify(live, null, 2));
      console.log('Merged new default fields into data/content.json');
    }
  } catch (e) {
    console.error('Could not merge defaults into content.json:', e.message);
  }
}

// ---- Admin accounts (username + scrypt-hashed password) --------------------
function loadAdmins() {
  try { return JSON.parse(fs.readFileSync(ADMINS_FILE, 'utf8')); } catch { return []; }
}
function saveAdmins(list) {
  fs.writeFileSync(ADMINS_FILE, JSON.stringify(list, null, 2));
}
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return 'scrypt:' + salt + ':' + hash;
}
function verifyPassword(pw, stored) {
  try {
    const [scheme, salt, hash] = String(stored).split(':');
    if (scheme !== 'scrypt' || !salt || !hash) return false;
    const calc = crypto.scryptSync(String(pw), salt, 64);
    const expected = Buffer.from(hash, 'hex');
    return expected.length === calc.length && crypto.timingSafeEqual(expected, calc);
  } catch (e) { return false; }
}
function findAdmin(username) {
  const u = String(username || '').trim().toLowerCase();
  return loadAdmins().find((a) => a.username.toLowerCase() === u);
}
// Seed the first admin from ADMIN_PASSWORD on first run (username: "admin").
if (loadAdmins().length === 0) {
  try {
    saveAdmins([{ username: 'admin', hash: hashPassword(ADMIN_PASSWORD) }]);
    console.log('Seeded initial admin account "admin" from ADMIN_PASSWORD');
  } catch (e) {
    console.error('Could not seed admin account:', e.message);
  }
}

// Build the mail transporter only when credentials are present.
const transporter = MAIL_ENABLED
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    })
  : null;

// ---- Content store ---------------------------------------------------------
function loadContent() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}
function saveContent(content) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(content, null, 2));
}

// ---- Enquiry store (backup so nothing is lost even if email fails) ---------
function loadEnquiries() {
  try {
    return JSON.parse(fs.readFileSync(ENQUIRIES_FILE, 'utf8'));
  } catch {
    return [];
  }
}
function saveEnquiry(entry) {
  const list = loadEnquiries();
  list.unshift(entry); // newest first
  fs.writeFileSync(ENQUIRIES_FILE, JSON.stringify(list, null, 2));
}

// ---- Send an enquiry by email (best effort) --------------------------------
async function emailEnquiry(entry) {
  if (!transporter) return false;
  const html = `
    <h2>New enquiry from the website</h2>
    <p><strong>Name:</strong> ${escapeHtml(entry.name)}</p>
    <p><strong>Phone:</strong> ${escapeHtml(entry.phone || '—')}</p>
    <p><strong>Email:</strong> ${escapeHtml(entry.email || '—')}</p>
    <p><strong>Message:</strong></p>
    <p style="white-space:pre-wrap">${escapeHtml(entry.message)}</p>
    <hr><p style="color:#888;font-size:12px">Received ${entry.date}</p>`;
  await transporter.sendMail({
    from: SMTP_FROM,
    to: CONTACT_TO,
    replyTo: entry.email || undefined,
    subject: `Website enquiry from ${entry.name}`,
    text: `Name: ${entry.name}\nPhone: ${entry.phone || '-'}\nEmail: ${entry.email || '-'}\n\n${entry.message}\n\nReceived ${entry.date}`,
    html,
  });
  return true;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

// ---- App setup -------------------------------------------------------------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true, limit: '2mb' })); // extended -> nested form fields
app.use(express.json({ limit: '64kb' })); // for the chatbot API
app.use(express.static(path.join(__dirname, 'public')));
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 1000 * 60 * 60 * 8 }, // 8 hours; secure when HTTPS
  })
);

// ---- Image uploads ---------------------------------------------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safe = file.originalname.toLowerCase().replace(/[^a-z0-9.]+/g, '-');
    cb(null, Date.now() + '-' + safe);
  },
});
// Whitelist raster image types only. SVG is excluded on purpose — it can carry
// embedded scripts and would be served same-origin (stored-XSS risk).
const ALLOWED_IMG_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const ALLOWED_IMG_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (ALLOWED_IMG_EXT.includes(ext) && ALLOWED_IMG_MIME.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only PNG, JPG, WEBP or GIF images are allowed.'));
  },
});

// ---- Auth ------------------------------------------------------------------
function requireAuth(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  return res.redirect('/admin/login');
}

// ---- Admin login brute-force throttling (per IP) ---------------------------
const loginFails = new Map(); // ip -> { count, until }
function loginLocked(ip) {
  const rec = loginFails.get(ip);
  return rec && rec.until && Date.now() < rec.until;
}
function noteLoginFail(ip) {
  const rec = loginFails.get(ip) || { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= 5) rec.until = Date.now() + 15 * 60 * 1000; // lock 15 min after 5 fails
  loginFails.set(ip, rec);
}
function clearLoginFails(ip) { loginFails.delete(ip); }

// ============================================================================
// PUBLIC SITE
// ============================================================================
function renderHome(req, res, lang) {
  res.render('index', {
    c: loadContent(),
    lang: lang,
    formStatus: req.query.sent === '1' ? 'ok' : req.query.err === '1' ? 'err' : null,
  });
}
// English at /, Chinese at /zh — each a separate crawlable, indexable URL (hreflang in <head>).
app.get('/', (req, res) => renderHome(req, res, 'en'));
app.get('/zh', (req, res) => renderHome(req, res, 'zh'));

// ---- Inner SEO content pages (bilingual: /slug = en, /zh/slug = zh) ----------
const SITE_URL = 'https://singaporebuddhistfuneral.com.sg';
function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function makeT(lang) {
  return (en, zh) => escHtml(lang === 'zh' ? (zh == null || zh === '' ? en : zh) : (en == null ? '' : en));
}
function renderContentPage(res, view, lang, enPath, zhPath, pageTitle, pageDesc, jsonLd, extra) {
  const IS_ZH = lang === 'zh';
  res.render(view, Object.assign({
    c: loadContent(),
    lang, L: lang, IS_ZH,
    t: makeT(lang),
    homeHref: IS_ZH ? '/zh' : '/',
    enPath, zhPath,
    canonicalPath: IS_ZH ? zhPath : enPath,
    pageTitle, pageDesc,
    jsonLd: jsonLd || [],
  }, extra || {}));
}

function packagesPage(lang) {
  return (req, res) => {
    const c = loadContent();
    const p = (c.pages && c.pages.packages) || {};
    const IS_ZH = lang === 'zh';
    const enPath = '/buddhist-funeral-packages';
    const zhPath = '/zh/buddhist-funeral-packages';
    const title = IS_ZH ? (p.metaTitleZh || p.metaTitle) : p.metaTitle;
    const desc = IS_ZH ? (p.metaDescriptionZh || p.metaDescription) : p.metaDescription;
    const name = IS_ZH ? (p.h1Zh || p.h1) : p.h1;
    const jsonLd = [
      {
        '@context': 'https://schema.org', '@type': 'Service',
        serviceType: 'Buddhist funeral package', name: name, description: desc,
        provider: { '@type': 'FuneralHome', name: ((c.site.brandTop || '') + ' ' + (c.site.brandBottom || '')).trim(), telephone: c.site.hotlineTel, url: SITE_URL + '/' },
        areaServed: { '@type': 'Country', name: 'Singapore' },
        url: SITE_URL + (IS_ZH ? zhPath : enPath),
      },
      {
        '@context': 'https://schema.org', '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: IS_ZH ? '首页' : 'Home', item: SITE_URL + (IS_ZH ? '/zh' : '/') },
          { '@type': 'ListItem', position: 2, name: name, item: SITE_URL + (IS_ZH ? zhPath : enPath) },
        ],
      },
    ];
    renderContentPage(res, 'page-packages', lang, enPath, zhPath, title, desc, jsonLd, { p });
  };
}
app.get('/buddhist-funeral-packages', packagesPage('en'));
app.get('/zh/buddhist-funeral-packages', packagesPage('zh'));

// ---- Contact form submission -----------------------------------------------
app.post('/contact', async (req, res) => {
  const name = (req.body.name || '').trim();
  const phone = (req.body.phone || '').trim();
  const email = (req.body.email || '').trim();
  const message = (req.body.message || '').trim();
  const honeypot = (req.body.website || '').trim(); // bots fill hidden fields
  const base = req.body.lang === 'zh' ? '/zh' : '/'; // return to the same language page

  // Spam bot caught, or required fields missing — pretend success, do nothing harmful.
  if (honeypot) return res.redirect(base + '?sent=1#contact');
  if (!name || !message || (!phone && !email)) {
    return res.redirect(base + '?err=1#contact');
  }

  const entry = { name, phone, email, message, date: new Date().toISOString() };
  try {
    saveEnquiry(entry); // always keep a copy
  } catch (e) {
    console.error('Could not save enquiry:', e.message);
  }
  try {
    await emailEnquiry(entry);
  } catch (e) {
    console.error('Could not email enquiry (saved to data/enquiries.json):', e.message);
  }
  res.redirect(base + '?sent=1#contact');
});

// ---- Chatbot: grounded answers via local Ollama (streamed) -----------------
// Builds a compact knowledge base from the site content so the bot only answers
// from real information and defers anything uncertain to the 24-hour hotline.
function chatSystemPrompt(c, lang) {
  const s = c.site || {};
  const name = ((s.brandTop || '') + ' ' + (s.brandBottom || '')).trim() || 'Singapore Buddhist Funeral Services';
  const list = (arr, fn) => (Array.isArray(arr) ? arr.map(fn).join('\n') : '');
  const p = [];
  p.push(`You are a warm, compassionate virtual assistant for ${name}, a Buddhist funeral service in Singapore.`);
  p.push('Rules: Answer ONLY using the INFORMATION below. Do not invent prices, facts, dates or promises. If you are unsure, or the person asks for exact pricing/availability, or the matter is urgent, gently ask them to call the 24-hour hotline or WhatsApp. Be brief, kind and clear (2-4 sentences).');
  p.push(lang === 'zh' ? 'Always reply in Simplified Chinese (中文).' : 'Always reply in English.');
  p.push(`CONTACT — 24-hour hotline: ${s.hotline}; WhatsApp: ${s.whatsapp}; Email: ${s.email}.`);
  if (c.services && c.services.items) p.push('SERVICES:\n' + list(c.services.items, (i) => `- ${i.title}: ${i.text}`));
  if (c.packages && c.packages.items) p.push('PACKAGES:\n' + list(c.packages.items, (pk) => `- ${pk.name} (${pk.days}): ${(pk.features || []).join('; ')}`));
  if (c.rites && c.rites.items) p.push('BUDDHIST RITES:\n' + list(c.rites.items, (i) => `- ${i.title}: ${i.text}`));
  if (c.steps && c.steps.items) p.push('WHAT TO DO FIRST:\n' + list(c.steps.items, (i) => `- ${i.title}: ${i.text}`));
  if (c.etiquette && c.etiquette.items) p.push('WAKE ETIQUETTE:\n' + list(c.etiquette.items, (i) => `- ${i.title}: ${i.text}`));
  if (c.faq && c.faq.items) p.push('FAQ:\n' + list(c.faq.items, (i) => `Q: ${i.q}\nA: ${i.a}`));
  return p.join('\n\n');
}

// Simple in-memory per-IP rate limit (public, cost-free, but protects the box).
const chatHits = new Map();
function chatRateLimited(ip) {
  const now = Date.now();
  const arr = (chatHits.get(ip) || []).filter((t) => now - t < 5 * 60 * 1000);
  arr.push(now);
  chatHits.set(ip, arr);
  return arr.length > 25; // 25 messages / 5 min / IP
}

app.post('/api/chat', async (req, res) => {
  const c = loadContent();
  const lang = req.body && req.body.lang === 'zh' ? 'zh' : 'en';
  const fallback = lang === 'zh'
    ? `抱歉，目前无法回应。请拨打我们的24小时热线 ${c.site.hotline}。`
    : `Sorry, I can't respond right now. Please call our 24-hour hotline ${c.site.hotline}.`;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering so tokens stream

  const ip = req.ip || 'unknown'; // real client IP (trust proxy is set)
  const busyMsg = lang === 'zh' ? `信息太多了。请直接拨打 ${c.site.hotline}。` : `That's a lot of messages — please call us directly at ${c.site.hotline}.`;
  if (!CHAT_ENABLED) return res.end(fallback);
  if (chatRateLimited(ip)) return res.end(busyMsg);
  if (chatInFlight >= CHAT_MAX_CONCURRENT) {
    return res.end(lang === 'zh' ? `我们正在为其他访客服务，请稍后再试，或拨打 ${c.site.hotline}。` : `We're helping other visitors right now — please try again shortly, or call ${c.site.hotline}.`);
  }

  const userMsg = String((req.body && req.body.message) || '').slice(0, 1000).trim();
  if (!userMsg) return res.end('');
  const history = Array.isArray(req.body.history) ? req.body.history.slice(-6) : [];
  // Anthropic: system prompt is a top-level param; messages are user/assistant only.
  const systemPrompt = chatSystemPrompt(c, lang);
  const messages = [
    ...history.map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.content || '').slice(0, 2000) })),
    { role: 'user', content: userMsg },
  ];

  chatInFlight++;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    const r = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 400, temperature: 0.3, system: systemPrompt, stream: true, messages }),
      signal: ctrl.signal,
    });
    if (!r.ok || !r.body) throw new Error('anthropic http ' + r.status);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let wrote = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue; // SSE: only data lines carry deltas
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          if (j.type === 'content_block_delta' && j.delta && typeof j.delta.text === 'string') { res.write(j.delta.text); wrote = true; }
        } catch (e) { /* ignore partial line */ }
      }
    }
    clearTimeout(timer);
    if (!wrote) res.write(fallback);
    res.end();
  } catch (e) {
    console.error('chat error:', e.message);
    try { res.write(fallback); } catch (_) {}
    res.end();
  } finally {
    chatInFlight--;
  }
});

// ---- SEO: robots.txt & sitemap.xml -----------------------------------------
// Both domains serve the same app, so we build these from the request host
// (whitelisted to prevent Host-header spoofing) so each domain self-references.
const SITE_HOSTS = [
  'singaporebuddhistfuneral.com.sg',
  'singaporebuddhistfuneral.sg',
  'www.singaporebuddhistfuneral.com.sg',
  'www.singaporebuddhistfuneral.sg',
];
function siteOrigin(req) {
  let host = String(req.headers.host || '').toLowerCase();
  if (!SITE_HOSTS.includes(host)) host = 'singaporebuddhistfuneral.com.sg';
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  return proto + '://' + host;
}

app.get('/robots.txt', (req, res) => {
  const origin = siteOrigin(req);
  res.type('text/plain').send(
    'User-agent: *\n' +
    'Allow: /\n' +
    'Disallow: /admin\n' +
    '\n' +
    'Sitemap: ' + origin + '/sitemap.xml\n'
  );
});

app.get('/sitemap.xml', (req, res) => {
  const origin = siteOrigin(req);
  let lastmod;
  try {
    lastmod = fs.statSync(DATA_FILE).mtime.toISOString().slice(0, 10);
  } catch (e) {
    lastmod = new Date().toISOString().slice(0, 10);
  }
  // Each entry has an English and a Chinese URL; both get reciprocal hreflang alternates.
  const PAGES = [
    { en: '/', zh: '/zh', priority: '1.0' },
    { en: '/buddhist-funeral-packages', zh: '/zh/buddhist-funeral-packages', priority: '0.9' },
  ];
  function altLinks(pg) {
    return (
      '    <xhtml:link rel="alternate" hreflang="en" href="' + origin + pg.en + '"/>\n' +
      '    <xhtml:link rel="alternate" hreflang="zh-SG" href="' + origin + pg.zh + '"/>\n' +
      '    <xhtml:link rel="alternate" hreflang="x-default" href="' + origin + pg.en + '"/>\n'
    );
  }
  function urlEntry(loc, pg) {
    return (
      '  <url>\n' +
      '    <loc>' + origin + loc + '</loc>\n' +
      altLinks(pg) +
      '    <lastmod>' + lastmod + '</lastmod>\n' +
      '    <changefreq>weekly</changefreq>\n' +
      '    <priority>' + pg.priority + '</priority>\n' +
      '  </url>\n'
    );
  }
  let body = '';
  PAGES.forEach((pg) => { body += urlEntry(pg.en, pg) + urlEntry(pg.zh, pg); });
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' +
    body +
    '</urlset>\n';
  res.type('application/xml').send(xml);
});

// ============================================================================
// ADMIN
// ============================================================================
app.get('/admin/login', (req, res) => {
  if (req.session.loggedIn) return res.redirect('/admin');
  res.render('admin-login', { error: null });
});

app.post('/admin/login', sameOriginPost, (req, res) => {
  const ip = req.ip || 'unknown';
  if (loginLocked(ip)) {
    return res.status(429).render('admin-login', { error: 'Too many attempts. Please wait 15 minutes and try again.' });
  }
  const admin = findAdmin(req.body.username);
  if (admin && verifyPassword(req.body.password, admin.hash)) {
    clearLoginFails(ip);
    req.session.loggedIn = true;
    req.session.user = admin.username;
    return res.redirect('/admin');
  }
  noteLoginFail(ip);
  res.status(401).render('admin-login', { error: 'Incorrect username or password.' });
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

app.get('/admin', requireAuth, (req, res) => {
  res.render('admin', {
    c: loadContent(),
    saved: req.query.saved === '1',
    message: req.query.message || null,
    enquiryCount: loadEnquiries().length,
    admins: loadAdmins().map((a) => a.username),
    currentUser: req.session.user || '',
  });
});

// ---- Account & admin-user management ---------------------------------------
// Change the logged-in admin's own password.
app.post('/admin/account/password', requireAuth, sameOriginPost, (req, res) => {
  const admins = loadAdmins();
  const me = admins.find((a) => a.username === req.session.user);
  if (!me) return res.redirect('/admin/logout');
  const cur = String(req.body.current || '');
  const nw = String(req.body.password || '');
  const cf = String(req.body.confirm || '');
  if (!verifyPassword(cur, me.hash)) return res.redirect('/admin?message=' + encodeURIComponent('Current password is incorrect.') + '#account');
  if (nw.length < 8) return res.redirect('/admin?message=' + encodeURIComponent('New password must be at least 8 characters.') + '#account');
  if (nw !== cf) return res.redirect('/admin?message=' + encodeURIComponent('New passwords do not match.') + '#account');
  me.hash = hashPassword(nw);
  saveAdmins(admins);
  res.redirect('/admin?saved=1#account');
});

// Create a new admin user.
app.post('/admin/admins', requireAuth, sameOriginPost, (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) return res.redirect('/admin?message=' + encodeURIComponent('Username must be 3-32 characters (letters, numbers, . _ -).') + '#account');
  if (password.length < 8) return res.redirect('/admin?message=' + encodeURIComponent('Password must be at least 8 characters.') + '#account');
  const admins = loadAdmins();
  if (admins.some((a) => a.username.toLowerCase() === username.toLowerCase())) return res.redirect('/admin?message=' + encodeURIComponent('That username already exists.') + '#account');
  admins.push({ username, hash: hashPassword(password) });
  saveAdmins(admins);
  res.redirect('/admin?saved=1#account');
});

// Delete an admin user (cannot delete yourself or the last remaining admin).
app.post('/admin/admins/delete', requireAuth, sameOriginPost, (req, res) => {
  const username = String(req.body.username || '');
  if (username === req.session.user) return res.redirect('/admin?message=' + encodeURIComponent('You cannot delete your own account.') + '#account');
  let admins = loadAdmins();
  if (admins.length <= 1) return res.redirect('/admin?message=' + encodeURIComponent('Cannot delete the last admin.') + '#account');
  admins = admins.filter((a) => a.username !== username);
  saveAdmins(admins);
  res.redirect('/admin?saved=1#account');
});

// ---- View enquiries received through the contact form ----------------------
app.get('/admin/enquiries', requireAuth, (req, res) => {
  res.render('admin-enquiries', {
    enquiries: loadEnquiries(),
    mailEnabled: MAIL_ENABLED,
    contactTo: CONTACT_TO,
  });
});

// ---- Save all text content -------------------------------------------------
// The admin form posts nested fields (e.g. hero[title], steps[items][0][title]),
// which express's extended urlencoded parser turns into a nested object.
// We merge it over the existing content so image paths etc. are preserved.
app.post('/admin/save', requireAuth, sameOriginPost, (req, res) => {
  const current = loadContent();
  const incoming = req.body;

  // Merge each top-level section.
  current.site = { ...current.site, ...incoming.site };
  current.hero = { ...current.hero, ...incoming.hero, backgroundImage: current.hero.backgroundImage };
  current.strip = { ...current.strip, ...incoming.strip };
  current.contact = { ...current.contact, ...incoming.contact };

  // Sections with a list of items: keep headings + replace item text fields,
  // preserving any non-text data (like gallery image paths) by index.
  mergeSection(current.steps, incoming.steps);
  mergeSection(current.services, incoming.services);
  mergeSection(current.rites, incoming.rites);
  mergeSection(current.faq, incoming.faq);
  mergeGallery(current.gallery, incoming.gallery);
  mergePackages(current.packages, incoming.packages);

  saveContent(current);
  res.redirect('/admin?saved=1');
});

function mergeSection(target, incoming) {
  if (!incoming) return;
  ['eyebrow', 'title', 'titleEm', 'lead'].forEach((k) => {
    if (incoming[k] !== undefined) target[k] = incoming[k];
  });
  if (incoming.items) {
    Object.keys(incoming.items).forEach((i) => {
      const idx = Number(i);
      if (target.items[idx]) Object.assign(target.items[idx], incoming.items[i]);
    });
  }
}

function mergeGallery(target, incoming) {
  if (!incoming) return;
  ['eyebrow', 'title', 'titleEm', 'lead'].forEach((k) => {
    if (incoming[k] !== undefined) target[k] = incoming[k];
  });
  if (incoming.items) {
    Object.keys(incoming.items).forEach((i) => {
      const idx = Number(i);
      // Only the caption is editable here; the image path is managed by uploads.
      if (target.items[idx] && incoming.items[i].caption !== undefined) {
        target.items[idx].caption = incoming.items[i].caption;
      }
    });
  }
}

function mergePackages(target, incoming) {
  if (!incoming) return;
  ['eyebrow', 'title', 'titleEm', 'lead'].forEach((k) => {
    if (incoming[k] !== undefined) target[k] = incoming[k];
  });
  if (incoming.items) {
    Object.keys(incoming.items).forEach((i) => {
      const idx = Number(i);
      const pkg = target.items[idx];
      const inc = incoming.items[i];
      if (!pkg) return;
      if (inc.name !== undefined) pkg.name = inc.name;
      if (inc.days !== undefined) pkg.days = inc.days;
      if (inc.tag !== undefined) pkg.tag = inc.tag;
      pkg.featured = inc.featured === 'on' || inc.featured === 'true' || inc.featured === true;
      if (inc.features) {
        // features posted as one textarea, one line per feature.
        pkg.features = String(inc.features)
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
      }
    });
  }
}

// ---- Hero background image -------------------------------------------------
app.post('/admin/hero-image', requireAuth, sameOriginPost, upload.single('image'), (req, res) => {
  const content = loadContent();
  if (req.file) {
    deleteUpload(content.hero.backgroundImage);
    content.hero.backgroundImage = '/uploads/' + req.file.filename;
    saveContent(content);
  }
  res.redirect('/admin?saved=1#hero');
});

app.post('/admin/hero-image/remove', requireAuth, sameOriginPost, (req, res) => {
  const content = loadContent();
  deleteUpload(content.hero.backgroundImage);
  content.hero.backgroundImage = '';
  saveContent(content);
  res.redirect('/admin?saved=1#hero');
});

// ---- Header logo -----------------------------------------------------------
app.post('/admin/logo', requireAuth, sameOriginPost, upload.single('image'), (req, res) => {
  const content = loadContent();
  if (req.file) {
    deleteUpload(content.site.logo);
    content.site.logo = '/uploads/' + req.file.filename;
    saveContent(content);
  }
  res.redirect('/admin?saved=1#sec-logo');
});

app.post('/admin/logo/remove', requireAuth, sameOriginPost, (req, res) => {
  const content = loadContent();
  deleteUpload(content.site.logo);
  content.site.logo = '';
  saveContent(content);
  res.redirect('/admin?saved=1#sec-logo');
});

// ---- Favicon ---------------------------------------------------------------
app.post('/admin/favicon', requireAuth, sameOriginPost, upload.single('image'), (req, res) => {
  const content = loadContent();
  if (req.file) {
    deleteUpload(content.site.favicon);
    content.site.favicon = '/uploads/' + req.file.filename;
    saveContent(content);
  }
  res.redirect('/admin?saved=1#sec-logo');
});

app.post('/admin/favicon/remove', requireAuth, sameOriginPost, (req, res) => {
  const content = loadContent();
  deleteUpload(content.site.favicon);
  content.site.favicon = '';
  saveContent(content);
  res.redirect('/admin?saved=1#sec-logo');
});

// ---- Gallery images --------------------------------------------------------
app.post('/admin/gallery/add', requireAuth, sameOriginPost, upload.single('image'), (req, res) => {
  const content = loadContent();
  if (req.file) {
    content.gallery.items.push({
      image: '/uploads/' + req.file.filename,
      caption: (req.body.caption || '').trim(),
    });
    saveContent(content);
  }
  res.redirect('/admin?saved=1#gallery');
});

app.post('/admin/gallery/delete', requireAuth, sameOriginPost, (req, res) => {
  const content = loadContent();
  const idx = Number(req.body.index);
  if (content.gallery.items[idx]) {
    deleteUpload(content.gallery.items[idx].image);
    content.gallery.items.splice(idx, 1);
    saveContent(content);
  }
  res.redirect('/admin?saved=1#gallery');
});

function deleteUpload(webPath) {
  if (!webPath || !webPath.startsWith('/uploads/')) return;
  const file = path.join(__dirname, 'public', webPath);
  fs.unlink(file, () => {}); // best effort
}

// ---- Error handler (e.g. upload too large / wrong type) --------------------
app.use((err, req, res, next) => {
  console.error(err.message);
  res.redirect('/admin?message=' + encodeURIComponent('Upload failed: ' + err.message));
});

app.listen(PORT, () => {
  console.log(`\n  Singapore Buddhist Funeral Services`);
  console.log(`  ──────────────────────────────────────`);
  console.log(`  Public site:  http://localhost:${PORT}`);
  console.log(`  Admin panel:  http://localhost:${PORT}/admin`);
  console.log(`  Admin password: ${ADMIN_PASSWORD === 'admin123' ? 'admin123  (CHANGE THIS! see README)' : '(set via ADMIN_PASSWORD)'}`);
  console.log(
    `  Contact email:  ${
      MAIL_ENABLED
        ? `enabled — enquiries go to ${CONTACT_TO}`
        : `NOT sending yet — set SMTP_USER/SMTP_PASS (see README). Enquiries still saved to data/enquiries.json`
    }\n`
  );
});
