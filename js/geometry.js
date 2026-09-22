// Geometry and spatial calculations for Slugs
// Uses straight-line spherical distance (Haversine) and 2D segment intersection

const EARTH_RADIUS_METERS = 6371000;

/**
 * Calculates great-circle distance between two geographic coordinates in meters.
 */
export function haversineDistance(lat1, lon1, lat2, lon2) {
    const toRad = (angle) => (angle * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);

    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return EARTH_RADIUS_METERS * c;
}

/**
 * Linearly interpolates between two points given a progress factor between 0.0 and 1.0.
 */
export function lerpCoordinates(start, end, progress) {
    const clampedProgress = Math.max(0, Math.min(1, progress));
    return {
        lat: start.lat + (end.lat - start.lat) * clampedProgress,
        lng: start.lng + (end.lng - start.lng) * clampedProgress
    };
}

/**
 * Helper cross-product for 2D orientation test.
 * > 0: counter-clockwise, < 0: clockwise, = 0: collinear
 */
function ccw(A, B, C) {
    return (C.lat - A.lat) * (B.lng - A.lng) - (B.lat - A.lat) * (C.lng - A.lng);
}

/**
 * Checks if point C lies on segment AB (assuming collinear).
 */
function onSegment(A, B, C) {
    return Math.min(A.lng, B.lng) <= C.lng && C.lng <= Math.max(A.lng, B.lng) &&
           Math.min(A.lat, B.lat) <= C.lat && C.lat <= Math.max(A.lat, B.lat);
}

/**
 * Determines whether two 2D line segments [p1 -> p2] and [p3 -> p4] intersect.
 * Coordinates are { lat, lng } or { x: lat, y: lng }.
 */
export function lineSegmentsIntersect(p1, p2, p3, p4) {
    const d1 = ccw(p3, p4, p1);
    const d2 = ccw(p3, p4, p2);
    const d3 = ccw(p1, p2, p3);
    const d4 = ccw(p1, p2, p4);

    // General case: strictly crossing
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
        ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
        return true;
    }

    // Collinear edge cases
    if (d1 === 0 && onSegment(p3, p4, p1)) return true;
    if (d2 === 0 && onSegment(p3, p4, p2)) return true;
    if (d3 === 0 && onSegment(p1, p2, p3)) return true;
    if (d4 === 0 && onSegment(p1, p2, p4)) return true;

    return false;
}

/**
 * Computes exact intersection point of two lines defined by (p1, p2) and (p3, p4) if one exists.
 */
export function getIntersectionPoint(p1, p2, p3, p4) {
    if (!lineSegmentsIntersect(p1, p2, p3, p4)) {
        return null;
    }

    const x1 = p1.lng, y1 = p1.lat;
    const x2 = p2.lng, y2 = p2.lat;
    const x3 = p3.lng, y3 = p3.lat;
    const x4 = p4.lng, y4 = p4.lat;

    const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(denom) < 1e-12) {
        // Collinear or parallel
        return { lat: (p1.lat + p2.lat) / 2, lng: (p1.lng + p2.lng) / 2 };
    }

    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
    return {
        lat: y1 + t * (y2 - y1),
        lng: x1 + t * (x2 - x1)
    };
}
