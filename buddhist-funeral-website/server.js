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

const app = express();

// ---- Config ----------------------------------------------------------------
// App runs on a port in the 20201–20300 range. Override with the PORT env var (any value in that range).
const PORT = process.env.PORT || 20201;
// Change the admin password here or via the ADMIN_PASSWORD environment variable.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-secret-in-production';

const DATA_FILE = path.join(__dirname, 'data', 'content.json');
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---- Content store ---------------------------------------------------------
function loadContent() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}
function saveContent(content) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(content, null, 2));
}

// ---- App setup -------------------------------------------------------------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true, limit: '2mb' })); // extended -> nested form fields
app.use(express.static(path.join(__dirname, 'public')));
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 8 }, // 8 hours
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
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files are allowed.'));
  },
});

// ---- Auth ------------------------------------------------------------------
function requireAuth(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  return res.redirect('/admin/login');
}

// ============================================================================
// PUBLIC SITE
// ============================================================================
app.get('/', (req, res) => {
  res.render('index', { c: loadContent() });
});

// ============================================================================
// ADMIN
// ============================================================================
app.get('/admin/login', (req, res) => {
  if (req.session.loggedIn) return res.redirect('/admin');
  res.render('admin-login', { error: null });
});

app.post('/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    req.session.loggedIn = true;
    return res.redirect('/admin');
  }
  res.render('admin-login', { error: 'Incorrect password. Please try again.' });
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

app.get('/admin', requireAuth, (req, res) => {
  res.render('admin', {
    c: loadContent(),
    saved: req.query.saved === '1',
    message: req.query.message || null,
  });
});

// ---- Save all text content -------------------------------------------------
// The admin form posts nested fields (e.g. hero[title], steps[items][0][title]),
// which express's extended urlencoded parser turns into a nested object.
// We merge it over the existing content so image paths etc. are preserved.
app.post('/admin/save', requireAuth, (req, res) => {
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
app.post('/admin/hero-image', requireAuth, upload.single('image'), (req, res) => {
  const content = loadContent();
  if (req.file) {
    deleteUpload(content.hero.backgroundImage);
    content.hero.backgroundImage = '/uploads/' + req.file.filename;
    saveContent(content);
  }
  res.redirect('/admin?saved=1#hero');
});

app.post('/admin/hero-image/remove', requireAuth, (req, res) => {
  const content = loadContent();
  deleteUpload(content.hero.backgroundImage);
  content.hero.backgroundImage = '';
  saveContent(content);
  res.redirect('/admin?saved=1#hero');
});

// ---- Gallery images --------------------------------------------------------
app.post('/admin/gallery/add', requireAuth, upload.single('image'), (req, res) => {
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

app.post('/admin/gallery/delete', requireAuth, (req, res) => {
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
  console.log(`  Admin password: ${ADMIN_PASSWORD === 'admin123' ? 'admin123  (CHANGE THIS! see README)' : '(set via ADMIN_PASSWORD)'}\n`);
});
