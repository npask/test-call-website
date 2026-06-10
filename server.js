const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*"
    }
});


app.use(express.static("public"));

const users = {}; // socket.id -> {username, avatar}

io.on("connection", (socket) => {

    socket.on("join", (data) => {

        users[socket.id] = {
            username: data.username,
            avatar: data.avatar
        };

        socket.broadcast.emit("user-joined", {
            id: socket.id,
            ...users[socket.id]
        });

        io.emit("users", users);
    });

    socket.on("signal", (data) => {
        io.to(data.to).emit("signal", {
            from: socket.id,
            signal: data.signal
        });
    });

    socket.on("disconnect", () => {

        delete users[socket.id];

        io.emit("user-left", socket.id);
        io.emit("users", users);
    });

});

server.listen(3000, () => {
    console.log("http://localhost:3000");
});
