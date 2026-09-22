// Leaflet Map and Geolocation Management
import { CONFIG } from './config.js';
import { showToast } from './ui.js';

let mapInstance = null;
let userMarker = null;
let accuracyCircle = null;
let currentPosition = null;
let watchId = null;
let hasAnnouncedLocation = false;

let startPinMarker = null;
let endPinMarker = null;
let previewPolyline = null;

export function initMap() {
    // Default fallback center: London / Greenwich if geolocation hasn't replied yet
    const defaultCenter = [51.505, -0.09];

    mapInstance = L.map('map', {
        zoomControl: false, // Mobile-first clean interface
        attributionControl: false
    }).setView(defaultCenter, CONFIG.MAP_DEFAULT_ZOOM);

    // Attribution control moved to bottom-right unobtrusively
    L.control.attribution({
        position: 'bottomright',
        prefix: false
    }).addAttribution('&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>').addTo(mapInstance);

    // Free OpenStreetMap Tile Layer (Zero Cost)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        subdomains: ['a', 'b', 'c']
    }).addTo(mapInstance);

    // Custom GPS current position marker with inline fallback styling
    const gpsIcon = L.divIcon({
        className: 'gps-container',
        html: `
            <div style="position: relative; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center;">
                <div class="gps-pulse-ring" style="position: absolute; width: 28px; height: 28px; border-radius: 50%; background: rgba(56, 189, 248, 0.35); border: 1.5px solid #38bdf8;"></div>
                <div class="gps-dot" style="position: relative; width: 14px; height: 14px; background: #0284c7; border: 2.5px solid #ffffff; border-radius: 50%; box-shadow: 0 2px 6px rgba(0,0,0,0.5); z-index: 2;"></div>
            </div>
        `,
        iconSize: [32, 32],
        iconAnchor: [16, 16]
    });

    startGeolocationTracking(gpsIcon);

    return mapInstance;
}

export function getMap() {
    return mapInstance;
}

export function getCurrentUserCoords() {
    return currentPosition;
}

/**
 * Recenter map on user and request a fresh zero-age GPS fix
 */
export function centerOnUser() {
    if (mapInstance && currentPosition) {
        mapInstance.setView([currentPosition.lat, currentPosition.lng], mapInstance.getZoom() || CONFIG.MAP_DEFAULT_ZOOM, {
            animate: true
        });
    }

    if ('geolocation' in navigator) {
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const { latitude, longitude, accuracy } = pos.coords;
                currentPosition = { lat: latitude, lng: longitude, accuracy };
                const latLng = [latitude, longitude];

                if (userMarker) userMarker.setLatLng(latLng);
                if (accuracyCircle) {
                    accuracyCircle.setLatLng(latLng);
                    accuracyCircle.setRadius(accuracy || 10);
                }
                if (mapInstance) {
                    mapInstance.setView(latLng, mapInstance.getZoom() || CONFIG.MAP_DEFAULT_ZOOM, { animate: true });
                }
                showToast(`📍 Snapped to GPS (±${Math.round(accuracy)}m)`, 'info', 2000);
            },
            (err) => {
                console.warn('Recenter GPS error:', err);
                if (err.code === 1) {
                    showToast('Location permission denied in browser.', 'error', 4000);
                } else {
                    showToast('Could not refresh GPS. Using last known coordinates.', 'warning', 3000);
                }
            },
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        );
    }
}

/**
 * Places or moves the Start Pin marker on the map
 */
export function setStartPin(lat, lng) {
    clearStartPin();
    const icon = L.divIcon({
        className: 'slug-marker',
        html: `
            <div class="pin-marker pin-start"></div>
            <div class="slug-label" style="border-color: #10b981; color: #10b981;">START</div>
        `,
        iconSize: [40, 40],
        iconAnchor: [20, 10]
    });

    startPinMarker = L.marker([lat, lng], { icon, zIndexOffset: 500 }).addTo(mapInstance);
    return startPinMarker;
}

/**
 * Removes the Start Pin marker
 */
export function clearStartPin() {
    if (startPinMarker && mapInstance) {
        mapInstance.removeLayer(startPinMarker);
        startPinMarker = null;
    }
}

/**
 * Places or moves the End Pin marker on the map
 */
export function setEndPin(lat, lng) {
    clearEndPin();
    const icon = L.divIcon({
        className: 'slug-marker',
        html: `
            <div class="pin-marker pin-end"></div>
            <div class="slug-label" style="border-color: #3b82f6; color: #3b82f6;">FINISH</div>
        `,
        iconSize: [40, 40],
        iconAnchor: [20, 10]
    });

    endPinMarker = L.marker([lat, lng], { icon, zIndexOffset: 500 }).addTo(mapInstance);
    return endPinMarker;
}

/**
 * Removes the End Pin marker
 */
export function clearEndPin() {
    if (endPinMarker && mapInstance) {
        mapInstance.removeLayer(endPinMarker);
        endPinMarker = null;
    }
}

/**
 * Draws a dashed line connecting start to end pin preview
 */
export function setRoutePreview(start, end) {
    clearRoutePreview();
    previewPolyline = L.polyline([[start.lat, start.lng], [end.lat, end.lng]], {
        color: '#60a5fa',
        weight: 3,
        dashArray: '6, 8',
        opacity: 0.8
    }).addTo(mapInstance);
    return previewPolyline;
}

/**
 * Clears the route preview polyline
 */
export function clearRoutePreview() {
    if (previewPolyline && mapInstance) {
        mapInstance.removeLayer(previewPolyline);
        previewPolyline = null;
    }
}

// Collections for multi-player elements
const remoteStartPins = new Map();
const slugMarkers = new Map();
const trailPolylines = new Map();

/**
 * Renders or updates a moving slug avatar marker
 */
export function renderSlugAvatar(attemptId, coords, playerName, color = '#10b981', isSelf = false) {
    if (!mapInstance) return;

    let marker = slugMarkers.get(attemptId);
    if (marker) {
        marker.setLatLng([coords.lat, coords.lng]);
    } else {
        const slugIcon = L.divIcon({
            className: 'slug-marker-wrapper',
            html: `
                <div style="display: flex; flex-direction: column; align-items: center; pointer-events: none;">
                    <div class="slug-body slug-crawling" style="border-color: ${color}; box-shadow: 0 4px 14px ${color}88;">
                        <span style="display: inline-block; transform: scaleX(-1);">🐌</span>
                    </div>
                    <div class="slug-label" style="border-color: ${color}; color: ${color};">
                        ${isSelf ? '⭐ ' : ''}${playerName}
                    </div>
                </div>
            `,
            iconSize: [64, 64],
            iconAnchor: [32, 21]
        });

        marker = L.marker([coords.lat, coords.lng], { icon: slugIcon, zIndexOffset: 800 }).addTo(mapInstance);
        slugMarkers.set(attemptId, marker);
    }
}

/**
 * Removes a slug avatar marker from the map
 */
export function removeSlugAvatar(attemptId) {
    const marker = slugMarkers.get(attemptId);
    if (marker && mapInstance) {
        mapInstance.removeLayer(marker);
        slugMarkers.delete(attemptId);
    }
}

/**
 * Renders or updates the path traveled by a slug (or completed path)
 */
export function renderTraveledTrail(attemptId, latLngs, color = '#10b981', isCompleted = false) {
    if (!mapInstance || !latLngs || latLngs.length < 2) return;

    let polyline = trailPolylines.get(attemptId);
    if (polyline) {
        polyline.setLatLngs(latLngs);
        if (isCompleted) {
            polyline.setStyle({
                weight: 5,
                opacity: 0.95,
                dashArray: null
            });
        }
    } else {
        polyline = L.polyline(latLngs, {
            color: color,
            weight: isCompleted ? 5 : 4,
            opacity: isCompleted ? 0.95 : 0.8,
            lineCap: 'round',
            lineJoin: 'round'
        }).addTo(mapInstance);
        trailPolylines.set(attemptId, polyline);
    }
}

/**
 * Removes a traveled trail from the map
 */
export function removeTraveledTrail(attemptId) {
    const polyline = trailPolylines.get(attemptId);
    if (polyline && mapInstance) {
        mapInstance.removeLayer(polyline);
        trailPolylines.delete(attemptId);
    }
}

/**
 * Renders a start pin marker for any player's attempt
 */
export function renderRemoteStartPin(attemptId, coords, playerName, color = '#10b981') {
    if (!mapInstance) return;

    let marker = remoteStartPins.get(attemptId);
    if (!marker) {
        const icon = L.divIcon({
            className: 'slug-marker',
            html: `
                <div class="pin-marker" style="background: ${color}; border-color: #fff;"></div>
                <div class="slug-label" style="border-color: ${color}; color: ${color}; font-size: 0.68rem;">
                    ${playerName} (Start)
                </div>
            `,
            iconSize: [50, 40],
            iconAnchor: [25, 10]
        });

        marker = L.marker([coords.lat, coords.lng], { icon, zIndexOffset: 400 }).addTo(mapInstance);
        remoteStartPins.set(attemptId, marker);
    }
}

/**
 * Removes a remote start pin
 */
export function removeRemoteStartPin(attemptId) {
    const marker = remoteStartPins.get(attemptId);
    if (marker && mapInstance) {
        mapInstance.removeLayer(marker);
        remoteStartPins.delete(attemptId);
    }
}

/**
 * Cleans up all session artifacts (avatars, trails, remote pins)
 */
export function clearAllGameLayers() {
    slugMarkers.forEach(marker => mapInstance && mapInstance.removeLayer(marker));
    slugMarkers.clear();

    trailPolylines.forEach(line => mapInstance && mapInstance.removeLayer(line));
    trailPolylines.clear();

    remoteStartPins.forEach(pin => mapInstance && mapInstance.removeLayer(pin));
    remoteStartPins.clear();
}

/**
 * Starts continuous HTML5 Geolocation tracking
 */
function startGeolocationTracking(gpsIcon) {
    if (!('geolocation' in navigator)) {
        showToast('Geolocation is not supported by your browser.', 'error', 5000);
        return;
    }

    const options = {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 3000
    };

    const updateLocation = (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        currentPosition = { lat: latitude, lng: longitude, accuracy };

        const latLng = [latitude, longitude];

        // 1. Accuracy circle
        if (!accuracyCircle) {
            accuracyCircle = L.circle(latLng, {
                radius: accuracy || 15,
                color: '#38bdf8',
                fillColor: '#38bdf8',
                fillOpacity: 0.12,
                weight: 1,
                opacity: 0.4
            }).addTo(mapInstance);
        } else {
            accuracyCircle.setLatLng(latLng);
            accuracyCircle.setRadius(accuracy || 15);
        }

        // 2. Position marker
        if (!userMarker) {
            userMarker = L.marker(latLng, { icon: gpsIcon, zIndexOffset: 1000 }).addTo(mapInstance);
            mapInstance.setView(latLng, CONFIG.MAP_DEFAULT_ZOOM);
        } else {
            userMarker.setLatLng(latLng);
        }

        if (!hasAnnouncedLocation) {
            hasAnnouncedLocation = true;
            showToast(`📍 GPS signal locked (±${Math.round(accuracy)}m)`, 'success', 3000);
        }
    };

    const handleError = (err) => {
        console.warn(`Geolocation error (${err.code}): ${err.message}`);
        if (err.code === 1) { // PERMISSION_DENIED
            showToast('GPS permission denied. Please allow location access in your browser.', 'error', 6000);
        } else if (err.code === 2) { // POSITION_UNAVAILABLE
            // Retry with low accuracy
            navigator.geolocation.getCurrentPosition(updateLocation, () => {}, { enableHighAccuracy: false, timeout: 10000 });
        } else if (err.code === 3) { // TIMEOUT
            navigator.geolocation.getCurrentPosition(updateLocation, () => {}, { enableHighAccuracy: false, timeout: 15000 });
        }
    };

    navigator.geolocation.getCurrentPosition(updateLocation, handleError, options);
    watchId = navigator.geolocation.watchPosition(updateLocation, handleError, options);
}
