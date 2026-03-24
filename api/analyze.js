/**
 * POST /api/analyze
 * Body: { name, city }
 *
 * 1. Finds the target business via Google Places Text Search
 * 2. Fetches nearby competitors (same niche, 1.5km radius)
 * 3. Returns business data + competitor comparison
 */

const SEARCH_KEYWORDS = ["hair salon", "barber", "hairdresser"];

async function getPlaceDetails(placeId, apiKey) {
  const url =
    `https://maps.googleapis.com/maps/api/place/details/json` +
    `?place_id=${encodeURIComponent(placeId)}&fields=reviews,website&reviews_sort=newest&key=${apiKey}`;

  const r = await fetch(url);
  const data = await r.json();
  if (data.status !== "OK") return { last_review_days: null, velocity: "unknown", website: null };

  const result  = data.result || {};
  const website = result.website || null;
  const reviews = (result.reviews || []).sort((a, b) => b.time - a.time);

  if (!reviews.length) return { last_review_days: null, velocity: "unknown", website };

  const now = Math.floor(Date.now() / 1000);
  const last_review_days = Math.floor((now - reviews[0].time) / 86400);

  let velocity = "unknown";
  if (reviews.length >= 3) {
    const spanDays = (reviews[0].time - reviews[reviews.length - 1].time) / 86400;
    const avgDays  = spanDays / (reviews.length - 1);
    velocity = avgDays < 7 ? "fast" : avgDays < 30 ? "medium" : "slow";
  }

  return { last_review_days, velocity, website };
}

const HAIR_TYPES = new Set(["hair_care", "hair_salon", "barber_shop"]);

function isHairBusiness(place) {
  return (place.types || []).some((t) => HAIR_TYPES.has(t));
}

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
      if (!isHairBusiness(place)) continue;   // skip spas, nail bars, etc.
      if (place.user_ratings_total < 10) continue; // skip near-empty profiles
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

  // Sort by review count desc (most established first), take top 5
  return results
    .sort((a, b) => b.reviews - a.reviews || b.rating - a.rating)
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

    // Step 2a — place details (review activity + website), runs parallel with competitor fetch
    const detailsPromise = getPlaceDetails(place.place_id, apiKey);

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

    const { last_review_days, velocity, website } = await detailsPromise;
    business.last_review_days = last_review_days;
    business.review_velocity  = velocity;
    business.website          = website;

    return res.status(200).json({ business, competitors });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
