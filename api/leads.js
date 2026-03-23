/**
 * GET /api/leads
 *
 * Returns all enriched leads stored in Supabase.
 * Used by the frontend to load the full lead pool on init and after each run.
 */

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: "Supabase not configured" });
  }

  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/leads?select=*&order=created_at.desc`,
      {
        headers: {
          apikey:        SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
        },
      }
    );

    const data = await r.json();

    if (!r.ok) {
      return res.status(500).json({ error: data.message || "Supabase error" });
    }

    return res.status(200).json({ leads: data });
  } catch (err) {
    console.error("[leads]", err.message);
    return res.status(500).json({ error: err.message });
  }
}
