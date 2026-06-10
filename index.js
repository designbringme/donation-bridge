const express = require("express");
const { Redis } = require("@upstash/redis");

const app = express();
app.use(express.json());

// ── Redis client (env variables di-set di Vercel dashboard) ──────────────────
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const DONATION_KEY = "donations"; // key sorted set di Redis
const MAX_AGE_MS   = 24 * 60 * 60 * 1000; // hapus donasi > 24 jam

// ── Helper: normalisasi payload dari berbagai platform ────────────────────────
function normalizeDonation(platform, body) {
  const now = Date.now();

  if (platform === "saweria") {
    // Saweria mengirim data di dalam field "data"
    const d = body.data || body;
    const id = String(d.id || d._id || now);
    const amount = Number(d.amount || d.donation_amount || 0);
    if (amount <= 0) return null;
    return {
      id,
      source:    "saweria",
      donorName: String(d.donator_name || d.name || "Anonymous"),
      amount,
      currency:  "IDR",
      message:   String(d.donator_msg || d.message || ""),
    };
  }

  if (platform === "sociabuzz") {
    const id = String(body.trx_id || body.id || now);
    const amount = Number(body.amount || body.value || 0);
    if (amount <= 0) return null;
    return {
      id,
      source:    "sociabuzz",
      donorName: String(body.from || body.username || body.name || "Anonymous"),
      amount,
      currency:  "IDR",
      message:   String(body.message || body.note || ""),
    };
  }

  if (platform === "bagibagi") {
    const id = String(body.id || body.transaction_id || now);
    const amount = Number(body.amount || body.nominal || 0);
    if (amount <= 0) return null;
    return {
      id,
      source:    "bagibagi",
      donorName: String(body.sender || body.name || body.username || "Anonymous"),
      amount,
      currency:  "IDR",
      message:   String(body.message || body.note || ""),
    };
  }

  if (platform === "tako") {
    const id = String(body.id || body.order_id || now);
    const amount = Number(body.amount || body.total || 0);
    if (amount <= 0) return null;
    return {
      id,
      source:    "tako",
      donorName: String(body.username || body.display_name || body.name || "Anonymous"),
      amount,
      currency:  "IDR",
      message:   String(body.message || body.comment || ""),
    };
  }

  return null;
}

// ════════════════════════════════════════════════════════════════════════════
//  POST /api/webhook/:platform
//  Terima webhook dari Saweria / SociaBuzz / BagiBagi / Tako
// ════════════════════════════════════════════════════════════════════════════
app.post("/api/webhook/:platform", async (req, res) => {
  const { platform } = req.params;

  const allowedPlatforms = ["saweria", "sociabuzz", "bagibagi", "tako"];
  if (!allowedPlatforms.includes(platform)) {
    return res.status(400).json({ ok: false, reason: "Unknown platform: " + platform });
  }

  const donation = normalizeDonation(platform, req.body);
  if (!donation) {
    return res.status(400).json({ ok: false, reason: "Invalid or zero-amount donation" });
  }

  try {
    const score = Date.now();

    // Simpan ke Redis sorted set (score = timestamp untuk urutan)
    await redis.zadd(DONATION_KEY, { score, member: JSON.stringify(donation) });

    // Bersihkan donasi yang lebih dari 24 jam agar Redis tidak penuh
    const cutoff = Date.now() - MAX_AGE_MS;
    await redis.zremrangebyscore(DONATION_KEY, 0, cutoff);

    console.log(`[webhook/${platform}] ${donation.donorName} → Rp${donation.amount}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error("[webhook] Redis error:", err);
    return res.status(500).json({ ok: false, reason: "Internal server error" });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  GET /api/donations?after=<timestamp>
//  Roblox polling: ambil donasi baru setelah timestamp tertentu
// ════════════════════════════════════════════════════════════════════════════
app.get("/api/donations", async (req, res) => {
  const afterScore = Number(req.query.after || 0);

  try {
    // Ambil semua entry dengan score > afterScore
    const raw = await redis.zrangebyscore(
      DONATION_KEY,
      afterScore + 1,
      "+inf",
      { withScores: false }
    );

    const items = [];
    let latestScore = afterScore;

    for (const entry of raw) {
      try {
        const parsed = typeof entry === "string" ? JSON.parse(entry) : entry;
        // Ambil score untuk entry ini agar bisa jadi cursor
        const score = await redis.zscore(DONATION_KEY, typeof entry === "string" ? entry : JSON.stringify(entry));
        if (score) {
          parsed._score = score;
          if (Number(score) > latestScore) latestScore = Number(score);
        }
        items.push(parsed);
      } catch (_) {
        // Skip entry yang corrupt
      }
    }

    return res.json({
      ok:       true,
      items,
      latestId: String(latestScore),
    });
  } catch (err) {
    console.error("[donations] Redis error:", err);
    return res.status(500).json({ ok: false, reason: "Internal server error" });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  GET /api/tail
//  Roblox gunakan ini saat server pertama start, untuk dapat timestamp terbaru
//  sehingga donasi lama tidak diputar ulang
// ════════════════════════════════════════════════════════════════════════════
app.get("/api/tail", async (req, res) => {
  try {
    // Ambil 1 entry terakhir beserta score-nya
    const result = await redis.zrange(DONATION_KEY, -1, -1, { withScores: true });

    if (result && result.length >= 2) {
      // zrange withScores: [member, score, member, score, ...]
      const score = result[1];
      return res.json({ ok: true, id: String(score) });
    }

    // Jika Redis kosong, kembalikan timestamp sekarang
    return res.json({ ok: true, id: String(Date.now()) });
  } catch (err) {
    console.error("[tail] Redis error:", err);
    return res.json({ ok: true, id: String(Date.now()) });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  GET /
//  Health check — buka di browser untuk verifikasi bridge berjalan
// ════════════════════════════════════════════════════════════════════════════
app.get("/", (req, res) => {
  res.json({
    ok:      true,
    status:  "Donation Bridge running",
    version: "1.0.0",
    routes: {
      webhook:   "POST /api/webhook/:platform  (saweria|sociabuzz|bagibagi|tako)",
      donations: "GET  /api/donations?after=<timestamp>",
      tail:      "GET  /api/tail",
    },
  });
});

// Vercel mengekspor app sebagai module, bukan listen() langsung
module.exports = app;
