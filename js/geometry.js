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
 * Determines whether two 2D line segments [p1 -> p2] and [p3 -> p4] intersect.
 * Coordinates are { lat, lng }.
 */
export function lineSegmentsIntersect(p1, p2, p3, p4) {
    const x1 = p1.lng, y1 = p1.lat;
    const x2 = p2.lng, y2 = p2.lat;
    const x3 = p3.lng, y3 = p3.lat;
    const x4 = p4.lng, y4 = p4.lat;

    const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    const EPS = 1e-9;

    if (Math.abs(denom) > 1e-12) {
        const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
        const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;
        return t >= -EPS && t <= (1 + EPS) && u >= -EPS && u <= (1 + EPS);
    }

    // Collinear or parallel check
    const cross = (x2 - x1) * (y3 - y1) - (y2 - y1) * (x3 - x1);
    if (Math.abs(cross) > 1e-10) return false;

    const minX1 = Math.min(x1, x2), maxX1 = Math.max(x1, x2);
    const minY1 = Math.min(y1, y2), maxY1 = Math.max(y1, y2);
    const minX2 = Math.min(x3, x4), maxX2 = Math.max(x3, x4);
    const minY2 = Math.min(y3, y4), maxY2 = Math.max(y3, y4);

    return Math.max(minX1, minX2) <= Math.min(maxX1, maxX2) + EPS &&
           Math.max(minY1, minY2) <= Math.min(maxY1, maxY2) + EPS;
}

/**
 * Computes exact intersection point of two lines defined by (p1, p2) and (p3, p4) if one exists.
 */
export function getIntersectionPoint(p1, p2, p3, p4) {
    const x1 = p1.lng, y1 = p1.lat;
    const x2 = p2.lng, y2 = p2.lat;
    const x3 = p3.lng, y3 = p3.lat;
    const x4 = p4.lng, y4 = p4.lat;

    const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    const EPS = 1e-9;

    if (Math.abs(denom) > 1e-12) {
        const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
        const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;

        if (t >= -EPS && t <= (1 + EPS) && u >= -EPS && u <= (1 + EPS)) {
            const clampedT = Math.max(0, Math.min(1, t));
            return {
                lat: y1 + clampedT * (y2 - y1),
                lng: x1 + clampedT * (x2 - x1)
            };
        }
        return null;
    }

    // Collinear overlap
    const cross = (x2 - x1) * (y3 - y1) - (y2 - y1) * (x3 - x1);
    if (Math.abs(cross) > 1e-10) return null;

    const minX1 = Math.min(x1, x2), maxX1 = Math.max(x1, x2);
    const minY1 = Math.min(y1, y2), maxY1 = Math.max(y1, y2);
    const minX2 = Math.min(x3, x4), maxX2 = Math.max(x3, x4);
    const minY2 = Math.min(y3, y4), maxY2 = Math.max(y3, y4);

    if (Math.max(minX1, minX2) <= Math.min(maxX1, maxX2) + EPS &&
        Math.max(minY1, minY2) <= Math.min(maxY1, maxY2) + EPS) {
        return {
            lat: (Math.max(minY1, minY2) + Math.min(maxY1, maxY2)) / 2,
            lng: (Math.max(minX1, minX2) + Math.min(maxX1, maxX2)) / 2
        };
    }

    return null;
}
