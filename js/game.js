// Game State, Pin Dropping, and Stun Enforcement Module
import { getSupabase, isConfigured } from './supabase.js';
import { getCurrentUser } from './auth.js';
import { getCurrentSession } from './sessions.js';
import { getCurrentUserCoords, setStartPin, clearStartPin, setEndPin, clearEndPin, setRoutePreview, clearRoutePreview, centerOnUser } from './map.js';
import { haversineDistance } from './geometry.js';
import { showToast, openModal } from './ui.js';
import { CONFIG } from './config.js';

let myActiveAttempt = null;
let isStunned = false;
let stunTimer = null;
let stunUntilDate = null;

export function getMyActiveAttempt() {
    return myActiveAttempt;
}

export function isPlayerStunned() {
    return isStunned;
}

/**
 * Initializes game buttons and loads existing active attempt or stun state
 */
export function initGame() {
    setupActionButtons();

    // Center on user button
    document.getElementById('btn-locate-me')?.addEventListener('click', () => {
        centerOnUser();
        showToast('Centered on GPS location', 'info', 1500);
    });

    // Check state periodically
    setInterval(async () => {
        if (isConfigured() && getCurrentUser() && getCurrentSession()) {
            await checkPlayerStun();
        }
    }, 10000);
}

/**
 * Reloads attempt and stun status when session or user changes
 */
export async function syncGameState() {
    clearMapArtifacts();

    const user = getCurrentUser();
    const session = getCurrentSession();

    if (!user || !session || !isConfigured()) {
        updateGameControls();
        return;
    }

    await checkPlayerStun();
    await loadMyActiveAttempt();
}

/**
 * Sets up listeners for Start Pin, End Pin, and Cancel buttons
 */
function setupActionButtons() {
    const btnDropStart = document.getElementById('btn-drop-start');
    const btnDropEnd = document.getElementById('btn-drop-end');
    const btnCancel = document.getElementById('btn-cancel-pin');

    // Drop Start Pin
    btnDropStart?.addEventListener('click', async () => {
        if (!validateCanDrop()) return;

        const coords = getCurrentUserCoords();
        if (!coords) {
            showToast('Waiting for GPS signal... Please ensure location permissions are granted.', 'warning');
            return;
        }

        btnDropStart.disabled = true;
        btnDropStart.innerHTML = '<span>⏳</span> Placing pin...';

        try {
            await createStartPin(coords);
            showToast('Start Pin dropped! Now walk to your target destination.', 'success', 4000);
        } catch (err) {
            console.error('Failed to drop start pin:', err);
            showToast(err.message || 'Error dropping start pin.', 'error');
        } finally {
            updateGameControls();
        }
    });

    // Drop End Pin
    btnDropEnd?.addEventListener('click', async () => {
        if (!myActiveAttempt || myActiveAttempt.status !== 'started') {
            showToast('No active start pin found.', 'warning');
            return;
        }

        const coords = getCurrentUserCoords();
        if (!coords) {
            showToast('Waiting for GPS signal...', 'warning');
            return;
        }

        const distance = haversineDistance(
            myActiveAttempt.start_lat,
            myActiveAttempt.start_lng,
            coords.lat,
            coords.lng
        );

        if (distance < 15) {
            showToast(`Target too close (${Math.round(distance)}m)! End pin must be at least 15m away.`, 'warning');
            return;
        }

        btnDropEnd.disabled = true;
        btnDropEnd.innerHTML = '<span>⏳</span> Launching crawl...';

        try {
            await launchCrawl(coords, distance);
            showToast(`Slug deployed! Crawling ${Math.round(distance)}m at ${CONFIG.GAME_SPEED_KMH} km/h.`, 'success', 5000);
        } catch (err) {
            console.error('Failed to launch crawl:', err);
            showToast(err.message || 'Error setting end pin.', 'error');
        } finally {
            updateGameControls();
        }
    });

    // Cancel Pin
    btnCancel?.addEventListener('click', async () => {
        if (!myActiveAttempt || myActiveAttempt.status !== 'started') return;

        if (confirm('Cancel this start pin and reset?')) {
            await cancelStartPin();
            showToast('Start pin removed.', 'info');
        }
    });
}

/**
 * Creates start pin record in Supabase and places visual marker
 */
async function createStartPin(coords) {
    const supabase = getSupabase();
    const user = getCurrentUser();
    const session = getCurrentSession();

    const { data: attempt, error } = await supabase
        .from('attempts')
        .insert({
            session_id: session.id,
            player_id: user.id,
            start_lat: coords.lat,
            start_lng: coords.lng,
            status: 'started'
        })
        .select()
        .single();

    if (error) throw error;

    myActiveAttempt = attempt;
    setStartPin(coords.lat, coords.lng);
}

/**
 * Updates attempt with end coordinates and transitions to 'moving'
 */
async function launchCrawl(coords, distanceMeters) {
    const supabase = getSupabase();
    const nowIso = new Date().toISOString();

    const { data: updated, error } = await supabase
        .from('attempts')
        .update({
            end_lat: coords.lat,
            end_lng: coords.lng,
            status: 'moving',
            move_started_at: nowIso,
            score: distanceMeters
        })
        .eq('id', myActiveAttempt.id)
        .select()
        .single();

    if (error) throw error;

    myActiveAttempt = updated;
    setEndPin(coords.lat, coords.lng);
    setRoutePreview(
        { lat: updated.start_lat, lng: updated.start_lng },
        { lat: coords.lat, lng: coords.lng }
    );
}

/**
 * Cancels started pin attempt
 */
async function cancelStartPin() {
    if (!myActiveAttempt) return;

    const supabase = getSupabase();
    await supabase
        .from('attempts')
        .delete()
        .eq('id', myActiveAttempt.id);

    clearStartPin();
    clearEndPin();
    clearRoutePreview();
    myActiveAttempt = null;
    updateGameControls();
}

/**
 * Loads user's current ongoing attempt in this session
 */
async function loadMyActiveAttempt() {
    const supabase = getSupabase();
    const user = getCurrentUser();
    const session = getCurrentSession();
    if (!supabase || !user || !session) return;

    const { data: attempts, error } = await supabase
        .from('attempts')
        .select('*')
        .eq('session_id', session.id)
        .eq('player_id', user.id)
        .in('status', ['started', 'moving'])
        .order('created_at', { ascending: false })
        .limit(1);

    if (error) {
        console.warn('Error loading active attempt:', error);
        return;
    }

    if (attempts && attempts.length > 0) {
        myActiveAttempt = attempts[0];

        // Restore map markers
        setStartPin(myActiveAttempt.start_lat, myActiveAttempt.start_lng);

        if (myActiveAttempt.status === 'moving' && myActiveAttempt.end_lat && myActiveAttempt.end_lng) {
            setEndPin(myActiveAttempt.end_lat, myActiveAttempt.end_lng);
            setRoutePreview(
                { lat: myActiveAttempt.start_lat, lng: myActiveAttempt.start_lng },
                { lat: myActiveAttempt.end_lat, lng: myActiveAttempt.end_lng }
            );
        }
    } else {
        myActiveAttempt = null;
    }

    updateGameControls();
}

/**
 * Checks if current player is currently stunned
 */
export async function checkPlayerStun() {
    const supabase = getSupabase();
    const user = getCurrentUser();
    const session = getCurrentSession();
    if (!supabase || !user || !session) return;

    const now = new Date().toISOString();

    const { data: stuns, error } = await supabase
        .from('stuns')
        .select('*')
        .eq('session_id', session.id)
        .eq('player_id', user.id)
        .gt('stunned_until', now)
        .order('stunned_until', { ascending: false })
        .limit(1);

    if (stuns && stuns.length > 0) {
        const stun = stuns[0];
        isStunned = true;
        stunUntilDate = new Date(stun.stunned_until);
        startStunCountdown();
    } else {
        if (isStunned) {
            isStunned = false;
            stunUntilDate = null;
            if (stunTimer) clearInterval(stunTimer);
            showToast('⚡ Stun expired! You can drop pins again.', 'success');
        }
    }

    updateGameControls();
}

/**
 * Ticks down stun timer and updates HUD badge
 */
function startStunCountdown() {
    if (stunTimer) clearInterval(stunTimer);

    const updateTimer = () => {
        if (!stunUntilDate) return;
        const diffMs = stunUntilDate.getTime() - Date.now();

        if (diffMs <= 0) {
            isStunned = false;
            stunUntilDate = null;
            clearInterval(stunTimer);
            updateGameControls();
            showToast('⚡ Stun expired! You can drop pins again.', 'success');
            return;
        }

        const mins = Math.floor(diffMs / 60000);
        const secs = Math.floor((diffMs % 60000) / 1000);

        const badge = document.getElementById('player-status-badge');
        const statusText = document.getElementById('status-text');
        const statusIcon = document.getElementById('status-icon');

        if (badge) {
            badge.className = 'hud-badge status-stunned';
            if (statusIcon) statusIcon.textContent = '⚡';
            if (statusText) statusText.textContent = `Stunned: ${mins}m ${secs}s`;
        }
    };

    updateTimer();
    stunTimer = setInterval(updateTimer, 1000);
}

/**
 * Validates prerequisites before pin dropping
 */
function validateCanDrop() {
    const user = getCurrentUser();
    if (!user) {
        showToast('Please sign in first!', 'warning');
        openModal('modal-auth');
        return false;
    }

    const session = getCurrentSession();
    if (!session) {
        showToast('Please join or create a session first!', 'warning');
        openModal('modal-session');
        return false;
    }

    if (isStunned) {
        showToast('You are stunned! Pin dropping is suspended until the timer expires.', 'error');
        return false;
    }

    if (myActiveAttempt && myActiveAttempt.status === 'moving') {
        showToast('Your slug is already in transit! Wait until it reaches the destination.', 'warning');
        return false;
    }

    return true;
}

/**
 * Updates UI action buttons and banners based on state
 */
export function updateGameControls() {
    const btnDropStart = document.getElementById('btn-drop-start');
    const btnDropEnd = document.getElementById('btn-drop-end');
    const btnCancel = document.getElementById('btn-cancel-pin');
    const banner = document.getElementById('info-banner');
    const bannerText = document.getElementById('banner-text');
    const bannerSubtext = document.getElementById('banner-subtext');
    const badge = document.getElementById('player-status-badge');
    const statusIcon = document.getElementById('status-icon');
    const statusText = document.getElementById('status-text');

    if (!btnDropStart || !btnDropEnd || !btnCancel) return;

    if (isStunned) {
        btnDropStart.style.display = 'flex';
        btnDropStart.disabled = true;
        btnDropStart.innerHTML = '<span>⚡</span> Stunned (Cooldown)';
        btnDropEnd.style.display = 'none';
        btnCancel.style.display = 'none';
        if (banner) banner.style.display = 'none';
        return;
    }

    if (!myActiveAttempt) {
        // Idle state
        btnDropStart.style.display = 'flex';
        btnDropStart.disabled = false;
        btnDropStart.innerHTML = '<span>📍</span> Drop Start Pin';
        btnDropEnd.style.display = 'none';
        btnCancel.style.display = 'none';
        if (banner) banner.style.display = 'none';

        if (badge) badge.className = 'hud-badge status-idle';
        if (statusIcon) statusIcon.textContent = '🐌';
        return;
    }

    if (myActiveAttempt.status === 'started') {
        // Start pin dropped, waiting for end pin
        btnDropStart.style.display = 'none';
        btnDropEnd.style.display = 'flex';
        btnDropEnd.disabled = false;
        btnDropEnd.innerHTML = '<span>🏁</span> Drop End Pin';
        btnCancel.style.display = 'flex';

        if (banner) {
            banner.style.display = 'flex';
            if (bannerText) bannerText.textContent = 'Start pin placed.';
            if (bannerSubtext) bannerSubtext.textContent = 'Walk to target & drop end pin';
        }

        if (badge) badge.className = 'hud-badge status-idle';
        if (statusIcon) statusIcon.textContent = '📍';
        if (statusText) statusText.textContent = 'Placing finish...';
        return;
    }

    if (myActiveAttempt.status === 'moving') {
        // Avatar is in transit
        btnDropStart.style.display = 'flex';
        btnDropStart.disabled = true;
        btnDropStart.innerHTML = '<span>🐌</span> Slug Crawling...';
        btnDropEnd.style.display = 'none';
        btnCancel.style.display = 'none';

        const dist = Math.round(myActiveAttempt.score || 0);
        // Estimated travel duration in minutes at 1 km/h
        const speedMetersPerMinute = (CONFIG.GAME_SPEED_KMH * 1000) / 60;
        const totalMinutes = Math.round(dist / speedMetersPerMinute);

        if (banner) {
            banner.style.display = 'flex';
            if (bannerText) bannerText.textContent = `Crawl route: ${dist}m`;
            if (bannerSubtext) bannerSubtext.textContent = `Speed: ${CONFIG.GAME_SPEED_KMH} km/h • ~${totalMinutes}m`;
        }

        if (badge) badge.className = 'hud-badge status-moving';
        if (statusIcon) statusIcon.textContent = '🐌';
        if (statusText) statusText.textContent = 'Slug in motion';
    }
}

/**
 * Removes all local map markers & preview lines
 */
function clearMapArtifacts() {
    clearStartPin();
    clearEndPin();
    clearRoutePreview();
    myActiveAttempt = null;
}
