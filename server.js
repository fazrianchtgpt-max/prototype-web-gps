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

// Map Alarm Type Code to String
const alarmMap = {
    '00': 'Normal',
    '01': '🚨 SOS ALARM!',
    '02': '🚫 Power Cut!',
    '03': '📳 Vibration Alert',
    '04': '📥 Enter Fence',
    '05': '📤 Exit Fence',
    '06': '🏎️ Over Speed',
    '09': '🔋 Moving Alarm',
    '10': '🔌 Enter GPS Blind Area',
    '11': '📶 Exit GPS Blind Area',
    '12': '🔔 Power On Alarm',
    '13': '📡 GPS First Fix',
    '14': '📉 Low Battery',
    '18': '🔌 Power Cut Alarm'
};

const gpsServer = net.createServer((socket) => {
    let currentImei = null;

    socket.on('data', (data) => {
        const hex = data.toString('hex').toLowerCase();

        let packetId = '';
        let isStandard = hex.startsWith('7878');
        let isExtended = hex.startsWith('7979');

        if (!isStandard && !isExtended) return;

        packetId = isStandard ? hex.substring(6, 8) : hex.substring(8, 10);

        // 1. LOGIN (ID 01)
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
            console.log(`[${new Date().toLocaleTimeString()}] 🟢 Login Device: ${currentImei}`);
        }

        // 2. HEARTBEAT / ALARM / STATUS (ID 13, 26, 94)
        else if (packetId === '13' || packetId === '26' || packetId === '94') {
            // ACK for standard packets
            if (isStandard && (packetId === '13' || packetId === '26')) {
                const serial = data.slice(data.length - 6, data.length - 4);
                socket.write(Buffer.from([0x78, 0x78, 0x05, packetId, serial[0], serial[1], 0x00, 0x00, 0x0d, 0x0a]));
            }

            let infoByte = 0;
            let alarmStr = "Normal";

            if (packetId === '13' || packetId === '26') infoByte = data[4];
            else if (packetId === '94') infoByte = data[31] || data[4];

            if (packetId === '26') {
                const alarmType = hex.substring(42, 44);
                alarmStr = alarmMap[alarmType] || `Alarm Code ${alarmType}`;
            }

            // ACC logic (Bit 1 in Terminal Info)
            const isAccOn = (infoByte & 0x02) !== 0;
            const newAcc = isAccOn ? "ON" : "OFF";

            if (currentImei) {
                lastAccStatus[currentImei] = newAcc;
                if (lastPayloads[currentImei]) {
                    lastPayloads[currentImei].acc = newAcc;
                    lastPayloads[currentImei].alarm = alarmStr;
                    io.emit('vessel_move', lastPayloads[currentImei]);
                }
                console.log(`[${new Date().toLocaleTimeString()}] 💓 Status Update: [${currentImei}] Mesin ${newAcc} | Alarm: ${alarmStr}`);
            }
        }

        // 3. LOCATION (ID 12, 18, 22)
        else if (packetId === '12' || packetId === '22' || packetId === '18') {
            try {
                let latHex = '', lonHex = '', speedHex = '', courseStatus = '';

                if (packetId === '12' || packetId === '22') {
                    latHex = hex.substring(22, 30);
                    lonHex = hex.substring(30, 38);
                    speedHex = hex.substring(38, 40);
                    courseStatus = hex.substring(40, 44);
                } else if (packetId === '18') {
                    latHex = hex.substring(28, 36);
                    lonHex = hex.substring(36, 44);
                    speedHex = hex.substring(44, 46);
                    courseStatus = hex.substring(46, 50);
                }

                if (latHex && lonHex && latHex !== '00000000') {
                    let rawLat = parseInt(latHex, 16);
                    let rawLon = parseInt(lonHex, 16);

                    // Decode Lat/Lon correctly
                    let lat = rawLat / 1800000;
                    let lon = rawLon / 1800000;

                    // Check Course/Status for Orientation
                    const cs = parseInt(courseStatus, 16);
                    const isNorth = (cs & 0x1000) !== 0;
                    const isEast = (cs & 0x2000) === 0;
                    const isAccOn = (cs & 0x0400) !== 0;

                    if (!isNorth && lat > 0) lat = -lat;
                    if (!isEast && lon > 0) lon = -lon;

                    const speed = parseInt(speedHex, 16);
                    const currentAcc = isAccOn ? "ON" : "OFF";
                    if (currentImei) lastAccStatus[currentImei] = currentAcc;

                    const payload = {
                        imei: currentImei || "353701096329020",
                        nopol: "T FAZRIAN ABC",
                        lat: parseFloat(lat.toFixed(6)),
                        lon: parseFloat(lon.toFixed(6)),
                        speed: speed,
                        acc: currentAcc,
                        sat: parseInt(hex.substring(20, 22), 16) || 12,
                        time: new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }),
                        alarm: (lastPayloads[currentImei] && lastPayloads[currentImei].alarm) || "Normal"
                    };

                    lastPayloads[payload.imei] = payload;
                    io.emit('vessel_move', payload);
                    console.log(`📍 LIVE: ${payload.nopol} | ${payload.lat}, ${payload.lon} | Speed: ${speed} km/h | Acc: ${payload.acc}`);
                }
            } catch (e) {
                console.error("Gagal parsing koord:", e.message);
            }
        }
    });

    socket.on('close', () => {
        if (currentImei) delete activeGpsSockets[currentImei];
        console.log(`🔴 Device Disconnected: ${currentImei}`);
    });
});

function createCommandPacket(command) {
    const cmdBuffer = Buffer.from(command, 'ascii');
    const body = Buffer.concat([Buffer.from([0x80, cmdBuffer.length]), cmdBuffer, Buffer.from([0x00, 0x01])]);
    const length = body.length + 2;
    const packetBeforeCrc = Buffer.concat([Buffer.from([length]), body]);
    const crcVal = getCRC(packetBeforeCrc);
    return Buffer.concat([Buffer.from([0x78, 0x78]), packetBeforeCrc, Buffer.from([(crcVal >> 8) & 0xFF, crcVal & 0xFF, 0x0d, 0x0a])]);
}

io.on('connection', (webSocket) => {
    Object.values(lastPayloads).forEach(p => webSocket.emit('vessel_move', p));
    webSocket.on('send_command', (data) => {
        const { imei, command } = data;
        const target = activeGpsSockets[imei];
        if (target) {
            target.write(createCommandPacket(command));
            webSocket.emit('command_res', { status: 'success', msg: `Command ${command} Sent!` });
        } else {
            webSocket.emit('command_res', { status: 'error', msg: 'Device Offline' });
        }
    });
});

gpsServer.listen(GPS_PORT, '0.0.0.0', () => console.log(`🚀 GPS Listener: ${GPS_PORT}`));
webServer.listen(WEB_PORT, '0.0.0.0', () => console.log(`🌐 Web/Socket: ${WEB_PORT}`));
