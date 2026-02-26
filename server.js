const net = require('net');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');

const app = express();
app.use(cors());

app.get('/', (req, res) => res.send('GPS SERVER IS RUNNING 🚀'));

const webServer = http.createServer(app);
const io = new Server(webServer, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const GPS_PORT = 5023;
const WEB_PORT = 80;

let lastPayloads = {};
try {
    if (fs.existsSync('payloads_db.json')) {
        lastPayloads = JSON.parse(fs.readFileSync('payloads_db.json', 'utf8'));
        console.log('✅ Loaded last payloads from DB:', Object.keys(lastPayloads));
    }
} catch (err) {
    console.error('Failed to load DB', err);
}

function savePayloadsDB() {
    fs.writeFileSync('payloads_db.json', JSON.stringify(lastPayloads, null, 2));
}

const activeGpsSockets = {};
const lastAccStatus = {};
const lastRelayStatus = {};
const pendingRelayConfirmations = {};

let globalSerial = 1;
function getNextSerial() {
    globalSerial = (globalSerial + 1) % 65535;
    if (globalSerial === 0) globalSerial = 1;
    return globalSerial;
}

// CRC-16/IBM
function getCRC(data) {
    let crc = 0xFFFF;
    for (let i = 0; i < data.length; i++) {
        crc ^= data[i];
        for (let j = 0; j < 8; j++) {
            crc = (crc & 1) ? (crc >> 1) ^ 0x8408 : crc >> 1;
        }
    }
    return crc ^ 0xFFFF;
}

// ============================================================
// PARSE BUFFER — Cari posisi packet valid di dalam buffer
// GT06N packet selalu diawali 78 78 atau 79 79
// ============================================================
function findNextPacket(buf) {
    for (let i = 0; i < buf.length - 1; i++) {
        if ((buf[i] === 0x78 && buf[i + 1] === 0x78) ||
            (buf[i] === 0x79 && buf[i + 1] === 0x79)) {
            return i; // posisi start marker
        }
    }
    return -1;
}

function parseBuffer(buf) {
    const packets = [];

    while (buf.length >= 5) {
        // Cari start marker 7878 atau 7979
        const startPos = findNextPacket(buf);

        if (startPos === -1) {
            // Tidak ada start marker — buang semua
            buf = Buffer.alloc(0);
            break;
        }

        if (startPos > 0) {
            // Ada byte sampah sebelum start marker — buang
            buf = buf.slice(startPos);
        }

        const isStd = buf[0] === 0x78;
        const isExt = buf[0] === 0x79;

        let msgLen, totalLen;

        if (isStd) {
            // 78 78 | LEN(1) | ...data... | CRC(2) | 0D 0A
            if (buf.length < 3) break; // tunggu data lebih banyak
            msgLen = buf[2];
            totalLen = 2 + 1 + msgLen + 2 + 2; // start(2)+len(1)+data(msgLen)+crc(2)+stop(2)
        } else if (isExt) {
            // 79 79 | LEN(2) | ...data... | CRC(2) | 0D 0A
            if (buf.length < 4) break;
            msgLen = buf.readUInt16BE(2);
            totalLen = 2 + 2 + msgLen + 2 + 2; // start(2)+len(2)+data(msgLen)+crc(2)+stop(2)
        } else {
            buf = buf.slice(1);
            continue;
        }

        if (buf.length < totalLen) break; // packet belum lengkap, tunggu

        // Ambil packet lengkap
        const packet = buf.slice(0, totalLen);
        buf = buf.slice(totalLen); // potong buffer
        packets.push(packet);
    }

    return { packets, remaining: buf };
}

// ============================================================
// COMMAND PACKET — Format 7878 Standard untuk GT06N
// 78 78 | LEN(1) | 0x80 | FLAG(4) | CMD | SERIAL(2) | CRC(2) | 0D 0A
// LEN = protocol(1) + flag(4) + cmd.len + serial(2)
// CRC = getCRC(dari protocol sampai serial)
// ============================================================
function createCommandPacket(command) {
    const cmdBuf = Buffer.from(command, 'ascii');
    // Instruction Length = Server Flag (4) + Command Length (N) + Language (2)
    const cmdLen = 4 + cmdBuf.length + 2;
    const cmdLenBuf = Buffer.from([cmdLen]);
    const flagBuf = Buffer.from([0x00, 0x00, 0x00, 0x00]);
    const langBuf = Buffer.from([0x00, 0x02]); // English

    const serial = getNextSerial();
    const serialBuf = Buffer.from([(serial >> 8) & 0xFF, serial & 0xFF]);

    // body = 0x80 + InstructionLength(1) + flag(4) + cmd + lang(2) + serial(2)
    const body = Buffer.concat([Buffer.from([0x80]), cmdLenBuf, flagBuf, cmdBuf, langBuf, serialBuf]);

    // MsgLen = body length
    const msgLen = body.length;
    const crc = getCRC(body);

    const packet = Buffer.concat([
        Buffer.from([0x78, 0x78, msgLen]),
        body,
        Buffer.from([(crc >> 8) & 0xFF, crc & 0xFF, 0x0D, 0x0A])
    ]);

    console.log(`[CMD] "${command}" serial=${serial} hex=${packet.toString('hex')}`);
    return packet;
}

// ACK standard
function buildAck(protoId, serial0, serial1) {
    // 78 78 05 [protoId] [s0] [s1] [crc_hi] [crc_lo] 0D 0A
    const body = Buffer.from([0x05, protoId, serial0, serial1]);
    const crc = getCRC(body);
    return Buffer.concat([
        Buffer.from([0x78, 0x78]),
        body,
        Buffer.from([(crc >> 8) & 0xFF, crc & 0xFF, 0x0D, 0x0A])
    ]);
}

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
    let tcpBuf = Buffer.alloc(0);

    socket.on('data', (chunk) => {
        tcpBuf = Buffer.concat([tcpBuf, chunk]);
        const result = parseBuffer(tcpBuf);
        tcpBuf = result.remaining;

        for (const pkt of result.packets) {
            try {
                handlePacket(pkt);
            } catch (e) {
                console.error(`[Packet Error] ${e.message}`);
            }
        }
    });

    function handlePacket(data) {
        const hex = data.toString('hex').toLowerCase();
        const isStd = hex.startsWith('7878');
        const isExt = hex.startsWith('7979');
        const packetId = isStd ? hex.substring(6, 8) : hex.substring(8, 10);

        console.log(`[${new Date().toLocaleTimeString()}] 📦 [${packetId}] ${isExt ? 'EXT' : 'STD'} len=${data.length} | ${hex}`);

        const payloadStart = isStd ? 4 : 5;

        // ── LOGIN (01) ──────────────────────────────────────
        if (packetId === '01') {
            const rawImei = hex.substring(payloadStart * 2, (payloadStart + 8) * 2);
            currentImei = rawImei.startsWith('0') ? rawImei.substring(1) : rawImei;
            activeGpsSockets[currentImei] = socket;

            const s0 = data[data.length - 6];
            const s1 = data[data.length - 5];
            const startByte = isStd ? 0x78 : 0x79;
            // Write ACK
            const ackBody = Buffer.from([0x05, 0x01, s0, s1]);
            const ackCrc = getCRC(ackBody);
            socket.write(Buffer.concat([
                Buffer.from([startByte, startByte]),
                ackBody,
                Buffer.from([(ackCrc >> 8) & 0xFF, ackCrc & 0xFF, 0x0D, 0x0A])
            ]));

            if (lastPayloads[currentImei]) {
                lastPayloads[currentImei].online = true;
                io.emit('vessel_move', lastPayloads[currentImei]);
            }
            console.log(`[${new Date().toLocaleTimeString()}] 🟢 Login: ${currentImei}`);
        }

        // ── HEARTBEAT / STATUS (13, 26, 94) ─────────────────
        else if (['13', '26', '94'].includes(packetId)) {
            const s0 = data[data.length - 6];
            const s1 = data[data.length - 5];
            const startByte = isStd ? 0x78 : 0x79;
            const ackBody = Buffer.from([0x05, parseInt(packetId, 16), s0, s1]);
            const ackCrc = getCRC(ackBody);
            socket.write(Buffer.concat([
                Buffer.from([startByte, startByte]),
                ackBody,
                Buffer.from([(ackCrc >> 8) & 0xFF, ackCrc & 0xFF, 0x0D, 0x0A])
            ]));

            let infoByte = 0;
            if (packetId === '13' || packetId === '26') {
                infoByte = data.length > payloadStart ? data[payloadStart] : 0;
            } else if (packetId === '94') {
                infoByte = data.length > 31 ? data[31] : 0;
            }

            const newAcc = (infoByte & 0x02) ? "ON" : "OFF";
            const newRelay = (infoByte & 0x80) ? "OFF" : "ON";

            if (currentImei) {
                lastAccStatus[currentImei] = newAcc;
                lastRelayStatus[currentImei] = newRelay;

                const pending = pendingRelayConfirmations[currentImei];
                if (pending && pending.targetStatus === newRelay) {
                    io.to(pending.wsId).emit('command_confirmed', {
                        imei: currentImei, relay: newRelay,
                        msg: `Mesin Berhasil Diubah Jadi ${newRelay}`
                    });
                    clearPendingRelay(currentImei);
                    console.log(`[${new Date().toLocaleTimeString()}] ✅ Relay confirmed: ${currentImei} → ${newRelay}`);
                }

                if (lastPayloads[currentImei]) {
                    Object.assign(lastPayloads[currentImei], {
                        acc: newAcc, relay: newRelay, online: true,
                        time: new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })
                    });
                    savePayloadsDB();
                    io.emit('vessel_move', lastPayloads[currentImei]);
                }

                console.log(`[${new Date().toLocaleTimeString()}] ⚡ STATUS: ${currentImei} | ACC: ${newAcc} | Mesin: ${newRelay} | infoByte=0x${infoByte.toString(16).padStart(2, '0')}`);
            }
        }

        // ── LOCATION (12, 22) ────────────────────────────────
        else if (['12', '22'].includes(packetId)) {
            if (data.length < payloadStart + 18) return;

            const latRaw = data.readUInt32BE(payloadStart + 7);
            const lonRaw = data.readUInt32BE(payloadStart + 11);
            const speed = data[payloadStart + 15];
            const courseInfo = data.readUInt16BE(payloadStart + 16);

            let lat = latRaw / 1800000;
            let lon = lonRaw / 1800000;

            if (courseInfo & 0x1000) lat = -Math.abs(lat); // South
            if (courseInfo & 0x2000) lon = -Math.abs(lon); // West
            if (lat > 0 && lat < 15) lat = -lat;           // Koreksi Indonesia

            const isAccOn = (courseInfo & 0x0400) !== 0;
            const currentAcc = isAccOn ? "ON" : "OFF";
            if (currentImei) lastAccStatus[currentImei] = currentAcc;

            const payload = {
                imei: currentImei || "unknown",
                nopol: "T FAZRIAN ABC", // Nopol dummy for logic
                lat: parseFloat(lat.toFixed(6)),
                lon: parseFloat(lon.toFixed(6)),
                speed,
                acc: (currentImei && lastAccStatus[currentImei]) || currentAcc,
                relay: (currentImei && lastRelayStatus[currentImei]) || "ON",
                sat: data[payloadStart + 6] ? data[payloadStart + 6] & 0x0F : 0,
                online: true,
                time: new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }),
                alarm: (currentImei && lastPayloads[currentImei]?.alarm) || "Normal"
            };

            if (Math.abs(payload.lat) < 90 && Math.abs(payload.lon) < 180) {
                if (currentImei) {
                    lastPayloads[payload.imei] = payload;
                    savePayloadsDB();
                }
                io.emit('vessel_move', payload);
            }

            console.log(`[${new Date().toLocaleTimeString()}] 📍 LOC: ${currentImei} | lat:${payload.lat} lon:${payload.lon} spd:${speed}`);
        }

        // ── COMMAND RESPONSE (15) ────────────────────────────
        else if (packetId === '15') {
            try {
                // 2(start) + len(1/2) + proto(1) + instruction_len(1) + flag(4)
                const textStart = isStd ? 9 : 10;
                const textEnd = data.length - 6; // potong serial(2)+crc(2)+stop(2)

                if (textEnd > textStart) {
                    const responseText = data.slice(textStart, textEnd).toString('ascii').trim();
                    console.log(`[${new Date().toLocaleTimeString()}] 📨 Response: "${responseText}"`);

                    if (currentImei && responseText) {
                        io.emit('device_response', { imei: currentImei, text: responseText });

                        if (responseText.toUpperCase().includes('RELAY')) {
                            const pending = pendingRelayConfirmations[currentImei];
                            if (pending) {
                                const isOff = responseText.includes(',1#');
                                const confirmedRelay = isOff ? 'OFF' : 'ON';
                                io.to(pending.wsId).emit('command_confirmed', {
                                    imei: currentImei, relay: confirmedRelay,
                                    msg: `Mesin Berhasil Diubah Jadi ${confirmedRelay}`
                                });
                                clearPendingRelay(currentImei);
                                console.log(`[${new Date().toLocaleTimeString()}] ✅ Relay via 0x15: ${confirmedRelay}`);
                            }
                        }
                    }
                }
            } catch (e) {
                console.error(`[Response Parse Error] ${e.message}`);
            }
        }

        // ── ALARM (16, 19, 98, 2c) ───────────────────────────
        else if (['16', '19', '98', '2c'].includes(packetId)) {
            if (isStd) {
                const s0 = data[data.length - 6];
                const s1 = data[data.length - 5];
                socket.write(buildAck(parseInt(packetId, 16), s0, s1));
            }
            console.log(`[${new Date().toLocaleTimeString()}] 🚨 ALARM [${packetId}]`);
        }

        else {
            console.log(`[${new Date().toLocaleTimeString()}] ❓ Unknown [${packetId}]`);
        }
    }

    socket.on('error', (err) => {
        console.log(`[${new Date().toLocaleTimeString()}] ⚠️ Error (${currentImei || 'unknown'}): ${err.message}`);
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
});

// ============================================================
// WEBSOCKET — CLIENT COMMANDS
// ============================================================
io.on('connection', (ws) => {
    console.log(`[${new Date().toLocaleTimeString()}] 🌐 Client Connected: ${ws.id}`);
    Object.values(lastPayloads).forEach(p => ws.emit('vessel_move', p));

    ws.on('send_command', (d) => {
        if (!d?.imei || !d?.command) {
            ws.emit('command_res', { status: 'error', msg: 'Data tidak valid' });
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
                    console.error(`[Write Error] ${err.message}`);
                    ws.emit('command_res', { status: 'error', msg: 'Gagal kirim perintah' });
                    return;
                }

                ws.emit('command_res', { status: 'success', msg: 'Perintah terkirim, menunggu respon alat...' });

                if (d.command.toUpperCase().includes('RELAY')) {
                    const targetStatus = d.command.includes(',1#') ? 'OFF' : 'ON';
                    clearPendingRelay(d.imei);

                    const timer = setTimeout(() => {
                        if (pendingRelayConfirmations[d.imei]) {
                            const wsId = pendingRelayConfirmations[d.imei].wsId;
                            delete pendingRelayConfirmations[d.imei];
                            io.to(wsId).emit('command_timeout', {
                                imei: d.imei,
                                msg: 'Alat tidak merespons dalam 30 detik.'
                            });
                            console.log(`[${new Date().toLocaleTimeString()}] ⏰ Relay timeout: ${d.imei}`);
                        }
                    }, 30000);

                    pendingRelayConfirmations[d.imei] = { wsId: ws.id, targetStatus, timer };
                }
            });
        } catch (e) {
            console.error(`[Command Error] ${e.message}`);
            ws.emit('command_res', { status: 'error', msg: 'Error buat packet' });
        }
    });

    ws.on('disconnect', () => {
        console.log(`[${new Date().toLocaleTimeString()}] 🌐 Client Disconnected: ${ws.id}`);
        Object.keys(pendingRelayConfirmations).forEach(imei => {
            if (pendingRelayConfirmations[imei]?.wsId === ws.id) clearPendingRelay(imei);
        });
    });
});

// ============================================================
// START
// ============================================================
gpsServer.listen(GPS_PORT, '0.0.0.0', () => console.log(`🚀 GPS TCP Server listening on port ${GPS_PORT}`));
webServer.listen(WEB_PORT, '0.0.0.0', () => console.log(`🌐 Web/WS Server listening on port ${WEB_PORT}`));

process.on('uncaughtException', (err) => console.error(`[UNCAUGHT] ${err.message}\n${err.stack}`));
process.on('unhandledRejection', (reason) => console.error(`[UNHANDLED]`, reason));