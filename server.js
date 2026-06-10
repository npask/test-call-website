const express = require("express");
const http    = require("http");
const { Server } = require("socket.io");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: "*" } });

app.use(express.static("public"));

// users[socket.id] = { username, avatar, profileColor, muted, speaking, joinedAt }
const users = {};

function broadcastUsers() {
  io.emit("users", users);
}

io.on("connection", (socket) => {

  // ── JOIN ────────────────────────────────────────────────────────────────────
  socket.on("join", (data) => {
    if (users[socket.id]) return;

    users[socket.id] = {
      username:     data.username     || "Unbekannt",
      avatar:       data.avatar       || null,
      profileColor: data.profileColor || "#5865f2",
      muted:        false,
      speaking:     false,
      joinedAt:     Date.now()
    };

    // Tell existing users about the newcomer (so they can call us)
    socket.broadcast.emit("user-joined", {
      id: socket.id,
      ...users[socket.id]
    });

    broadcastUsers();
  });

  // ── LEAVE ───────────────────────────────────────────────────────────────────
  socket.on("leave", () => {
    if (!users[socket.id]) return;
    delete users[socket.id];
    io.emit("user-left", socket.id);
    broadcastUsers();
  });

  // ── WEBRTC SIGNAL RELAY ─────────────────────────────────────────────────────
  socket.on("signal", (data) => {
    if (!data.to || !data.signal) return;
    io.to(data.to).emit("signal", {
      from:   socket.id,
      signal: data.signal
    });
  });

  // ── SPEAKING ────────────────────────────────────────────────────────────────
  socket.on("speaking", (isSpeaking) => {
    if (!users[socket.id]) return;
    users[socket.id].speaking = !!isSpeaking;
    io.emit("speaking", { id: socket.id, speaking: !!isSpeaking });
  });

  // ── MUTE ────────────────────────────────────────────────────────────────────
  socket.on("mute-state", (muted) => {
    if (!users[socket.id]) return;
    users[socket.id].muted = !!muted;
    io.emit("mute-state", { id: socket.id, muted: !!muted });
  });

  // ── LATENCY PING ────────────────────────────────────────────────────────────
  socket.on("ping-latency", (timestamp) => {
    socket.emit("pong-latency", timestamp);
  });

  // ── DISCONNECT ──────────────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    if (!users[socket.id]) return;
    delete users[socket.id];
    io.emit("user-left", socket.id);
    broadcastUsers();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`VoiceChat läuft → http://localhost:${PORT}`);
});
