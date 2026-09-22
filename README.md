# Slugs 🐌

A real-time, slow-burn multiplayer path strategy game played in real space on smartphones.

## How the Game Works
- **Drop Start Pin:** Drop a pin at your current GPS location.
- **Drop End Pin:** Set your target destination to release your slug avatar.
- **Slow Crawl:** Your avatar crawls very slowly (default ~1 km/h) toward the destination.
- **Spoiler Mechanic:** When an attempt completes, the path remains active for 1 hour. If another player's moving avatar crosses an existing trail, their attempt is **voided** and they are **stunned** for 1 hour (cannot drop new pins).
- **Scoring:** Successful attempts score straight-line distance in meters.

---

## Zero-Cost Stack Setup

This project uses:
1. **GitHub Pages** for 100% free static hosting (zero overage risk).
2. **Supabase Free Tier** for PostgreSQL, Auth, and Realtime (no credit card required, zero overage risk).
3. **Leaflet.js + OpenStreetMap** for map rendering.

### Step 1: Create Free Supabase Backend
1. Sign up at [supabase.com](https://supabase.com) (free tier, no credit card required).
2. Create a new project (e.g., `slugs-game`).
3. In your Supabase Dashboard:
   - Go to **SQL Editor** &rarr; **New Query**.
   - Paste the contents of `sql/schema.sql` and click **Run**.
4. Go to **Authentication** &rarr; **Providers** &rarr; **Email**:
   - Turn off **Confirm email** (so players can start testing immediately without verifying email).
5. Go to **Project Settings** &rarr; **API**:
   - Copy your **Project URL** and public **`anon` key**.

### Step 2: Configure the App
Open `js/config.js` and paste your credentials:
```javascript
export const CONFIG = {
    SUPABASE_URL: 'https://your-project-ref.supabase.co',
    SUPABASE_ANON_KEY: 'your-anon-key-here',
    ...
};
```

### Step 3: Run Locally or Deploy

#### Local Testing
Because this uses ES modules, serve the folder with any local web server:
```bash
# Using Python
python -m http.server 8000

# Using Node (npx)
npx serve
```
Then open `http://localhost:8000` in your mobile browser or desktop browser (with mobile emulation enabled).

#### Deploy to GitHub Pages
1. Push this folder to a GitHub repository.
2. In GitHub repo settings, navigate to **Pages** &rarr; select `main` branch (root folder) &rarr; Save.
3. Your game is live at `https://<username>.github.io/<repo-name>/`.
