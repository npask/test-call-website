const socket = io();

let localStream;
let muted = false;

let username = localStorage.getItem("username");
let avatar = localStorage.getItem("avatar");

const setup = document.getElementById("setup");
const privacy = document.getElementById("privacy");

if (!username || !avatar) {
    setup.style.display = "flex";
} else {
    setup.style.display = "none";
}

privacy.style.display = "flex";

document.getElementById("saveSetup").onclick = () => {

    const name = document.getElementById("name").value;

    const file = document.getElementById("avatar").files[0];

    const reader = new FileReader();

    reader.onload = () => {

        localStorage.setItem("username", name);
        localStorage.setItem("avatar", reader.result);

        setup.style.display = "none";

    };

    reader.readAsDataURL(file);
};

document.getElementById("accept").onclick = () => {
    privacy.style.display = "none";
};

document.getElementById("join").onclick = async () => {

    localStream = await navigator.mediaDevices.getUserMedia({
        audio: true
    });

    socket.emit("join", {
        username: localStorage.getItem("username"),
        avatar: localStorage.getItem("avatar")
    });

};

document.getElementById("mute").onclick = () => {

    muted = !muted;

    localStream.getAudioTracks().forEach(t => {
        t.enabled = !muted;
    });

};

socket.on("users", (users) => {

    const container = document.getElementById("participants");
    container.innerHTML = "";

    Object.values(users).forEach(u => {

        container.innerHTML += `
            <div class="user">
                <img src="${u.avatar}">
                <div>${u.username}</div>
            </div>
        `;

    });

});
