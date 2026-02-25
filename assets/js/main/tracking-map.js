document.addEventListener("DOMContentLoaded", function () {
    // 1. Initialize Map
    // Map center set to Indonesia by default
    const map = L.map('map').setView([-0.7893, 113.9213], 5);

    // 2. Add Tile Layer (OpenStreetMap)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
    }).addTo(map);

    // 3. Define Custom Icons using the generated SVGs
    function createRotatedIcon(iconUrl, heading) {
        return L.divIcon({
            className: 'custom-div-icon',
            html: `<img src="${iconUrl}" style="width: 36px; height: 36px; transform: rotate(${heading}deg); transform-origin: center center; filter: drop-shadow(0px 4px 4px rgba(0,0,0,0.3));">`,
            iconSize: [36, 36],
            iconAnchor: [18, 18],
            popupAnchor: [0, -18]
        });
    }

    // Popup HTML generator
    function generatePopupHTML(data) {
        // Engine badge styling
        const engineBadge = data.engine === "ON"
            ? '<span class="badge badge-neon-success px-2 py-1">ON</span>'
            : '<span class="badge badge-neon-danger px-2 py-1">OFF</span>';

        return `
            <div class="px-2 py-1" style="min-width: 250px;">
                <h6 class="fw-bold text-dark mb-2 pb-2 border-bottom d-flex align-items-center gap-2">
                    <i class="bi bi-geo-alt-fill text-primary"></i> ${data.name}
                </h6>
                <table class="table table-sm table-borderless mb-0" style="font-size: 0.8rem;">
                    <tbody>
                        <tr><td class="text-muted p-1" style="width: 85px;">Imei.</td><td class="p-1 fw-medium">: ${data.imei}</td></tr>
                        <tr><td class="text-muted p-1">No.GSM</td><td class="p-1 fw-medium">: ${data.gsm}</td></tr>
                        <tr><td class="text-muted p-1">Tgl</td><td class="p-1 fw-medium">: ${data.date}</td></tr>
                        <tr><td class="text-muted p-1">Koordinat</td><td class="p-1 fw-medium">: ${data.lat.toFixed(7)}, ${data.lng.toFixed(7)}</td></tr>
                        <tr><td class="text-muted p-1">Speed</td><td class="p-1 fw-medium">: ${data.speed} Km/Jam</td></tr>
                        <tr><td class="text-muted p-1 align-middle">Engine</td><td class="p-1 fw-medium">: ${engineBadge}</td></tr>
                        <tr><td class="text-muted p-1">Park</td><td class="p-1 fw-medium">: ${data.park}</td></tr>
                        <tr><td class="text-muted p-1">Odometer</td><td class="p-1 fw-medium">: ${data.odometer} Km</td></tr>
                        <tr><td class="text-muted p-1 align-top">Alamat</td><td class="p-1 fw-medium text-wrap" style="line-height: 1.4;">: ${data.address}</td></tr>
                    </tbody>
                </table>
                <div class="mt-3 d-flex gap-2">
                    <a href="https://www.google.com/maps/dir/?api=1&destination=${data.lat},${data.lng}" target="_blank" class="btn btn-primary w-50 rounded-pill btn-sm fw-bold text-white">
                        <i class="bi bi-cursor-fill me-1"></i> Navigate
                    </a>
                    <a href="https://www.google.com/maps?layer=c&cbll=${data.lat},${data.lng}" target="_blank" class="btn btn-info w-50 rounded-pill btn-sm fw-bold text-white shadow-sm" style="background-color: var(--neon-blue); border-color: var(--neon-blue);">
                        <i class="bi bi-person-walking me-1"></i> Street View
                    </a>
                </div>
            </div>
        `;
    }

    // 4. Vehicle registry and markers map
    const markers = {};
    const vehiclesData = {};

    // 5. Expose focus function to global scope for HTML clicks
    window.focusVehicleId = function (id) {
        if (markers[id]) {
            const marker = markers[id];
            map.flyTo(marker.getLatLng(), 16, { animate: true, duration: 1.5 });
            setTimeout(() => { marker.openPopup(); }, 500);
            document.getElementById('map').scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    };

    // 6. Remote Command function
    window.sendRemoteCommand = function (imei, command) {
        if (typeof socket !== 'undefined' && socket.connected) {
            console.log(`Sending ${command} to ${imei}`);
            socket.emit('send_command', { imei: imei, command: command });
            alert(`Perintah ${command} dikirim ke unit ${imei}...`);
        } else {
            alert('Koneksi server terputus!');
        }
    };

    // 7. Map UI Overlay Controls
    document.querySelectorAll('.mc-btn').forEach(btn => {
        const text = btn.textContent.trim();
        if (text === 'Center') {
            btn.addEventListener('click', () => {
                const markerList = Object.values(markers);
                if (markerList.length > 0) {
                    const group = new L.featureGroup(markerList);
                    map.fitBounds(group.getBounds().pad(0.1));
                }
            });
        }
    });

    // 8. Socket.io Integration
    var socket; // Global to this scope
    if (typeof io !== 'undefined') {
        socket = io('http://52.221.241.188:3000');

        socket.on('connect', () => {
            console.log('Connected to Tracking Server');
        });

        socket.on('command_res', (res) => {
            alert(`Respon Alat: ${res.msg}`);
        });

        socket.on('vessel_move', (data) => {
            console.log('Received vessel_move data:', data);

            const vehicleId = data.imei || "UNKNOWN";
            const newLatLng = [data.lat, data.lon];

            // Format vehicle status/color
            let vtStatus = data.acc === 'ON' ? (data.speed > 5 ? 'green' : 'yellow') : 'red';
            const iconUrl = `assets/icon-gps/car_${vtStatus}.svg`;
            const customIcon = createRotatedIcon(iconUrl, 0);

            // Update Vehicle Data Cache
            if (!vehiclesData[vehicleId]) {
                vehiclesData[vehicleId] = {
                    id: vehicleId,
                    name: data.nopol || 'T FAZRIAN ABC',
                    imei: vehicleId,
                    gsm: "Simcard Aktif",
                    odometer: "0",
                    park: "-"
                };
            }

            const vData = vehiclesData[vehicleId];
            vData.lat = data.lat;
            vData.lng = data.lon;
            vData.speed = data.speed;
            vData.engine = data.acc;
            vData.status = vtStatus;
            vData.date = data.time;
            vData.sat = data.sat;
            vData.address = `${data.lat.toFixed(6)}, ${data.lon.toFixed(6)}`;

            // Update Total Vehicle Count UI
            const vesselCountEl = document.getElementById('vessel-count');
            if (vesselCountEl) {
                vesselCountEl.innerText = Object.keys(vehiclesData).length;
            }

            // Update Alarm Summary Badge
            const alarmSummary = document.getElementById('alarm-summary');
            if (alarmSummary) {
                if (data.alarm && data.alarm !== "Normal") {
                    // Only show if there's an actual alarm
                    alarmSummary.innerHTML = `
                        <span class="badge badge-neon-danger px-3 py-2 rounded-pill">
                            <i class="bi bi-exclamation-triangle-fill me-1"></i> Alert: ${data.alarm}
                        </span>
                    `;
                } else {
                    alarmSummary.innerHTML = ""; // Hide if normal
                }
            }

            // Update Map Marker
            if (!markers[vehicleId]) {
                const marker = L.marker(newLatLng, { icon: customIcon })
                    .addTo(map)
                    .bindPopup(generatePopupHTML(vData), {
                        maxWidth: 320,
                        minWidth: 280,
                        className: 'futuristic-popup'
                    });
                markers[vehicleId] = marker;

                // If it's the only vehicle, auto center
                if (Object.keys(markers).length === 1) {
                    map.setView(newLatLng, 15);
                }
            } else {
                const marker = markers[vehicleId];
                marker.setLatLng(newLatLng);
                marker.setIcon(customIcon);
                if (marker.isPopupOpen()) {
                    marker.setPopupContent(generatePopupHTML(vData));
                }
            }

            // Update UI Table
            const tableBody = document.getElementById('vehicle-table-body');
            if (tableBody) {
                const noDataRow = document.getElementById('no-data-row');
                if (noDataRow) noDataRow.remove();

                let row = document.getElementById(`row-${vehicleId}`);
                if (!row) {
                    row = document.createElement('tr');
                    row.id = `row-${vehicleId}`;
                    tableBody.prepend(row); // Newest at top
                }

                row.innerHTML = `
                    <td>
                        <div class="d-flex align-items-center justify-content-center gap-1">
                            <button class="btn btn-sm btn-primary rounded-circle shadow-sm"
                                title="Lihat di Peta" onclick="focusVehicleId('${vehicleId}')">
                                <i class="bi bi-geo-alt-fill"></i>
                            </button>
                            <button class="btn btn-sm btn-danger rounded-circle shadow-sm"
                                title="Matikan Mesin" onclick="sendRemoteCommand('${vehicleId}', 'RELAY,1#')">
                                <i class="bi bi-power"></i>
                            </button>
                        </div>
                    </td>
                    <td>
                        ${(data.alarm && data.alarm !== "Normal")
                        ? `<span class="badge badge-neon-danger">${data.alarm}</span>`
                        : `<span class="badge badge-neon-success">Normal</span>`}
                    </td>
                    <td class="fw-bold text-dark">
                        <img src="${iconUrl}" alt="Vehicle" style="width: 24px; vertical-align: middle;" class="me-2">
                        ${vData.name}
                    </td>
                    <td>${data.time}</td>
                    <td><span class="badge bg-secondary text-white">${data.speed}Km/J</span></td>
                    <td>
                        ${data.acc === 'ON'
                        ? '<span class="badge badge-neon-success">ON</span>'
                        : '<span class="badge badge-neon-danger">OFF</span>'}
                    </td>
                    <td><span class="badge badge-neon-danger">OFF</span></td>
                    <td><span class="badge badge-neon-warning">Normal Batt</span></td>
                    <td><span class="badge bg-dark rounded-circle px-2">${data.sat}</span></td>
                    <td style="max-width: 200px;" class="text-truncate" title="${vData.address}">
                        <i class="bi bi-pin-map-fill text-danger me-1"></i> ${vData.address}
                    </td>
                    <td><span class="text-muted fst-italic">Growigo</span></td>
                `;
            }
        });
    }

    // popup template with command buttons
    function generatePopupHTML(data) {
        const engineBadge = data.engine === "ON"
            ? '<span class="badge badge-neon-success px-2 py-1">ON</span>'
            : '<span class="badge badge-neon-danger px-2 py-1">OFF</span>';

        return `
            <div class="px-2 py-1" style="min-width: 250px;">
                <h6 class="fw-bold text-dark mb-2 pb-2 border-bottom d-flex align-items-center gap-2">
                    <img src="assets/icon-gps/car_${data.status}.svg" style="width: 24px;"> ${data.name}
                </h6>
                <table class="table table-sm table-borderless mb-0" style="font-size: 0.8rem;">
                    <tbody>
                        <tr><td class="text-muted p-1" style="width: 85px;">IMEI</td><td class="p-1 fw-medium">: ${data.id}</td></tr>
                        <tr><td class="text-muted p-1">Status Mesin</td><td class="p-1 fw-medium">: ${engineBadge}</td></tr>
                        <tr><td class="text-muted p-1">Kecepatan</td><td class="p-1 fw-medium">: ${data.speed} Km/Jam</td></tr>
                        <tr><td class="text-muted p-1">Posisi</td><td class="p-1 fw-medium">: ${data.lat.toFixed(6)}, ${data.lng.toFixed(6)}</td></tr>
                        <tr><td class="text-muted p-1">Waktu</td><td class="p-1 fw-medium">: ${data.date}</td></tr>
                    </tbody>
                </table>
                <div class="mt-3 d-flex flex-column gap-2">
                    <div class="d-flex gap-2">
                        <button onclick="sendRemoteCommand('${data.id}', 'RELAY,0#')" class="btn btn-success btn-sm w-50 rounded-pill fw-bold">
                            <i class="bi bi-play-fill"></i> Mesin ON
                        </button>
                        <button onclick="sendRemoteCommand('${data.id}', 'RELAY,1#')" class="btn btn-danger btn-sm w-50 rounded-pill fw-bold">
                            <i class="bi bi-stop-fill"></i> Mesin OFF
                        </button>
                    </div>
                    <a href="https://www.google.com/maps/dir/?api=1&destination=${data.lat},${data.lng}" target="_blank" class="btn btn-primary w-100 rounded-pill btn-sm fw-bold text-white mt-1">
                        <i class="bi bi-cursor-fill me-1"></i> Buka Google Maps
                    </a>
                </div>
            </div>
        `;
    }
});
