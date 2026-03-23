/**
 * Step 1: Hit List Engine
 *
 * Generates a filtered list of local business leads from Google Places API
 * based on a provided ICP (Ideal Customer Profile).
 *
 * POST /api/hitlist
 * Body: { city, limit }
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

// Post-scrape ICP filter — applied after full dataset is built
function meetsICP(place) {
  const { rating, user_ratings_total, business_status } = place;

  if (rating === undefined || rating === null) return false;
  if (user_ratings_total === undefined || user_ratings_total === null) return false;

  if (rating < 3.8 || rating > 4.7) return false;
  if (user_ratings_total < 20) return false;
  // business_status may be absent from Text Search — treat missing as OPERATIONAL
  if (business_status && business_status !== "OPERATIONAL") return false;
  if (isChain(place.name)) return false;

  return true;
}

// Channel classification based on phone number format
function getContactType(phone) {
  if (!phone) return null;
  const clean = phone.replace(/\D/g, "");
  if (clean.startsWith("447") || clean.startsWith("07")) return "whatsapp";
  return "call";
}

// Step 1.6 — Message Layer
function generateMessages(name, observation) {
  const obs = observation.charAt(0).toLowerCase() + observation.slice(1);
  return {
    whatsapp_message: `Hey — came across ${name} and noticed ${obs}\n\nWe help salons fix this exact issue and boost bookings.\n\nHappy to show you what this could look like.`,
    loom_hook: `I was looking at ${name} and noticed ${obs}\n\nQuick idea on how you could improve this — recorded a short video for you.`,
  };
}

// Step 1.5 — Observation Layer
function generateObservation(rating, reviews) {
  if (reviews >= 80 && rating <= 4.4) {
    return `You've already got strong review volume (${reviews}), but your rating sits at ${rating} — there's clear room to push this higher.`;
  } else if (reviews <= 60 && rating >= 4.3) {
    return `Your rating is solid (${rating}), but with only ${reviews} reviews you're likely losing trust vs nearby competitors.`;
  } else {
    return `You're in a strong middle position (${rating} rating from ${reviews} reviews), but not yet standing out in your area.`;
  }
}

function formatLead(place) {
  const phone = place.international_phone_number || "";
  return {
    id:           place.place_id,
    place_id:     place.place_id,
    name:         place.name,
    rating:       place.rating,
    reviews:      place.user_ratings_total,
    phone,
    website:      place.website || "",
    address:      place.formatted_address || "",
    city:         place._city || "",
    maps_link:    `https://www.google.com/maps/place/?q=place_id:${place.place_id}`,
    contact_type: getContactType(phone),
  };
}

// Area suffixes — each generates an independent search to maximise coverage
const SEARCH_QUERIES = ["hair salon", "barber shop", "hairdresser"];
const AREA_PREFIXES  = ["", "North ", "South ", "East ", "West "];

async function generateHitList({ city, limit }) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_PLACES_API_KEY is not set");

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Collect raw candidates across all areas × queries — no pre-filtering
  const seenIds  = new Set();
  const candidates = [];

  for (const prefix of AREA_PREFIXES) {
    const area = `${prefix}${city}`;
    for (const query of SEARCH_QUERIES) {
      const fullQuery = `${query} in ${area}`;
      const results   = await searchPlaces(fullQuery, apiKey);

      for (const place of results) {
        if (seenIds.has(place.place_id)) continue;
        seenIds.add(place.place_id);
        candidates.push({ ...place, _query: query, _city: city });
      }
    }
  }

  // Step 1.2 — Raw Data Pool: store all scraped businesses before filtering
  if (SUPABASE_URL && SUPABASE_KEY) {
    const rawBusinesses = candidates.map((p) => ({
      place_id: p.place_id,
      name: p.name,
      rating: p.rating ?? null,
      reviews: p.user_ratings_total || 0,
      address: p.formatted_address || p.vicinity || "",
      types: p.types || [],
      lat: p.geometry?.location?.lat || null,
      lng: p.geometry?.location?.lng || null,
      city,
      query: p._query || "",
    }));

    try {
      await fetch(
        `${SUPABASE_URL}/rest/v1/raw_businesses?on_conflict=place_id,city`,
        {
          method: "POST",
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            "Content-Type": "application/json",
            Prefer: "resolution=merge-duplicates",
          },
          body: JSON.stringify(rawBusinesses),
        }
      );
    } catch (err) {
      console.error("[hitlist] raw upsert failed:", err.message);
    }
  }

  // Post-scrape filter — applied after full dataset is built
  const passing = candidates.filter((c) => meetsICP(c)).slice(0, limit);

  // Fetch phone + website only for the filtered set (parallel)
  const enriched = await Promise.all(
    passing.map(async (candidate) => {
      const details = await getPlaceDetails(candidate.place_id, apiKey);
      return formatLead({ ...candidate, ...details });
    })
  );

  // Exclude leads with no phone number
  const leads = enriched.filter((l) => l.phone);

  // Attach observation + messages
  for (const lead of leads) {
    lead.observation = generateObservation(lead.rating, lead.reviews);
    Object.assign(lead, generateMessages(lead.name, lead.observation));
  }

  // Step 1.7 — Upsert enriched leads to Supabase leads table
  if (SUPABASE_URL && SUPABASE_KEY && leads.length > 0) {
    const rows = leads.map((l) => ({
      place_id:  l.place_id,
      city,
      name:      l.name,
      rating:    l.rating,
      reviews:   l.reviews,
      phone:     l.phone || "",
      website:   l.website || "",
      address:   l.address || "",
      maps_link: l.maps_link || "",
    }));

    try {
      await fetch(`${SUPABASE_URL}/rest/v1/leads?on_conflict=place_id,city`, {
        method: "POST",
        headers: {
          apikey:         SUPABASE_KEY,
          Authorization:  `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
          Prefer:         "resolution=merge-duplicates",
        },
        body: JSON.stringify(rows),
      });
    } catch (err) {
      console.error("[hitlist] leads upsert failed:", err.message);
    }
  }

  return leads;
}

// Vercel serverless handler
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { city, limit = 20 } = req.body;

  if (!city || typeof city !== "string") {
    return res.status(400).json({ error: "city is required and must be a string" });
  }

  try {
    const hits = await generateHitList({ city, limit: Number(limit) });
    return res.status(200).json({ hits, count: hits.length });
  } catch (err) {
    console.error("[hitlist]", err.message);
    return res.status(500).json({ error: err.message });
  }
}
