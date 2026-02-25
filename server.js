const net = require('net');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const webServer = http.createServer(app);
const io = new Server(webServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const GPS_PORT = 5023;
const WEB_PORT = 3000;

// Storage sementara untuk nyimpen koneksi GPS aktif berdasarkan IMEI
const activeGpsSockets = {};

// Setup Express: Serve Static Files (assets + html)
app.use('/assets', express.static(path.join(__dirname, 'assets')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

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
            // Ambil IMEI (biasanya byte ke 4-11)
            currentImei = hex.substring(8, 24);
            activeGpsSockets[currentImei] = socket; // Simpan koneksi biar bisa ditembak command

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
        if (hex.startsWith('7878') && hex.substring(6, 8) === '13') {
            const serial = data.slice(data.length - 6, data.length - 4);
            socket.write(Buffer.from([0x78, 0x78, 0x05, 0x13, serial[0], serial[1], 0x00, 0x00, 0x0d, 0x0a]));
        }

        // 3. LOCATION DATA (ID 12)
        if (hex.startsWith('7878') && hex.substring(6, 8) === '12') {
            try {
                const latHex = hex.substring(22, 30);
                const lonHex = hex.substring(30, 38);
                const speedHex = hex.substring(38, 40);

                let lat = parseInt(latHex, 16) / 1800000;
                let lon = parseInt(lonHex, 16) / 1800000;
                if (lat > 0) lat = -lat; // Lintang Selatan (Indonesia)

                const speed = parseInt(speedHex, 16);

                // Siapkan data untuk Dashboard
                const payload = {
                    imei: currentImei || "0353701096329020",
                    nopol: "B 1234 ABC",
                    lat: parseFloat(lat.toFixed(6)),
                    lon: parseFloat(lon.toFixed(6)),
                    speed: speed,
                    acc: speed > 0 ? "ON" : "OFF", // Logic sederhana: jalan = mesin nyala
                    sat: Math.floor(Math.random() * 5) + 8,
                    time: new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }),
                    alarm: "Normal"
                };

                // Lempar ke Browser via Socket.io
                io.emit('vessel_move', payload);
                console.log(`📍 Live: ${payload.nopol} | Speed: ${speed} km/h`);
            } catch (e) {
                console.error("Gagal parsing koordinat:", e);
            }
        }
    });

    socket.on('close', () => {
        if (currentImei) {
            delete activeGpsSockets[currentImei];
        }
        console.log(`� GPS Disconnected (IMEI: ${currentImei || 'Unknown'})`);
    });

    socket.on('error', (err) => {
        console.log('⚠️ TCP Error:', err.message);
    });
});

// --- SOCKET.IO (HUBUNGAN WEB -> SERVER) ---
io.on('connection', (webSocket) => {
    console.log(`🖥️ Dashboard Browser Connected: ${webSocket.id}`);

    // Tangkap perintah dari tombol Engine ON/OFF di Web
    webSocket.on('send_command', (data) => {
        const { imei, command } = data; // command bisa "RELAY,1#" (Off) atau "RELAY,0#" (On)
        console.log(`� Mengirim perintah ${command} ke IMEI: ${imei}`);

        const targetSocket = activeGpsSockets[imei];
        if (targetSocket) {
            // Format perintah GT06N via GPRS harus dibungkus protocol ID 80 (Command)
            // Untuk Prototype, kita coba kirim string langsung (beberapa device support)
            // Jika tidak mental, harus dibungkus packet 0x80
            targetSocket.write(`DYD,${command === 'RELAY,1#' ? '1' : '0'}#`);
            webSocket.emit('command_res', { status: 'success', msg: 'Perintah terkirim!' });
        } else {
            webSocket.emit('command_res', { status: 'error', msg: 'Alat tidak terhubung!' });
        }
    });

    webSocket.on('disconnect', () => {
        console.log(`🔌 Dashboard Disconnected: ${webSocket.id}`);
    });
});

gpsServer.listen(GPS_PORT, '0.0.0.0', () => console.log(`🚀 GPS Listener (TCP): Port ${GPS_PORT}`));
webServer.listen(WEB_PORT, '0.0.0.0', () => console.log(`🌐 Web Dashboard: http://0.0.0.0:${WEB_PORT}`));
