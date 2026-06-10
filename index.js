const express = require("express");
const { Redis } = require("@upstash/redis");

const app = express();
app.use(express.json());

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const DONATION_KEY = "donations";
const MAX_AGE_MS   = 24 * 60 * 60 * 1000;

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

function normalizeDonation(platform, body) {
  const now = Date.now();
  console.log(`[normalize/${platform}] raw body:`, JSON.stringify(body));

  if (platform === "saweria") {
    const d = (body.data && typeof body.data === "object") ? body.data : body;
    const amount = Number(d.amount || d.donation_amount || 0);
    if (amount <= 0) return null;
    return {
      id:        String(now),
      source:    "saweria",
      donorName: String(d.donator_name || d.name || "Anonymous"),
      amount,
      currency:  "IDR",
      message:   String(d.donator_msg || d.message || ""),
    };
  }

  if (platform === "sociabuzz") {
    const amount = Number(body.amount || body.value || 0);
    if (amount <= 0) return null;
    return {
      id:        String(now),
      source:    "sociabuzz",
      donorName: String(body.from || body.username || body.name || "Anonymous"),
      amount,
      currency:  "IDR",
      message:   String(body.message || body.note || ""),
    };
  }

  if (platform === "bagibagi") {
    const amount = Number(body.amount || body.nominal || 0);
    if (amount <= 0) return null;
    return {
      id:        String(now),
      source:    "bagibagi",
      donorName: String(body.sender || body.name || body.username || "Anonymous"),
      amount,
      currency:  "IDR",
      message:   String(body.message || body.note || ""),
    };
  }

  if (platform === "tako") {
    const amount = Number(body.amount || body.total || 0);
    if (amount <= 0) return null;
    return {
      id:        String(now),
      source:    "tako",
      donorName: String(body.username || body.display_name || body.name || "Anonymous"),
      amount,
      currency:  "IDR",
      message:   String(body.message || body.comment || ""),
    };
  }

  return null;
}

app.post("/api/webhook/:platform", async (req, res) => {
  const { platform } = req.params;
  const allowed = ["saweria", "sociabuzz", "bagibagi", "tako"];

  if (!allowed.includes(platform)) {
    return res.status(400).json({ ok: false, reason: "Unknown platform: " + platform });
  }

  const donation = normalizeDonation(platform, req.body);
  if (!donation) {
    return res.json({ ok: false, reason: "Invalid or zero-amount donation" });
  }

  try {
    const score = Date.now();
    donation.id = String(score);
    await redis.zadd(DONATION_KEY, { score, member: JSON.stringify(donation) });
    const cutoff = score - MAX_AGE_MS;
    await redis.zremrangebyscore(DONATION_KEY, "-inf", cutoff);
    console.log(`[webhook/${platform}] SAVED: ${donation.donorName} Rp${donation.amount} id=${score}`);
    return res.json({ ok: true, id: String(score) });
  } catch (err) {
    console.error("[webhook] Redis error:", err.message);
    return res.status(500).json({ ok: false, reason: "Redis error: " + err.message });
  }
});

app.get("/api/donations", async (req, res) => {
  const afterScore = Number(req.query.after || 0);
  console.log("[donations] polling, after =", afterScore);

  try {
    const raw = await redis.zrange(DONATION_KEY, afterScore + 1, "+inf", {
      byScore: true,
    });

    console.log("[donations] raw count:", raw.length);

    const items = [];
    let latestScore = afterScore;

    for (const entry of raw) {
      try {
        const parsed = typeof entry === "string" ? JSON.parse(entry) : entry;
        const entryScore = Number(parsed.id || 0);
        if (entryScore > latestScore) latestScore = entryScore;
        items.push(parsed);
      } catch (e) {
        console.log("[donations] parse error:", e.message);
      }
    }

    console.log("[donations] returning", items.length, "items, latestId =", latestScore);
    return res.json({ ok: true, items, latestId: String(latestScore) });
  } catch (err) {
    console.error("[donations] Redis error:", err.message);
    return res.status(500).json({ ok: false, reason: "Redis error: " + err.message });
  }
});

app.get("/api/tail", async (req, res) => {
  try {
    const result = await redis.zrange(DONATION_KEY, -1, -1);
    if (result && result.length > 0) {
      try {
        const parsed = typeof result[0] === "string" ? JSON.parse(result[0]) : result[0];
        const id = String(parsed.id || Date.now());
        return res.json({ ok: true, id });
      } catch (e) {}
    }
    return res.json({ ok: true, id: String(Date.now()) });
  } catch (err) {
    return res.json({ ok: true, id: String(Date.now()) });
  }
});

app.get("/api/test-webhook", async (req, res) => {
  const score = Date.now();
  const donation = {
    id:        String(score),
    source:    "saweria",
    donorName: req.query.name || "TestDonor",
    amount:    Number(req.query.amount || 10000),
    currency:  "IDR",
    message:   req.query.msg || "Test donation dari bridge",
  };

  try {
    await redis.zadd(DONATION_KEY, { score, member: JSON.stringify(donation) });
    console.log("[test-webhook] inserted:", JSON.stringify(donation));
    return res.json({ ok: true, donation, tip: "Tunggu 4-7 detik, lalu cek Roblox" });
  } catch (err) {
    return res.status(500).json({ ok: false, reason: err.message });
  }
});

app.get("/api/debug", async (req, res) => {
  try {
    const all = await redis.zrange(DONATION_KEY, 0, -1);
    const count = await redis.zcard(DONATION_KEY);
    return res.json({
      ok: true,
      count,
      items: all,
      env: {
        hasRedisUrl:   !!process.env.UPSTASH_REDIS_REST_URL,
        hasRedisToken: !!process.env.UPSTASH_REDIS_REST_TOKEN,
      }
    });
  } catch (err) {
    return res.status(500).json({ ok: false, reason: err.message });
  }
});

app.get("/", (req, res) => {
  res.json({
    ok:      true,
    status:  "Donation Bridge running",
    version: "2.0.0",
    endpoints: {
      healthCheck: "GET  /",
      webhook:     "POST /api/webhook/saweria",
      polling:     "GET  /api/donations?after=<score>",
      tail:        "GET  /api/tail",
      testWebhook: "GET  /api/test-webhook?name=Budi&amount=50000",
      debug:       "GET  /api/debug",
    },
  });
});

module.exports = app;
