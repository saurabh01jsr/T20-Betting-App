# T20 Score Predictor

Simple local web app for predicting T20 match scores with friends. Two innings per match, closest score wins each innings.

## Run

```bash
npm install
npm start
```

Open `http://localhost:3000` in your browser. The setup form expects 4 players.

## Notes

- Data is stored in `data.json` in this folder.
- Use the Admin PIN to add matches, lock predictions, set toss, and finalize scores.
- Use the in-app "Sync Schedule" button to pre-load the T20 World Cup 2026 fixtures.
- Toss can be entered manually or auto-synced from a Goalserve feed (see below).

## Optional: Change Schedule Feed

```bash
export SCHEDULE_FEED_URL="https://fixturedownload.com/feed/json/mens-t20-world-cup-2026"
```

## Toss Auto-Sync (Goalserve)

Set `GOALSERVE_TOSS_FEED_URL` to a Goalserve feed URL that includes the Toss info. The app will:
- Auto-check for toss updates around match start time.
- Keep manual toss entry available as a fallback.
- Offer a "Sync Toss Now" button in the UI.

Example environment variables:

```bash
export GOALSERVE_TOSS_FEED_URL="https://YOUR_GOALSERVE_FEED_URL"
export TOSS_SYNC_INTERVAL_SECONDS=60
export TOSS_SYNC_WINDOW_MINUTES=360
```

## Deploy to Render (Recommended)

This project includes a `render.yaml` Blueprint so you can deploy with a managed Postgres database.

1. Push this repo to GitHub.
2. In Render, choose **New -> Blueprint** and select the repo.
3. Render will create:
   - A web service for the Node app
   - A Postgres database
4. After it deploys, open the app URL and run the setup once.

Render uses the `DATABASE_URL` it provisions automatically. The app will use Postgres in production and the local `data.json` file when `DATABASE_URL` is not set.
