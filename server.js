const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { Server } = require("socket.io");
const app = express(), server = http.createServer(app), io = new Server(server, { cors: { origin: "*" } });
app.use(express.static("public"));

// Private rooms and invite tokens are intentionally ephemeral: a server restart clears them.
const channels = new Map([["general", { id: "general", name: "Allgemein", private: false }]]);
const users = new Map();
const listChannels = () => [...channels.values()].map(c => ({ id: c.id, name: c.name, private: c.private, count: [...users.values()].filter(u => u.channelId === c.id).length }));
const sendChannels = () => io.emit("channels", listChannels());
const sendUsers = id => io.to(id).emit("users", Object.fromEntries([...users].filter(([, u]) => u.channelId === id)));
function leave(socket) { const u = users.get(socket.id); if (!u) return; socket.leave(u.channelId); users.delete(socket.id); io.to(u.channelId).emit("user-left", socket.id); sendUsers(u.channelId); sendChannels(); }

io.on("connection", socket => {
  socket.emit("channels", listChannels());
  socket.on("create-channel", ({ name }) => { name = String(name || "").trim().slice(0, 32); if (!name) return; const id = crypto.randomUUID(), invite = crypto.randomBytes(9).toString("base64url"); channels.set(id, { id, name, private: true, invite }); socket.emit("channel-created", { id, name, private: true, invite }); sendChannels(); });
  socket.on("join", data => { const c = channels.get(data.channelId || "general"); if (!c || (c.private && data.invite !== c.invite)) return socket.emit("join-error", "Dieser Einladungslink ist ungültig."); leave(socket); const u = { username: String(data.username || "Unbekannt").slice(0, 32), avatar: data.avatar || null, profileColor: data.profileColor || "#5865f2", muted: false, speaking: false, channelId: c.id }; users.set(socket.id, u); socket.join(c.id); socket.to(c.id).emit("user-joined", { id: socket.id, ...u }); sendUsers(c.id); sendChannels(); });
  socket.on("leave", () => leave(socket));
  socket.on("signal", data => { const a = users.get(socket.id), b = users.get(data?.to); if (a && b && a.channelId === b.channelId && data.signal) io.to(data.to).emit("signal", { from: socket.id, signal: data.signal }); });
  socket.on("speaking", speaking => { const u = users.get(socket.id); if (u) { u.speaking = !!speaking; io.to(u.channelId).emit("speaking", { id: socket.id, speaking: u.speaking }); } });
  socket.on("mute-state", muted => { const u = users.get(socket.id); if (u) { u.muted = !!muted; io.to(u.channelId).emit("mute-state", { id: socket.id, muted: u.muted }); } });
  socket.on("ping-latency", t => socket.emit("pong-latency", t)); socket.on("disconnect", () => leave(socket));
});
server.listen(process.env.PORT || 3000, () => console.log("VoiceChat läuft auf Port 3000"));
