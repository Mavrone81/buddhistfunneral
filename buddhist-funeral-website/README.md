# Singapore Buddhist Funeral Services — Website + Admin

A complete website with a simple admin panel where you can **edit all the wording** and **upload photos** yourself — no coding needed.

## What you can do in the admin panel

- Change every piece of text on the site (headings, paragraphs, services, packages, FAQ, contact details).
- Upload a **hero background image** for the top banner.
- Upload, caption and delete **gallery photos** (the gallery section appears automatically once you add a photo).
- All changes go live instantly.

---

## Running it on your computer

You need [Node.js](https://nodejs.org) installed (version 18 or newer).

1. Open a terminal in this folder.
2. Install once:
   ```
   npm install
   ```
3. Start the website:
   ```
   npm start
   ```
4. Open your browser:
   - **Website:** http://localhost:20201
   - **Admin panel:** http://localhost:20201/admin

   The app runs on port **20201** by default (within the 20201–20300 range). To use a different port in that range, start with `PORT=20250 npm start`.

### Logging into the admin

- Default password: **`admin123`**
- **Please change it** (see below) before putting the site online.

---

## Changing the admin password

Set an environment variable when starting:

```
ADMIN_PASSWORD="your-strong-password" npm start
```

(On Windows PowerShell: `$env:ADMIN_PASSWORD="your-strong-password"; npm start`)

You can also set `PORT` and `SESSION_SECRET` the same way. For a real deployment, always set a long random `SESSION_SECRET`.

---

## Contact form (emailing you)

The website has a **contact form** in the Contact section. Every submission is:

1. Saved to `data/enquiries.json` and viewable in the admin under **Enquiries** (top-right button).
2. Emailed to you — **once you set up email** (see below).

Enquiries are recorded even before email is set up, so nothing is ever lost.

### Enable email with Gmail (recommended)

Gmail needs an **App Password** (not your normal password):

1. Turn on 2-Step Verification at https://myaccount.google.com/security
2. Create an App Password at https://myaccount.google.com/apppasswords (choose “Mail”). You’ll get a 16-character code.
3. Start the site with these environment variables:

   ```
   CONTACT_TO="fudunchuan.rsn@gmail.com" \
   SMTP_USER="your-gmail@gmail.com" \
   SMTP_PASS="the-16-char-app-password" \
   npm start
   ```

That’s it — enquiries will arrive in your inbox (with the sender’s email as reply-to). The startup message confirms whether email is active.

| Variable | Meaning | Default |
|---|---|---|
| `CONTACT_TO` | Inbox that receives enquiries | `fudunchuan.rsn@gmail.com` |
| `SMTP_USER` | Email account used to send | _(none — email off until set)_ |
| `SMTP_PASS` | App password for that account | _(none)_ |
| `SMTP_HOST` | Mail server | `smtp.gmail.com` |
| `SMTP_PORT` | Mail port | `465` |
| `SMTP_FROM` | “From” address | same as `SMTP_USER` |

You can use any provider (Outlook, your web host’s SMTP, SendGrid, etc.) by setting `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS` accordingly.

---

## Where your content lives

- **Text:** `data/content.json` — automatically updated when you save in the admin.
- **Images:** `public/uploads/` — your uploaded photos.

To back up your site’s content, just keep a copy of these two locations.

---

## Putting it online (hosting)

This is a standard Node.js app. It runs on any host that supports Node — e.g. Render, Railway, Fly.io, a DigitalOcean droplet, or any VPS. Set the `ADMIN_PASSWORD` and `SESSION_SECRET` environment variables there, and run `npm start`.

> Note: uploaded images are stored on disk. On hosts with a temporary filesystem (some free tiers), attach a persistent disk/volume to the `public/uploads` folder so photos survive restarts.

---

## CI/CD — auto-deploy to DigitalOcean

Pushing to `main` on GitHub automatically redeploys the live droplet via
GitHub Actions (`.github/workflows/deploy.yml`).

**Flow:** push to `main` → GitHub Action SSHes into the droplet → `git reset --hard origin/main`
→ `npm ci` → `pm2 reload`.

### Content vs code (important)
- **Code** is managed in git and deploys automatically.
- **Live content** (`data/content.json`) and **uploaded photos** (`public/uploads/`)
  are **git-ignored** and live only on the server, so deploys never overwrite what the
  client edits in the admin panel. The repo ships `data/content.default.json` as the
  seed used only on a fresh install (when `content.json` doesn't yet exist).
- To change site copy in production, use the **admin panel** — not git.

### Required GitHub repo secrets
Settings → Secrets and variables → Actions:

| Secret | Value |
|---|---|
| `DO_HOST` | droplet IP (e.g. `157.230.240.163`) |
| `DO_USER` | SSH user (e.g. `root`) |
| `DO_SSH_KEY` | private deploy key (generated on the server) |

The droplet must have the repo at `/root/buddhistfunneral`, PM2 running the app from
`ecosystem.config.js`, and the deploy key's public half in `~/.ssh/authorized_keys`.
