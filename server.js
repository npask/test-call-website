const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static("public"));

// users[socket.id] = { username, avatar, muted, speaking, joinedAt }
const users = {};

function broadcastUsers() {
  io.emit("users", users);
}

io.on("connection", (socket) => {
  // Join the voice channel
  socket.on("join", (data) => {
    // Prevent duplicate joins
    if (users[socket.id]) return;

    users[socket.id] = {
      username: data.username || "Unbekannt",
      avatar: data.avatar || null,
      muted: false,
      speaking: false,
      joinedAt: Date.now()
    };

    // Tell existing users about the newcomer
    socket.broadcast.emit("user-joined", {
      id: socket.id,
      ...users[socket.id]
    });

    broadcastUsers();
  });

  // Leave the channel explicitly
  socket.on("leave", () => {
    if (!users[socket.id]) return;
    delete users[socket.id];
    io.emit("user-left", socket.id);
    broadcastUsers();
  });

  // WebRTC signaling relay
  socket.on("signal", (data) => {
    if (!data.to || !data.signal) return;
    io.to(data.to).emit("signal", {
      from: socket.id,
      signal: data.signal
    });
  });

  // Speaking indicator
  socket.on("speaking", (isSpeaking) => {
    if (!users[socket.id]) return;
    users[socket.id].speaking = isSpeaking;
    io.emit("speaking", { id: socket.id, speaking: isSpeaking });
  });

  // Mute state sync
  socket.on("mute-state", (muted) => {
    if (!users[socket.id]) return;
    users[socket.id].muted = muted;
    io.emit("mute-state", { id: socket.id, muted });
  });

  socket.on("disconnect", () => {
    if (!users[socket.id]) return;
    delete users[socket.id];
    io.emit("user-left", socket.id);
    broadcastUsers();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`VoiceChat running → http://localhost:${PORT}`);
});
