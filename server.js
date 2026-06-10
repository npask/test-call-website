const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// WICHTIG: server direkt an socket.io
const io = new Server(server, {
    cors: {
        origin: "*"
    }
});

app.use(express.static("public"));

io.on("connection", (socket) => {
    console.log("User connected:", socket.id);
});

server.listen(process.env.PORT || 3000);
