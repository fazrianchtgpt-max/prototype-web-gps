const net = require('net');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const webServer = http.createServer(app);
const io = new Server(webServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const GPS_PORT = 5023;
const WEB_PORT = 3000;

const activeGpsSockets = {};
const lastPayloads = {};
const lastAccStatus = {};

function getCRC(data) {
    let crc = 0xFFFF;
    for (let i = 0; i < data.length; i++) {
        crc ^= data[i];
        for (let j = 0; j < 8; j++) {
            if ((crc & 0x0001) !== 0) {
                crc = (crc >> 1) ^ 0x8408;
            } else {
                crc >>= 1;
            }
        }
    }
    return crc ^ 0xFFFF;
}

const gpsServer = net.createServer((socket) => {
    let currentImei = null;

    socket.on('data', (data) => {
        const hex = data.toString('hex').toLowerCase();

        let packetId = '';
        let isStandard = hex.startsWith('7878');
        let isExtended = hex.startsWith('7979');

        if (isStandard) {
            packetId = hex.substring(6, 8);
        } else if (isExtended) {
            packetId = hex.substring(8, 10);
        } else {
            return;
        }

        // 1. LOGIN HANDLING (ID 01)
        if (isStandard && packetId === '01') {
            const rawImei = hex.substring(8, 24);
            currentImei = rawImei.startsWith('0') ? rawImei.substring(1) : rawImei;
            activeGpsSockets[currentImei] = socket;

            const serial = data.slice(data.length - 6, data.length - 4);
            const body = Buffer.from([0x05, 0x01, serial[0], serial[1]]);
            const crcVal = getCRC(body);
            const response = Buffer.concat([
                Buffer.from([0x78, 0x78]),
                body,
                Buffer.from([(crcVal >> 8) & 0xFF, crcVal & 0xFF, 0x0d, 0x0a])
            ]);
            socket.write(response);
            console.log(`[${new Date().toLocaleTimeString()}] 🟢 Login: ${currentImei}`);
        }

        // 2. HEARTBEAT / STATUS / ALARM (ID 13, 94, 26, 27)
        else if (packetId === '13' || packetId === '94' || packetId === '26' || packetId === '27') {
            if (isStandard && packetId === '13') {
                const serial = data.slice(data.length - 6, data.length - 4);
                socket.write(Buffer.from([0x78, 0x78, 0x05, 0x13, serial[0], serial[1], 0x00, 0x00, 0x0d, 0x0a]));
            }

            // Extract Termianl Info Byte
            let info = 0;
            if (packetId === '13') info = data[4];
            else if (packetId === '94') info = data[31] || data[30];
            else if (packetId === '26' || packetId === '27') info = data[4];

            // Bitwise ACC check (GT06N: Bit 1 is Ignition)
            const isAccOn = (info & 0x02) !== 0;
            const newAcc = isAccOn ? "ON" : "OFF";

            if (currentImei && lastAccStatus[currentImei] !== newAcc) {
                lastAccStatus[currentImei] = newAcc;
                console.log(`[${new Date().toLocaleTimeString()}] ⚡ Realtime ACC Change [${currentImei}]: ${newAcc}`);

                // PUSH IMMEDIATELY to frontend even if no new location
                if (lastPayloads[currentImei]) {
                    lastPayloads[currentImei].acc = newAcc;
                    lastPayloads[currentImei].time = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
                    io.emit('vessel_move', lastPayloads[currentImei]);
                }
            } else {
                console.log(`[${new Date().toLocaleTimeString()}] 💓 Heartbeat [${currentImei || '353701096329020'}]: Mesin ${newAcc}`);
            }
        }

        // 3. LOCATION DATA (12, 18, 22)
        else if (packetId === '12' || packetId === '22' || packetId === '18') {
            try {
                let latHex = '', lonHex = '', speedHex = '', accBit = false;

                if (packetId === '12' || packetId === '22') {
                    latHex = hex.substring(22, 30);
                    lonHex = hex.substring(30, 38);
                    speedHex = hex.substring(38, 40);

                    // In location packet 0x12, byte 30 (hex index 60) marks status
                    // but usually it's better to rely on Status packets (0x13) or 
                    // look for the bit in the specific device info section.
                    // For prototype, we combine with speed as fallback if no heartbeat yet
                    const infoByte = data[30] || 0;
                    accBit = (infoByte & 0x02) !== 0;
                } else if (packetId === '18') {
                    latHex = hex.substring(28, 36);
                    lonHex = hex.substring(36, 44);
                    speedHex = hex.substring(44, 46);
                }

                if (latHex && lonHex && latHex !== '00000000') {
                    const lat = parseInt(latHex, 16) / 1800000;
                    const lon = parseInt(lonHex, 16) / 1800000;
                    const speed = parseInt(speedHex || "00", 16);

                    // Sync ACC status
                    if (packetId === '12' && accBit) lastAccStatus[currentImei] = "ON";
                    else if (packetId === '12' && !accBit && speed === 0) lastAccStatus[currentImei] = "OFF";

                    const payload = {
                        imei: currentImei || "353701096329020",
                        nopol: "T FAZRIAN ABC",
                        lat: parseFloat((lat > 0 ? -lat : lat).toFixed(6)),
                        lon: parseFloat(lon.toFixed(6)),
                        speed: speed,
                        acc: lastAccStatus[currentImei] || (speed > 0 ? "ON" : "OFF"),
                        sat: Math.floor(Math.random() * 3) + 9,
                        time: new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }),
                        alarm: "Normal"
                    };

                    lastPayloads[payload.imei] = payload;
                    io.emit('vessel_move', payload);
                    console.log(`📍 LIVE: ${payload.nopol} | ${payload.lat}, ${payload.lon} | ${speed} km/h | Acc: ${payload.acc}`);
                }
            } catch (e) {
                console.error("Gagal parsing:", e.message);
            }
        }
    });

    socket.on('close', () => {
        if (currentImei) delete activeGpsSockets[currentImei];
        console.log(`🔴 Disconnected: ${currentImei}`);
    });
    socket.on('error', (err) => { console.log("⚠️ Error:", err.message); });
});

function createCommandPacket(command) {
    const cmdBuffer = Buffer.from(command, 'ascii');
    const body = Buffer.concat([
        Buffer.from([0x80]),
        Buffer.from([cmdBuffer.length]),
        cmdBuffer,
        Buffer.from([0x00, 0x01])
    ]);
    const length = body.length + 2;
    const packetBeforeCrc = Buffer.concat([Buffer.from([length]), body]);
    const crcVal = getCRC(packetBeforeCrc);
    return Buffer.concat([Buffer.from([0x78, 0x78]), packetBeforeCrc, Buffer.from([(crcVal >> 8) & 0xFF, crcVal & 0xFF, 0x0d, 0x0a])]);
}

io.on('connection', (webSocket) => {
    console.log("🖥️ Web Connected");
    Object.values(lastPayloads).forEach(payload => {
        webSocket.emit('vessel_move', payload);
    });
    webSocket.on('send_command', (data) => {
        const { imei, command } = data;
        const targetSocket = activeGpsSockets[imei];
        if (targetSocket) {
            targetSocket.write(createCommandPacket(command));
            console.log(`✅ CMD [${command}] -> ${imei}`);
            webSocket.emit('command_res', { status: 'success', msg: `Sent: ${command}` });
        } else {
            webSocket.emit('command_res', { status: 'error', msg: 'Offline' });
        }
    });
});

gpsServer.listen(GPS_PORT, '0.0.0.0', () => console.log(`🚀 GPS Listener: ${GPS_PORT}`));
webServer.listen(WEB_PORT, '0.0.0.0', () => console.log(`🌐 Web/Socket: ${WEB_PORT}`));
