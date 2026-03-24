/**
 * POST /api/enrich
 * Body: { website }
 *
 * Fetches the business website (main page + /contact + /about)
 * and extracts email address and owner/contact name.
 * Always returns 200 — fields are null if not found.
 */

const SKIP_DOMAINS = [
  "example.com", "sentry.io", "wixpress.com", "squarespace.com",
  "wordpress.com", "googleapis.com", "cloudflare.com", "schema.org",
  "shopify.com", "wix.com", "godaddy.com", "amazonaws.com",
];

const SKIP_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".woff", ".woff2",
  ".ttf", ".eot", ".css", ".js", ".ico",
];

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function fetchPage(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": UA, "Accept": "text/html" },
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!r.ok) return "";
    return await r.text();
  } catch {
    clearTimeout(timer);
    return "";
  }
}

function extractEmail(html, domain) {
  const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const all = [...new Set((html.match(emailRegex) || []).map(e => e.toLowerCase()))];

  const clean = all.filter(e => {
    if (e.length > 80) return false;
    if (SKIP_DOMAINS.some(d => e.includes(d))) return false;
    if (SKIP_EXTENSIONS.some(ext => e.endsWith(ext))) return false;
    return true;
  });

  // Prefer emails on the business's own domain
  const ownDomain = clean.filter(e => domain && e.endsWith("@" + domain));
  return ownDomain[0] || clean[0] || null;
}

function extractOwner(html) {
  // 1. Schema.org Person near "owner" / "founder" context
  const schemaCtx = html.match(
    /"@type"\s*:\s*"Person"[^}]{0,400}"name"\s*:\s*"([A-Z][a-z]{1,20}(?:\s[A-Z][a-z]{1,25}){1,2})"/
  ) || html.match(
    /"name"\s*:\s*"([A-Z][a-z]{1,20}(?:\s[A-Z][a-z]{1,25}){1,2})"[^}]{0,400}"@type"\s*:\s*"Person"/
  );
  if (schemaCtx) return schemaCtx[1].trim();

  // 2. Meta author tag
  const metaAuthor = html.match(
    /<meta[^>]+name=["']author["'][^>]+content=["']([^"']{2,60})["']/i
  ) || html.match(
    /<meta[^>]+content=["']([^"']{2,60})["'][^>]+name=["']author["']/i
  );
  if (metaAuthor) return metaAuthor[1].trim();

  // 3. "Owner" / "Founder" / "Director" near a proper name
  const roleLabel = html.match(
    /(?:owner|founder|director|proprietor|principal)\s*[:\-–]?\s*([A-Z][a-z]{1,20}(?:\s[A-Z][a-z]{1,25}){1,2})/i
  );
  if (roleLabel) return roleLabel[1].trim();

  // 4. Name near a mailto link
  const mailtoName = html.match(
    /mailto:[^"'\s]+["'][^>]{0,60}>([A-Z][a-z]{1,20}(?:\s[A-Z][a-z]{1,25}){1,2})</
  );
  if (mailtoName) return mailtoName[1].trim();

  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { website } = req.body;
  if (!website || typeof website !== "string") {
    return res.status(400).json({ error: "website is required" });
  }

  const base = website.startsWith("http") ? website : `https://${website}`;

  let domain = null;
  try {
    domain = new URL(base).hostname.replace(/^www\./, "");
  } catch {
    return res.status(200).json({ email: null, owner: null });
  }

  // Fetch main page + contact + about in parallel
  const paths = ["", "/contact", "/contact-us", "/about"];
  const pages = await Promise.all(
    paths.map(p => {
      try { return fetchPage(new URL(p, base).href); }
      catch { return Promise.resolve(""); }
    })
  );

  const html = pages.join(" ");
  if (!html.trim()) return res.status(200).json({ email: null, owner: null });

  const email = extractEmail(html, domain);
  const owner = extractOwner(html);

  return res.status(200).json({ email, owner });
}
