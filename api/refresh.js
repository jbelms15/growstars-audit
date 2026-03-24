/**
 * POST /api/refresh
 * Body: { place_id }
 *
 * Fetches live data from Google Places for a specific business.
 * Returns fresh rating, review count, velocity, and days since last review.
 * Called on-demand before outreach — not at scrape time.
 */

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
    const url =
      `https://maps.googleapis.com/maps/api/place/details/json` +
      `?place_id=${encodeURIComponent(place_id)}` +
      `&fields=rating,user_ratings_total,reviews` +
      `&reviews_sort=newest&key=${apiKey}`;

    const r    = await fetch(url);
    const data = await r.json();

    if (data.status !== "OK") {
      return res.status(200).json({ error: data.status });
    }

    const result  = data.result || {};
    const reviews = (result.reviews || []).sort((a, b) => b.time - a.time);
    const now     = Math.floor(Date.now() / 1000);

    const last_review_days = reviews.length
      ? Math.floor((now - reviews[0].time) / 86400)
      : null;

    let velocity = null;
    if (reviews.length >= 3) {
      const spanDays = (reviews[0].time - reviews[reviews.length - 1].time) / 86400;
      const avgDays  = spanDays / (reviews.length - 1);
      velocity = avgDays < 7 ? "fast" : avgDays < 30 ? "medium" : "slow";
    }

    // Negative sentiment — 1–2 star reviews in the sample (up to 5 from Places API)
    const negReviews = reviews.filter(r => r.rating <= 2);
    const neg_count  = negReviews.length;
    const neg_snippet = neg_count && negReviews[0].text
      ? negReviews[0].text.slice(0, 160)
      : null;

    // Responds to reviews — count of reviews with an owner reply in the sample
    const responds_count = reviews.filter(r => !!(r.author_reply?.text)).length;
    const responds_total = reviews.length;

    return res.status(200).json({
      rating:           result.rating             ?? null,
      reviews:          result.user_ratings_total ?? null,
      last_review_days,
      velocity,
      neg_count,
      neg_snippet,
      responds_count,
      responds_total,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
