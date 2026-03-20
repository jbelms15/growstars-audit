export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action, query, place_id, id } = req.query;
  const API_KEY = process.env.GOOGLE_PLACES_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Supabase REST helper — uses service role key to bypass RLS
  const sbFetch = async (method, path, body) => {
    const headers = {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    };
    if (method === 'POST') headers['Prefer'] = 'return=representation';
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    try { return JSON.parse(text); } catch { return { error: text }; }
  };

  try {
    // Google Places: text search
    if (action === 'search' || (!action && query)) {
      if (!API_KEY) return res.status(500).json({ error: 'API key not configured' });
      const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(query)}&inputtype=textquery&fields=place_id,name,formatted_address&key=${API_KEY}`;
      const r = await fetch(url);
      return res.status(200).json(await r.json());
    }

    // Google Places: place details
    if (action === 'details' || (!action && place_id)) {
      if (!API_KEY) return res.status(500).json({ error: 'API key not configured' });
      const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place_id}&fields=name,formatted_address,rating,user_ratings_total,photos,opening_hours,website,formatted_phone_number,reviews,business_status&key=${API_KEY}`;
      const r = await fetch(url);
      return res.status(200).json(await r.json());
    }

    // Supabase: save prospect
    if (action === 'save') {
      if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
      const data = await sbFetch('POST', 'Prospects', req.body);
      if (Array.isArray(data) && data.length) return res.status(200).json(data[0]);
      if (data && !data.error) return res.status(200).json(data);
      return res.status(400).json(data || { error: 'Save failed' });
    }

    // Supabase: list all prospects
    if (action === 'prospects') {
      if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
      const data = await sbFetch('GET', 'Prospects?select=*&order=created_at.desc');
      return res.status(200).json(Array.isArray(data) ? data : []);
    }

    // Supabase: update prospect status
    if (action === 'update') {
      if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
      const data = await sbFetch('PATCH', `Prospects?id=eq.${encodeURIComponent(id)}`, req.body);
      return res.status(200).json(data);
    }

    // Supabase: delete prospect
    if (action === 'delete') {
      if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
      await sbFetch('DELETE', `Prospects?id=eq.${encodeURIComponent(id)}`);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
