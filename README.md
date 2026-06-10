# Donation Bridge — Saweria / SociaBuzz ke Roblox

Bridge ini menerima webhook dari platform donasi dan menyediakan
endpoint polling untuk server Roblox.

---

## Struktur File

```
donation-bridge/
├── api/
│   └── index.js     ← kode utama bridge (Express + Redis)
├── package.json
├── vercel.json      ← konfigurasi deploy Vercel
└── README.md
```

---

## Cara Deploy ke Vercel

### 1. Buat database Redis di Upstash
- Buka https://console.upstash.com → buat akun gratis
- Buat database baru → region: Asia Pacific (Singapore)
- Salin nilai UPSTASH_REDIS_REST_URL dan UPSTASH_REDIS_REST_TOKEN

### 2. Upload ke GitHub
- Buat repo baru di github.com
- Upload semua file ini ke repo tersebut
  (pastikan file api/index.js ada di dalam folder api/)

### 3. Deploy ke Vercel
- Buka https://vercel.com → Sign up with GitHub
- "Add New" → "Project" → pilih repo ini → "Import"
- Di bagian Environment Variables, tambahkan:
  - UPSTASH_REDIS_REST_URL   = (dari Upstash)
  - UPSTASH_REDIS_REST_TOKEN = (dari Upstash)
- Klik "Deploy"

### 4. Verifikasi
Buka URL Vercel kamu di browser. Harus tampil:
```json
{"ok":true,"status":"Donation Bridge running"}
```

---

## Setup Webhook di Platform Donasi

Ganti `nama-project` dengan nama project Vercel kamu:

| Platform   | URL Webhook                                            |
|------------|--------------------------------------------------------|
| Saweria    | https://nama-project.vercel.app/api/webhook/saweria    |
| SociaBuzz  | https://nama-project.vercel.app/api/webhook/sociabuzz  |
| BagiBagi   | https://nama-project.vercel.app/api/webhook/bagibagi   |
| Tako       | https://nama-project.vercel.app/api/webhook/tako       |

---

## Setup Roblox

Di `DonationConfig` (ReplicatedStorage → Shared → DonationConfig):

```lua
DonationConfig.bridgeUrl = "https://nama-project.vercel.app"
```

Pastikan HTTP Requests diaktifkan:
Roblox Studio → File → Game Settings → Security → Allow HTTP Requests ✓

---

## Endpoint API

| Method | Path                          | Keterangan                          |
|--------|-------------------------------|-------------------------------------|
| GET    | /                             | Health check                        |
| POST   | /api/webhook/:platform        | Terima webhook dari platform donasi |
| GET    | /api/donations?after=<ts>     | Roblox ambil donasi baru            |
| GET    | /api/tail                     | Roblox ambil timestamp terakhir     |
