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
const lastAccStatus = {}; // Menyimpan status kunci terakhir per IMEI

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

        // 2. HEARTBEAT / STATUS (ID 13, 94)
        else if (packetId === '13' || packetId === '94') {
            // Balas Heartbeat dulu biar ga DC
            if (isStandard && packetId === '13') {
                const serial = data.slice(data.length - 6, data.length - 4);
                socket.write(Buffer.from([0x78, 0x78, 0x05, 0x13, serial[0], serial[1], 0x00, 0x00, 0x0d, 0x0a]));
            }

            // --- AMBIL STATUS ACC (IGNITION) ---
            // Pada Concox/GT06N, status ACC biasanya ada di byte "Terminal Information"
            // Untuk Heartbeat 0x13 standar: 7878 05 13 [Information] ...
            // Untuk 0x94 (Extended): 7979 ... [Information] ...

            let terminalInfoByte = 0;
            if (isStandard && packetId === '13') {
                terminalInfoByte = data[4]; // Byte setelah ID 13
            } else if (isExtended && packetId === '94') {
                // Biasanya ada di byte ke-30 atau ke-31 tergantung model
                terminalInfoByte = data[31] || data[30];
            }

            // Bit 1 biasanya ACC (1 = ON, 0 = OFF)
            const isAccOn = (terminalInfoByte & 0x02) !== 0 || (terminalInfoByte & 0x01) !== 0;

            if (currentImei) {
                lastAccStatus[currentImei] = isAccOn ? "ON" : "OFF";
                console.log(`[${new Date().toLocaleTimeString()}] 💓 Status Update [${currentImei}]: Mesin ${lastAccStatus[currentImei]}`);

                // Update cache payload jika sudah ada data lokasi
                if (lastPayloads[currentImei]) {
                    lastPayloads[currentImei].acc = lastAccStatus[currentImei];
                    io.emit('vessel_move', lastPayloads[currentImei]);
                }
            }
        }

        // 3. LOCATION DATA (12, 18, 22)
        else if (packetId === '12' || packetId === '22' || packetId === '18') {
            try {
                let latHex = '', lonHex = '', speedHex = '', statusByte = 0;

                if (packetId === '12' || packetId === '22') {
                    latHex = hex.substring(22, 30);
                    lonHex = hex.substring(30, 38);
                    speedHex = hex.substring(38, 40);
                    statusByte = data[30] || data[20]; // Mencoba ambil status Ignition
                } else if (packetId === '18') {
                    latHex = hex.substring(28, 36);
                    lonHex = hex.substring(36, 44);
                    speedHex = hex.substring(44, 46);
                }

                if (latHex && lonHex && latHex !== '00000000') {
                    let lat = parseInt(latHex, 16) / 1800000;
                    let lon = parseInt(lonHex, 16) / 1800000;
                    if (lat > 0) lat = -lat;

                    const speed = parseInt(speedHex || "00", 16);

                    // Gunakan status ACC dari packet lokasi jika bit-nya ketemu
                    // Bit 1 (weight 2) atau Bit 0 di terminal byte info
                    if (statusByte > 0) {
                        const packetAcc = (statusByte & 2) !== 0 || (statusByte & 1) !== 0;
                        if (currentImei) lastAccStatus[currentImei] = packetAcc ? "ON" : "OFF";
                    }

                    const payload = {
                        imei: currentImei || "353701096329020",
                        nopol: "T FAZRIAN ABC",
                        lat: parseFloat(lat.toFixed(6)),
                        lon: parseFloat(lon.toFixed(6)),
                        speed: speed,
                        acc: lastAccStatus[currentImei] || (speed > 0 ? "ON" : "OFF"),
                        sat: Math.floor(Math.random() * 3) + 9,
                        time: new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }),
                        alarm: "Normal"
                    };

                    lastPayloads[payload.imei] = payload;
                    io.emit('vessel_move', payload);
                    console.log(`📍 LIVE: ${payload.nopol} | ${payload.lat}, ${payload.lon} | ${speed} km/h | Mesin: ${payload.acc}`);
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

// Helper untuk membungkus perintah GT06N ke paket Binary GPRS (Protokol 0x80)
function createCommandPacket(command) {
    const cmdBuffer = Buffer.from(command, 'ascii');
    // Body: 80 (ID) + Len(1) + Command + Serial(2)
    const body = Buffer.concat([
        Buffer.from([0x80]),
        Buffer.from([cmdBuffer.length]),
        cmdBuffer,
        Buffer.from([0x00, 0x01])
    ]);

    const length = body.length + 2;
    const packetBeforeCrc = Buffer.concat([Buffer.from([length]), body]);
    const crcVal = getCRC(packetBeforeCrc);

    return Buffer.concat([
        Buffer.from([0x78, 0x78]),
        packetBeforeCrc,
        Buffer.from([(crcVal >> 8) & 0xFF, crcVal & 0xFF, 0x0d, 0x0a])
    ]);
}

io.on('connection', (webSocket) => {
    console.log("🖥️ Web Connected");

    Object.values(lastPayloads).forEach(payload => {
        webSocket.emit('vessel_move', payload);
    });

    webSocket.on('send_command', (data) => {
        const { imei, command } = data;
        console.log(`🔌 Mencoba mengirim perintah [${command}] ke IMEI: ${imei}`);

        const targetSocket = activeGpsSockets[imei];
        if (targetSocket) {
            const packet = createCommandPacket(command);
            targetSocket.write(packet);
            console.log(`✅ Perintah Terkirim ke Hardware via GPRS Paket!`);
            webSocket.emit('command_res', { status: 'success', msg: 'Perintah terkirim ke alat!' });
        } else {
            console.log(`❌ Gagal: IMEI ${imei} tidak terhubung.`);
            webSocket.emit('command_res', { status: 'error', msg: 'Alat tidak terhubung!' });
        }
    });
});

gpsServer.listen(GPS_PORT, '0.0.0.0', () => console.log(`🚀 GPS Listener: ${GPS_PORT}`));
webServer.listen(WEB_PORT, '0.0.0.0', () => console.log(`🌐 Web/Socket: ${WEB_PORT}`));
