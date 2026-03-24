/**
 * POST /api/competitors
 * Body: { place_id }
 *
 * Fetches nearby competitors for a given business.
 * 1. Gets lat/lng from Place Details
 * 2. Runs nearby search (same logic as analyze.js)
 * Returns { competitors: [...] }
 */

const SEARCH_KEYWORDS = ["hair salon", "barber", "hairdresser"];
const HAIR_TYPES      = new Set(["hair_care", "hair_salon", "barber_shop"]);

function isHairBusiness(place) {
  return (place.types || []).some(t => HAIR_TYPES.has(t));
}

async function fetchNearbyCompetitors(lat, lng, excludePlaceId, apiKey) {
  const results = [];
  const seen    = new Set([excludePlaceId]);

  for (const keyword of SEARCH_KEYWORDS) {
    const url =
      `https://maps.googleapis.com/maps/api/place/nearbysearch/json` +
      `?location=${lat},${lng}&radius=1500&keyword=${encodeURIComponent(keyword)}&key=${apiKey}`;

    const r    = await fetch(url);
    const data = await r.json();

    for (const place of data.results || []) {
      if (seen.has(place.place_id))              continue;
      if (!place.rating || !place.user_ratings_total) continue;
      if (!isHairBusiness(place))                continue;
      if (place.user_ratings_total < 10)         continue;
      seen.add(place.place_id);
      results.push({
        name:     place.name,
        rating:   place.rating,
        reviews:  place.user_ratings_total,
        place_id: place.place_id,
        vicinity: place.vicinity || null,
      });
    }
  }

  return results
    .sort((a, b) => b.reviews - a.reviews || b.rating - a.rating)
    .slice(0, 5);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { place_id } = req.body;
  if (!place_id || typeof place_id !== "string") {
    return res.status(400).json({ error: "place_id is required" });
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "GOOGLE_PLACES_API_KEY not set" });

  try {
    // Step 1 — get lat/lng from Place Details
    const detailsUrl =
      `https://maps.googleapis.com/maps/api/place/details/json` +
      `?place_id=${encodeURIComponent(place_id)}&fields=geometry&key=${apiKey}`;

    const dr   = await fetch(detailsUrl);
    const dd   = await dr.json();

    if (dd.status !== "OK") {
      return res.status(200).json({ competitors: [] });
    }

    const lat = dd.result?.geometry?.location?.lat;
    const lng = dd.result?.geometry?.location?.lng;

    if (!lat || !lng) {
      return res.status(200).json({ competitors: [] });
    }

    // Step 2 — nearby search
    const competitors = await fetchNearbyCompetitors(lat, lng, place_id, apiKey);
    return res.status(200).json({ competitors });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
