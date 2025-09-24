// app.js
import 'dotenv/config';
import Parser from 'rss-parser';
import { GoogleApis } from 'googleapis';
import OpenAI from 'openai';
import { hasBeenPosted, markPosted } from './db.js';
import { extractFirstImageFromContent, sleep } from './utils.js';
import cron from 'node-cron';
import axios from 'axios';

const parser = new Parser({ timeout: 15000 });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const google = new GoogleApis();
const oauth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET
);
oauth2Client.setCredentials({ refresh_token: process.env.REFRESH_TOKEN });
const blogger = google.blogger({ version: 'v3', auth: oauth2Client });

const RSS_URL = process.env.GSMARENA_RSS || 'https://www.gsmarena.com/rss-news-reviews.php';
const MAX_ITEMS = parseInt(process.env.MAX_ITEMS_PER_RUN || '5', 10);
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const BLOG_ID = process.env.BLOG_ID;

if (!process.env.OPENAI_API_KEY || !process.env.CLIENT_ID || !process.env.CLIENT_SECRET || !process.env.REFRESH_TOKEN || !BLOG_ID) {
  console.error("Missing env vars. Check .env");
  process.exit(1);
}

async function fetchFeed() {
  console.log(`[${new Date().toISOString()}] Fetching RSS...`);
  const feed = await parser.parseURL(RSS_URL);
  return feed.items.slice(0, MAX_ITEMS);
}

async function rewriteWithGPT(title, snippet, content) {
  const prompt = `You are an expert news editor. Rewrite the news item below into a short blog post in Urdu (friendly tone) with:
- A 1-line hook headline (keep original title as reference),
- A 3-6 sentence summary,
- One short conclusion line with call-to-action "Source link included".
Make the text unique and SEO-friendly. Keep it concise.

Title: ${title}

Snippet: ${snippet || ''}

Full content (if available): ${content || ''}

Return only the HTML-ready body (you may use <p>, <strong>, <ul>, <li>, <img src="...">).`;
  const resp = await openai.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 800
  });
  const out = resp.choices?.[0]?.message?.content;
  return out || '';
}

async function createBloggerPost(title, htmlContent) {
  const body = { title, content: htmlContent };
  const res = await blogger.posts.insert({
    blogId: BLOG_ID,
    requestBody: body
  });
  return res.data;
}

function buildPostHtml(rewrittenHtml, sourceLink, imageUrl) {
  let html = '';
  if (imageUrl) {
    html += `<p><img src="${imageUrl}" alt="image" /></p>`;
  }
  html += rewrittenHtml;
  html += `<p><em>Source:</em> <a href="${sourceLink}" target="_blank" rel="noopener">GSMArena</a></p>`;
  return html;
}

async function processOnce() {
  try {
    const items = await fetchFeed();
    for (const item of items) {
      const guid = item.guid || item.link;
      if (hasBeenPosted(guid) || hasBeenPosted(item.link)) {
        console.log('Already posted:', item.title);
        continue;
      }

      console.log('Processing:', item.title);

      // Try to extract an image
      let imageUrl = extractFirstImageFromContent(item['content:encoded'] || item.content || item.contentSnippet);
      // fallback: try to fetch page and find og:image
      if (!imageUrl) {
        try {
          const page = await axios.get(item.link, { timeout: 10000 });
          const m = page.data.match(/property=["']og:image["']\s*content=["']([^"']+)["']/i) || page.data.match(/<meta name=["']og:image["'] content=["']([^"']+)["']/i);
          if (m) imageUrl = m[1];
        } catch (e) {
          // ignore page fetch errors
        }
      }

      // Rewrite with GPT
      const rewritten = await rewriteWithGPT(item.title, item.contentSnippet, item['content:encoded'] || item.content);

      const html = buildPostHtml(rewritten, item.link, imageUrl);
      const post = await createBloggerPost(item.title, html);
      console.log('Posted: ', post.url);

      // Mark in DB
      markPosted({ guid, link: item.link, title: item.title, published_at: item.pubDate });

      // small delay to avoid rate-limits
      await sleep(2000);
    }
  } catch (err) {
    console.error('Error in processOnce:', err?.message || err);
  }
}

// If running as long-lived process, schedule via cron env var
if (process.env.POST_INTERVAL_CRON) {
  console.log('Running as scheduled process. Cron:', process.env.POST_INTERVAL_CRON);
  // run once at start
  process.once('SIGINT', () => process.exit(0));
  process.once('SIGTERM', () => process.exit(0));
  (async ()=>{ await processOnce(); })();
  cron.schedule(process.env.POST_INTERVAL_CRON, async () => {
    console.log('Cron tick:', new Date().toISOString());
    await processOnce();
  });
} else {
  // run once and exit (good for GitHub Actions / Colab runs)
  (async ()=>{ await processOnce(); process.exit(0); })();
  }
  
