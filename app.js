/**
 * app.js
 *
 * Hybrid GSMArena -> OpenAI -> Blogger autoposter (single-file advanced app)
 *
 * Usage:
 *  - Create a .env file (example below)
 *  - npm install rss-parser openai googleapis better-sqlite3 axios node-cron dotenv
 *  - MODE=cron node app.js      # run as long-lived service (cron schedule)
 *  - MODE=once node app.js      # run once and exit (GitHub Actions / Colab)
 *
 * .env example:
 *
 * OPENAI_API_KEY=sk-...
 *
 * # Blogger OAuth2 (one-time get REFRESH_TOKEN via OAuth flow)
 * CLIENT_ID=xxxxx.apps.googleusercontent.com
 * CLIENT_SECRET=xxxx
 * REFRESH_TOKEN=yyyy
 * BLOG_ID=1234567890123456789
 *
 * # App settings
 * GSMARENA_RSS=https://www.gsmarena.com/rss-news-reviews.php
 * POST_INTERVAL_CRON=0 * * * *        # cron schedule (when MODE=cron)
 * MAX_ITEMS_PER_RUN=3
 * OPENAI_MODEL=gpt-4o-mini
 * DB_PATH=./data/posts.db
 * USER_AGENT=GSM2Blogger/1.0
 *
 * NOTES:
 *  - For GitHub Actions: run with MODE=once; to persist DB between runs use artifacts or an external store.
 *  - For Colab: mount Drive and set DB_PATH to a Drive path so DB persists.
 */

import 'dotenv/config';
import Parser from 'rss-parser';
import axios from 'axios';
import Database from 'better-sqlite3';
import { GoogleApis } from 'googleapis';
import OpenAI from 'openai';
import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* -------------------------
   Load config from env
   ------------------------- */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const BLOG_ID = process.env.BLOG_ID;

const GSMARENA_RSS = process.env.GSMARENA_RSS || 'https://www.gsmarena.com/rss-news-reviews.php';
const POST_INTERVAL_CRON = process.env.POST_INTERVAL_CRON || '0 * * * *'; // default: hourly
const MAX_ITEMS_PER_RUN = parseInt(process.env.MAX_ITEMS_PER_RUN || '3', 10);
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const DB_PATH = process.env.DB_PATH || './data/posts.db';
const MODE = (process.env.MODE || 'once').toLowerCase(); // 'once' or 'cron'
const USER_AGENT = process.env.USER_AGENT || 'GSM2Blogger/1.0';

// basic validation
if (!OPENAI_API_KEY) {
  console.error('ERROR: OPENAI_API_KEY not set in .env');
  process.exit(1);
}
if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN || !BLOG_ID) {
  console.error('ERROR: Blogger OAuth config missing (CLIENT_ID/CLIENT_SECRET/REFRESH_TOKEN/BLOG_ID)');
  process.exit(1);
}

/* -------------------------
   Initialize libs
   ------------------------- */
const parser = new Parser();
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const google = new GoogleApis();
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
const blogger = google.blogger({ version: 'v3', auth: oauth2Client });

/* -------------------------
   Initialize SQLite DB
   ------------------------- */
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL'); // safer writes

db.prepare(`
  CREATE TABLE IF NOT EXISTS posted (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guid TEXT UNIQUE,
    link TEXT UNIQUE,
    title TEXT,
    published_at TEXT,
    posted_at TEXT DEFAULT (datetime('now'))
  )
`).run();

function hasBeenPosted(guidOrLink) {
  const row = db.prepare('SELECT 1 FROM posted WHERE guid = ? OR link = ?').get(guidOrLink, guidOrLink);
  return !!row;
}
function markPosted({ guid, link, title, published_at }) {
  const stmt = db.prepare('INSERT OR IGNORE INTO posted (guid, link, title, published_at) VALUES (?, ?, ?, ?)');
  stmt.run(guid, link, title, published_at || null);
}

/* -------------------------
   Helpers
   ------------------------- */
function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function fetchPage(url) {
  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 12000
    });
    return res.data;
  } catch (e) {
    return null;
  }
}

function extractFirstImageFromHtml(html) {
  if (!html) return null;
  const imgMatch = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (imgMatch) return imgMatch[1];
  return null;
}

function extractOgImage(html) {
  if (!html) return null;
  const m = html.match(/property=["']og:image["']\s*content=["']([^"']+)["']/i) || html.match(/<meta[^>]*name=["']og:image["'][^>]*content=["']([^"']+)["']/i);
  if (m) return m[1];
  return null;
}

/* -------------------------
   OpenAI rewriter
   ------------------------- */
async function rewriteWithOpenAI({ title, snippet, content, lang = 'ur' }) {
  // Build instruction: you can change to 'en' or other
  const languageNote = lang === 'ur' ? 'Urdu (in Urdu/Urdu script)' : (lang === 'hi' ? 'Hindi (Devanagari)' : 'English');
  const prompt = `You are a professional news editor. Rewrite the following GSMArena item into a short blog post suitable for publishing.
- Keep the original title as reference.
- Produce a 1-line hook (headline), then 3-6 sentences summary in ${languageNote}.
- Make it unique, SEO-friendly, and avoid copying verbatim.
- Add a short concluding sentence with a call to action like "Read original source" and include source link anchor.
- Return HTML-ready content only (you may use <p>, <strong>, <ul>, <li>, and keep it concise).
  
Title: ${title}

Snippet: ${snippet || ''}

Full content:
${content || ''}

Output only the HTML body.`;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 900
    });
    const text = completion.choices?.[0]?.message?.content;
    return text || '';
  } catch (err) {
    log('OpenAI error:', err?.message || err);
    throw err;
  }
}

/* -------------------------
   Create Blogger post
   ------------------------- */
async function createBloggerPost({ title, htmlContent, labels = [] }) {
  try {
    const res = await blogger.posts.insert({
      blogId: BLOG_ID,
      requestBody: {
        title,
        content: htmlContent,
        labels: labels.length ? labels : undefined
      }
    });
    return res.data;
  } catch (err) {
    // googleapis errors often have response.data
    log('Blogger API error:', err?.message || err?.toString());
    throw err;
  }
}

/* -------------------------
   Main process: fetch RSS -> transform -> post
   ------------------------- */
async function processOnce() {
  try {
    log('Fetching RSS:', GSMARENA_RSS);
    const feed = await parser.parseURL(GSMARENA_RSS);
    if (!feed?.items?.length) {
      log('No items in feed.');
      return;
    }

    const items = feed.items.slice(0, MAX_ITEMS_PER_RUN);
    for (const item of items) {
      const guid = item.guid || item.link || item.id || item.title;
      const link = item.link;
      const title = item.title || 'Untitled';

      if (hasBeenPosted(guid) || hasBeenPosted(link)) {
        log('Already posted:', title);
        continue;
      }

      log('Processing new item:', title);

      // Try to get an image (from RSS content, content:encoded, or OG)
      let imageUrl = null;
      const contentCandidates = item['content:encoded'] || item.content || item.contentSnippet || '';
      imageUrl = extractFirstImageFromHtml(contentCandidates);

      if (!imageUrl && link) {
        const pageHtml = await fetchPage(link);
        if (pageHtml) {
          imageUrl = extractOgImage(pageHtml) || extractFirstImageFromHtml(pageHtml);
        }
      }

      // Call OpenAI to rewrite. You can change language param if you want multiple languages.
      let rewrittenHtml = '';
      try {
        rewrittenHtml = await rewriteWithOpenAI({ title, snippet: item.contentSnippet, content: contentCandidates, lang: 'ur' });
      } catch (e) {
        log('OpenAI failed for item, skipping:', title);
        continue;
      }

      // Build final post HTML
      let finalHtml = '';
      if (imageUrl) {
        finalHtml += `<p><img src="${imageUrl}" alt="${escapeHtml(title)}" style="max-width:100%;height:auto" /></p>\n`;
      }
      finalHtml += rewrittenHtml;
      finalHtml += `\n<p><em>Source:</em> <a href="${link}" target="_blank" rel="noopener">GSMArena — Read original</a></p>`;

      // Post to Blogger
      let posted;
      try {
        posted = await createBloggerPost({ title, htmlContent: finalHtml });
      } catch (e) {
        log('Failed to post to Blogger for:', title);
        continue;
      }

      log('Posted to Blogger:', posted.url || posted.id || '(no url returned)');

      // Mark in DB
      markPosted({ guid, link, title, published_at: item.pubDate || item.isoDate || null });

      // Rate-limit friendly sleep (small)
      await sleep(1500);
      // Break after posting one item per run if running in 'once' mode (helps avoid many posts by accident).
      if (MODE === 'once') {
        log('MODE=once: exiting after one post to avoid mass-posting. Set MODE=cron to run continuously.');
        return;
      }
    }
  } catch (err) {
    log('processOnce error:', err?.message || err);
  }
}

/* -------------------------
   Utility sleep and escape
   ------------------------- */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/[&<>"']/g, (m) => {
    switch (m) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#039;';
      default: return m;
    }
  });
}

/* -------------------------
   Startup: MODE handling
   ------------------------- */
async function start() {
  log('Starting GSM2Blogger', { MODE, OPENAI_MODEL, GSMARENA_RSS, DB_PATH });

  if (MODE === 'once') {
    await processOnce();
    log('Finished single run (MODE=once). Exiting.');
    process.exit(0);
  } else {
    // MODE cron (long lived)
    log('Scheduling cron:', POST_INTERVAL_CRON);
    // Run once immediately
    await processOnce();
    // schedule subsequent runs
    cron.schedule(POST_INTERVAL_CRON, async () => {
      log('Cron tick - running processOnce');
      await processOnce();
    });
    // keep process alive
    process.stdin.resume();
  }
}

/* -------------------------
   Helpful note for GitHub Actions persistence
   ------------------------- */
/**
 * NOTE for GitHub Actions:
 *  - GitHub runners are ephemeral. To persist DB between runs you have options:
 *    1) Upload ./data/posts.db as an artifact at the end of the workflow and download at start.
 *    2) Use a remote DB or object storage (S3/GCS) and load/save DB file each run.
 *    3) Use actions/cache (not ideal for frequent-changing binary DB).
 *
 * If you want, you can implement simple S3 upload/download steps in your workflow and
 * set DB_PATH to a temporary file (./data/posts.db) and copy to/from S3 on start/end.
 */

/* -------------------------
   Run
   ------------------------- */
start().catch((e) => {
  log('Fatal error in start():', e?.message || e);
  process.exit(1);
});

                             
