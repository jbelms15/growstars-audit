export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { query, place_id } = req.query;
  const API_KEY = process.env.GOOGLE_PLACES_API_KEY;

  if (!API_KEY) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  try {
    if (place_id) {
      const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place_id}&fields=name,formatted_address,rating,user_ratings_total,photos,opening_hours,website,formatted_phone_number,reviews,business_status&key=${API_KEY}`;
      const r = await fetch(url);
      const data = await r.json();
      return res.status(200).json(data);
    }

    if (query) {
      const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(query)}&inputtype=textquery&fields=place_id,name,formatted_address&key=${API_KEY}`;
      const r = await fetch(url);
      const data = await r.json();
      return res.status(200).json(data);
    }

    return res.status(400).json({ error: 'Missing query or place_id' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
