// Leaflet Map and Geolocation Management
import { CONFIG } from './config.js';

let mapInstance = null;
let userMarker = null;
let accuracyCircle = null;
let currentPosition = null;
let watchId = null;

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

    // Custom GPS current position marker with nested elements to prevent CSS transform conflicts
    const gpsIcon = L.divIcon({
        className: 'gps-container',
        html: '<div class="gps-pulse-ring"></div><div class="gps-dot"></div>',
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
            },
            (err) => console.warn('Recenter GPS error:', err),
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

/**
 * Starts continuous HTML5 Geolocation tracking
 */
function startGeolocationTracking(gpsIcon) {
    if (!('geolocation' in navigator)) {
        console.warn('Geolocation is not supported by this browser.');
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
    };

    const handleError = (err) => {
        console.warn(`Geolocation error (${err.code}): ${err.message}`);
    };

    navigator.geolocation.getCurrentPosition(updateLocation, handleError, options);
    watchId = navigator.geolocation.watchPosition(updateLocation, handleError, options);
}
