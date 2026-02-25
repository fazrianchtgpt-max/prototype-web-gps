const net = require('net');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

app.get('/', (req, res) => res.send('GPS SERVER IS RUNNING 🚀'));

const webServer = http.createServer(app);
const io = new Server(webServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const GPS_PORT = 5023;
const WEB_PORT = 80;

const activeGpsSockets = {};
const lastPayloads = {};
const lastAccStatus = {};
const lastRelayStatus = {};
const pendingRelayConfirmations = {}; // imei -> { wsId, targetStatus, timer }

let globalSerial = 1;
function getNextSerial() {
    globalSerial = (globalSerial + 1) % 65535;
    if (globalSerial === 0) globalSerial = 1;
    return globalSerial;
}

// CRC-16/IBM (GT06N Standard)
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

// ✅ FIXED: createCommandPacket menggunakan Extended Packet 0x7979
// GT06N command packet format:
// 7979 | length(2) | protocol(0x80) | serverFlag(4) | command | serial(2) | CRC(2) | 0D0A
function createCommandPacket(command) {
    const cmdBuffer = Buffer.from(command, 'ascii');
    const serialNum = getNextSerial();
    const serverFlag = Buffer.from([0x00, 0x00, 0x00, 0x00]);
    const serialBuf = Buffer.from([(serialNum >> 8) & 0xFF, serialNum & 0xFF]);

    // Content = protocolId(1) + serverFlag(4) + cmd + serial(2)
    const content = Buffer.concat([
        Buffer.from([0x80]),  // Protocol ID
        serverFlag,
        cmdBuffer,
        serialBuf
    ]);

    const length = content.length;
    const crcVal = getCRC(content);

    const packet = Buffer.concat([
        Buffer.from([0x79, 0x79]),                              // Extended Start
        Buffer.from([(length >> 8) & 0xFF, length & 0xFF]),     // 2-byte length
        content,                                                 // Protocol + body
        Buffer.from([(crcVal >> 8) & 0xFF, crcVal & 0xFF]),     // CRC
        Buffer.from([0x0D, 0x0A])                               // Stop bits
    ]);

    return packet;
}

// ✅ Helper: Build login ACK response packet (7878)
function buildStandardAck(packetId, serial0, serial1) {
    const body = Buffer.from([0x05, packetId, serial0, serial1]);
    const crcVal = getCRC(body);
    return Buffer.concat([
        Buffer.from([0x78, 0x78]),
        body,
        Buffer.from([(crcVal >> 8) & 0xFF, crcVal & 0xFF, 0x0D, 0x0A])
    ]);
}

// ✅ Helper: Clear pending relay confirmation dengan timeout
function clearPendingRelay(imei) {
    if (pendingRelayConfirmations[imei]) {
        clearTimeout(pendingRelayConfirmations[imei].timer);
        delete pendingRelayConfirmations[imei];
    }
}

// ============================================================
// GPS TCP SERVER
// ============================================================
const gpsServer = net.createServer((socket) => {
    let currentImei = null;

    socket.on('data', (data) => {
        try {
            const hex = data.toString('hex').toLowerCase();
            const isStandard = hex.startsWith('7878');
            const isExtended = hex.startsWith('7979');
            if (!isStandard && !isExtended) return;

            const packetId = isStandard ? hex.substring(6, 8) : hex.substring(8, 10);

            // ─────────────────────────────────────────────
            // 1. LOGIN PACKET (0x01)
            // ─────────────────────────────────────────────
            if (isStandard && packetId === '01') {
                const rawImei = hex.substring(8, 24);
                currentImei = rawImei.startsWith('0') ? rawImei.substring(1) : rawImei;
                activeGpsSockets[currentImei] = socket;

                // ACK login
                const serial0 = data[data.length - 6];
                const serial1 = data[data.length - 5];
                const resp = buildStandardAck(0x01, serial0, serial1);
                socket.write(resp);

                if (lastPayloads[currentImei]) {
                    lastPayloads[currentImei].online = true;
                    io.emit('vessel_move', lastPayloads[currentImei]);
                }
                console.log(`[${new Date().toLocaleTimeString()}] 🟢 Login: ${currentImei}`);
            }

            // ─────────────────────────────────────────────
            // 2. HEARTBEAT / STATUS (0x13, 0x26, 0x94)
            // ─────────────────────────────────────────────
            else if (packetId === '13' || packetId === '26' || packetId === '94') {

                // ACK untuk heartbeat standard
                if (isStandard && (packetId === '13' || packetId === '26')) {
                    const serial0 = data[data.length - 6];
                    const serial1 = data[data.length - 5];
                    const protoId = parseInt(packetId, 16);
                    const body = Buffer.from([0x05, protoId, serial0, serial1]);
                    const crcVal = getCRC(body);
                    socket.write(Buffer.concat([
                        Buffer.from([0x78, 0x78]),
                        body,
                        Buffer.from([(crcVal >> 8) & 0xFF, crcVal & 0xFF, 0x0D, 0x0A])
                    ]));
                }

                let infoByte;
                if (packetId === '13' || packetId === '26') {
                    infoByte = data[4];
                } else {
                    // 0x94 extended status — offset 31
                    infoByte = data.length > 31 ? data[31] : 0;
                }

                const isAccOn = (infoByte & 0x02) !== 0;
                const isRelayCut = (infoByte & 0x80) !== 0;

                const newAcc = isAccOn ? "ON" : "OFF";
                const newRelay = isRelayCut ? "OFF" : "ON";

                if (currentImei) {
                    lastAccStatus[currentImei] = newAcc;
                    lastRelayStatus[currentImei] = newRelay;

                    // ✅ Cek pending relay confirmation
                    const pending = pendingRelayConfirmations[currentImei];
                    if (pending && pending.targetStatus === newRelay) {
                        io.to(pending.wsId).emit('command_confirmed', {
                            imei: currentImei,
                            relay: newRelay,
                            msg: `Mesin Berhasil Diubah Jadi ${newRelay}`
                        });
                        clearPendingRelay(currentImei);
                    }

                    if (lastPayloads[currentImei]) {
                        Object.assign(lastPayloads[currentImei], {
                            acc: newAcc,
                            relay: newRelay,
                            online: true,
                            time: new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })
                        });
                        io.emit('vessel_move', lastPayloads[currentImei]);
                    }
                    console.log(`[${new Date().toLocaleTimeString()}] ⚡ STATUS: ${currentImei} | ACC: ${newAcc} | Mesin: ${newRelay}`);
                }
            }

            // ─────────────────────────────────────────────
            // 3. LOCATION PACKET (0x12, 0x22)
            // ─────────────────────────────────────────────
            else if (packetId === '12' || packetId === '22') {
                try {
                    // Pastikan data cukup panjang sebelum baca
                    if (data.length < 22) return;

                    const latRaw = data.readUInt32BE(11);
                    const lonRaw = data.readUInt32BE(15);
                    const speed = data[19];
                    const courseInfo = data.readUInt16BE(20);

                    let lat = latRaw / 1800000;
                    let lon = lonRaw / 1800000;

                    const isSouth = (courseInfo & 0x1000) !== 0;
                    const isWest = (courseInfo & 0x2000) !== 0;
                    const isAccOn = (courseInfo & 0x0400) !== 0;

                    if (isSouth && lat > 0) lat = -lat;
                    if (isWest && lon > 0) lon = -lon;
                    // Koreksi koordinat untuk Indonesia (selatan equator)
                    if (lat > 0 && lat < 15) lat = -lat;

                    const currentAcc = isAccOn ? "ON" : "OFF";
                    if (currentImei) lastAccStatus[currentImei] = currentAcc;

                    const payload = {
                        imei: currentImei || "unknown",
                        nopol: "T FAZRIAN ABC",
                        lat: parseFloat(lat.toFixed(6)),
                        lon: parseFloat(lon.toFixed(6)),
                        speed: speed,
                        acc: (currentImei && lastAccStatus[currentImei]) || currentAcc,
                        relay: (currentImei && lastRelayStatus[currentImei]) || "ON",
                        sat: data[10] || 10,
                        online: true,
                        time: new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }),
                        alarm: (lastPayloads[currentImei] && lastPayloads[currentImei].alarm) || "Normal"
                    };

                    if (Math.abs(payload.lat) < 90 && Math.abs(payload.lon) < 180) {
                        if (currentImei) lastPayloads[payload.imei] = payload;
                        io.emit('vessel_move', payload);
                    }

                    console.log(`[${new Date().toLocaleTimeString()}] 📍 LOC: ${currentImei} | lat:${payload.lat} lon:${payload.lon} spd:${speed}`);
                } catch (e) {
                    console.error(`[Location Parse Error] ${e.message}`);
                }
            }

            // ─────────────────────────────────────────────
            // 4. COMMAND RESPONSE (0x15)
            // ─────────────────────────────────────────────
            else if (packetId === '15') {
                console.log(`[${new Date().toLocaleTimeString()}] 📥 Hardware Response: ${hex}`);

                // ✅ Parse response text dari alat (jika ada)
                // Format: 7979 | len(2) | 0x15 | serverFlag(4) | response_text | serial(2) | CRC | 0D0A
                try {
                    if (isExtended && data.length > 9) {
                        const responseText = data.slice(7, data.length - 6).toString('ascii').trim();
                        console.log(`[${new Date().toLocaleTimeString()}] 📨 Response Text: ${responseText}`);
                        if (currentImei) {
                            io.emit('device_response', { imei: currentImei, text: responseText });
                        }
                    }
                } catch (e) { /* abaikan parse error response */ }
            }

        } catch (e) {
            console.error(`[Socket Data Error] ${e.message}`);
        }
    });

    socket.on('error', (err) => {
        if (currentImei) {
            console.log(`[${new Date().toLocaleTimeString()}] ⚠️ Socket Error (${currentImei}): ${err.message}`);
        }
        // Jangan crash, biarkan socket close secara natural
    });

    socket.on('close', () => {
        if (currentImei) {
            delete activeGpsSockets[currentImei];
            clearPendingRelay(currentImei); // ✅ Bersihkan pending confirmation
            if (lastPayloads[currentImei]) {
                lastPayloads[currentImei].online = false;
                io.emit('vessel_move', lastPayloads[currentImei]);
            }
            console.log(`[${new Date().toLocaleTimeString()}] 🔴 Disconnect: ${currentImei}`);
        }
    });
});

// ============================================================
// WEBSOCKET — CLIENT COMMANDS
// ============================================================
io.on('connection', (ws) => {
    console.log(`[${new Date().toLocaleTimeString()}] 🌐 Client WS Connected: ${ws.id}`);

    // Kirim semua data terakhir ke client yang baru connect
    Object.values(lastPayloads).forEach(p => ws.emit('vessel_move', p));

    ws.on('send_command', (d) => {
        // Validasi input
        if (!d || !d.imei || !d.command) {
            ws.emit('command_res', { status: 'error', msg: 'Data perintah tidak valid' });
            return;
        }

        const s = activeGpsSockets[d.imei];

        // ✅ Cek socket masih hidup dan tidak destroyed
        if (!s || s.destroyed) {
            ws.emit('command_res', { status: 'error', msg: 'Device Offline' });
            return;
        }

        try {
            const packet = createCommandPacket(d.command);

            s.write(packet, (err) => {
                if (err) {
                    console.error(`[Write Error] ${d.imei}: ${err.message}`);
                    ws.emit('command_res', { status: 'error', msg: 'Gagal mengirim perintah ke alat' });
                    return;
                }

                console.log(`[${new Date().toLocaleTimeString()}] 🔌 Sent [${d.command}] to ${d.imei}`);
                ws.emit('command_res', { status: 'success', msg: 'Perintah terkirim, menunggu respon alat...' });

                // ✅ Setup pending relay confirmation dengan TIMEOUT
                if (d.command.toUpperCase().includes('RELAY')) {
                    // RELAY,1# = cut engine (OFF), RELAY,0# = restore (ON)
                    const targetStatus = d.command.includes(',1#') ? 'OFF' : 'ON';

                    // Hapus pending lama jika ada
                    clearPendingRelay(d.imei);

                    // Set timeout 20 detik — jika alat tidak respons
                    const timer = setTimeout(() => {
                        if (pendingRelayConfirmations[d.imei]) {
                            delete pendingRelayConfirmations[d.imei];
                            ws.emit('command_timeout', {
                                imei: d.imei,
                                msg: 'Alat tidak merespons dalam 20 detik. Coba lagi.'
                            });
                            console.log(`[${new Date().toLocaleTimeString()}] ⏰ Relay timeout: ${d.imei}`);
                        }
                    }, 20000);

                    pendingRelayConfirmations[d.imei] = {
                        wsId: ws.id,
                        targetStatus,
                        timer
                    };
                }
            });

        } catch (e) {
            console.error(`[Command Error] ${e.message}`);
            ws.emit('command_res', { status: 'error', msg: 'Error saat membuat packet perintah' });
        }
    });

    ws.on('disconnect', () => {
        console.log(`[${new Date().toLocaleTimeString()}] 🌐 Client WS Disconnected: ${ws.id}`);
        // Bersihkan pending relay milik ws ini agar tidak menggantung
        Object.keys(pendingRelayConfirmations).forEach(imei => {
            if (pendingRelayConfirmations[imei].wsId === ws.id) {
                clearPendingRelay(imei);
            }
        });
    });
});

// ============================================================
// START SERVERS
// ============================================================
gpsServer.listen(GPS_PORT, '0.0.0.0', () => {
    console.log(`🚀 GPS TCP Server listening on port ${GPS_PORT}`);
});

webServer.listen(WEB_PORT, '0.0.0.0', () => {
    console.log(`🌐 Web/WS Server listening on port ${WEB_PORT}`);
});

// ============================================================
// ✅ GLOBAL ERROR HANDLER — Cegah server crash
// ============================================================
process.on('uncaughtException', (err) => {
    console.error(`[UNCAUGHT EXCEPTION] ${err.message}`);
    console.error(err.stack);
    // Server tetap jalan, tidak crash
});

process.on('unhandledRejection', (reason, promise) => {
    console.error(`[UNHANDLED REJECTION]`, reason);
    // Server tetap jalan, tidak crash
});