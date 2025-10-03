/**
 * app.js
 *
 * Hybrid Multi-Feed Tech News -> OpenAI (GPT) -> Unsplash (Free Images) -> Blogger Autoposter
 * WITH MULTIPLE OPENAI KEYS SUPPORT & FIXED HTML ISSUES
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

// --- ENVIRONMENT VARIABLES AND CONFIG ---
// Multiple OpenAI API Keys (comma separated)
const OPENAI_API_KEYS_STRING = process.env.OPENAI_API_KEYS || '';
const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY; 

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const BLOG_ID = process.env.BLOG_ID;

// Multiple feeds for diverse tech content (comma-separated in .env)
const RSS_FEEDS_TO_PROCESS_STRING = process.env.RSS_FEEDS_TO_PROCESS || 
  'https://www.deepmind.com/blog/';

// Run every 5 hours: '0 */5 * * *'
const POST_INTERVAL_CRON = process.env.POST_INTERVAL_CRON || '0 */5 * * *'; 
const MAX_TOKENS = 3500;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const DB_PATH = process.env.DB_PATH || './data/posts.db';
const MODE = (process.env.MODE || 'cron').toLowerCase(); 
const USER_AGENT = process.env.USER_AGENT || 'TechBloggerAuto/2.5';

// Parse multiple API keys
const OPENAI_API_KEYS = OPENAI_API_KEYS_STRING.split(',').map(key => key.trim()).filter(Boolean);

if (OPENAI_API_KEYS.length === 0) {
  console.error('ERROR: OPENAI_API_KEYS not set in .env (comma separated)');
  process.exit(1);
}

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN || !BLOG_ID) {
  console.error('ERROR: Blogger OAuth config missing');
  process.exit(1);
}

if (!UNSPLASH_ACCESS_KEY) {
    console.warn('WARNING: UNSPLASH_ACCESS_KEY is missing. Images will not be fetched automatically.');
}

// --- INITIALIZATION ---
const parser = new Parser({
    customFields: {
        item: ['content', 'contentSnippet', 'pubDate'],
    }
});

const google = new GoogleApis();
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
const blogger = google.blogger({ version: 'v3', auth: oauth2Client });

const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Updated database schema to track API key usage
db.prepare(`
  CREATE TABLE IF NOT EXISTS posted (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guid TEXT UNIQUE,
    link TEXT UNIQUE,
    title TEXT,
    published_at TEXT,
    feed_url TEXT,
    openai_key_used TEXT,
    tokens_used INTEGER DEFAULT 0,
    posted_at TEXT DEFAULT (datetime('now'))
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS key_usage (
    key_hash TEXT PRIMARY KEY,
    last_used INTEGER DEFAULT 0,
    total_used INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )
`).run();

// --- HELPER FUNCTIONS ---
function hasBeenPosted(guidOrLink) {
  const row = db.prepare('SELECT 1 FROM posted WHERE guid = ? OR link = ?').get(guidOrLink, guidOrLink);
  return !!row;
}

function markPosted({ guid, link, title, published_at, feed_url, openai_key_used, tokens_used }) {
  const stmt = db.prepare('INSERT OR IGNORE INTO posted (guid, link, title, published_at, feed_url, openai_key_used, tokens_used) VALUES (?, ?, ?, ?, ?, ?, ?)');
  stmt.run(guid, link, title, published_at || null, feed_url || null, openai_key_used || null, tokens_used || 0);
}

// Simple hash function to store key usage without exposing actual keys
function hashAPIKey(key) {
  return Buffer.from(key).toString('base64').slice(-20);
}

// Get the least recently used API key
function getNextAPIKey() {
  const keysWithUsage = OPENAI_API_KEYS.map(key => {
    const keyHash = hashAPIKey(key);
    const usage = db.prepare('SELECT last_used, total_used, total_tokens FROM key_usage WHERE key_hash = ?').get(keyHash);
    return {
      key,
      keyHash,
      lastUsed: usage ? usage.last_used : 0,
      totalUsed: usage ? usage.total_used : 0,
      totalTokens: usage ? usage.total_tokens : 0
    };
  });

  // Sort by last used timestamp (oldest first)
  keysWithUsage.sort((a, b) => a.lastUsed - b.lastUsed);
  
  const selectedKey = keysWithUsage[0];
  
  // Update usage in database
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO key_usage (key_hash, last_used, total_used) 
    VALUES (?, ?, COALESCE((SELECT total_used FROM key_usage WHERE key_hash = ?), 0) + 1)
  `);
  stmt.run(selectedKey.keyHash, now, selectedKey.keyHash);
  
  log(`Using API Key: ${selectedKey.keyHash} (Total used: ${selectedKey.totalUsed + 1} times, Total tokens: ${selectedKey.totalTokens})`);
  return selectedKey.key;
}

// Update token usage for a key
function updateTokenUsage(keyHash, tokensUsed) {
  const stmt = db.prepare(`
    UPDATE key_usage 
    SET total_tokens = total_tokens + ? 
    WHERE key_hash = ?
  `);
  stmt.run(tokensUsed, keyHash);
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function validateWordCount(text, minWords = 800, maxWords = 900) {
    const wordCount = text.split(/\s+/).length;
    log(`Article word count: ${wordCount} words`);
    return wordCount >= minWords && wordCount <= maxWords;
}

// Clean HTML content - REMOVE VERTICAL THREE DOTS AND UNWANTED HTML
function cleanHTMLContent(html) {
  if (!html) return '';
  
  return html
    // Remove vertical three dots (···) and horizontal three dots
    .replace(/···/g, '')
    .replace(/\.\.\./g, '')
    .replace(/…/g, '')
    // Remove "html" text (case insensitive)
    .replace(/html/gi, '')
    // Remove unwanted HTML comments
    .replace(/<!--.*?-->/gs, '')
    // Remove script tags
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    // Remove style tags but keep content
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    // Clean up extra spaces
    .replace(/\s+/g, ' ')
    // Remove empty paragraphs
    .replace(/<p>\s*<\/p>/gi, '')
    // Fix multiple newlines
    .replace(/\n\s*\n/g, '\n')
    .trim();
}

// --- CORE AI & FREE IMAGE FUNCTIONS ---

/**
 * Calls GPT to generate article content, title, and metadata in JSON format.
 * Uses rotating API keys
 */
async function generateArticleAndMetadata(sourceContent) {
  const selectedAPIKey = getNextAPIKey();
  const openai = new OpenAI({ apiKey: selectedAPIKey });
  
  const prompt = `CRITICAL ROLE: You are a FACTUAL tech journalist with 10+ years experience. Create ORIGINAL, TRUTHFUL content that adds genuine value.

SOURCE ANALYSIS:
${sourceContent}

NON-NEGOTIABLE REQUIREMENTS:
1. **WORD COUNT:** Generate 800-850 words EXACTLY - COUNT THEM
2. **AUTHENTICITY:** Write 100% factual information ONLY from provided sources - NO HALLUCINATION
3. **ORIGINALITY:** Create completely unique phrasing - NO AI-generated patterns or repetitive structures
4. **SEO OPTIMIZATION:** Natural keyword placement, NO keyword stuffing - sound human and natural
5. **HUMAN STYLE:** Write like experienced human journalist with:
   - Occasional informal phrases
   - Mild opinions ("interestingly", "surprisingly")
   - Varied sentence length (mix short and long)
   - Natural transitional phrases
   - Industry-specific jargon appropriately used
6. **STRUCTURE:** 
   - Compelling H1 title (8-12 words)
   - Introduction paragraph (60-80 words)
   - 3-4 H2 sections with detailed analysis (150-200 words each)
   - "Key Insights" section with bullet points
   - "Future Implications" conclusion (80-100 words)
7. **NO HALLUCINATION:** Strictly use source material - NO invented facts or data
8. **PLAGIARISM-FREE:** Rewrite everything in your own words - must pass plagiarism checks
9. **NO THREE DOTS:** Do not use "..." or "…" or "···" anywhere in the content
10. **NO HTML TEXT:** Do not write the word "html" anywhere in the content
11. **CLEAN HTML:** Use proper HTML tags but avoid unnecessary attributes

OUTPUT FORMAT (JSON ONLY - NO OTHER TEXT):
{
  "title": "Engaging 8-12 word title with primary keyword - make it click-worthy",
  "search_description": "155-160 character meta description that makes people want to click", 
  "meta_tags": "Keyword1, Keyword2, Technology Analysis, Industry Insights, Future Trends",
  "alt_text": "Detailed 12-15 word visual description for relevant Unsplash image search",
  "article_body": "800-850 word COMPLETE article with proper HTML structure (h1, h2, p, ul/li tags only)"
}

FINAL VERIFICATION: Ensure content is 100% unique, factual, and appears human-written. Word count must be 800-850.`;

    try {
        const completion = await openai.chat.completions.create({
            model: OPENAI_MODEL,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: MAX_TOKENS,
            response_format: { type: "json_object" }, 
            temperature: 0.8,
        });

        if (!completion.choices || !completion.choices[0] || !completion.choices[0].message) {
            log('OpenAI response structure invalid');
            throw new Error('Invalid response structure from OpenAI');
        }

        let jsonText = completion.choices[0].message.content;
        
        if (!jsonText) {
            log('OpenAI returned empty content');
            throw new Error('Empty content from OpenAI');
        }
        
        jsonText = jsonText.replace(/```json|```/g, '').trim(); 
        
        let result;
        try {
            result = JSON.parse(jsonText);
        } catch (parseError) {
            log('JSON parse error. Raw content:', jsonText);
            throw new Error('Failed to parse JSON from OpenAI response');
        }
        
        // Validate required fields
        const required = ['title', 'search_description', 'meta_tags', 'alt_text', 'article_body'];
        for (const field of required) {
            if (!result[field]) {
                log(`Missing required field: ${field}`);
                throw new Error(`Missing required field: ${field}`);
            }
        }

        // Track token usage
        const tokensUsed = completion.usage?.total_tokens || 0;
        updateTokenUsage(hashAPIKey(selectedAPIKey), tokensUsed);
        log(`Tokens used for this request: ${tokensUsed}`);

        if (!validateWordCount(result.article_body)) {
            const wordCount = result.article_body.split(/\s+/).length;
            log(`Warning: Word count ${wordCount} is outside preferred range (800-850)`);
        }

        // CLEAN HTML CONTENT - Remove three dots and "html" text
        result.article_body = cleanHTMLContent(result.article_body);
        
        log('Article generated successfully');
        return {
            ...result,
            api_key_hash: hashAPIKey(selectedAPIKey),
            tokens_used: tokensUsed
        };

    } catch (err) {
        log('OpenAI Generation error:', err?.message || err);
        throw new Error('Failed to generate structured article content.');
    }
}

/**
 * Fetches a random high-quality image from Unsplash based on the search query (altText).
 * FIXED: Removes attribution that causes "···" and "html" text
 */
async function fetchUnsplashImage(query) {
    if (!UNSPLASH_ACCESS_KEY) {
        log('Unsplash access key missing - skipping image');
        return null;
    }

    try {
        log(`Searching Unsplash for: ${query}`);
        const UNSPLASH_URL = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape&client_id=${UNSPLASH_ACCESS_KEY}`;
        
        const res = await axios.get(UNSPLASH_URL, {
            headers: { 'User-Agent': USER_AGENT },
            timeout: 10000
        });

        if (res.data.results && res.data.results.length > 0) {
            const image = res.data.results[0];
            log('Unsplash image found successfully');
            
            // Use raw image URL without any tracking parameters
            // This avoids the "···" and "html" text that comes with attribution
            let imageUrl = image.urls.regular;
            
            // Remove any Unsplash tracking parameters that might cause issues
            imageUrl = imageUrl.split('?')[0]; // Remove query parameters
            imageUrl += '?fit=crop&w=1200&h=630&q=80'; // Add clean parameters
            
            return imageUrl; 
        } else {
            log('No images found on Unsplash for query:', query);
            return null;
        }
    } catch (err) {
        log('Unsplash API Error:', err?.message);
        return null; 
    }
}

// --- MAIN PROCESSING LOGIC ---

async function processOnce() {
  try {
    const feedUrls = RSS_FEEDS_TO_PROCESS_STRING.split(',').map(url => url.trim()).filter(Boolean);
    let allItems = [];

    log('--- Starting new run ---');
    log(`Available API Keys: ${OPENAI_API_KEYS.length}`);
    log(`Checking ${feedUrls.length} RSS feeds for new items...`);

    // 1. Fetch items from all feeds
    for (const url of feedUrls) {
      try {
        const feed = await parser.parseURL(url);
        const newItems = feed.items.slice(0, 10).map(item => ({
            ...item,
            feedUrl: url,
            pubDateParsed: item.pubDate ? new Date(item.pubDate) : new Date(0)
        }));
        allItems.push(...newItems);
        log(`Fetched ${newItems.length} items from ${url}`);
      } catch (e) {
        log(`Failed to fetch feed: ${url}. Error: ${e.message}`);
      }
    }
    
    // 2. Filter and Sort to find the single newest item
    const unpostedItems = allItems
        .filter(item => {
            const guid = item.guid || item.link || item.title;
            const posted = hasBeenPosted(guid);
            if (!posted) {
                log(`New item found: ${item.title} from ${item.feedUrl}`);
            }
            return !posted;
        })
        .sort((a, b) => b.pubDateParsed.getTime() - a.pubDateParsed.getTime()); 
    
    if (!unpostedItems.length) {
        log('No new, unposted items found across all feeds.');
        return;
    }

    log(`Found ${unpostedItems.length} unposted items. Processing newest one.`);

    // 3. Select the newest item and prepare source material (synthesis)
    const primaryItem = unpostedItems[0];
    const sourceContent = `
PRIMARY SOURCE:
Title: ${primaryItem.title}
Content: ${primaryItem.contentSnippet || primaryItem.content || 'No content available'}
Published: ${primaryItem.pubDate || 'Unknown date'}
Source: ${primaryItem.feedUrl}
`;

    log(`Synthesizing 800-word article based on: "${primaryItem.title}"`);
    
    // 4. Generate Article, Title, and Metadata
    let articleData;
    try {
        articleData = await generateArticleAndMetadata(sourceContent);
        log('Article generation completed');
    } catch (e) {
        log('Article generation failed. Skipping post.');
        return;
    }

    // 5. Fetch and Embed Image (Free Unsplash) - CLEAN VERSION
    let finalHtml = '';
    let imageUrl = await fetchUnsplashImage(articleData.alt_text);

    if (imageUrl) {
        log('Unsplash image fetched successfully - embedding in post');
        // CLEAN IMAGE EMBED - No attribution that causes "···" or "html"
        finalHtml += `<div style="text-align: center; margin: 20px 0;">
            <img src="${imageUrl}" alt="${escapeHtml(articleData.alt_text)}" style="max-width: 100%; height: auto; border-radius: 12px; box-shadow: 0 4px 8px rgba(0,0,0,0.1);" />
        </div>\n`;
        
        // Optional: Add clean caption without any problematic text
        finalHtml += `<div style="text-align: center; margin-bottom: 30px;">
            <p style="font-style: italic; color: #666; font-size: 14px; margin: 0;">${escapeHtml(articleData.alt_text)}</p>
        </div>\n`;
    } else {
        log('Image fetching failed - proceeding without image');
    }
    
    // ADD CLEAN ARTICLE BODY (No three dots or "html" text)
    finalHtml += articleData.article_body;
    
    const labels = articleData.meta_tags.split(',').map(t => t.trim()).filter(Boolean);
    
    // 6. Post to Blogger
    let posted;
    try {
        log('Posting to Blogger...');
        posted = await createBloggerPost({ 
            title: articleData.title, 
            htmlContent: finalHtml, 
            labels: labels 
        });
        log('Blogger post successful');
    } catch (e) {
        log('Failed to post to Blogger:', e.message);
        return;
    }

    // 7. Mark as Posted and Final Log
    log('=== POST SUCCESSFUL ===');
    log('Title:', articleData.title);
    log('Blogger URL:', posted.url);
    log('Word Count:', articleData.article_body.split(/\s+/).length);
    log('Tokens Used:', articleData.tokens_used);
    log('Source Feed:', primaryItem.feedUrl);
    log('API Key Used:', articleData.api_key_hash);
    
    markPosted({ 
        guid: primaryItem.guid || primaryItem.link, 
        link: primaryItem.link, 
        title: articleData.title, 
        published_at: primaryItem.pubDate || null,
        feed_url: primaryItem.feedUrl,
        openai_key_used: articleData.api_key_hash,
        tokens_used: articleData.tokens_used
    });
    
    // 8. Wait before next potential run
    await sleep(5000); 

  } catch (err) {
    log('processOnce Critical Error:', err?.message || err);
  }
}

// --- BLOGGER API FUNCTION ---
async function createBloggerPost({ title, htmlContent, labels = [] }) {
  try {
    const res = await blogger.posts.insert({
      blogId: BLOG_ID,
      requestBody: {
        title,
        content: htmlContent,
        labels: labels.length ? labels : ['Tech News', 'AI Analysis', 'Industry Insights']
      }
    });
    return res.data;
  } catch (err) {
    log('Blogger API error:', err?.message || err?.toString());
    throw err;
  }
}

// --- START APPLICATION ---
async function start() {
  log('Starting TechBloggerAuto v2.6 (Fixed Vertical Dots & HTML Text Issues)', { 
    MODE, 
    OPENAI_MODEL, 
    DB_PATH,
    RSS_FEEDS: RSS_FEEDS_TO_PROCESS_STRING.split(',').length,
    API_KEYS: OPENAI_API_KEYS.length
  });
  
  // Display key usage statistics
  const keyStats = OPENAI_API_KEYS.map(key => {
    const keyHash = hashAPIKey(key);
    const usage = db.prepare('SELECT total_used, total_tokens FROM key_usage WHERE key_hash = ?').get(keyHash);
    return {
      key: keyHash,
      used: usage ? usage.total_used : 0,
      tokens: usage ? usage.total_tokens : 0
    };
  });
  
  log('Initial Key Usage Statistics:');
  keyStats.forEach(stat => {
    log(`- Key ${stat.key}: ${stat.used} posts, ${stat.tokens} tokens`);
  });
  
  if (MODE === 'once') {
    await processOnce();
    log('Finished single run. Exiting.');
    process.exit(0);
  } else {
    log(`Scheduling cron: ${POST_INTERVAL_CRON} (Every 5 hours)`);
    await processOnce(); 
    cron.schedule(POST_INTERVAL_CRON, processOnce);
    process.stdin.resume(); 
  }
}

// Global error handling
process.on('unhandledRejection', (reason, promise) => {
  log('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  log('Uncaught Exception:', error);
  process.exit(1);
});

start().catch(e => { 
  log('Fatal startup error:', e?.message || e); 
  process.exit(1); 
});
