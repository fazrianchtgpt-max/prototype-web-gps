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

    // Vehicle registry and markers map
    const vehiclesData = [];
    const markers = {};

    // 5. Expose focus function to global scope for HTML clicks
    window.focusVehicleId = function (id) {
        if (markers[id]) {
            const marker = markers[id];
            map.flyTo(marker.getLatLng(), 16, {
                animate: true,
                duration: 1.5
            });
            // Give time to fly before opening popup
            setTimeout(() => {
                marker.openPopup();
            }, 500);

            // Scroll to the map container smoothly
            document.getElementById('map').scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    };

    // 6. Map UI Overlay Controls
    document.querySelectorAll('.mc-btn').forEach(btn => {
        if (btn.textContent.trim() === 'Center') {
            btn.addEventListener('click', () => {
                const group = new L.featureGroup(Object.values(markers));
                map.fitBounds(group.getBounds().pad(0.1));
            });
        }
    });

    // 7. Socket.io Integration
    if (typeof io !== 'undefined') {
        const socket = io('http://52.221.241.188:3000');

        socket.on('connect', () => {
            console.log('Connected to Tracking Server');
        });

        socket.on('vessel_move', (data) => {
            console.log('Received vessel_move data:', data);

            // Update Map Marker (Using fixed ID 1 for now)
            const vehicleId = "1";
            const newLatLng = [data.lat, data.lon];

            // Format vehicle status/color
            let vtStatus = data.acc === 'ON' ? (data.speed > 5 ? 'green' : 'yellow') : 'red';
            const iconUrl = `assets/icon-gps/car_${vtStatus}.svg`;
            const customIcon = createRotatedIcon(iconUrl, 0); // Need exact heading if hardware supports it

            // Define structured vehicle data config used in popup map
            let vData = vehiclesData.find(v => v.id === vehicleId);
            if (!vData) {
                // New Vehicle
                vData = {
                    id: vehicleId,
                    type: "car",
                    status: vtStatus,
                    name: data.nopol || 'B 1234 ABC',
                    lat: data.lat,
                    lng: data.lon,
                    heading: 0,
                    imei: data.imei || '-',
                    gsm: "-",
                    date: data.time,
                    speed: data.speed,
                    engine: data.acc,
                    park: "-",
                    odometer: "0",
                    address: `${data.lat.toFixed(6)}, ${data.lon.toFixed(6)}`
                };
                vehiclesData.push(vData);
            } else {
                // Update Existing Vehicle
                vData.lat = data.lat;
                vData.lng = data.lon;
                vData.speed = data.speed;
                vData.imei = data.imei || '-';
                vData.date = data.time;
                vData.engine = data.acc;
                vData.status = vtStatus;
                vData.address = `${data.lat.toFixed(6)}, ${data.lon.toFixed(6)}`;
            }

            if (!markers[vehicleId]) {
                // Create New Map Marker
                const marker = L.marker(newLatLng, { icon: customIcon })
                    .addTo(map)
                    .bindPopup(generatePopupHTML(vData), {
                        maxWidth: 320,
                        minWidth: 280,
                        className: 'futuristic-popup'
                    });
                markers[vehicleId] = marker;

                // Center map to first marker auto
                map.setView(newLatLng, 15);
            } else {
                // Update specific marker on map
                const marker = markers[vehicleId];
                marker.setLatLng(newLatLng);
                marker.setIcon(customIcon);

                if (marker.isPopupOpen()) {
                    marker.setPopupContent(generatePopupHTML(vData));
                }
            }

            // Update UI Table (Dynamic)
            const tableBody = document.getElementById('vehicle-table-body');
            if (tableBody) {
                // Remove the "no data" placeholder if it exists
                const noDataRow = document.getElementById('no-data-row');
                if (noDataRow) {
                    noDataRow.remove();
                }

                let row = document.getElementById(`row-${vehicleId}`);

                if (!row) {
                    row = document.createElement('tr');
                    row.id = `row-${vehicleId}`;
                    tableBody.appendChild(row);
                }

                row.innerHTML = `
                    <td>
                        <div class="d-flex align-items-center justify-content-center gap-1">
                            <button class="btn btn-sm btn-primary rounded-circle shadow-sm"
                                title="Lihat di Peta" onclick="focusVehicleId('${vehicleId}')">
                                <i class="bi bi-geo-alt-fill"></i>
                            </button>
                        </div>
                    </td>
                    <td>
                        <div class="d-flex align-items-center justify-content-center gap-2">
                            <span class="status-dot success" title="Sudah Dibaca"></span>
                            <span class="badge badge-neon-warning text-center rounded-pill px-3">
                                <i class="bi bi-battery me-1"></i> Normal Batt
                            </span>
                        </div>
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
                    <td>-</td>
                    <td><span class="badge bg-dark rounded-circle px-2">${data.sat}</span></td>
                    <td style="max-width: 200px;" class="text-truncate" title="${vData.address}">
                        <i class="bi bi-pin-map-fill text-danger me-1"></i> ${vData.address}
                    </td>
                    <td><span class="text-muted fst-italic">Unknown</span></td>
                `;
            }
        });
    }
});
