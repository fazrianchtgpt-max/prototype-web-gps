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

// ============================================================
// COMMAND PACKET GT06N — Format Standard 7878
// ============================================================
// GT06N menerima perintah server dalam format STANDARD (7878):
//
// 78 78 | LEN(1) | 0x80 | FLAG(4) | COMMAND(n) | SERIAL(2) | CRC(2) | 0D 0A
//
// LEN = jumlah byte dari: protocol(1) + flag(4) + command(n) + serial(2)
// CRC = dihitung dari: protocol(0x80) + flag(4) + command + serial(2)
// ============================================================
function createCommandPacket(command) {
    const cmdBuffer = Buffer.from(command, 'ascii');
    const serialNum = getNextSerial();
    const serialBuf = Buffer.from([(serialNum >> 8) & 0xFF, serialNum & 0xFF]);
    const serverFlag = Buffer.from([0x00, 0x00, 0x00, 0x00]);

    // Bagian setelah header (untuk CRC dan length)
    // = protocol(0x80) + flag(4) + cmd + serial(2)
    const body = Buffer.concat([
        Buffer.from([0x80]),
        serverFlag,
        cmdBuffer,
        serialBuf
    ]);

    // LEN = body.length (protocol + flag + cmd + serial)
    const msgLen = body.length;

    // CRC dihitung dari seluruh body
    const crcVal = getCRC(body);

    // Packet final
    const packet = Buffer.concat([
        Buffer.from([0x78, 0x78]),                              // Start (standard)
        Buffer.from([msgLen]),                                   // 1-byte length
        body,                                                    // Protocol + Flag + Command + Serial
        Buffer.from([(crcVal >> 8) & 0xFF, crcVal & 0xFF]),     // CRC
        Buffer.from([0x0D, 0x0A])                               // Stop
    ]);

    console.log(`[DEBUG] CMD="${command}" serial=${serialNum} hex=${packet.toString('hex')}`);
    return packet;
}

// Build ACK packet standard (7878)
function buildStandardAck(packetIdByte, serial0, serial1) {
    // Format: 78 78 05 [protoId] [serial_hi] [serial_lo] [crc_hi] [crc_lo] 0D 0A
    const forCRC = Buffer.from([0x05, packetIdByte, serial0, serial1]);
    const crcVal = getCRC(forCRC);
    return Buffer.concat([
        Buffer.from([0x78, 0x78]),
        forCRC,
        Buffer.from([(crcVal >> 8) & 0xFF, crcVal & 0xFF, 0x0D, 0x0A])
    ]);
}

// Bersihkan pending relay
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
    let tcpBuffer = Buffer.alloc(0); // Buffer untuk handle TCP fragmentation

    socket.on('data', (chunk) => {
        try {
            tcpBuffer = Buffer.concat([tcpBuffer, chunk]);

            // Proses semua packet lengkap dalam buffer
            while (tcpBuffer.length >= 4) {
                let totalLen = 0;

                if (tcpBuffer[0] === 0x78 && tcpBuffer[1] === 0x78) {
                    // Standard packet: 78 78 | LEN(1) | ... | CRC(2) | 0D 0A
                    const msgLen = tcpBuffer[2];
                    totalLen = msgLen + 7; // start(2) + len(1) + msgLen + crc(2) + stop(2)
                    if (tcpBuffer.length < totalLen) break;

                } else if (tcpBuffer[0] === 0x79 && tcpBuffer[1] === 0x79) {
                    // Extended packet: 79 79 | LEN(2) | ... | CRC(2) | 0D 0A
                    if (tcpBuffer.length < 4) break;
                    const msgLen = tcpBuffer.readUInt16BE(2);
                    totalLen = msgLen + 8; // start(2) + len(2) + msgLen + crc(2) + stop(2)
                    if (tcpBuffer.length < totalLen) break;

                } else {
                    // Bukan packet valid, buang byte dan coba lagi
                    console.log(`[WARN] Invalid byte 0x${tcpBuffer[0].toString(16)} — discarding`);
                    tcpBuffer = tcpBuffer.slice(1);
                    continue;
                }

                const packetData = tcpBuffer.slice(0, totalLen);
                tcpBuffer = tcpBuffer.slice(totalLen);
                processPacket(socket, packetData);
            }
        } catch (e) {
            console.error(`[Socket Data Error] ${e.message}`);
            tcpBuffer = Buffer.alloc(0);
        }
    });

    socket.on('error', (err) => {
        console.log(`[${new Date().toLocaleTimeString()}] ⚠️ Socket Error (${currentImei || 'unknown'}): ${err.message}`);
    });

    socket.on('close', () => {
        if (currentImei) {
            delete activeGpsSockets[currentImei];
            clearPendingRelay(currentImei);
            if (lastPayloads[currentImei]) {
                lastPayloads[currentImei].online = false;
                io.emit('vessel_move', lastPayloads[currentImei]);
            }
            console.log(`[${new Date().toLocaleTimeString()}] 🔴 Disconnect: ${currentImei}`);
        }
    });

    // Proses satu packet lengkap
    function processPacket(socket, data) {
        const hex = data.toString('hex').toLowerCase();
        const isStandard = hex.startsWith('7878');
        const isExtended = hex.startsWith('7979');
        const packetId = isStandard ? hex.substring(6, 8) : hex.substring(8, 10);

        console.log(`[${new Date().toLocaleTimeString()}] 📦 [${packetId}] ${isExtended ? 'EXT' : 'STD'} len=${data.length} | ${hex.substring(0, 50)}`);

        // ─── 1. LOGIN (0x01) ───────────────────────────────
        if (isStandard && packetId === '01') {
            const rawImei = hex.substring(8, 24);
            currentImei = rawImei.startsWith('0') ? rawImei.substring(1) : rawImei;
            activeGpsSockets[currentImei] = socket;

            const serial0 = data[data.length - 6];
            const serial1 = data[data.length - 5];
            socket.write(buildStandardAck(0x01, serial0, serial1));

            if (lastPayloads[currentImei]) {
                lastPayloads[currentImei].online = true;
                io.emit('vessel_move', lastPayloads[currentImei]);
            }
            console.log(`[${new Date().toLocaleTimeString()}] 🟢 Login: ${currentImei}`);
        }

        // ─── 2. HEARTBEAT / STATUS (0x13, 0x26, 0x94) ─────
        else if (packetId === '13' || packetId === '26' || packetId === '94') {
            if (isStandard) {
                const serial0 = data[data.length - 6];
                const serial1 = data[data.length - 5];
                const protoIdByte = parseInt(packetId, 16);
                socket.write(buildStandardAck(protoIdByte, serial0, serial1));
            }

            let infoByte = 0;
            if (packetId === '13' || packetId === '26') {
                infoByte = data.length > 4 ? data[4] : 0;
            } else if (packetId === '94') {
                infoByte = data.length > 31 ? data[31] : 0;
            }

            const isAccOn = (infoByte & 0x02) !== 0;
            const isRelayCut = (infoByte & 0x80) !== 0;
            const newAcc = isAccOn ? "ON" : "OFF";
            const newRelay = isRelayCut ? "OFF" : "ON";

            if (currentImei) {
                lastAccStatus[currentImei] = newAcc;
                lastRelayStatus[currentImei] = newRelay;

                // Cek pending relay confirmation dari status heartbeat
                const pending = pendingRelayConfirmations[currentImei];
                if (pending && pending.targetStatus === newRelay) {
                    io.to(pending.wsId).emit('command_confirmed', {
                        imei: currentImei,
                        relay: newRelay,
                        msg: `Mesin Berhasil Diubah Jadi ${newRelay}`
                    });
                    clearPendingRelay(currentImei);
                    console.log(`[${new Date().toLocaleTimeString()}] ✅ Relay confirmed via heartbeat: ${currentImei} → ${newRelay}`);
                }

                if (lastPayloads[currentImei]) {
                    Object.assign(lastPayloads[currentImei], {
                        acc: newAcc, relay: newRelay, online: true,
                        time: new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })
                    });
                    io.emit('vessel_move', lastPayloads[currentImei]);
                }

                console.log(`[${new Date().toLocaleTimeString()}] ⚡ STATUS: ${currentImei} | ACC: ${newAcc} | Mesin: ${newRelay} | infoByte: 0x${infoByte.toString(16).padStart(2, '0')}`);
            }
        }

        // ─── 3. LOCATION (0x12, 0x22) ─────────────────────
        else if (packetId === '12' || packetId === '22') {
            try {
                if (data.length < 22) {
                    console.log(`[WARN] Location packet pendek: ${data.length} bytes`);
                    return;
                }

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
                if (lat > 0 && lat < 15) lat = -lat; // Koreksi Indonesia

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
                    alarm: (currentImei && lastPayloads[currentImei] && lastPayloads[currentImei].alarm) || "Normal"
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

        // ─── 4. COMMAND RESPONSE dari alat (0x15) ─────────
        else if (packetId === '15') {
            console.log(`[${new Date().toLocaleTimeString()}] 📥 CMD Response RAW: ${hex}`);

            try {
                let responseText = '';

                if (isStandard) {
                    // 78 78 | LEN(1) | 0x15 | FLAG(4) | TEXT | SERIAL(2) | CRC(2) | 0D0A
                    // Offset text: 2(start) + 1(len) + 1(proto) + 4(flag) = offset 8
                    if (data.length > 12) {
                        responseText = data.slice(8, data.length - 6).toString('ascii').trim();
                    }
                } else {
                    // 79 79 | LEN(2) | 0x15 | FLAG(4) | TEXT | SERIAL(2) | CRC(2) | 0D0A
                    // Offset text: 2(start) + 2(len) + 1(proto) + 4(flag) = offset 9
                    if (data.length > 13) {
                        responseText = data.slice(9, data.length - 6).toString('ascii').trim();
                    }
                }

                if (responseText) {
                    console.log(`[${new Date().toLocaleTimeString()}] 📨 Response Text: "${responseText}"`);
                    if (currentImei) {
                        io.emit('device_response', { imei: currentImei, text: responseText });

                        // Konfirmasi relay dari response text alat
                        if (responseText.toUpperCase().includes('RELAY')) {
                            const pending = pendingRelayConfirmations[currentImei];
                            if (pending) {
                                const isOff = responseText.includes(',1#') || responseText.toUpperCase().includes('RELAY OFF');
                                const confirmedRelay = isOff ? 'OFF' : 'ON';
                                io.to(pending.wsId).emit('command_confirmed', {
                                    imei: currentImei,
                                    relay: confirmedRelay,
                                    msg: `Mesin Berhasil Diubah Jadi ${confirmedRelay}`
                                });
                                clearPendingRelay(currentImei);
                                console.log(`[${new Date().toLocaleTimeString()}] ✅ Relay confirmed via 0x15: ${currentImei} → ${confirmedRelay}`);
                            }
                        }
                    }
                }
            } catch (e) {
                console.error(`[Response Parse Error] ${e.message}`);
            }
        }

        // ─── 5. ALARM (0x16, 0x19, 0x98, 0x2C) ───────────
        else if (['16', '19', '98', '2c'].includes(packetId)) {
            if (isStandard) {
                const serial0 = data[data.length - 6];
                const serial1 = data[data.length - 5];
                socket.write(buildStandardAck(parseInt(packetId, 16), serial0, serial1));
            }
            console.log(`[${new Date().toLocaleTimeString()}] 🚨 ALARM [${packetId}]: ${hex}`);
        }

        // ─── Unknown packet ────────────────────────────────
        else {
            console.log(`[${new Date().toLocaleTimeString()}] ❓ Unknown [${packetId}]: ${hex}`);
        }
    }
});

// ============================================================
// WEBSOCKET — CLIENT COMMANDS
// ============================================================
io.on('connection', (ws) => {
    console.log(`[${new Date().toLocaleTimeString()}] 🌐 Client Connected: ${ws.id}`);
    Object.values(lastPayloads).forEach(p => ws.emit('vessel_move', p));

    ws.on('send_command', (d) => {
        if (!d || !d.imei || !d.command) {
            ws.emit('command_res', { status: 'error', msg: 'Data perintah tidak valid' });
            return;
        }

        const s = activeGpsSockets[d.imei];
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

                console.log(`[${new Date().toLocaleTimeString()}] 🔌 Sent [${d.command}] → ${d.imei}`);
                ws.emit('command_res', { status: 'success', msg: 'Perintah terkirim, menunggu respon alat...' });

                // Setup relay confirmation timeout
                if (d.command.toUpperCase().includes('RELAY')) {
                    const targetStatus = d.command.includes(',1#') ? 'OFF' : 'ON';
                    clearPendingRelay(d.imei);

                    const timer = setTimeout(() => {
                        if (pendingRelayConfirmations[d.imei]) {
                            const wsId = pendingRelayConfirmations[d.imei].wsId;
                            delete pendingRelayConfirmations[d.imei];
                            io.to(wsId).emit('command_timeout', {
                                imei: d.imei,
                                msg: 'Alat tidak merespons dalam 30 detik. Periksa sinyal dan coba lagi.'
                            });
                            console.log(`[${new Date().toLocaleTimeString()}] ⏰ Relay timeout: ${d.imei}`);
                        }
                    }, 30000);

                    pendingRelayConfirmations[d.imei] = { wsId: ws.id, targetStatus, timer };
                }
            });

        } catch (e) {
            console.error(`[Command Error] ${e.message}`);
            ws.emit('command_res', { status: 'error', msg: 'Error saat membuat packet' });
        }
    });

    ws.on('disconnect', () => {
        console.log(`[${new Date().toLocaleTimeString()}] 🌐 Client Disconnected: ${ws.id}`);
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
// GLOBAL ERROR HANDLER
// ============================================================
process.on('uncaughtException', (err) => {
    console.error(`[UNCAUGHT EXCEPTION] ${err.message}`);
    console.error(err.stack);
});

process.on('unhandledRejection', (reason) => {
    console.error(`[UNHANDLED REJECTION]`, reason);
});