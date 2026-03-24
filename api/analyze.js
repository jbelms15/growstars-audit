/**
 * POST /api/analyze
 * Body: { name, city }
 *
 * 1. Finds the target business via Google Places Text Search
 * 2. Fetches nearby competitors (same niche, 1.5km radius)
 * 3. Returns business data + competitor comparison
 */

const SEARCH_KEYWORDS = ["hair salon", "barber", "hairdresser"];

async function fetchNearbyCompetitors(lat, lng, excludePlaceId, apiKey) {
  const results = [];
  const seen = new Set([excludePlaceId]);

  for (const keyword of SEARCH_KEYWORDS) {
    const url =
      `https://maps.googleapis.com/maps/api/place/nearbysearch/json` +
      `?location=${lat},${lng}&radius=1500&keyword=${encodeURIComponent(keyword)}&key=${apiKey}`;

    const r    = await fetch(url);
    const data = await r.json();

    for (const place of data.results || []) {
      if (seen.has(place.place_id)) continue;
      if (!place.rating || !place.user_ratings_total) continue;
      seen.add(place.place_id);
      results.push({
        name:    place.name,
        rating:  place.rating,
        reviews: place.user_ratings_total,
      });
    }
  }

  // Sort by rating desc, take top 5
  return results
    .sort((a, b) => b.rating - a.rating || b.reviews - a.reviews)
    .slice(0, 5);
}

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

  try {
    // Step 1 — find target business
    const query = city ? `${name} ${city}` : name;
    const searchUrl =
      `https://maps.googleapis.com/maps/api/place/textsearch/json` +
      `?query=${encodeURIComponent(query)}&key=${apiKey}`;

    const sr   = await fetch(searchUrl);
    const sd   = await sr.json();

    if (sd.status !== "OK" || !sd.results?.length) {
      return res.status(404).json({ error: "Business not found" });
    }

    const place = sd.results[0];
    const lat   = place.geometry?.location?.lat;
    const lng   = place.geometry?.location?.lng;

    const business = {
      name:      place.name,
      rating:    place.rating ?? null,
      reviews:   place.user_ratings_total ?? 0,
      maps_link: `https://www.google.com/maps/place/?q=place_id:${place.place_id}`,
    };

    // Step 2 — fetch nearby competitors
    let competitors = [];
    if (lat && lng) {
      competitors = await fetchNearbyCompetitors(lat, lng, place.place_id, apiKey);
    }

    return res.status(200).json({ business, competitors });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
