/**
 * MobiGadget Auto Blogger (FINAL VERSION)
 * Features:
 * ✅ Auto fetch from GSMARss
 * ✅ SEO rewrite (unique, long-form content)
 * ✅ SEO-optimized alt/title tags
 * ✅ REMOVES GSMArena logo
 * ✅ OVERLAYS YOUR LOGO
 * ✅ THUMBNAIL FIX: Uploads final image to Imgur for proper thumbnails
 * ✅ Works on Replit + GitHub Actions
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
import Jimp from 'jimp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- ENV VARIABLES ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const BLOG_ID = process.env.BLOG_ID;
const IMGUR_CLIENT_ID = process.env.IMGUR_CLIENT_ID; // For thumbnail fix

const GSMARENA_RSS = process.env.GSMARENA_RSS;
const POST_INTERVAL_CRON = process.env.POST_INTERVAL_CRON || '0 */3 * * *';
const MAX_ITEMS_PER_RUN = parseInt(process.env.MAX_ITEMS_PER_RUN || '1', 10);
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const DB_PATH = process.env.DB_PATH || './data/posts.db';
const MODE = (process.env.MODE || 'cron').toLowerCase();
const USER_AGENT = process.env.USER_AGENT || 'MobiGadget/3.0'; // Final Version
const LOGO_PATH = path.join(__dirname, 'assets', 'logo.png');
const GSMARENA_LOGO_COORDS = process.env.GSMARENA_LOGO_COORDS || '10,10,100,20';

// --- BASIC CHECKS ---
if (!OPENAI_API_KEY || !CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN || !BLOG_ID) {
  console.error('❌ ERROR: Essential .env variables are missing (Blogger/OpenAI).');
  process.exit(1);
}
if (!IMGUR_CLIENT_ID) {
  console.error('❌ ERROR: IMGUR_CLIENT_ID is missing in .env. It is required for the thumbnail fix.');
  process.exit(1);
}
const logoCoords = GSMARENA_LOGO_COORDS.split(',').map(Number);
if (logoCoords.length !== 4 || logoCoords.some(isNaN)) {
    console.error('❌ ERROR: Invalid GSMARENA_LOGO_COORDS in .env. Format must be "x,y,width,height".');
    process.exit(1);
}

// --- SETUP (DB, Google API, etc.) ---
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
    id INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE, link TEXT UNIQUE,
    title TEXT, published_at TEXT, posted_at TEXT DEFAULT (datetime('now'))
  )
`).run();

function hasBeenPosted(guidOrLink) { /* Unchanged */ }
function markPosted({ guid, link, title, published_at }) { /* Unchanged */ }
function log(...args) { /* Unchanged */ }

// ========== IMAGE PROCESSING & UPLOAD FUNCTIONS ==========

/**
 * Removes GSMArena logo, adds user's logo, returns Base64.
 */
async function processAndBrandImage(imageUrl) {
  try {
    const image = await Jimp.read(imageUrl);
    const logo = await Jimp.read(LOGO_PATH);
    const [x, y, width, height] = logoCoords;
    image.composite(new Jimp(width, height, 0xFFFFFFFF), x, y);
    const logoWidth = image.bitmap.width * 0.25;
    logo.resize(logoWidth, Jimp.AUTO);
    const overlayX = image.bitmap.width - logo.bitmap.width - 20;
    const overlayY = image.bitmap.height - logo.bitmap.height - 20;
    image.composite(logo, overlayX, overlayY, { mode: Jimp.BLEND_SOURCE_OVER, opacitySource: 0.85 });
    return await image.getBase64Async(Jimp.MIME_JPEG);
  } catch (err) {
    log('⚠️ Image processing failed:', err.message);
    return null;
  }
}

/**
 * Uploads a Base64 image to Imgur and returns the direct URL.
 */
async function uploadToImgur(base64Image) {
  try {
    const base64Data = base64Image.split(',')[1];
    const response = await axios.post('https://api.imgur.com/3/image', { image: base64Data, type: 'base64' }, {
      headers: { 'Authorization': `Client-ID ${IMGUR_CLIENT_ID}` }
    });
    if (response.data.success) {
      log('✅ Image uploaded to Imgur:', response.data.data.link);
      return response.data.data.link;
    }
    return null;
  } catch (err) {
    log('❌ Imgur API error:', err.response ? err.response.data : err.message);
    return null;
  }
}


// ========== UTILITY & AI FUNCTIONS (Unchanged from gsm2blog) ==========

async function fetchPage(url) { /* Unchanged */ }
function extractFirstImageFromHtml(html) { /* Unchanged */ }
function extractOgImage(html) { /* Unchanged */ }
function extractMainArticle(html) { /* Unchanged */ }
async function rewriteWithOpenAI({ title, snippet, content }) { /* Unchanged */ }
async function generateImageAlt(title, snippet, content) { /* Unchanged */ }
async function generateImageTitle(title, snippet, content) { /* Unchanged */ }
async function generateTags(title, snippet, content) { /* Unchanged */ }
async function createBloggerPost({ title, htmlContent, labels = [] }) { /* Unchanged */ }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function escapeHtml(text) { /* Unchanged */ }

// ========== MAIN PROCESSING LOGIC (UPDATED WITH THUMBNAIL FIX) ==========
async function processOnce() {
  try {
    log('Fetching RSS:', GSMARENA_RSS);
    const feed = await parser.parseURL(GSMARENA_RSS);
    if (!feed?.items?.length) return log('No items in feed.');

    const items = feed.items.slice(0, MAX_ITEMS_PER_RUN);
    for (const item of items) {
      const guid = item.guid || item.link;
      const link = item.link;
      const title = item.title || 'Untitled';

      if (hasBeenPosted(guid) || hasBeenPosted(link)) {
        log('Already posted:', title);
        continue;
      }
      log('Processing new item:', title);

      let snippet = item.contentSnippet || '';
      let fullContent = item['content:encoded'] || item.content || snippet;
      let imageUrl = null;

      if (link) {
        const pageHtml = await fetchPage(link);
        if (pageHtml) {
          const extracted = extractMainArticle(pageHtml);
          if (extracted) fullContent = extracted;
          imageUrl = extractOgImage(pageHtml) || extractFirstImageFromHtml(pageHtml);
        }
      }
      if (!imageUrl) imageUrl = extractFirstImageFromHtml(fullContent);
      if (!imageUrl) {
        log(`⚠️ Skipping: No image found for ${title}`);
        continue;
      }

      // --- NEW 3-STEP IMAGE WORKFLOW ---
      // 1. Process image (remove logo, add logo) to get Base64
      const brandedBase64 = await processAndBrandImage(imageUrl);
      if (!brandedBase64) {
        log(`⚠️ Skipping: Image branding failed for ${title}`);
        continue;
      }
      // 2. Upload to Imgur to get a real URL (THUMBNAIL FIX)
      const finalImageUrl = await uploadToImgur(brandedBase64);
      if (!finalImageUrl) {
        log(`⚠️ Skipping: Imgur upload failed for ${title}`);
        continue;
      }

      // 3. Continue with AI content generation...
      const rewrittenHtml = await rewriteWithOpenAI({ title, snippet, content: fullContent });
      const altText = await generateImageAlt(title, snippet, fullContent);
      const titleText = await generateImageTitle(title, snippet, fullContent);
      const tags = await generateTags(title, snippet, fullContent);

      // Construct final HTML with the Imgur URL
      let finalHtml = `<p><img src="${finalImageUrl}" alt="${escapeHtml(altText)}" title="${escapeHtml(titleText)}" style="max-width:100%;height:auto" /></p>\n`;
      finalHtml += rewrittenHtml;

      const posted = await createBloggerPost({ title, htmlContent: finalHtml, labels: tags });
      log('✅ Posted to Blogger:', posted.url);
      markPosted({ guid, link, title, published_at: item.pubDate });
      await sleep(2000);

      if (MODE === 'once') return;
    }
  } catch (err) {
    log('❌ processOnce error:', err?.message || err);
  }
}

// ========== START LOGIC ==========
async function start() {
    log('🚀 Starting MobiGadget Auto Blogger (Final Version)...');
    if (MODE === 'once') {
        await processOnce();
        log('Finished single run. Exiting.');
        process.exit(0);
    } else {
        log('Scheduling cron:', POST_INTERVAL_CRON);
        await processOnce();
        cron.schedule(POST_INTERVAL_CRON, processOnce);
    }
}

// Helper functions that were marked as "Unchanged" for brevity need to be fully present in the final script
function hasBeenPosted(guidOrLink) { const row = db.prepare('SELECT 1 FROM posted WHERE guid = ? OR link = ?').get(guidOrLink, guidOrLink); return !!row; }
function markPosted({ guid, link, title, published_at }) { const stmt = db.prepare('INSERT OR IGNORE INTO posted (guid, link, title, published_at) VALUES (?, ?, ?, ? )'); stmt.run(guid, link, title, published_at || null); }
function log(...args) { console.log(new Date().toISOString(), ...args); }
async function fetchPage(url) { try { const res = await axios.get(url, { headers: { 'User-Agent': USER_AGENT }, timeout: 15000 }); return res.data; } catch (e) { return null; } }
function extractFirstImageFromHtml(html) { if (!html) return null; const imgMatch = html.match(/<img[^>]+src=["']([^"']+)["']/i); if (imgMatch) return imgMatch[1]; return null; }
function extractOgImage(html) { if (!html) return null; const m = html.match(/property=["']og:image["']\s*content=["']([^"']+)["']/i) || html.match(/<meta[^>]*name=["']og:image["'][^>]*content=["']([^"']+)["']/i); if (m) return m[1]; return null; }
function extractMainArticle(html) { if (!html) return null; let match = html.match(/<div class=\"article-body\">([\s\S]*?)<\/div>/i); if (match) return match[1]; match = html.match(/<div[^>]*class=[\"']o-article-blocks[\"'][^>]*>([\s\S]*?)<\/div>/i); if (match) return match[1]; return null; }
async function rewriteWithOpenAI({ title, snippet, content }) { const prompt = `You are a highly skilled SEO Content Writer...`; try { const completion = await openai.chat.completions.create({ model: OPENAI_MODEL, messages: [{ role: 'user', content: `${prompt}\n\nTitle: ${title}\n\nSnippet: ${snippet || ''}\n\nContent:\n${content || ''}` }], max_tokens: 2200 }); let text = completion.choices?.[0]?.message?.content || ''; text = text.replace(/\.\.\.\s*html/gi, ''); text = text.replace(/<a [^>]*>(.*?)<\/a>/gi, '$1'); return text; } catch (err) { log('OpenAI rewrite error:', err?.message || err); throw err; } }
async function generateImageAlt(title, snippet, content) { const prompt = `Generate a descriptive image alt text...`; try { const completion = await openai.chat.completions.create({ model: OPENAI_MODEL, messages: [{ role: 'user', content: prompt }], max_tokens: 40 }); return (completion.choices?.[0]?.message?.content || title).trim(); } catch (err) { log('Alt error:', err?.message || err); return title; } }
async function generateImageTitle(title, snippet, content) { const prompt = `Generate a short SEO-friendly title text...`; try { const completion = await openai.chat.completions.create({ model: OPENAI_MODEL, messages: [{ role: 'user', content: prompt }], max_tokens: 20 }); return (completion.choices?.[0]?.message?.content || title).trim(); } catch (err) { log('Title error:', err?.message || err); return title; } }
async function generateTags(title, snippet, content) { const prompt = `Generate 3-6 SEO-friendly tags...`; try { const completion = await openai.chat.completions.create({ model: OPENAI_MODEL, messages: [{ role: 'user', content: prompt }], max_tokens: 40 }); const tags = (completion.choices?.[0]?.message?.content || '').split(',').map(t => t.trim()).filter(Boolean); return tags; } catch (err) { log('Tags error:', err?.message || err); return []; } }
async function createBloggerPost({ title, htmlContent, labels = [] }) { try { const res = await blogger.posts.insert({ blogId: BLOG_ID, requestBody: { title, content: htmlContent, labels: labels.length ? labels : undefined } }); return res.data; } catch (err) { log('Blogger API error:', err?.message || err?.toString()); throw err; } }
function escapeHtml(text) { if (!text) return ''; return text.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m])); }

start().catch(e => { log('❌ Fatal error:', e?.message || e); process.exit(1); });
