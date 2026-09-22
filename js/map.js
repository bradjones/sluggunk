// Leaflet Map and Geolocation Management
import { CONFIG } from './config.js';

let mapInstance = null;
let userMarker = null;
let currentPosition = null;
let watchId = null;

export function initMap() {
    // Default fallback center: London / Greenwich if geolocation hasn't replied yet
    const defaultCenter = [51.505, -0.09];

    mapInstance = L.map('map', {
        zoomControl: false, // Cleaner UI on mobile
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
            // Center map on player first time location is discovered
            mapInstance.setView(latLng, CONFIG.MAP_DEFAULT_ZOOM);
        } else {
            userMarker.setLatLng(latLng);
        }
    };

    const handleError = (err) => {
        console.warn(`Geolocation error (${err.code}): ${err.message}`);
    };

    // Get immediate position first
    navigator.geolocation.getCurrentPosition(updateLocation, handleError, options);

    // Then watch for movement
    watchId = navigator.geolocation.watchPosition(updateLocation, handleError, options);
}
