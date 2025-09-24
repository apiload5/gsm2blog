import 'dotenv/config';
import Parser from 'rss-parser';
import { google } from 'googleapis';
import OpenAI from 'openai';
import fs from 'fs';
import cron from 'node-cron';

const parser = new Parser();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Google OAuth client setup
const oauth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET
);
oauth2Client.setCredentials({ refresh_token: process.env.REFRESH_TOKEN });
const blogger = google.blogger({ version: 'v3', auth: oauth2Client });

// Already posted links JSON file
const postedFile = 'posted.json';
if (!fs.existsSync(postedFile)) fs.writeFileSync(postedFile, JSON.stringify([]));

async function fetchAndPost() {
  try {
    const feed = await parser.parseURL('https://www.gsmarena.com/rss-news-reviews.php');

    for (const item of feed.items) {
      const postedLinks = JSON.parse(fs.readFileSync(postedFile));
      if (postedLinks.includes(item.link)) {
        console.log(`⏩ Already posted: ${item.title}`);
        continue;
      }

      console.log(`📰 New article found: ${item.title}`);

      // GPT rewrite
      const gptResp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a news editor. Rewrite GSMArena articles in SEO-friendly, simple, unique language. Add a short intro + conclusion." },
          { role: "user", content: `${item.title}\n\n${item.contentSnippet}` }
        ]
      });

      const rewritten = gptResp.choices[0].message.content;

      // Blogger post body
      const postBody = {
        title: item.title,
        content: `<h2>${item.title}</h2><p>${rewritten}</p><p><a href="${item.link}" target="_blank">Source: GSMArena</a></p>`
      };

      const resp = await blogger.posts.insert({
        blogId: process.env.BLOG_ID,
        requestBody: postBody
      });

      console.log(`✅ Posted to Blogger: ${resp.data.url}`);

      // Save link to posted.json
      postedLinks.push(item.link);
      fs.writeFileSync(postedFile, JSON.stringify(postedLinks, null, 2));

      break; // per run ek hi post
    }
  } catch (err) {
    console.error("❌ Error:", err.message);
  }
}

// Hybrid mode: GitHub/Colab vs Local/Server
if (process.env.MODE === "once") {
  // GitHub Actions ya Colab ke liye
  fetchAndPost();
} else {
  // Local/Cloud ke liye: cron har ghante run kare
  console.log("⏳ Cron job scheduled (every hour)");
  cron.schedule("0 * * * *", fetchAndPost);
  fetchAndPost(); // start pe ek dafa run bhi kare
  }
                             
