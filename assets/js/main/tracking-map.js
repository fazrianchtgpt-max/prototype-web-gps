document.addEventListener("DOMContentLoaded", function () {
    // 1. Initialize Map
    const map = L.map('map').setView([-0.7893, 113.9213], 5);

    // 2. Add Tile Layer (OpenStreetMap)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
    }).addTo(map);

    // 3. Define Custom Icons
    function createRotatedIcon(iconUrl, heading) {
        return L.divIcon({
            className: 'custom-div-icon',
            html: `<img src="${iconUrl}" style="width: 36px; height: 36px; transform: rotate(${heading}deg); transform-origin: center center; filter: drop-shadow(0px 4px 4px rgba(0,0,0,0.3));">`,
            iconSize: [36, 36],
            iconAnchor: [18, 18],
            popupAnchor: [0, -18]
        });
    }

    const markers = {};
    const vehiclesData = {};

    window.focusVehicleId = function (id) {
        if (markers[id]) {
            const marker = markers[id];
            map.flyTo(marker.getLatLng(), 16, { animate: true, duration: 1.5 });
            setTimeout(() => { marker.openPopup(); }, 500);
            document.getElementById('map').scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    };

    window.sendRemoteCommand = function (imei, command) {
        if (typeof socket !== 'undefined' && socket.connected) {
            let actionText = `MENJALANKAN PERINTAH [${command}]`;
            let confirmColor = '#3085d6';

            if (command.includes('RELAY,1#')) {
                actionText = 'MEMATIKAN MESIN';
                confirmColor = '#dc3545';
            } else if (command.includes('RELAY,0#')) {
                actionText = 'MENGHIDUPKAN MESIN';
                confirmColor = '#198754';
            } else if (command.includes('RESET#')) {
                actionText = 'REBOOT ALAT GPS';
                confirmColor = '#ffc107';
            }

            Swal.fire({
                title: 'Konfirmasi',
                text: `Apakah Anda yakin ingin ${actionText}?`,
                icon: 'question',
                showCancelButton: true,
                confirmButtonColor: confirmColor,
                cancelButtonColor: '#6c757d',
                confirmButtonText: 'Ya, Jalankan!',
                cancelButtonText: 'Batal'
            }).then((result) => {
                if (result.isConfirmed) {
                    socket.emit('send_command', { imei: imei, command: command });

                    // TAMPILKAN STATUS LOADING (MENUNGGU HARDWARE)
                    Swal.fire({
                        title: 'Memproses...',
                        html: `Sedang mengirim perintah <b>${command}</b>.<br>Mohon tunggu laporan balasan dari hardware...`,
                        allowOutsideClick: false,
                        didOpen: () => {
                            Swal.showLoading();
                        }
                    });

                    // Failsafe: Jika 30 detik tidak ada kabar (untuk perintah non-relay biasanya cepat)
                    const timeoutMs = command.includes('RELAY') ? 120000 : 30000;
                    if (window.cmdTimeout) clearTimeout(window.cmdTimeout);
                    window.cmdTimeout = setTimeout(() => {
                        if (Swal.isVisible() && Swal.getHtmlContainer().innerText.includes('balasan')) {
                            Swal.fire({
                                title: 'Waktu Habis',
                                text: 'Alat tidak memberikan laporan balik. Pastikan alat online dan memiliki sinyal.',
                                icon: 'warning'
                            });
                        }
                    }, timeoutMs);
                }
            });
        } else {
            Swal.fire('Error', 'Koneksi server terputus!', 'error');
        }
    };

    window.centerMapOnVehicle = function () {
        const ids = Object.keys(vehiclesData);
        if (ids.length > 0) {
            window.focusVehicleId(ids[0]);
        } else {
            Swal.fire('Info', 'Belum ada kendaraan di peta!', 'info');
        }
    };

    window.showVehicleSettings = function () {
        const ids = Object.keys(vehiclesData);
        if (ids.length > 0) {
            const imei = ids[0];
            const data = vehiclesData[imei];

            document.getElementById('settings-nopol').innerText = data.name;
            document.getElementById('settings-imei').innerText = `IMEI: ${imei}`;
            document.getElementById('settings-online').innerText = data.online ? 'ONLINE' : 'OFFLINE';
            document.getElementById('settings-online').className = data.online ? 'fw-bold fs-6 text-info' : 'fw-bold fs-6 text-muted';
            document.getElementById('settings-relay').innerText = data.relay === 'ON' ? 'READY (ON)' : 'CUT-OFF (OFF)';
            document.getElementById('settings-relay').className = data.relay === 'ON' ? 'fw-bold fs-6 text-success' : 'fw-bold fs-6 text-danger';
            document.getElementById('settings-acc').innerText = data.engine;
            document.getElementById('settings-sat').innerText = data.sat;
            document.getElementById('settings-address').innerText = data.address;

            const modal = new bootstrap.Modal(document.getElementById('vehicleSettingsModal'));
            modal.show();
        } else {
            Swal.fire('Info', 'Data kendaraan belum masuk!', 'info');
        }
    };

    window.sendRemoteCommandByNopol = function (command) {
        const ids = Object.keys(vehiclesData);
        if (ids.length > 0) {
            window.sendRemoteCommand(ids[0], command);
        } else {
            Swal.fire('Info', 'Belum ada kendaraan!', 'info');
        }
    };

    // Socket.io Integration
    var socket;
    if (typeof io !== 'undefined') {
        socket = io('https://kulocloud.biz.id'); // Use standard HTTPS (Cloudflare will proxy to port 80) // Port 8080 for Cloudflare Flexible SSL

        socket.on('connect', () => {
            console.log('Connected to Server');
            // Jika mobil belum muncul, refresh data dari cache
        });

        socket.on('connect_error', (err) => {
            console.error('Connection Error:', err);
        });

        socket.on('command_res', (res) => {
            if (res.status === 'success') {
                console.log('Server Log:', res.msg);
            } else {
                if (window.cmdTimeout) clearTimeout(window.cmdTimeout);
                Swal.fire('Gagal', res.msg, 'error');
            }
        });

        socket.on('command_confirmed', (res) => {
            if (window.cmdTimeout) clearTimeout(window.cmdTimeout);
            Swal.fire({
                title: 'SUKSES!',
                text: res.msg,
                icon: 'success',
                confirmButtonText: 'Selesai'
            });
        });

        socket.on('device_response', (res) => {
            if (window.cmdTimeout) clearTimeout(window.cmdTimeout);
            Swal.fire({
                title: 'Respon Hardware',
                html: `<div class="bg-dark text-success p-3 rounded font-monospace" style="text-align:left;">${res.text}</div>`,
                icon: 'info',
                confirmButtonText: 'Oke'
            });
        });

        socket.on('vessel_move', (data) => {
            console.log('Update Realtime:', data);
            const vehicleId = data.imei;
            const newLatLng = [data.lat, data.lon];

            // --- MAS ARI COLOR LOGIC ---
            // 1. Grey = Offline (data.online === false)
            // 2. Red = Mesin OFF (data.relay === 'OFF')
            // 3. Yellow = Standby (Mesin ON, Speed === 0)
            // 4. Green = Moving (Mesin ON, Speed > 0)
            let vtStatus = 'gray';
            if (data.online) {
                if (data.relay === 'OFF') {
                    vtStatus = 'red';
                } else {
                    vtStatus = data.speed > 2 ? 'green' : 'yellow';
                }
            }

            const iconUrl = `assets/icon-gps/car_${vtStatus}.svg`;
            const customIcon = createRotatedIcon(iconUrl, 0);

            if (!vehiclesData[vehicleId]) {
                vehiclesData[vehicleId] = { id: vehicleId, name: data.nopol || 'Unit GPS' };
            }
            const vData = vehiclesData[vehicleId];
            Object.assign(vData, {
                lat: data.lat, lng: data.lon, speed: data.speed,
                engine: data.acc, relay: data.relay, online: data.online,
                status: vtStatus, date: data.time, sat: data.sat,
                address: `${data.lat.toFixed(6)}, ${data.lon.toFixed(6)}`
            });

            // Update Map
            if (!markers[vehicleId]) {
                markers[vehicleId] = L.marker(newLatLng, { icon: customIcon })
                    .addTo(map)
                    .bindPopup(generatePopupHTML(vData), { maxWidth: 300, minWidth: 250 });
                if (Object.keys(markers).length === 1) map.setView(newLatLng, 15);
            } else {
                const marker = markers[vehicleId];
                marker.setLatLng(newLatLng);
                marker.setIcon(customIcon);
                if (marker.isPopupOpen()) marker.setPopupContent(generatePopupHTML(vData));
            }

            // Update Table
            const tableBody = document.getElementById('vehicle-table-body');
            if (tableBody) {
                const noDataRow = document.getElementById('no-data-row');
                if (noDataRow) noDataRow.remove();

                let row = document.getElementById(`row-${vehicleId}`);
                if (!row) {
                    row = document.createElement('tr');
                    row.id = `row-${vehicleId}`;
                    tableBody.prepend(row);
                }

                row.innerHTML = `
                    <td>
                        <div class="d-flex align-items-center justify-content-center gap-1">
                            <button class="btn btn-sm btn-primary rounded-circle" onclick="focusVehicleId('${vehicleId}')"><i class="bi bi-geo-alt-fill"></i></button>
                            <button class="btn btn-sm btn-danger rounded-circle" onclick="sendRemoteCommand('${vehicleId}', 'RELAY,1#')"><i class="bi bi-power"></i></button>
                        </div>
                    </td>
                    <td>
                        ${(data.alarm && data.alarm !== "Normal")
                        ? `<span class="badge bg-danger animate__animated animate__flash animate__infinite">${data.alarm}</span>`
                        : `<span class="badge bg-success">NORMAL</span>`}
                    </td>
                    <td class="fw-bold">
                        <img src="${iconUrl}" width="24" class="me-2"> ${vData.name}
                    </td>
                    <td><small>${data.time}</small></td>
                    <td><span class="badge bg-secondary">${data.speed}Km/J</span></td>
                    <td>${data.acc === 'ON' ? '<span class="badge bg-success">ON</span>' : '<span class="badge bg-danger">OFF</span>'}</td>
                    <td>${data.relay === 'ON' ? '<span class="badge bg-success">ON</span>' : '<span class="badge bg-danger">OFF</span>'}</td>
                    <td>${data.online ? '<span class="badge bg-info text-dark">ONLINE</span>' : '<span class="badge bg-secondary">OFFLINE</span>'}</td>
                    <td><span class="badge bg-dark">${data.sat}</span></td>
                    <td class="text-truncate" style="max-width:150px" title="${vData.address}">${vData.address}</td>
                    <td><span class="badge bg-light text-dark">Growigo</span></td>
                `;
            }
        });
    }

    function generatePopupHTML(data) {
        const accBadge = data.engine === "ON" ? '<span class="badge bg-success px-2 py-1">ON</span>' : '<span class="badge bg-danger px-2 py-1">OFF</span>';
        const relayBadge = data.relay === "ON" ? '<span class="badge bg-success px-2 py-1">ON</span>' : '<span class="badge bg-danger px-2 py-1">OFF</span>';
        const onlineBadge = data.online ? '<span class="badge bg-info text-dark">ONLINE</span>' : '<span class="badge bg-secondary">OFFLINE</span>';

        return `
            <div class="px-2 py-1" style="min-width: 250px;">
                <h6 class="fw-bold text-dark mb-2 pb-2 border-bottom">
                    <img src="assets/icon-gps/car_${data.status}.svg" style="width: 24px;"> ${data.name}
                </h6>
                <table class="table table-sm table-borderless mb-0" style="font-size: 0.8rem;">
                    <tbody>
                        <tr><td class="text-muted p-1" style="width: 100px;">Status Alat</td><td class="p-1 fw-bold">: ${onlineBadge}</td></tr>
                        <tr><td class="text-muted p-1">Status Kontak</td><td class="p-1 fw-medium">: ${accBadge}</td></tr>
                        <tr><td class="text-muted p-1">Status Mesin</td><td class="p-1 fw-medium">: ${relayBadge}</td></tr>
                        <tr><td class="text-muted p-1">Kecepatan</td><td class="p-1 fw-medium">: ${data.speed} Km/Jam</td></tr>
                        <tr><td class="text-muted p-1">Waktu</td><td class="p-1 fw-medium">: ${data.date}</td></tr>
                    </tbody>
                </table>
                <div class="mt-3 d-flex flex-column gap-2">
                    <div class="d-flex gap-2">
                        <button onclick="sendRemoteCommand('${data.id}', 'RELAY,0#')" class="btn btn-success btn-sm w-50 rounded-pill fw-bold">ON</button>
                        <button onclick="sendRemoteCommand('${data.id}', 'RELAY,1#')" class="btn btn-danger btn-sm w-50 rounded-pill fw-bold">OFF</button>
                    </div>
                    <a href="https://www.google.com/maps/dir/?api=1&destination=${data.lat},${data.lng}" target="_blank" class="btn btn-primary w-100 rounded-pill btn-sm fw-bold text-white mt-1">Google Maps</a>
                </div>
            </div>
        `;
    }
});
