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

        // 1. LOGIN HANDLING (ID 01)
        if (hex.startsWith('7878') && hex.substring(6, 8) === '01') {
            currentImei = hex.substring(8, 24);
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
        else if (hex.startsWith('7878') && packetId === '13') {
            const serial = data.slice(data.length - 6, data.length - 4);
            socket.write(Buffer.from([0x78, 0x78, 0x05, 0x13, serial[0], serial[1], 0x00, 0x00, 0x0d, 0x0a]));
            console.log(`[${new Date().toLocaleTimeString()}] 💓 Heartbeat: ${currentImei || 'Unknown'} - Alat Masih Aktif/Standby`);
        }

        // 3. LOCATION DATA (ID 12 atau 22)
        else if (hex.startsWith('7878') && (packetId === '12' || packetId === '22')) {
            try {
                const latHex = hex.substring(22, 30);
                const lonHex = hex.substring(30, 38);
                const speedHex = hex.substring(38, 40);

                let lat = parseInt(latHex, 16) / 1800000;
                let lon = parseInt(lonHex, 16) / 1800000;
                if (lat > 0) lat = -lat; // Lintang Selatan (Indonesia)

                const speed = parseInt(speedHex, 16);

                // Siapkan data untuk Dashboard (Pastikan tipe data lat/lon number)
                const payload = {
                    imei: currentImei || "353701096329020",
                    nopol: "T 5670 OP",
                    lat: parseFloat(lat.toFixed(6)), // Ubah string kembali jadi number
                    lon: parseFloat(lon.toFixed(6)), // Ubah string kembali jadi number
                    speed: speed,
                    acc: speed > 0 ? "ON" : "OFF",
                    sat: Math.floor(Math.random() * 5) + 8,
                    time: new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }),
                    alarm: "Normal"
                };

                // Lempar ke Browser via Socket.io
                io.emit('vessel_move', payload);
                console.log(`📍 Live: ${payload.nopol} | Speed: ${speed} km/h`);
            } catch (e) { }
        }
    });

    socket.on('close', () => {
        if (currentImei) delete activeGpsSockets[currentImei];
        console.log("🔴 GPS Disconnected");
    });

    socket.on('error', () => { });
});

// --- SOCKET.IO (HUBUNGAN WEB -> SERVER) ---
io.on('connection', (webSocket) => {
    console.log("🖥️ Dashboard Browser Connected");

    webSocket.on('send_command', (data) => {
        const { imei, command } = data;
        console.log(`🔌 Mengirim perintah ${command} ke IMEI: ${imei}`);

        const targetSocket = activeGpsSockets[imei];
        if (targetSocket) {
            targetSocket.write(`DYD,${command === 'RELAY,1#' ? '1' : '0'}#`);
            webSocket.emit('command_res', { status: 'success', msg: 'Perintah terkirim!' });
        } else {
            webSocket.emit('command_res', { status: 'error', msg: 'Alat tidak terhubung!' });
        }
    });
});

gpsServer.listen(GPS_PORT, '0.0.0.0', () => console.log(`🚀 GPS Listener: ${GPS_PORT}`));
webServer.listen(WEB_PORT, '0.0.0.0', () => console.log(`🌐 Web/Socket Server: Port ${WEB_PORT}`));
