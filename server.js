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
const lastRelayStatus = {};

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

const alarmMap = {
    '00': 'Normal',
    '01': '🚨 SOS ALARM!',
    '02': '🚫 Power Cut!',
    '03': '📳 Vibration Alert',
    '04': '📥 Enter Fence',
    '05': '📤 Exit Fence',
    '06': '🏎️ Over Speed',
    '09': '🔋 Moving Alarm',
    '14': '📉 Low Battery',
    '18': '🔌 Power Cut Alarm'
};

const gpsServer = net.createServer((socket) => {
    let currentImei = null;

    socket.on('data', (data) => {
        const hex = data.toString('hex').toLowerCase();
        let isStandard = hex.startsWith('7878');
        let isExtended = hex.startsWith('7979');
        if (!isStandard && !isExtended) return;

        const packetId = isStandard ? hex.substring(6, 8) : hex.substring(8, 10);

        // 1. LOGIN (01)
        if (isStandard && packetId === '01') {
            const rawImei = hex.substring(8, 24);
            currentImei = rawImei.startsWith('0') ? rawImei.substring(1) : rawImei;
            activeGpsSockets[currentImei] = socket;

            const serial = data.slice(data.length - 6, data.length - 4);
            const body = Buffer.from([0x05, 0x01, serial[0], serial[1]]);
            const crcVal = getCRC(body);
            const resp = Buffer.concat([Buffer.from([0x78, 0x78]), body, Buffer.from([(crcVal >> 8) & 0xFF, crcVal & 0xFF, 0x0d, 0x0a])]);
            socket.write(resp);
            console.log(`[${new Date().toLocaleTimeString()}] 🟢 Login: ${currentImei}`);
        }

        // 2. HEARTBEAT / STATUS (13, 26, 94)
        else if (packetId === '13' || packetId === '26' || packetId === '94') {
            if (isStandard && (packetId === '13' || packetId === '26')) {
                const serial = data.slice(data.length - 6, data.length - 4);
                socket.write(Buffer.from([0x78, 0x78, 0x05, packetId, serial[0], serial[1], 0x00, 0x00, 0x0d, 0x0a]));
            }

            // Terminal Info Byte
            let infoByte = 0;
            if (packetId === '13' || packetId === '26') infoByte = data[4];
            else if (packetId === '94') infoByte = data[31] || data[4];

            // Bit 1: ACC, Bit 7: Relay (1=OFF/Cut, 0=ON/Connected)
            const isAccOn = (infoByte & 0x02) !== 0;
            const isRelayCut = (infoByte & 0x80) !== 0;

            const newAcc = isAccOn ? "ON" : "OFF";
            const newRelay = isRelayCut ? "OFF" : "ON";

            let alarmStr = "Normal";
            if (packetId === '26') {
                const alarmCode = hex.substring(42, 44);
                alarmStr = alarmMap[alarmCode] || `Alarm ${alarmCode}`;
            }

            if (currentImei) {
                lastAccStatus[currentImei] = newAcc;
                lastRelayStatus[currentImei] = newRelay;

                if (lastPayloads[currentImei]) {
                    Object.assign(lastPayloads[currentImei], {
                        acc: newAcc,
                        relay: newRelay,
                        alarm: alarmStr,
                        time: new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })
                    });
                    io.emit('vessel_move', lastPayloads[currentImei]);
                }
                console.log(`[${new Date().toLocaleTimeString()}] ⚡ STATUS: ${currentImei} | ACC: ${newAcc} | Mesin: ${newRelay}`);
            }
        }

        // 3. LOCATION (12, 18, 22)
        else if (packetId === '12' || packetId === '22' || packetId === '18') {
            try {
                let latOffset = (packetId === '18') ? 14 : 11;
                let lonOffset = (packetId === '18') ? 18 : 15;
                let speedOffset = (packetId === '18') ? 22 : 19;
                let courseOffset = (packetId === '18') ? 23 : 20;

                const latRaw = data.readUInt32BE(latOffset);
                const lonRaw = data.readUInt32BE(lonOffset);
                const speed = data[speedOffset];
                const courseInfo = data.readUInt16BE(courseOffset);

                let lat = latRaw / 1800000;
                let lon = lonRaw / 1800000;

                const isSouth = (courseInfo & 0x1000) !== 0;
                const isWest = (courseInfo & 0x2000) !== 0;
                const isAccOn = (courseInfo & 0x0400) !== 0;

                // Indonesia always South & East for this range
                if (isSouth && lat > 0) lat = -lat;
                if (isWest && lon > 0) lon = -lon;

                // Absolute Override for Karawang/Jakarta area if slightly off
                if (lat > 0 && lat < 10) lat = -lat;

                const currentAcc = isAccOn ? "ON" : "OFF";
                if (currentImei) lastAccStatus[currentImei] = currentAcc;

                const payload = {
                    imei: currentImei || "353701096329020",
                    nopol: "T FAZRIAN ABC",
                    lat: parseFloat(lat.toFixed(6)),
                    lon: parseFloat(lon.toFixed(6)),
                    speed: speed,
                    acc: lastAccStatus[currentImei] || currentAcc,
                    relay: lastRelayStatus[currentImei] || "ON",
                    sat: data[10] || 10,
                    time: new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }),
                    alarm: (lastPayloads[currentImei] && lastPayloads[currentImei].alarm) || "Normal"
                };

                if (payload.lat !== 0 && payload.lon !== 0) {
                    lastPayloads[payload.imei] = payload;
                    io.emit('vessel_move', payload);
                    console.log(`📍 LIVE: ${payload.imei} | ${payload.lat}, ${payload.lon} | ACC: ${payload.acc} | Mesin: ${payload.relay}`);
                }
            } catch (e) {
                console.error("Parsing Error:", e.message);
            }
        }
    });

    socket.on('close', () => { if (currentImei) delete activeGpsSockets[currentImei]; });
});

function createCommandPacket(command) {
    const cmdBuffer = Buffer.from(command, 'ascii');
    const body = Buffer.concat([
        Buffer.from([0x80]),
        Buffer.from([cmdBuffer.length + 4]),
        Buffer.from([0x00, 0x00, 0x00, 0x01]), // Server Flag 1
        cmdBuffer,
        Buffer.from([0x00, 0x01])
    ]);
    const length = body.length;
    const p = Buffer.concat([Buffer.from([0x78, 0x78, length]), body]);
    const crcVal = getCRC(Buffer.concat([Buffer.from([length]), body]));
    return Buffer.concat([p, Buffer.from([(crcVal >> 8) & 0xFF, crcVal & 0xFF, 0x0d, 0x0a])]);
}

io.on('connection', (ws) => {
    Object.values(lastPayloads).forEach(p => ws.emit('vessel_move', p));
    ws.on('send_command', (d) => {
        const s = activeGpsSockets[d.imei];
        if (s) {
            s.write(createCommandPacket(d.command));
            console.log(`🔌 Sent [${d.command}] to ${d.imei}`);
            ws.emit('command_res', { status: 'success', msg: 'Sent' });
        }
    });
});

gpsServer.listen(GPS_PORT, '0.0.0.0', () => console.log(`🚀 GPS: ${GPS_PORT}`));
webServer.listen(WEB_PORT, '0.0.0.0', () => console.log(`🌐 WEB: ${WEB_PORT}`));
