# Adopt User Lookup — LTI 1.3

A Blackboard Learn LTI 1.3 tool that lets admins look up Blackboard UUIDs and manage Pendo/Adopt segments. Runs on Render with **no database required**.

## Features

- UUID → Username lookup
- Batch email → UUID lookup (CSV upload, multi-account disambiguation)
- Adopt segment creation — push resolved UUIDs as a new Pendo segment
- Adopt segment update — append UUIDs to an existing segment
- Adopt segment browser — view members with BB username enrichment

---

## How it works (no DB)

LTI 1.3 normally needs a database to store platform registrations and nonces. This app avoids that by:

- **Platform config** stored entirely in environment variables
- **Nonces** kept in an in-memory Map with a 10-minute TTL (sufficient for a single Render instance)
- **Sessions** stored in a signed server-side cookie (no external store)
- **RSA keypair** generated fresh on each startup — Blackboard fetches the current public key from `/keys` on every launch, so this is fine

> ⚠️ If you scale to multiple instances (Render paid plan), nonces won't be shared across instances. For multi-instance deployments, add Redis for the nonce store. For a single instance this is production-safe.

---

## Deploy to Render

### 1. Push to GitHub

```bash
git init && git add . && git commit -m "init"
gh repo create adopt-user-lookup-lti --public --push
```

### 2. Create a Render Web Service

1. Go to [render.com](https://render.com) → **New → Web Service**
2. Connect your GitHub repo
3. Settings:
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node src/server.js`
4. Deploy — note your public URL, e.g. `https://adopt-user-lookup.onrender.com`

> Render free tier spins down after 15 min of inactivity — the first launch after spin-down will be slow. Use the $7/mo Starter plan for always-on.

### 3. Set environment variables in Render

Go to your service → **Environment** tab and add:

| Key | Value |
|---|---|
| `SESSION_SECRET` | Output of `openssl rand -hex 32` |
| `APP_URL` | `https://your-app.onrender.com` |
| `BB_PLATFORM_ISSUER` | Your BB URL e.g. `https://learn.myschool.edu` |
| `BB_LTI_CLIENT_ID` | *(fill in after step 4)* |
| `BB_LTI_AUTH_URL` | *(fill in after step 4)* |
| `BB_LTI_JWKS_URL` | *(fill in after step 4)* |
| `BB_CLIENT_ID` | From BB REST API integration (step 5) |
| `BB_CLIENT_SECRET` | From BB REST API integration (step 5) |
| `ADOPT_HOST` | `https://app.pendo.io` |
| `NODE_ENV` | `production` |

---

## Blackboard Setup

### 4. Register the LTI 1.3 Tool in Blackboard

1. In Blackboard Admin → **LTI Tool Providers → Register LTI 1.3 Tool**
2. Enter these URLs (replace `your-app.onrender.com`):

| Field | Value |
|---|---|
| Tool Launch URL | `https://your-app.onrender.com/lti` |
| OIDC Login Initiation URL | `https://your-app.onrender.com/lti` |
| Public JWK URL | `https://your-app.onrender.com/keys` |
| Redirect URL(s) | `https://your-app.onrender.com/lti/launch` |

3. Submit — Blackboard generates a **Client ID** (a long string)
4. Go to the tool's detail page — note:
   - **Client ID**
   - **Authorization URL** (ends in `/authorizations`)
   - **JWKS URL** (ends in `/jwks`)

5. Back in Render, fill in the three env vars you left blank:

```
BB_LTI_CLIENT_ID   = <the Client ID from BB>
BB_LTI_AUTH_URL    = <the Authorization URL from BB>
BB_LTI_JWKS_URL    = <the JWKS URL from BB>
```

6. Trigger a redeploy in Render (env var changes don't auto-redeploy)

### 5. Create a Blackboard REST API Integration

1. Admin → **REST API Integrations → Create Integration**
2. Set a name, note the **Application ID / Client ID** and **Secret**
3. Set the **End User** to an admin account
4. Add `BB_CLIENT_ID` and `BB_CLIENT_SECRET` in Render

### 6. Create a Placement in Blackboard

1. In the LTI tool settings → **Manage Placements → Create Placement**
2. Recommended settings:
   - **Label**: Adopt User Lookup
   - **Type**: System Tool
   - **Launch in New Window**: ✓
3. The tool appears under **Admin → Tools** (or wherever System Tools show in your BB theme)

---

## URL Reference

| Path | Purpose |
|---|---|
| `GET /lti` | OIDC login initiation (Blackboard calls this first) |
| `POST /lti` | Also accepts POST form of login initiation |
| `POST /lti/launch` | OIDC callback — verifies JWT, creates session |
| `GET /keys` | JWKS endpoint — Blackboard fetches your public key here |
| `GET /app` | App UI (requires valid LTI session) |
| `GET /health` | Health check, no auth |
| `GET /api/bb/user` | Search BB user by email |
| `GET /api/bb/user/uuid/:uuid` | Look up BB user by UUID |
| `GET /api/adopt/segments` | List Pendo segments |
| `POST /api/adopt/segments/members` | Get segment members |
| `POST /api/adopt/segments/create` | Create segment |
| `PUT /api/adopt/segments/:id` | Update segment |
| `GET /api/adopt/status` | Poll segment processing status |

---

## Local Development

```bash
cp .env.example .env
# Fill in .env — set NODE_ENV=development to skip LTI session check
npm install
npm run dev
# Visit http://localhost:3000/app directly (LTI check bypassed in dev)
```
