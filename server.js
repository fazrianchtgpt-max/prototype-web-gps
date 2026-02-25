const net = require('net');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// ==========================================
// 1. EXPRESS & SOCKET.IO SERVER (PORT 3000)
// ==========================================
const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Izinkan semua domain frontend untuk connect
        methods: ["GET", "POST"]
    }
});

// Jalankan web server di port 3000
server.listen(3000, () => {
    console.log('✅ Web Server & Socket.io berjalan di port 3000');
});

io.on('connection', (socket) => {
    console.log(`📡 Client Frontend Terhubung: ${socket.id}`);

    socket.on('disconnect', () => {
        console.log(`🔌 Client Terputus: ${socket.id}`);
    });
});

// ==========================================
// 2. PARSING PROTOKOL GT06N
// ==========================================
// Struktur format paket GPS Tracker (GT06N)
function parseGT06N(buffer) {
    // Panjang minimal paket GT06N adalah 10 bytes
    if (buffer.length < 10) return null;

    // Header 2 bytes: 0x78 0x78
    const startBit = buffer.readUInt16BE(0);
    if (startBit !== 0x7878 && startBit !== 0x7979) return null;

    // ID Protocol (Byte ke-3)
    const protocolId = buffer.readUInt8(3);

    // ID Paket 0x12 (18 desimal) atau 0x22 (34 desimal) adalah Data Lokasi
    if (protocolId === 0x12 || protocolId === 0x22) {

        // --- Ekstrak Tanggal & Waktu (6 Bytes, mulai dari index 4) ---
        const year = buffer.readUInt8(4);
        const month = buffer.readUInt8(5);
        const day = buffer.readUInt8(6);
        const hour = buffer.readUInt8(7);
        const minute = buffer.readUInt8(8);
        const second = buffer.readUInt8(9);

        const time = `20${year.toString().padStart(2, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')} ${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}:${second.toString().padStart(2, '0')}`;

        // --- Satelit GPS (1 Byte, mulai index 10) ---
        const satInfo = buffer.readUInt8(10);
        const sat = satInfo & 0x0F; // Ambil 4 bit terakhir

        // --- Latitude & Longitude (4 Bytes, mulai index 11 dan 15) ---
        let latRaw = buffer.readUInt32BE(11);
        let lonRaw = buffer.readUInt32BE(15);

        // Rumus konversi desimal (dibagi 1,800,000)
        let lat = latRaw / 1800000.0;
        let lon = lonRaw / 1800000.0;

        // Aturan Lintang Selatan: Jika Latitude Positif, ubah menjadi Negatif
        if (lat > 0) {
            lat = -lat;
        }

        // --- Speed (1 Byte, mulai index 19) ---
        const speed = buffer.readUInt8(19);

        // --- Status (2 Bytes, mulai index 20) ---
        // Mengekstrak status kontak (Engine ACC) dari bit-bit info status
        const statusRaw = buffer.readUInt16BE(20);
        // Bit kedua dari byte pertama merepresentasikan status ACC (1=ON, 0=OFF)
        const accStatus = (buffer.readUInt8(20) & 0x02) >> 1;
        const acc = accStatus === 1 ? 'ON' : 'OFF';

        return {
            imei: "Unknown", // Device IMEI biasanya dikirim via login packet (0x01)
            lat: lat,
            lon: lon,
            speed: speed,
            acc: acc,
            sat: sat,
            time: time,
            nopol: "B 1234 ABC" // Hardcode atau bisa query DB berdasarkan IMEI
        };
    }
    return null;
}

// ==========================================
// 3. TCP SERVER (PORT 5023)
// ==========================================
const tcpServer = net.createServer((socket) => {
    console.log(`🚗 Hardware GPS Terhubung: ${socket.remoteAddress}:${socket.remotePort}`);

    socket.on('data', (data) => {
        try {
            const parsedData = parseGT06N(data);

            if (parsedData) {
                // Jangan broadcast jika koordinat 0.0 (Invalid GPS / No signal)
                if (parsedData.lat !== 0 && parsedData.lon !== 0) {
                    console.log('📍 Data Valid Mendarat -> Broadcast ke Frontend:', parsedData);
                    // Broadcast event 'vessel_move' ke semua client frontend
                    io.emit('vessel_move', parsedData);
                }
            }

            // Opsional: Hardware GT06N sering meminta balasan (Packet 0x13 dsb)
            // agar TCP koneksinya tidak diputus sepihak
        } catch (error) {
            console.error('❌ Gagal membaca data Hex GPS:', error);
        }
    });

    socket.on('close', () => {
        console.log('🚗 Hardware GPS Terputus');
    });

    socket.on('error', (err) => {
        console.log('⚠️ TCP Socket Error:', err.message);
    });
});

// Jalankan TCP server di port 5023
tcpServer.listen(5023, () => {
    console.log('✅ TCP Server Hardware GPS GT06N berjalan di port 5023');
});
