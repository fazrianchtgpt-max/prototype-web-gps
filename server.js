const net = require('net');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors'); // Tambahkan CORS

const app = express();
app.use(cors()); // Izinkan semua domain mengakses server ini

const webServer = http.createServer(app);
const io = new Server(webServer, {
    cors: {
        origin: "*", // Wajib agar Frontend di hosting/Vercel bisa konek ke Socket AWS ini
        methods: ["GET", "POST"]
    }
});

const GPS_PORT = 5023;
const WEB_PORT = 3000;

// Storage sementara untuk nyimpen koneksi GPS aktif berdasarkan IMEI
const activeGpsSockets = {};

// --- HELPER: CRC16 UNTUK GT06N ---
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

// --- GPS RECEIVER (TCP) ---
const gpsServer = net.createServer((socket) => {
    let currentImei = null;

    socket.on('data', (data) => {
        const hex = data.toString('hex').toLowerCase();

        // Cek Header 0x7878 atau 0x7979
        const isStandard = hex.startsWith('7878');
        const isExtended = hex.startsWith('7979');

        if (!isStandard && !isExtended) return;

        // Ambil ID Protokol (Byte ke-4)
        // Jika 7878 -> index 6,8. Jika 7979 -> index 6,8 juga (tergantung panjang)
        const packetId = hex.substring(6, 8);

        // 1. LOGIN HANDLING (ID 01)
        if (isStandard && packetId === '01') {
            currentImei = hex.substring(8, 23); // IMEI 15 digit
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
            console.log(`[${new Date().toLocaleTimeString()}] 🟢 Device Login: ${currentImei}`);
        }

        // 2. HEARTBEAT (ID 13)
        else if (isStandard && packetId === '13') {
            const serial = data.slice(data.length - 6, data.length - 4);
            socket.write(Buffer.from([0x78, 0x78, 0x05, 0x13, serial[0], serial[1], 0x00, 0x00, 0x0d, 0x0a]));
            console.log(`[${new Date().toLocaleTimeString()}] 💓 Heartbeat: ${currentImei || 'Unknown'}`);
        }

        // 3. LOCATION DATA (Multiple IDs)
        else if (packetId === '12' || packetId === '22' || packetId === '18' || packetId === '20') {
            try {
                let latHex, lonHex, speedHex;

                if (packetId === '12' || packetId === '22') {
                    latHex = hex.substring(22, 30);
                    lonHex = hex.substring(30, 38);
                    speedHex = hex.substring(38, 40);
                } else if (packetId === '18') {
                    // ID 18 biasanya hexnya lebih panjang, offset kordinat bergeser
                    latHex = hex.substring(28, 36);
                    lonHex = hex.substring(36, 44);
                    speedHex = hex.substring(44, 46);
                } else if (packetId === '20' && isExtended) {
                    // ID 20 (7979) offset beda lagi
                    latHex = hex.substring(34, 42);
                    lonHex = hex.substring(42, 50);
                    speedHex = hex.substring(50, 52);
                }

                if (latHex && lonHex) {
                    let lat = parseInt(latHex, 16) / 1800000;
                    let lon = parseInt(lonHex, 16) / 1800000;
                    if (lat > 0) lat = -lat; // Lintang Selatan (Indonesia)

                    const speed = parseInt(speedHex || "00", 16);

                    const payload = {
                        imei: currentImei || "353701096329020",
                        nopol: "T FAZRIAN ABC",
                        lat: parseFloat(lat.toFixed(6)),
                        lon: parseFloat(lon.toFixed(6)),
                        speed: speed,
                        acc: speed > 0 ? "ON" : "OFF",
                        sat: Math.floor(Math.random() * 5) + 8,
                        time: new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }),
                        alarm: "Normal"
                    };

                    io.emit('vessel_move', payload);
                    console.log(`📍 LIVE: ${payload.nopol} | Lat: ${payload.lat} | Lon: ${payload.lon} | Speed: ${speed} km/h`);
                }
            } catch (e) {
                console.error("Gagal parsing koordinat:", e);
            }
        } else {
            // Log Unhandled packets
            console.log(`[${new Date().toLocaleTimeString()}] 📦 Raw Data (ID: ${packetId}) -> ${hex.substring(0, 40)}...`);
        }
    });

    socket.on('close', () => {
        if (currentImei) delete activeGpsSockets[currentImei];
        console.log("🔴 GPS Disconnected");
    });

    socket.on('error', (err) => { console.log("⚠️ Socket Error:", err.message); });
});

// --- SOCKET.IO ---
io.on('connection', (webSocket) => {
    console.log("🖥️ Dashboard Connected");
    webSocket.on('send_command', (data) => {
        const { imei, command } = data;
        const targetSocket = activeGpsSockets[imei];
        if (targetSocket) {
            targetSocket.write(`DYD,${command === 'RELAY,1#' ? '1' : '0'}#`);
            webSocket.emit('command_res', { status: 'success', msg: 'Sent!' });
        }
    });
});

gpsServer.listen(GPS_PORT, '0.0.0.0', () => console.log(`🚀 GPS Listener: ${GPS_PORT}`));
webServer.listen(WEB_PORT, '0.0.0.0', () => console.log(`🌐 Web/Socket Server: Port ${WEB_PORT}`));
