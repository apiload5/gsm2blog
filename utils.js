// utils.js
import axios from 'axios';

export function extractFirstImageFromContent(content) {
  if (!content) return null;
  const m = content.match(/<img[^>]+src="([^">]+)"/i);
  if (m) return m[1];
  return null;
}

// simple sleep
export function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
  
