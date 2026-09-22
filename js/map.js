// Leaflet Map and Geolocation Management
import { CONFIG } from './config.js';

let mapInstance = null;
let userMarker = null;
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

    // Custom GPS current position marker
    const gpsIcon = L.divIcon({
        className: 'gps-current-pulse',
        iconSize: [16, 16],
        iconAnchor: [8, 8]
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

export function centerOnUser() {
    if (mapInstance && currentPosition) {
        mapInstance.setView([currentPosition.lat, currentPosition.lng], CONFIG.MAP_DEFAULT_ZOOM, {
            animate: true
        });
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
        maximumAge: 5000
    };

    const updateLocation = (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        currentPosition = { lat: latitude, lng: longitude, accuracy };

        const latLng = [latitude, longitude];

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
