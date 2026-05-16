const express = require("express");
const SpotifyWebApi = require("spotify-web-api-node");
const ytdl = require("@distube/ytdl-core");
const YoutubeSearch = require("youtube-sr").default;

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
const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
});

let spotifyTokenExpiry = 0;

async function ensureSpotifyToken() {
  if (Date.now() < spotifyTokenExpiry) return;
  const data = await spotifyApi.clientCredentialsGrant();
  spotifyApi.setAccessToken(data.body.access_token);
  spotifyTokenExpiry = Date.now() + (data.body.expires_in - 60) * 1000;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function parseSpotifyId(url, type) {
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
      const firstTrack = body.tracks.items[0]?.track;
      const query = firstTrack ? `${firstTrack.name} ${firstTrack.artists[0]?.name}` : title;

      return res.json({ type: "playlist", title, artist, cover, duration: `${trackCount} tracks`, query, trackCount });
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

      return res.json({ type: "album", title, artist, cover, duration: `${trackCount} tracks`, query, trackCount });
    }

  } catch (err) {
    console.error("[/api/info] Error:", err.message);
    return res.status(500).json({ error: "Failed to fetch Spotify info.", detail: err.message });
  }
});

// ─── POST /api/download ───────────────────────────────────────────────────────
app.post("/api/download", async (req, res) => {
  const { query, title } = req.body;
  if (!query) return res.status(400).json({ error: "Missing 'query' in request body." });

  try {
    // 1. Search YouTube
    const results = await YoutubeSearch.search(query, { limit: 5, type: "video" });

    if (!results || results.length === 0) {
      return res.status(404).json({ error: "No YouTube results found." });
    }

    // Pick best result under 10 minutes
    const video = results.find((v) => v.duration > 0 && v.duration < 600000) || results[0];
    const videoUrl = `https://www.youtube.com/watch?v=${video.id}`;

    // 2. Get audio format info using ytdl-core (no download, just URL)
    const info = await ytdl.getInfo(videoUrl);
    const formats = ytdl.filterFormats(info.formats, "audioonly");

    if (!formats || formats.length === 0) {
      return res.status(500).json({ error: "No audio formats found." });
    }

    // Pick best quality audio format
    const best = formats.sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0];

    const safeTitle = (title || video.title || "download")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "_");

    return res.json({
      success: true,
      url: best.url,
      title: `${safeTitle}.mp3`,
      youtubeTitle: video.title,
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
