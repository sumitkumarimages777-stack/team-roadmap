# Team Product Roadmap — live editable website

One file (`index.html`), no build step. After a one-time 5-minute setup,
everyone on the team can add modules, tasks, sub-tasks, change statuses and
delete items **directly on the website**, and it saves live for everyone.

---

## Step 1 — Put it on GitHub (no coding, all in the browser)

1. Go to https://github.com and sign up / log in
2. Click the **+** (top right) → **New repository**
3. Name it e.g. `team-roadmap`, keep it **Private**, click **Create repository**
4. On the new repo page, click the link **"uploading an existing file"**
5. Drag `index.html` and `README.md` onto the page
6. Click **Commit changes**

## Step 2 — Publish on Vercel

1. Go to https://vercel.com and click **Sign Up → Continue with GitHub**
2. Click **Add New… → Project**
3. Find your `team-roadmap` repo → **Import** → **Deploy** (change nothing)
4. In ~30 seconds you get a URL like `team-roadmap.vercel.app` — share it with the team

From now on, any change committed to GitHub redeploys automatically.

## Step 3 — Turn on live editing from the website (one time, ~5 min)

Right now the site shows a yellow banner saying live editing isn't connected.
To fix that you connect a free Google Firebase database:

1. Go to https://console.firebase.google.com → **Add project**
   (any name; you can turn OFF Google Analytics)
2. Left menu: **Build → Realtime Database → Create database**
   → pick a location → choose **Start in test mode** → Enable
3. Click the ⚙️ gear (top left) → **Project settings** → scroll to **Your apps**
   → click the **`</>`** (Web) icon → give it any nickname → **Register app**
4. Firebase shows a `firebaseConfig` code block. You need 4 values from it:
   `apiKey`, `authDomain`, `databaseURL`, `projectId`
   (If `databaseURL` isn't shown there, copy it from the Realtime Database
   page — it looks like `https://yourproject-default-rtdb.asia-southeast1.firebasedatabase.app`)
5. Open `index.html` on GitHub → click the ✏️ pencil to edit → at the very top,
   paste those 4 values into `FIREBASE_CONFIG` between the quotes.
   Optionally set `EDIT_PASSCODE = "yourword"` so only the team can edit.
6. **Commit changes** → Vercel redeploys → the banner disappears and the
   badge in the header shows **● live sync**

That's the last time anyone touches the file. All editing now happens on the site:
click **✎ Edit** → add modules, tasks, sub-tasks (nest as deep as you want),
rename, delete, and click status pills to update progress. Everyone sees
changes instantly.

### Important note on test mode

"Test mode" leaves the database open for ~30 days, then blocks writes.
For an internal tool the simple fix: in Firebase → Realtime Database →
**Rules** tab, set:

```json
{
  "rules": { ".read": true, ".write": true }
}
```

This keeps it working permanently. It means anyone who has your database URL
could technically write to it, so keep the site URL within the team and set an
`EDIT_PASSCODE`. If you later want proper login-based security, that can be
added with Firebase Authentication.
