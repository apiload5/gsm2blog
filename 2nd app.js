/**
 * app.js
 *
 * Hybrid GSMArena -> OpenAI -> Blogger autoposter (single-file advanced app)
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

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const BLOG_ID = process.env.BLOG_ID;

const GSMARENA_RSS = process.env.GSMARENA_RSS; 
const POST_INTERVAL_CRON = process.env.POST_INTERVAL_CRON || '0 * * * *';
const MAX_ITEMS_PER_RUN = parseInt(process.env.MAX_ITEMS_PER_RUN || '3', 10);
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const DB_PATH = process.env.DB_PATH || './data/posts.db';
const MODE = (process.env.MODE || 'once').toLowerCase();
const USER_AGENT = process.env.USER_AGENT || 'GSM2Blogger/1.0';

if (!OPENAI_API_KEY) {
  console.error('ERROR: OPENAI_API_KEY not set in .env');
  process.exit(1);
}
if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN || !BLOG_ID) {
  console.error('ERROR: Blogger OAuth config missing');
  process.exit(1);
}

const parser = new Parser();
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const google = new GoogleApis();
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
const blogger = google.blogger({ version: 'v3', auth: oauth2Client });

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
}

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

function extractMainArticle(html) {
  if (!html) return null;

  // Try GSMArena style
  let match = html.match(/<div class=\"article-body\">([\s\S]*?)<\/div>/i);
  if (match) return match[1];

  // Try Engadget style
  match = html.match(/<div[^>]*class=[\"']o-article-blocks[\"'][^>]*>([\s\S]*?)<\/div>/i);
  if (match) return match[1];

  // Fallback: return null
  return null;
}

async function rewriteWithOpenAI({ title, snippet, content, lang = 'ur' }) {
  const languageNote = lang === 'ur' ? 'Urdu (in Urdu/Urdu script)' : (lang === 'hi' ? 'Hindi (Devanagari)' : 'English');
  const prompt = `You are a professional news editor. Rewrite the following GSMArena item into a detailed blog post suitable for publishing.\n- Keep the original title as reference.\n- Produce a 1-line hook (headline), then 3-8 sentences summary in ${languageNote}.\n- Make it unique, SEO-friendly, and avoid copying verbatim.\n- Expand into full article if input seems short.\n- Return HTML-ready content only.`;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: `${prompt}\n\nTitle: ${title}\n\nSnippet: ${snippet || ''}\n\nFull content:\n${content || ''}` }],
      max_tokens: 1200
    });
    const text = completion.choices?.[0]?.message?.content;
    return text || '';
  } catch (err) {
    log('OpenAI error:', err?.message || err);
    throw err;
  }
}

async function generateImageAltText(title, snippet, content) {
  const prompt = `Generate a short SEO-friendly image alt text (2-6 words) for the following article.\nTitle: ${title}\nSnippet: ${snippet || ''}\nContent: ${content || ''}\n\nOnly return the alt text, no explanations.`;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 30
    });
    const text = completion.choices?.[0]?.message?.content;
    return (text || title).trim();
  } catch (err) {
    log('OpenAI alt-text error:', err?.message || err);
    return title; // fallback to title
  }
}

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
    log('Blogger API error:', err?.message || err?.toString());
    throw err;
  }
}

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
      const snippet = item.contentSnippet || '';
      let fullContent = item['content:encoded'] || item.content || snippet;

      // Try to fetch full article HTML
      if (link) {
        const pageHtml = await fetchPage(link);
        if (pageHtml) {
          const extracted = extractMainArticle(pageHtml);
          if (extracted) {
            fullContent = extracted;
          }
          if (!imageUrl) {
            imageUrl = extractOgImage(pageHtml) || extractFirstImageFromHtml(pageHtml);
          }
        }
      }
      if (!imageUrl) {
        imageUrl = extractFirstImageFromHtml(fullContent);
      }

      let rewrittenHtml = '';
      try {
        rewrittenHtml = await rewriteWithOpenAI({ title, snippet, content: fullContent, lang: 'ur' });
        // Clean unwanted trailing '... html'
        rewrittenHtml = rewrittenHtml.replace(/\.\.\.\s*html/gi, '');
      } catch (e) {
        log('OpenAI failed for item, skipping:', title);
        continue;
      }

      let finalHtml = '';
      if (imageUrl) {
        const altText = await generateImageAltText(title, snippet, fullContent);
        finalHtml += `<p><img src="${imageUrl}" alt="${escapeHtml(altText)}" title="${escapeHtml(altText)}" style="max-width:100%;height:auto" /></p>\n`;
      }
      finalHtml += rewrittenHtml;
      // ⚡ Source line removed completely

      let posted;
      try {
        posted = await createBloggerPost({ title, htmlContent: finalHtml });
      } catch (e) {
        log('Failed to post to Blogger for:', title);
        continue;
      }

      log('Posted to Blogger:', posted.url || posted.id || '(no url returned)');

      markPosted({ guid, link, title, published_at: item.pubDate || item.isoDate || null });

      await sleep(1500);
      if (MODE === 'once') {
        log('MODE=once: exiting after one post to avoid mass-posting. Set MODE=cron to run continuously.');
        return;
      }
    }
  } catch (err) {
    log('processOnce error:', err?.message || err);
  }
}

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

async function start() {
  log('Starting GSM2Blogger', { MODE, OPENAI_MODEL, GSMARENA_RSS, DB_PATH });

  if (MODE === 'once') {
    await processOnce();
    log('Finished single run (MODE=once). Exiting.');
    process.exit(0);
  } else {
    log('Scheduling cron:', POST_INTERVAL_CRON);
    await processOnce();
    cron.schedule(POST_INTERVAL_CRON, async () => {
      log('Cron tick - running processOnce');
      await processOnce();
    });
    process.stdin.resume();
  }
}

start().catch((e) => {
  log('Fatal error in start():', e?.message || e);
  process.exit(1);
});
