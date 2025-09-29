# GSM2 Blog Auto-Content Publisher (GSMArena -> OpenAI -> Blogger)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Technology: Node.js](https://img.shields.io/badge/Technology-Node.js-339933.svg)]()
[![Automation: Cron](https://img.shields.io/badge/Automation-Cron-blue.svg)]()

## 📝 Project Overview

The **GSM2 Blog Auto-Content Publisher** is a sophisticated, single-file Node.js application designed to automate the content generation and publishing workflow for a blog.

It functions as a **hybrid bridge** that:
1.  **Feeds:** Reads the latest technology news from the GSMArena RSS feed.
2.  **Rewrites:** Uses the **OpenAI (GPT) API** to rewrite and expand the fetched content into unique, SEO-friendly articles.
3.  **Publishes:** Automatically posts the rewritten articles, complete with images and alt-text, to a **Google Blogger** site.

This application is built for automatic content curation, requiring minimal manual intervention once configured.

---

## 🚀 Key Features and Functionality

The application performs the following core automated tasks:

### 1. Source Data Acquisition
* **RSS Polling:** Fetches the latest items from a configured GSMArena RSS feed (`GSMARENA_RSS`).
* **Deep Content Extraction:** For each item, it attempts to fetch the full article page and use custom parsing logic to extract the complete article body and the primary image (`og:image` or first `<img>`).
* **Post Tracking:** Uses an internal **SQLite database (`better-sqlite3`)** to track posts using their unique GUID/link, preventing duplicate publishing.

### 2. AI Content Generation
* **Professional Rewriting:** Uses the specified OpenAI model (defaulting to `gpt-4o-mini`) to rewrite news snippets into detailed, high-quality blog posts.
* **Language Support:** The rewrite function is currently configured for content generation in **Urdu** (`lang: 'ur'`).
* **SEO Optimization:** Generates short, SEO-friendly image **Alt Text** for the extracted feature image using OpenAI.

### 3. Publishing and Scheduling
* **Blogger API Integration:** Uses the official **Google Blogger API (via `googleapis`)** with OAuth2 and a Refresh Token to securely insert new posts.
* **HTML Structure:** The final output is an HTML-ready string that includes the feature image (with alt text) followed by the AI-rewritten content.
* **Scheduling:** Can run either **`once`** or continuously via a **`node-cron`** scheduler at a configurable interval (`POST_INTERVAL_CRON`).

---

## ⚙️ Configuration and Setup

This application is configured entirely via environment variables in a **`.env`** file.

### 1. Prerequisites
* Node.js (v14+)
* API keys and configuration for **OpenAI** and **Google Blogger OAuth**.
* A Google Cloud Project enabled for the **Blogger API**.

### 2. Environment Variables (`.env`)

You must set the following variables:

| Variable | Description | Required | Example Value |
| :--- | :--- | :--- | :--- |
| `OPENAI_API_KEY` | Your OpenAI API Key. | **YES** | `sk-xxxxxxxxxxxxxxxxxxxx` |
| `CLIENT_ID` | Google OAuth Client ID. | **YES** | `12345.apps.googleusercontent.com` |
| `CLIENT_SECRET` | Google OAuth Client Secret. | **YES** | `GOCSPX-xxxxxxxxxxxxxx` |
| `REFRESH_TOKEN` | Google OAuth Refresh Token for Blogger. | **YES** | `1//xxxxxxxxxxxxxxxxxxxxx` |
| `BLOG_ID` | The ID of your target Blogger blog. | **YES** | `8675309` |
| `GSMARENA_RSS` | The URL of the RSS feed to monitor. | NO (Default) | `https://www.gsmarena.com/rss.php3` |
| `POST_INTERVAL_CRON` | Cron schedule for continuous mode. | NO (Default) | `0 * * * *` (Every hour) |
| `MODE` | Set to `cron` for continuous running, or `once` for a single run. | NO (Default) | `cron` |

### 3. Installation and Run

1.  **Clone the repository:**
    ```bash
    git clone [https://github.com/apiload5/gsm2blog.git](https://github.com/apiload5/gsm2blog.git)
    cd gsm2blog
    ```

2.  **Install dependencies:**
    ```bash
    npm install dotenv rss-parser axios better-sqlite3 googleapis openai node-cron
    ```
    *(Note: These are the dependencies used in `app.js`)*

3.  **Run the application:**
    * **Single Run (Test Mode):**
        ```bash
        # Ensure MODE=once is set in .env or via command line
        node app.js
        ```
    * **Continuous (Production Mode):**
        ```bash
        # Ensure MODE=cron and POST_INTERVAL_CRON are set
        node app.js
        ```

---

## 📜 Database and Tracking

The application uses an SQLite database file (`./data/posts.db` by default) to maintain a record of all articles that have been successfully processed and posted. The `posted` table tracks the GUID, link, title, and posting time to prevent redundant posts, even if the application is restarted.

## 🤝 License

This project is licensed under the **MIT License**.
