const SYSTEM_PROMPT = `You are generating slides for a sales-focused audit deck used in outbound prospecting.

IMPORTANT: These slides are NOT reports. They are designed to be understood in under 2 seconds, create immediate clarity, and support a Loom video and sales call.

STRICT RULES (MUST FOLLOW):

1. ONE IDEA PER SLIDE — never combine multiple ideas
2. NO PARAGRAPHS — maximum: 1 short main line + 1 short supporting line
3. SIMPLE LANGUAGE ONLY — no jargon (no "review velocity", "algorithm", "SEO")
4. VISUAL-FIRST — prefer numbers and short phrases over sentences

SLIDE FORMAT — return exactly this JSON structure:
{
  "insight_summary": "1-2 sentences max, highlight gap vs competitors, mention impact",
  "whatsapp_message": "2-3 lines, curiosity-driven, do not explain everything",
  "loom_script": ["bullet 1", "bullet 2", "bullet 3"],
  "slides": [
    { "title": "string", "main": "short punchy statement or numbers", "supporting": "optional 1-line clarification" }
  ]
}

REQUIRED SLIDES (exactly 7, in this order):
1. You vs Competitors — direct comparison, make it instantly clear who is ahead/behind
2. The Gap — quantify the difference (e.g. "3x fewer reviews than top competitor")
3. Impact — what this causes (visibility, customer choice)
4. Cost / Risk — what they are losing or risk losing
5. Opportunity — what happens if fixed
6. Call to Action — invite to next step
7. How It Works — simple flow: more reviews → more visibility → more customers

CRITICAL EXAMPLES:
BAD: "Frederick Dental Group is already dominating locally with 342 reviews vs competitors averaging just 44..."
GOOD: title: "You vs Competitors", main: "You: 342 reviews | Competitors: 44 avg", supporting: "You are currently ahead"

BAD: "If competitors accelerate their review velocity, your visibility lead could shrink..."
GOOD: title: "Risk", main: "Competitors are catching up", supporting: "Your lead could shrink over time"

TONE: direct, simple, slightly conversational, not corporate, not technical
Do NOT try to sound impressive. Do NOT explain everything. Do NOT combine ideas.`;

const GENERIC_TYPES = new Set([
  'point_of_interest', 'establishment', 'food', 'store', 'health', 'finance',
  'local_government_office', 'political', 'geocode', 'premise',
]);

const CATEGORY_MAP = {
  nail_salon:  { label: 'Nail Salon',    min: 20,  max: 50  },
  hair_salon:  { label: 'Hair Salon',    min: 40,  max: 80  },
  dentist:     { label: 'Dentist',       min: 80,  max: 250 },
  restaurant:  { label: 'Restaurant',   min: 20,  max: 60  },
  gym:         { label: 'Gym',           min: 30,  max: 70  },
  spa:         { label: 'Spa / Massage', min: 50,  max: 120 },
  generic:     { label: 'Business',      min: 30,  max: 80  },
};

function detectCategory(types) {
  if (!types || !types.length) return 'generic';
  const t = types.join(' ');
  if (/nail/.test(t)) return 'nail_salon';
  if (/hair|beauty|barber/.test(t)) return 'hair_salon';
  if (/dentist|dental/.test(t)) return 'dentist';
  if (/restaurant|meal_takeaway|meal_delivery|cafe|bakery/.test(t)) return 'restaurant';
  if (/gym|fitness/.test(t)) return 'gym';
  if (/spa|massage/.test(t)) return 'spa';
  return 'generic';
}

function calcScores(bizReviews, bizRating, avgCompReviews) {
  const safeComp = avgCompReviews > 0 ? avgCompReviews : 1;
  const safeBiz  = bizReviews > 0 ? bizReviews : 1;
  const dominanceRatio = +(safeComp / safeBiz).toFixed(2);

  let gapLevel;
  if (dominanceRatio >= 3)        gapLevel = 'high';
  else if (dominanceRatio >= 1.5) gapLevel = 'medium';
  else                            gapLevel = 'low';

  let mapPackScore = 100;
  if (dominanceRatio >= 3)        mapPackScore -= 40;
  else if (dominanceRatio >= 1.5) mapPackScore -= 25;
  else                            mapPackScore -= 10;
  if (bizRating < 4.0)      mapPackScore -= 30;
  else if (bizRating < 4.3) mapPackScore -= 15;
  if (bizReviews < 20)      mapPackScore -= 20;
  mapPackScore = Math.max(0, mapPackScore);

  const confidenceLevel = gapLevel === 'high' ? 'high' : gapLevel === 'medium' ? 'medium' : 'low';
  return { dominanceRatio, gapLevel, mapPackScore, confidenceLevel };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action, query, place_id, id } = req.query;
  const API_KEY       = process.env.GOOGLE_PLACES_API_KEY;
  const SUPABASE_URL  = process.env.SUPABASE_URL;
  const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

  const sbFetch = async (method, path, body) => {
    const headers = {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    };
    if (method === 'POST' || method === 'PATCH') headers['Prefer'] = 'return=representation';
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      method, headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    try { return JSON.parse(text); } catch { return { error: text }; }
  };

  try {
    // Search
    if (action === 'search' || (!action && query)) {
      if (!API_KEY) return res.status(500).json({ error: 'API key not configured' });
      const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(query)}&inputtype=textquery&fields=place_id,name,formatted_address&key=${API_KEY}`;
      return res.status(200).json(await (await fetch(url)).json());
    }

    // Details
    if (action === 'details' || (!action && place_id)) {
      if (!API_KEY) return res.status(500).json({ error: 'API key not configured' });
      const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place_id}&fields=name,formatted_address,rating,user_ratings_total,website,formatted_phone_number,types,geometry&key=${API_KEY}`;
      return res.status(200).json(await (await fetch(url)).json());
    }

    // Analyze
    if (action === 'analyze') {
      if (!API_KEY)       return res.status(500).json({ error: 'Google API key not configured' });
      if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'Anthropic API key not configured' });
      if (!place_id)      return res.status(400).json({ error: 'place_id is required' });

      const { biz = {} } = req.body || {};

      // 1. Fetch place details
      const detailsUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place_id}&fields=name,formatted_address,rating,user_ratings_total,types,geometry&key=${API_KEY}`;
      const detailsData = await (await fetch(detailsUrl)).json();
      const bizDetail = detailsData.result;
      if (!bizDetail) return res.status(400).json({ error: 'Business not found' });

      const primaryType = bizDetail.types?.find(t => !GENERIC_TYPES.has(t)) || 'business';
      const location    = bizDetail.geometry?.location;
      const category    = detectCategory(bizDetail.types);
      const catInfo     = CATEGORY_MAP[category];

      // 2. Fetch competitors
      let competitors = [];
      if (location) {
        const compUrl = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${location.lat},${location.lng}&radius=5000&type=${encodeURIComponent(primaryType)}&key=${API_KEY}`;
        const compData = await (await fetch(compUrl)).json();
        competitors = (compData.results || [])
          .filter(p => p.place_id !== place_id && (p.user_ratings_total || 0) > 0)
          .slice(0, 3)
          .map(p => ({ name: p.name, rating: p.rating || 0, review_count: p.user_ratings_total || 0, address: p.vicinity || '' }));
      }

      // 3. Scores
      const bizReviews     = bizDetail.user_ratings_total || 0;
      const bizRating      = bizDetail.rating || 0;
      const avgCompReviews = competitors.length > 0
        ? competitors.reduce((a, c) => a + c.review_count, 0) / competitors.length
        : bizReviews || 1;

      const { dominanceRatio, gapLevel, mapPackScore, confidenceLevel } = calcScores(bizReviews, bizRating, avgCompReviews);
      const revenueRange = `€${catInfo.min}–€${catInfo.max}`;

      // 4. Claude input
      const input = {
        business: { name: bizDetail.name, address: bizDetail.formatted_address, rating: bizRating, review_count: bizReviews, category: catInfo.label, revenue_per_customer: revenueRange, ...biz },
        competitors,
        dominance_ratio: dominanceRatio,
        gap_level: gapLevel,
        map_pack_score: mapPackScore,
        avg_competitor_reviews: +avgCompReviews.toFixed(0),
      };

      // 5. Claude
      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-opus-4-6',
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: `Generate the audit deck for this business.\n\nData:\n${JSON.stringify(input, null, 2)}` }],
        }),
      });

      const claudeData = await claudeRes.json();
      if (claudeData.error) return res.status(500).json({ error: claudeData.error.message });

      const rawText = claudeData.content?.[0]?.text || '';
      let outputs;
      try {
        const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
        outputs = JSON.parse(cleaned);
      } catch {
        return res.status(500).json({ error: 'Failed to parse Claude response', raw: rawText });
      }

      return res.status(200).json({
        insight_summary:       outputs.insight_summary,
        whatsapp_message:      outputs.whatsapp_message,
        loom_script:           outputs.loom_script,
        slides:                outputs.slides,
        competitors,
        dominance_ratio:       dominanceRatio,
        gap_level:             gapLevel,
        map_pack_score:        mapPackScore,
        confidence_level:      confidenceLevel,
        revenue_range:         revenueRange,
        avg_competitor_reviews: +avgCompReviews.toFixed(0),
        biz_reviews:           bizReviews,
        biz_rating:            bizRating,
        category:              catInfo.label,
      });
    }

    // Save prospect
    if (action === 'save') {
      if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
      const data = await sbFetch('POST', 'Prospects', req.body);
      if (Array.isArray(data) && data.length) return res.status(200).json(data[0]);
      if (data && !data.error) return res.status(200).json(data);
      return res.status(400).json(data || { error: 'Save failed' });
    }

    // List prospects
    if (action === 'prospects') {
      if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
      const data = await sbFetch('GET', 'Prospects?select=*&order=created_at.desc');
      return res.status(200).json(Array.isArray(data) ? data : []);
    }

    // Update prospect
    if (action === 'update') {
      if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });
      const data = await sbFetch('PATCH', `Prospects?id=eq.${encodeURIComponent(id)}`, req.body);
      return res.status(200).json(data);
    }

    // Delete prospect
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
