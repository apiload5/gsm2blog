// app.js
import 'dotenv/config';
import Parser from 'rss-parser';
import axios from 'axios';
import Database from 'better-sqlite3';
import { google } from 'googleapis';
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
const POST_INTERVAL_CRON = process.env.POST_INTERVAL_CRON || '0 * * * *';
const MAX_ITEMS_PER_RUN = parseInt(process.env.MAX_ITEMS_PER_RUN || '3', 10);
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const DB_PATH = process.env.DB_PATH || './data/posts.db';
const MODE = (process.env.MODE || 'once').toLowerCase();
const USER_AGENT = process.env.USER_AGENT || 'GSM2Blogger/1.0';

function fatal(msg) {
  console.error(new Date().toISOString(), 'FATAL:', msg);
  process.exit(1);
}

if (!OPENAI_API_KEY) fatal('OPENAI_API_KEY not set');
if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN || !BLOG_ID) fatal('Blogger OAuth config missing (CLIENT_ID/CLIENT_SECRET/REFRESH_TOKEN/BLOG_ID)');

/* -------------------------
   Init libs
   ------------------------- */
const parser = new Parser();
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
const blogger = google.blogger({ version: 'v3', auth: oauth2Client });

/* -------------------------
   Ensure data folder + DB
   ------------------------- */
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

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
  // Also update posted.json for easy commit diff
  try {
    const pjsonPath = path.join(dbDir, 'posted.json');
    let arr = [];
    if (fs.existsSync(pjsonPath)) {
      arr = JSON.parse(fs.readFileSync(pjsonPath, 'utf8') || '[]');
      if (!Array.isArray(arr)) arr = [];
    }
    arr.push({ guid: guid || link, title, link, published_at });
    fs.writeFileSync(pjsonPath, JSON.stringify(arr, null, 2));
  } catch (e) {
    // non-fatal
    console.error('Failed to update posted.json:', e?.message || e);
  }
}

/* -------------------------
   Helpers
   ------------------------- */
function log(...args) { console.log(new Date().toISOString(), ...args); }

async function fetchPage(url) {
  try {
    const res = await axios.get(url, { headers: { 'User-Agent': USER_AGENT }, timeout: 12000 });
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
  const languageNote = lang === 'ur' ? 'Urdu (in Urdu script)' : (lang === 'hi' ? 'Hindi (Devanagari)' : 'English');
  const prompt = `You are a professional news editor. Rewrite the following item into a short blog post suitable for publishing.
- Keep original title as reference.
- Produce a 1-line hook, then 3-6 sentences summary in ${languageNote}.
- Make it unique, SEO-friendly, avoid copying verbatim.
- Add a short concluding sentence with a call to action "Read original source" and include the source link anchor.
Return HTML-ready content only (use <p>, <strong>, <ul>, <li>).
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
    log('OpenAI error:', err?.response?.data || err?.message || err);
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
      requestBody: { title, content: htmlContent, labels: labels.length ? labels : undefined }
    });
    return res.data;
  } catch (err) {
    log('Blogger API error:', err?.response?.data || err?.message || err?.toString());
    throw err;
  }
}

/* -------------------------
   Main process
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

      let imageUrl = null;
      const contentCandidates = item['content:encoded'] || item.content || item.contentSnippet || '';
      imageUrl = extractFirstImageFromHtml(contentCandidates);
      if (!imageUrl && link) {
        const pageHtml = await fetchPage(link);
        if (pageHtml) imageUrl = extractOgImage(pageHtml) || extractFirstImageFromHtml(pageHtml);
      }

      let rewrittenHtml = '';
      try {
        rewrittenHtml = await rewriteWithOpenAI({ title, snippet: item.contentSnippet, content: contentCandidates, lang: 'ur' });
      } catch (e) {
        log('OpenAI failed for item, using raw snippet as fallback:', title);
        rewrittenHtml = `<p>${escapeHtml(item.contentSnippet || item.content || '').slice(0, 2000)}</p>`;
      }

      let finalHtml = '';
      if (imageUrl) finalHtml += `<p><img src="${imageUrl}" alt="${escapeHtml(title)}" style="max-width:100%;height:auto" /></p>\n`;
      finalHtml += rewrittenHtml;
      finalHtml += `\n<p><em>Source:</em> <a href="${link}" target="_blank" rel="noopener">Original — Read</a></p>`;

      let posted;
      try {
        posted = await createBloggerPost({ title, htmlContent: finalHtml });
      } catch (e) {
        log('Failed to post to Blogger for:', title);
        continue;
      }

      log('✅ Posted to Blogger:', posted?.url || posted?.id || '(no url returned)');
      markPosted({ guid, link, title, published_at: item.pubDate || item.isoDate || null });
      await sleep(1500);

      // If you want only one post per run, uncomment following:
      // if (MODE === 'once') { log('MODE=once: exiting after one post'); return; }
    }
  } catch (err) {
    log('processOnce error:', err?.response?.data || err?.message || err);
  }
}

/* -------------------------
   Utility
   ------------------------- */
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/[&<>"']/g, (m) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;' }[m]));
}

/* -------------------------
   Start
   ------------------------- */
async function start() {
  log('Starting GSM2Blogger', { MODE, OPENAI_MODEL, GSMARENA_RSS, DB_PATH });
  if (MODE === 'once') {
    await processOnce();
    log('Finished single run (MODE=once). Exiting.');
    process.exit(0);
  } else {
    log('Scheduling cron:', POST_INTERVAL_CRON);
    await processOnce();
    cron.schedule(POST_INTERVAL_CRON, async () => { log('Cron tick'); await processOnce(); });
    process.stdin.resume();
  }
}

start().catch((e) => { log('Fatal start error:', e?.message || e); process.exit(1); });

                             
