/**
 * POST /api/analyze
 * Body: { name, city }
 *
 * Looks up a single business by name via Google Places Text Search.
 * Returns name, rating, reviews, maps_link.
 */

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { name, city } = req.body;
  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "name is required" });
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "GOOGLE_PLACES_API_KEY not set" });

  const query = city ? `${name} ${city}` : name;
  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${apiKey}`;

  try {
    const r    = await fetch(url);
    const data = await r.json();

    if (data.status !== "OK" || !data.results?.length) {
      return res.status(404).json({ error: "Business not found" });
    }

    const place = data.results[0];
    return res.status(200).json({
      name:      place.name,
      rating:    place.rating ?? null,
      reviews:   place.user_ratings_total ?? 0,
      maps_link: `https://www.google.com/maps/place/?q=place_id:${place.place_id}`,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
