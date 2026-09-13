# FamDam — Family Chore & Activity Chart

A lightweight, no-backend web app for tracking family chores and activities:

- Add/remove family members (with a color).
- Add/remove chores or activities, assign them to one or more family members,
  and schedule them **every day** or on **specific days of the week**, with a
  **number of times per day**.
- A weekly chart showing what's due each day, with check-off boxes.
- Optional **Google account connection**: syncs your chores as recurring
  events on a dedicated "Family Chores" Google Calendar, and stores your
  FamDam data in your Google Drive app-data folder so it follows you across
  every device you sign in on (phone, tablet, laptop…).

It's a static site — plain HTML/CSS/JS, no server, no database to run or pay
for. Your data lives in the browser (`localStorage`) and, once you connect
Google, in your own Google account.

## 1. Try it locally

Just open `index.html` in a browser, or serve the folder:

```bash
npx serve .
# or: python3 -m http.server 8080
```

Family members and chores work immediately with no setup. Google syncing is
optional — see below.

## 2. Set up Google Calendar sync (one-time, ~5 minutes)

FamDam needs its own Google OAuth **Client ID** to talk to your Calendar and
Drive. You create this once, for free, in your own Google account:

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and
   create a new project (or reuse one).
2. Enable these two APIs for the project (**APIs & Services → Library**):
   - **Google Calendar API**
   - **Google Drive API**
3. Go to **APIs & Services → OAuth consent screen**:
   - User type: **External** (fine for personal/family use — just add your
     family's Google accounts as *Test users* if the app stays in "Testing"
     mode).
   - Fill in the required app name/support email fields.
4. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Web application**.
   - Under **Authorized JavaScript origins**, add the URL(s) where you'll host
     FamDam, e.g.:
     - `http://localhost:8080` (for local testing)
     - `https://YOUR-GITHUB-USERNAME.github.io` (for GitHub Pages — see below)
   - Save, then copy the generated **Client ID** (ends in
     `.apps.googleusercontent.com`).
5. Open FamDam in your browser, click the **⚙️** button next to "Connect
   Google", paste the Client ID, and save.
6. Click **Connect Google** and approve the permissions. FamDam will create a
   "Family Chores" calendar and start syncing.

Everyone in the family can do step 5–6 on their own device with the *same*
Client ID (it's not a secret — it just identifies the app) and their *own*
Google account, or you can all sign in with one shared family Google account
if you prefer a single shared calendar.

> FamDam only ever talks directly to Google's APIs from your browser. There is
> no third-party server involved and no credentials of yours are sent
> anywhere else.

## 3. Host it on the web

Because it's a static site, any static host works. Two easy options:

### GitHub Pages (recommended, free)

1. In this repository on GitHub, go to **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to `Deploy from a branch`,
   branch `main` (or whichever branch you keep this on), folder `/ (root)`.
3. Save. GitHub will publish the site at
   `https://YOUR-GITHUB-USERNAME.github.io/REPO-NAME/`.
4. Add that exact URL to **Authorized JavaScript origins** in your Google
   OAuth client (step 4 above), then reload the page and connect Google.

### Netlify / Vercel (drag-and-drop alternative)

Drag this folder onto [Netlify Drop](https://app.netlify.com/drop) or import
the repo into [Vercel](https://vercel.com/new) with no build command — it's
static files. Add whatever URL they give you as an Authorized JavaScript
origin in Google Cloud, the same as above.

## How scheduling works

- **Every day**: the chore is due daily.
- **Specific days**: pick any combination of weekdays.
- **Times per day**: e.g. "3" for a chore like "take medicine" that happens
  three times a day — the chart shows three check-boxes for that day, and
  (when Google-connected) three separate recurring calendar events spread
  across the day.

## Data & privacy

- Without connecting Google, everything stays in that browser's
  `localStorage` only (not shared across devices).
- After connecting Google, FamDam keeps a `famdam-state.json` file in your
  Google Drive's hidden **app data** folder (not visible in your regular
  Drive file list, and only readable by FamDam) plus the chore events on your
  "Family Chores" calendar. Disconnecting (⚙️ → Disconnect Google) revokes
  FamDam's access token in the browser; to fully remove its Drive/Calendar
  access, visit your [Google Account permissions
  page](https://myaccount.google.com/permissions).

## File overview

```
index.html       Page structure
css/style.css    Styling (light/dark aware, mobile-friendly)
js/app.js        State, rendering, member/chore CRUD, weekly chart
js/google.js     Google sign-in, Drive app-data sync, Calendar event sync
```
