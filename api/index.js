const express = require("express");
const SpotifyWebApi = require("spotify-web-api-node");
const playdl = require("play-dl");

const app = express();
app.use(express.json());

// ─── UNIVERSAL CORS ───────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ─── SPOTIFY CLIENT ───────────────────────────────────────────────────────────
// Uses Client Credentials flow (no user login needed).
// Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in Vercel Environment Variables.
const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
});

let spotifyTokenExpiry = 0;

async function ensureSpotifyToken() {
  if (Date.now() < spotifyTokenExpiry) return;
  const data = await spotifyApi.clientCredentialsGrant();
  spotifyApi.setAccessToken(data.body.access_token);
  // Token is valid for 3600s; refresh 60s early
  spotifyTokenExpiry = Date.now() + (data.body.expires_in - 60) * 1000;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function parseSpotifyId(url, type) {
  // Matches both https://open.spotify.com/track/ID and spotify:track:ID
  const re = new RegExp(`${type}\\/([A-Za-z0-9]+)|${type}:([A-Za-z0-9]+)`);
  const m = url.match(re);
  return m ? m[1] || m[2] : null;
}

function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = String(totalSec % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function detectType(url) {
  if (url.includes("/track/") || url.includes("track:")) return "track";
  if (url.includes("/playlist/") || url.includes("playlist:")) return "playlist";
  if (url.includes("/album/") || url.includes("album:")) return "album";
  return null;
}

// ─── POST /api/info ───────────────────────────────────────────────────────────
// Body: { url: "https://open.spotify.com/track/..." }
// Returns: { type, title, artist, cover, duration, query }
app.post("/api/info", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "Missing 'url' in request body." });

  const type = detectType(url);
  if (!type) return res.status(400).json({ error: "URL must be a Spotify track, album, or playlist link." });

  try {
    await ensureSpotifyToken();

    if (type === "track") {
      const id = parseSpotifyId(url, "track");
      if (!id) return res.status(400).json({ error: "Could not parse Spotify track ID." });

      const { body } = await spotifyApi.getTrack(id);
      const title = body.name;
      const artist = body.artists.map((a) => a.name).join(", ");
      const cover = body.album.images[0]?.url || null;
      const duration = formatDuration(body.duration_ms);
      const query = `${title} ${artist}`;

      return res.json({ type: "track", title, artist, cover, duration, query });
    }

    if (type === "playlist") {
      const id = parseSpotifyId(url, "playlist");
      if (!id) return res.status(400).json({ error: "Could not parse Spotify playlist ID." });

      const { body } = await spotifyApi.getPlaylist(id);
      const title = body.name;
      const artist = body.owner.display_name;
      const cover = body.images[0]?.url || null;
      const trackCount = body.tracks.total;

      // Return first track's query as a representative sample
      const firstTrack = body.tracks.items[0]?.track;
      const query = firstTrack
        ? `${firstTrack.name} ${firstTrack.artists[0]?.name}`
        : title;

      return res.json({
        type: "playlist",
        title,
        artist,
        cover,
        duration: `${trackCount} tracks`,
        query,
        trackCount,
      });
    }

    if (type === "album") {
      const id = parseSpotifyId(url, "album");
      if (!id) return res.status(400).json({ error: "Could not parse Spotify album ID." });

      const { body } = await spotifyApi.getAlbum(id);
      const title = body.name;
      const artist = body.artists.map((a) => a.name).join(", ");
      const cover = body.images[0]?.url || null;
      const trackCount = body.tracks.total;
      const firstTrack = body.tracks.items[0];
      const query = firstTrack ? `${firstTrack.name} ${artist}` : title;

      return res.json({
        type: "album",
        title,
        artist,
        cover,
        duration: `${trackCount} tracks`,
        query,
        trackCount,
      });
    }
  } catch (err) {
    console.error("[/api/info] Error:", err.message);
    return res.status(500).json({ error: "Failed to fetch Spotify info.", detail: err.message });
  }
});

// ─── POST /api/download ───────────────────────────────────────────────────────
// Body: { query: "Song Name Artist", title: "Song Name" }
// Returns: { success: true, url: "DIRECT_AUDIO_URL", title: "filename.mp3" }
//
// Strategy: Search YouTube with play-dl (pure JS, no binaries), pick the best
// match, then resolve a streamable audio format URL and return it directly.
// The FRONTEND is responsible for the actual download — we never pipe audio
// through Vercel (avoids the 10-second timeout entirely).
app.post("/api/download", async (req, res) => {
  const { query, title } = req.body;
  if (!query) return res.status(400).json({ error: "Missing 'query' in request body." });

  try {
    // 1. Search YouTube for the best matching video
    const searchResults = await playdl.search(query, { source: { youtube: "video" }, limit: 5 });

    if (!searchResults || searchResults.length === 0) {
      return res.status(404).json({ error: "No YouTube results found for the query." });
    }

    // Pick the result whose duration is closest to a typical song (< 10 min)
    const video =
      searchResults.find((v) => v.durationInSec > 0 && v.durationInSec < 600) ||
      searchResults[0];

    // 2. Get stream info — play-dl resolves direct YouTube audio format URLs
    const streamInfo = await playdl.stream(video.url, { quality: 2 }); // quality 2 = best audio

    // streamInfo.url is the direct CDN audio URL (no binary needed)
    const directUrl = streamInfo.url;

    if (!directUrl) {
      return res.status(500).json({ error: "Could not resolve a direct audio URL." });
    }

    const safeTitle = (title || video.title || "download")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "_");

    return res.json({
      success: true,
      url: directUrl,
      title: `${safeTitle}.mp3`,
      youtubeTitle: video.title,
      youtubeDuration: video.durationRaw,
    });
  } catch (err) {
    console.error("[/api/download] Error:", err.message);
    return res.status(500).json({ error: "Failed to resolve audio URL.", detail: err.message });
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

// ─── EXPORT FOR VERCEL ────────────────────────────────────────────────────────
module.exports = app;
