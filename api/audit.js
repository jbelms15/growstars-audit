const SYSTEM_PROMPT = `You are helping generate outputs for a Google Business Profile audit tool used for outbound prospecting.

This is a conversion tool designed to start conversations with business owners, create awareness of a problem, lead them to watch a Loom video, and get them to book a call.

Flow: WhatsApp message to spark curiosity -> Loom video if interested -> Sales call using slides.

DO NOT over-explain, sound like a report, use SEO jargon, or teach deeply.
DO be concise, specific, focus on competitor comparison, focus on customer choice, use simple language.

CORE PRINCIPLES:
1. SIMPLICITY - explain so any owner understands instantly
2. COMPARISON - always anchor insights against competitors
3. OUTCOME - focus on customers, visibility, lost opportunities
4. CURIOSITY - leave gaps so they want to learn more

LANGUAGE: Do NOT use: SEO, algorithm, review velocity, ranking factors
Say instead: customers choosing competitors, Google tends to favor, consistently getting reviews
Tone: direct, simple, slightly conversational, not corporate

OUTPUT REQUIREMENTS:
1. insight_summary (1-2 sentences): main gap vs competitors, impact on visibility or customer choice
2. whatsapp_message (2-3 lines): curiosity-driven, do NOT explain everything
3. loom_script (2-3 min structure): step-by-step, focus on showing not explaining
4. slides (array): each object has id, type (cover/comparison/gap/impact/cost/opportunity/cta/how_it_works), title, bullets[] or content
   Required order: cover, comparison, gap, impact, cost, opportunity, cta, how_it_works

Goal: make owner realize the problem, want to fix it, move to a call. Optimize for clarity, simplicity, and persuasion.`;

const GENERIC_TYPES = new Set([
  'point_of_interest', 'establishment', 'food', 'store', 'health', 'finance',
  'local_government_office', 'political', 'geocode', 'premise',
]);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action, query, place_id, id } = req.query;
  const API_KEY = process.env.GOOGLE_PLACES_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

  // Supabase REST helper — uses service role key to bypass RLS
  const sbFetch = async (method, path, body) => {
    const headers = {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    };
    if (method === 'POST' || method === 'PATCH') headers['Prefer'] = 'return=representation';
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


    // AI analysis: fetch competitors + Claude-generated outputs
    if (action === 'analyze') {
      if (!API_KEY) return res.status(500).json({ error: 'Google API key not configured' });
      if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'Anthropic API key not configured' });
      if (!place_id) return res.status(400).json({ error: 'place_id is required' });

      const { audit_scores = {}, biz = {} } = req.body || {};

      // 1. Fetch place details to get types + geometry
      const detailsUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place_id}&fields=name,formatted_address,rating,user_ratings_total,types,geometry&key=${API_KEY}`;
      const detailsRes = await fetch(detailsUrl);
      const detailsData = await detailsRes.json();
      const bizDetail = detailsData.result;
      if (!bizDetail) return res.status(400).json({ error: 'Business not found' });

      // 2. Pick primary type (skip generic ones)
      const primaryType = bizDetail.types?.find(t => !GENERIC_TYPES.has(t)) || 'business';
      const location = bizDetail.geometry?.location;

      // 3. Fetch top 3 competitors via Nearby Search
      let competitors = [];
      if (location) {
        const compUrl = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${location.lat},${location.lng}&radius=5000&type=${encodeURIComponent(primaryType)}&key=${API_KEY}`;
        const compRes = await fetch(compUrl);
        const compData = await compRes.json();
        competitors = (compData.results || [])
          .filter(p => p.place_id !== place_id && (p.user_ratings_total || 0) > 0)
          .slice(0, 3)
          .map(p => ({
            name: p.name,
            rating: p.rating || 0,
            review_count: p.user_ratings_total || 0,
            address: p.vicinity || '',
          }));
      }

      // 4. Calculate dominance_ratio and gap_level
      const bizReviews = bizDetail.user_ratings_total || 0;
      const bizRating = bizDetail.rating || 0;
      const avgCompReviews = competitors.length > 0
        ? competitors.reduce((a, c) => a + c.review_count, 0) / competitors.length
        : bizReviews || 1;
      const dominanceRatio = +(bizReviews / avgCompReviews).toFixed(2);

      let gapLevel;
      if (dominanceRatio >= 1.2)      gapLevel = 'leading';
      else if (dominanceRatio >= 0.8) gapLevel = 'competitive';
      else if (dominanceRatio >= 0.5) gapLevel = 'behind';
      else                            gapLevel = 'significantly_behind';

      // 5. Build structured input for Claude
      const input = {
        business: { name: bizDetail.name, address: bizDetail.formatted_address, rating: bizRating, review_count: bizReviews, ...biz },
        competitors, audit_scores,
        dominance_ratio: dominanceRatio,
        gap_level: gapLevel,
      };

      // 6. Call Claude API
      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-opus-4-6',
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: `Analyze this Google Business Profile audit data and generate the outbound prospecting outputs.

Return ONLY a valid JSON object (no markdown, no explanation) with exactly these keys: insight_summary, whatsapp_message, loom_script, slides.

Data:
${JSON.stringify(input, null, 2)}` }],
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
        insight_summary: outputs.insight_summary,
        whatsapp_message: outputs.whatsapp_message,
        loom_script: outputs.loom_script,
        slides: outputs.slides,
        competitors,
        dominance_ratio: dominanceRatio,
        gap_level: gapLevel,
      });
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
