const express = require("express");
const SpotifyWebApi = require("spotify-web-api-node");

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

// ─── SPOTIFY ──────────────────────────────────────────────────────────────────
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
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;

function detectType(url) {
  if (url.includes("/track/") || url.includes("track:")) return "track";
  if (url.includes("/playlist/") || url.includes("playlist:")) return "playlist";
  if (url.includes("/album/") || url.includes("album:")) return "album";
  return null;
}

function parseSpotifyId(url, type) {
  const re = new RegExp(`${type}\\/([A-Za-z0-9]+)|${type}:([A-Za-z0-9]+)`);
  const m = url.match(re);
  return m ? m[1] || m[2] : null;
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ─── YOUTUBE SEARCH (no key needed) ──────────────────────────────────────────
async function searchYouTube(query) {
  const encoded = encodeURIComponent(query);
  const url = `https://www.youtube.com/results?search_query=${encoded}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
  });
  const html = await res.text();
  // Extract video IDs from YouTube search results page
  const matches = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/g);
  if (!matches || matches.length === 0) throw new Error("No YouTube results found");
  const videoId = matches[0].replace('"videoId":"', "").replace('"', "");
  return videoId;
}

// ─── RAPIDAPI: Try multiple endpoints until one works ────────────────────────
async function getAudioUrlViaRapidAPI(videoId) {
  const endpoints = [
    {
      host: "youtube-mp36.p.rapidapi.com",
      url: `https://youtube-mp36.p.rapidapi.com/dl?id=${videoId}`,
      method: "GET",
      extract: (d) => d.link || d.url,
    },
    {
      host: "youtube-to-mp315.p.rapidapi.com",
      url: `https://youtube-to-mp315.p.rapidapi.com/dl?id=${videoId}`,
      method: "GET",
      extract: (d) => d.link || d.url,
    },
    {
      host: "yt-api.p.rapidapi.com",
      url: `https://yt-api.p.rapidapi.com/dl?id=${videoId}`,
      method: "GET",
      extract: (d) => d.url || (d.formats && d.formats[0] && d.formats[0].url),
    },
    {
      host: "youtube-mp3-downloader2.p.rapidapi.com",
      url: `https://youtube-mp3-downloader2.p.rapidapi.com/ytmp3/ytmp3/?url=https://www.youtube.com/watch?v=${videoId}`,
      method: "GET",
      extract: (d) => d.dlink || d.link || d.url,
    },
    {
      host: "youtube-to-mp3-downloader.p.rapidapi.com",
      url: `https://youtube-to-mp3-downloader.p.rapidapi.com/ytmp3/ytmp3/?url=https://www.youtube.com/watch?v=${videoId}`,
      method: "GET",
      extract: (d) => d.dlink || d.link || d.url,
    },
  ];

  let lastError = null;

  for (const ep of endpoints) {
    try {
      const res = await fetch(ep.url, {
        method: ep.method,
        headers: {
          "x-rapidapi-key": RAPIDAPI_KEY,
          "x-rapidapi-host": ep.host,
        },
      });

      if (!res.ok) continue;
      const data = await res.json();
      const audioUrl = ep.extract(data);

      if (audioUrl && audioUrl.startsWith("http")) {
        console.log(`[download] Success via ${ep.host}`);
        return audioUrl;
      }

      // Some APIs return status "ok" with a link after processing
      if (data.status === "ok" || data.status === "processing") {
        // Poll once after 2 seconds
        await new Promise((r) => setTimeout(r, 2000));
        const res2 = await fetch(ep.url, {
          method: ep.method,
          headers: {
            "x-rapidapi-key": RAPIDAPI_KEY,
            "x-rapidapi-host": ep.host,
          },
        });
        if (res2.ok) {
          const data2 = await res2.json();
          const audioUrl2 = ep.extract(data2);
          if (audioUrl2 && audioUrl2.startsWith("http")) {
            console.log(`[download] Success (after poll) via ${ep.host}`);
            return audioUrl2;
          }
        }
      }
    } catch (err) {
      lastError = err;
      console.error(`[download] ${ep.host} failed:`, err.message);
    }
  }

  throw new Error(lastError?.message || "All RapidAPI endpoints failed");
}

// ─── POST /api/info ───────────────────────────────────────────────────────────
app.post("/api/info", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "Missing url" });

  const type = detectType(url);
  if (!type) return res.status(400).json({ error: "Not a valid Spotify link" });

  try {
    await ensureSpotifyToken();

    if (type === "track") {
      const id = parseSpotifyId(url, "track");
      const { body } = await spotifyApi.getTrack(id);
      return res.json({
        type: "track",
        title: body.name,
        artist: body.artists.map((a) => a.name).join(", "),
        cover: body.album.images[0]?.url || null,
        duration: formatDuration(body.duration_ms),
        query: `${body.name} ${body.artists[0].name}`,
      });
    }

    if (type === "playlist") {
      const id = parseSpotifyId(url, "playlist");
      const { body } = await spotifyApi.getPlaylist(id);
      const first = body.tracks.items[0]?.track;
      return res.json({
        type: "playlist",
        title: body.name,
        artist: body.owner.display_name,
        cover: body.images[0]?.url || null,
        duration: `${body.tracks.total} tracks`,
        query: first ? `${first.name} ${first.artists[0]?.name}` : body.name,
        trackCount: body.tracks.total,
      });
    }

    if (type === "album") {
      const id = parseSpotifyId(url, "album");
      const { body } = await spotifyApi.getAlbum(id);
      const artist = body.artists.map((a) => a.name).join(", ");
      const first = body.tracks.items[0];
      return res.json({
        type: "album",
        title: body.name,
        artist,
        cover: body.images[0]?.url || null,
        duration: `${body.tracks.total} tracks`,
        query: first ? `${first.name} ${artist}` : body.name,
        trackCount: body.tracks.total,
      });
    }
  } catch (err) {
    console.error("[/api/info]", err.message);
    return res.status(500).json({ error: "Failed to fetch Spotify info", detail: err.message });
  }
});

// ─── POST /api/download ───────────────────────────────────────────────────────
app.post("/api/download", async (req, res) => {
  const { query, title } = req.body;
  if (!query) return res.status(400).json({ error: "Missing query" });

  try {
    // 1. Find YouTube video ID
    const videoId = await searchYouTube(query);
    console.log(`[download] Found videoId: ${videoId} for query: ${query}`);

    // 2. Get direct MP3 URL via RapidAPI
    const audioUrl = await getAudioUrlViaRapidAPI(videoId);

    const safeTitle = (title || query)
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "_")
      .slice(0, 80);

    return res.json({
      success: true,
      url: audioUrl,
      title: `${safeTitle}.mp3`,
    });
  } catch (err) {
    console.error("[/api/download]", err.message);
    return res.status(500).json({ error: "Failed to resolve audio URL", detail: err.message });
  }
});

// ─── HEALTH ───────────────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) =>
  res.json({ status: "ok", hasSpotify: !!process.env.SPOTIFY_CLIENT_ID, hasRapidApi: !!process.env.RAPIDAPI_KEY })
);

module.exports = app;
