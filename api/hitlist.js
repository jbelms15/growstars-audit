/**
 * Step 1: Hit List Engine
 *
 * Generates a filtered list of local business leads from Google Places API
 * based on a provided ICP (Ideal Customer Profile).
 *
 * POST /api/hitlist
 * Body: { city, icp, limit }
 */

const CHAIN_BLACKLIST = [
  "mcdonald",
  "starbucks",
  "subway",
  "costa coffee",
  "greggs",
  "pret a manger",
  "kfc",
  "burger king",
  "pizza hut",
  "domino",
  "nando",
  "wagamama",
  "five guys",
  "leon",
  "yo! sushi",
  "itsu",
  "tesco",
  "sainsbury",
  "boots",
  "supercuts",
  "great clips",
  "fantastic sams",
  "sport clips",
  "regis salon",
  "hair cuttery",
];

function isChain(name) {
  const lower = name.toLowerCase();
  return CHAIN_BLACKLIST.some((keyword) => lower.includes(keyword));
}

const MAX_PAGES = 3;

async function fetchPage(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  if (data.status !== "OK" && data.status !== "ZERO_RESULTS") return null;
  return data;
}

async function searchPlaces(query, apiKey) {
  const results = [];
  const baseUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json`;

  let url = `${baseUrl}?query=${encodeURIComponent(query)}&key=${apiKey}`;

  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await fetchPage(url);
    if (!data) break;

    results.push(...(data.results || []));

    if (!data.next_page_token) break;

    // Google requires ~2s delay before next_page_token becomes valid
    await new Promise((r) => setTimeout(r, 2000));
    url = `${baseUrl}?pagetoken=${encodeURIComponent(data.next_page_token)}&key=${apiKey}`;
  }

  return results;
}

// Only fetches phone + website — all other fields come from Text Search
async function getPlaceDetails(placeId, apiKey) {
  const fields = ["international_phone_number", "website"].join(",");
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=${fields}&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) return {};
  const data = await res.json();
  if (data.status !== "OK") return {};
  return data.result || {};
}

// Pre-filter using Text Search data (no extra API calls needed)
function meetsICP(place, icp) {
  const { rating, user_ratings_total, business_status } = place;

  if (rating === undefined || rating === null) return false;
  if (user_ratings_total === undefined || user_ratings_total === null) return false;

  if (rating < 4.0 || rating > 4.6) return false;
  if (user_ratings_total < icp.min_reviews) return false;
  if (user_ratings_total > icp.max_reviews) return false;
  // business_status may be absent from Text Search — treat missing as OPERATIONAL
  if (business_status && business_status !== "OPERATIONAL") return false;
  if (isChain(place.name)) return false;

  return true;
}

function formatLead(place) {
  return {
    id: place.place_id,
    name: place.name,
    rating: place.rating,
    review_count: place.user_ratings_total,
    phone: place.international_phone_number || "",
    website: place.website || "",
    address: place.formatted_address || "",
    place_id: place.place_id,
    maps_link: `https://www.google.com/maps/place/?q=place_id:${place.place_id}`,
  };
}

async function generateHitList({ city, icp, limit }) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_PLACES_API_KEY is not set");

  // Collect raw candidates from all search queries
  const seenIds = new Set();
  const candidates = [];

  for (const query of icp.search_queries) {
    const fullQuery = `${query} in ${city}`;
    const results = await searchPlaces(fullQuery, apiKey);

    for (const place of results) {
      if (seenIds.has(place.place_id)) continue;
      seenIds.add(place.place_id);
      candidates.push(place);
    }
  }

  // Pre-filter using Text Search data (fast, no extra API calls)
  const passing = candidates.filter((c) => meetsICP(c, icp)).slice(0, limit);

  // Fetch phone + website only for the filtered set (parallel)
  const leads = await Promise.all(
    passing.map(async (candidate) => {
      const details = await getPlaceDetails(candidate.place_id, apiKey);
      return formatLead({ ...candidate, ...details });
    })
  );

  return leads;
}

// Vercel serverless handler
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { city, icp, limit = 20 } = req.body;

  if (!city || typeof city !== "string") {
    return res.status(400).json({ error: "city is required and must be a string" });
  }
  if (!icp || !Array.isArray(icp.search_queries) || icp.search_queries.length === 0) {
    return res.status(400).json({ error: "icp must include a non-empty search_queries array" });
  }
  if (typeof icp.min_reviews !== "number" || typeof icp.max_reviews !== "number") {
    return res.status(400).json({ error: "icp must include numeric min_reviews and max_reviews" });
  }

  try {
    const hits = await generateHitList({ city, icp, limit: Number(limit) });
    return res.status(200).json({ hits, count: hits.length });
  } catch (err) {
    console.error("[hitlist]", err.message);
    return res.status(500).json({ error: err.message });
  }
}
