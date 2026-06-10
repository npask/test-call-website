const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server);

app.use(express.static("public"));

io.on("connection", socket => {

    socket.on("join-room", room => {
        socket.join(room);

        socket.to(room).emit("user-joined", socket.id);

        socket.on("signal", data => {
            io.to(data.target).emit("signal", {
                sender: socket.id,
                signal: data.signal
            });
        });

        socket.on("disconnect", () => {
            socket.to(room).emit("user-left", socket.id);
        });
    });

});

server.listen(3000, () => {
    console.log("Server läuft auf Port 3000");
});
