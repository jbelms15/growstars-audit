/**
 * POST /api/scrape-email
 * Body: { url }
 *
 * Fetches the business website and scans for email addresses.
 * Checks mailto: links first, then falls back to regex pattern matching.
 * Always returns 200 — email is null if not found or site is unreachable.
 */

const SKIP_DOMAINS = [
  "example.com", "sentry.io", "wixpress.com", "squarespace.com",
  "wordpress.com", "googleapis.com", "cloudflare.com", "schema.org",
];

const SKIP_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".woff", ".woff2",
  ".ttf", ".eot", ".css", ".js", ".ico",
];

function extractEmail(html) {
  // 1. mailto: links are most reliable
  const mailtoMatch = html.match(
    /mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/i
  );
  if (mailtoMatch) return mailtoMatch[1].toLowerCase();

  // 2. Plain email pattern anywhere in the HTML
  const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const matches = html.match(emailRegex) || [];

  return (
    matches.find((email) => {
      const lower = email.toLowerCase();
      if (SKIP_DOMAINS.some((d) => lower.includes(d))) return false;
      if (SKIP_EXTENSIONS.some((ext) => lower.endsWith(ext))) return false;
      return true;
    })?.toLowerCase() || null
  );
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { url } = req.body;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "url is required" });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const r = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html",
      },
      redirect: "follow",
    });

    clearTimeout(timeout);

    if (!r.ok) return res.status(200).json({ email: null });

    const html = await r.text();
    const email = extractEmail(html);

    return res.status(200).json({ email });
  } catch {
    // Timeout, connection refused, bot block, etc. — just return null
    return res.status(200).json({ email: null });
  }
}
