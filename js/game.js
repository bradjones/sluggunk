// Game State, Avatar Movement, and Realtime Sync Module
import { getSupabase, isConfigured } from './supabase.js';
import { getCurrentUser } from './auth.js';
import { getCurrentSession } from './sessions.js';
import { 
    getCurrentUserCoords, 
    setStartPin, 
    clearStartPin, 
    setEndPin, 
    clearEndPin, 
    setRoutePreview, 
    clearRoutePreview, 
    centerOnUser,
    renderSlugAvatar,
    removeSlugAvatar,
    renderTraveledTrail,
    removeTraveledTrail,
    renderRemoteStartPin,
    removeRemoteStartPin,
    clearAllGameLayers
} from './map.js';
import { haversineDistance, lerpCoordinates } from './geometry.js';
import { showToast, openModal } from './ui.js';
import { CONFIG } from './config.js';

let myActiveAttempt = null;
let isStunned = false;
let stunTimer = null;
let stunUntilDate = null;

// Multi-player session attempts collection
const sessionAttempts = new Map();
let attemptsChannel = null;
let movementLoopTimer = null;

const PLAYER_COLORS = [
    '#10b981', // Emerald
    '#06b6d4', // Cyan
    '#8b5cf6', // Violet
    '#f59e0b', // Amber
    '#ec4899', // Pink
    '#3b82f6', // Blue
    '#14b8a6', // Teal
    '#f97316'  // Orange
];

export function getMyActiveAttempt() {
    return myActiveAttempt;
}

export function isPlayerStunned() {
    return isStunned;
}

export function getAllSessionAttempts() {
    return Array.from(sessionAttempts.values());
}

/**
 * Initializes game buttons, locate utility, and stun monitoring
 */
export function initGame() {
    setupActionButtons();

    document.getElementById('btn-locate-me')?.addEventListener('click', () => {
        centerOnUser();
        showToast('Centered on GPS location', 'info', 1500);
    });

    // Check stun periodically
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
    clearAllGameLayers();
    sessionAttempts.clear();

    const user = getCurrentUser();
    const session = getCurrentSession();

    if (!user || !session || !isConfigured()) {
        if (attemptsChannel) {
            const supabase = getSupabase();
            supabase?.removeChannel(attemptsChannel);
            attemptsChannel = null;
        }
        if (movementLoopTimer) {
            clearInterval(movementLoopTimer);
            movementLoopTimer = null;
        }
        updateGameControls();
        return;
    }

    await checkPlayerStun();
    await loadMyActiveAttempt();
    await loadSessionAttempts(session.id);
    subscribeToAttemptsRealtime(session.id);

    if (!movementLoopTimer) {
        startMovementLoop();
    }
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
            showToast('Waiting for GPS signal... Please make sure location is enabled.', 'warning');
            return;
        }

        btnDropStart.disabled = true;
        btnDropStart.innerHTML = '<span>⏳</span> Placing pin...';

        try {
            await createStartPin(coords);
            showToast('Start Pin dropped! Walk to your destination and drop End Pin.', 'success', 4000);
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
            showToast(`Slug released! Crawling ${Math.round(distance)}m at ${CONFIG.GAME_SPEED_KMH} km/h.`, 'success', 5000);
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
        .select(`*, profiles(display_name)`)
        .single();

    if (error) throw error;

    myActiveAttempt = attempt;
    sessionAttempts.set(attempt.id, attempt);
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
        .select(`*, profiles(display_name)`)
        .single();

    if (error) throw error;

    myActiveAttempt = updated;
    sessionAttempts.set(updated.id, updated);

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

    sessionAttempts.delete(myActiveAttempt.id);
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
        .select(`*, profiles(display_name)`)
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
        sessionAttempts.set(myActiveAttempt.id, myActiveAttempt);

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
 * Loads all active session attempts (started, moving, and recently completed within 1 hr)
 */
async function loadSessionAttempts(sessionId) {
    const supabase = getSupabase();
    if (!supabase) return;

    const { data: attempts, error } = await supabase
        .from('attempts')
        .select(`
            id,
            session_id,
            player_id,
            start_lat,
            start_lng,
            end_lat,
            end_lng,
            status,
            move_started_at,
            completed_at,
            expires_at,
            score,
            created_at,
            profiles ( display_name )
        `)
        .eq('session_id', sessionId)
        .in('status', ['started', 'moving', 'completed']);

    if (!error && attempts) {
        const now = Date.now();
        attempts.forEach(att => {
            // Keep completed attempts only if not expired (1 hour window)
            if (att.status === 'completed') {
                if (att.expires_at && new Date(att.expires_at).getTime() > now) {
                    sessionAttempts.set(att.id, att);
                }
            } else {
                sessionAttempts.set(att.id, att);
            }
        });
    }
}

/**
 * Real-time subscription to attempts in the current session
 */
function subscribeToAttemptsRealtime(sessionId) {
    const supabase = getSupabase();
    if (!supabase) return;

    if (attemptsChannel) {
        supabase.removeChannel(attemptsChannel);
    }

    attemptsChannel = supabase.channel(`attempts-${sessionId}`)
        .on('postgres_changes', {
            event: '*',
            schema: 'public',
            table: 'attempts',
            filter: `session_id=eq.${sessionId}`
        }, async (payload) => {
            const { eventType, new: newRecord, old: oldRecord } = payload;
            const user = getCurrentUser();

            if (eventType === 'DELETE') {
                const deletedId = oldRecord?.id;
                if (deletedId) {
                    sessionAttempts.delete(deletedId);
                    removeSlugAvatar(deletedId);
                    removeTraveledTrail(deletedId);
                    removeRemoteStartPin(deletedId);
                }
                return;
            }

            if (newRecord) {
                // Fetch profile display name for the player
                const { data: profile } = await supabase
                    .from('profiles')
                    .select('display_name')
                    .eq('id', newRecord.player_id)
                    .single();

                newRecord.profiles = profile || { display_name: 'Pilot' };

                if (newRecord.status === 'voided') {
                    sessionAttempts.delete(newRecord.id);
                    removeSlugAvatar(newRecord.id);
                    removeTraveledTrail(newRecord.id);
                    removeRemoteStartPin(newRecord.id);

                    if (user && newRecord.player_id === user.id) {
                        myActiveAttempt = null;
                        clearMapArtifacts();
                        showToast('💥 Your path was intercepted! You are stunned for 1 hour.', 'error', 6000);
                        await checkPlayerStun();
                    }
                    return;
                }

                sessionAttempts.set(newRecord.id, newRecord);

                if (user && newRecord.player_id === user.id) {
                    myActiveAttempt = newRecord;
                    updateGameControls();
                }
            }
        })
        .subscribe();
}

/**
 * Main game movement and tick loop (calculates progress, updates avatars & trails)
 */
function startMovementLoop() {
    movementLoopTimer = setInterval(() => {
        const user = getCurrentUser();
        const now = Date.now();

        sessionAttempts.forEach((attempt) => {
            const isSelf = user && attempt.player_id === user.id;
            const playerName = attempt.profiles?.display_name || (isSelf ? 'You' : 'Slug');
            const color = getPlayerColor(attempt.player_id);

            // 1. Started: show start pin if remote player
            if (attempt.status === 'started') {
                if (!isSelf) {
                    renderRemoteStartPin(
                        attempt.id,
                        { lat: attempt.start_lat, lng: attempt.start_lng },
                        playerName,
                        color
                    );
                }
                return;
            }

            // 2. Completed: show full active trail until expired
            if (attempt.status === 'completed') {
                removeSlugAvatar(attempt.id);
                removeRemoteStartPin(attempt.id);

                if (attempt.expires_at && new Date(attempt.expires_at).getTime() > now) {
                    renderTraveledTrail(
                        attempt.id,
                        [
                            [attempt.start_lat, attempt.start_lng],
                            [attempt.end_lat, attempt.end_lng]
                        ],
                        color,
                        true // isCompleted (solid thick trail)
                    );
                } else {
                    // Expired
                    removeTraveledTrail(attempt.id);
                    sessionAttempts.delete(attempt.id);
                }
                return;
            }

            // 3. Moving: interpolate position along route
            if (attempt.status === 'moving' && attempt.end_lat && attempt.end_lng && attempt.move_started_at) {
                const start = { lat: attempt.start_lat, lng: attempt.start_lng };
                const end = { lat: attempt.end_lat, lng: attempt.end_lng };

                const totalDist = haversineDistance(start.lat, start.lng, end.lat, end.lng);
                const speedMps = (CONFIG.GAME_SPEED_KMH * 1000) / 3600; // 1 km/h in m/s
                const totalSeconds = totalDist / speedMps;

                const elapsedSeconds = (now - new Date(attempt.move_started_at).getTime()) / 1000;
                const progress = Math.min(1.0, Math.max(0.0, elapsedSeconds / totalSeconds));

                // Deterministic current avatar coordinate
                const currentPos = lerpCoordinates(start, end, progress);

                // Render moving avatar
                renderSlugAvatar(attempt.id, currentPos, playerName, color, isSelf);

                // Render trail traveled so far (fog of war: only show what has been crawled)
                renderTraveledTrail(
                    attempt.id,
                    [
                        [start.lat, start.lng],
                        [currentPos.lat, currentPos.lng]
                    ],
                    color,
                    false
                );

                // Update bottom banner info if self
                if (isSelf && myActiveAttempt?.id === attempt.id) {
                    updateSelfCrawlBanner(totalDist, progress, totalSeconds - elapsedSeconds);
                }

                // Check for completion
                if (progress >= 1.0) {
                    if (isSelf) {
                        completeMyAttempt(attempt, totalDist);
                    }
                }
            }
        });
    }, 1000);
}

/**
 * Marks own attempt completed and awards straight-line distance score
 */
async function completeMyAttempt(attempt, scoreMeters) {
    const supabase = getSupabase();
    const now = new Date();
    const completedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + CONFIG.PATH_EXPIRATION_MS).toISOString(); // Active 1 hr

    const { data: completed, error } = await supabase
        .from('attempts')
        .update({
            status: 'completed',
            completed_at: completedAt,
            expires_at: expiresAt,
            score: Math.round(scoreMeters)
        })
        .eq('id', attempt.id)
        .select(`*, profiles(display_name)`)
        .single();

    if (!error && completed) {
        sessionAttempts.set(completed.id, completed);
        myActiveAttempt = null;
        clearStartPin();
        clearEndPin();
        clearRoutePreview();
        updateGameControls();
        showToast(`🏁 Slug reached target! +${Math.round(scoreMeters)}m scored!`, 'success', 6000);
    }
}

/**
 * Updates self progress in bottom banner
 */
function updateSelfCrawlBanner(totalDist, progress, remainingSeconds) {
    const banner = document.getElementById('info-banner');
    const bannerText = document.getElementById('banner-text');
    const bannerSubtext = document.getElementById('banner-subtext');

    if (!banner) return;
    banner.style.display = 'flex';

    const covered = Math.round(totalDist * progress);
    const total = Math.round(totalDist);
    const pct = Math.round(progress * 100);
    const mins = Math.max(0, Math.ceil(remainingSeconds / 60));

    if (bannerText) bannerText.textContent = `Crawled: ${covered}m / ${total}m (${pct}%)`;
    if (bannerSubtext) bannerSubtext.textContent = `ETA: ~${mins}m • 1 km/h`;
}

/**
 * Computes deterministic vibrant color for a player
 */
function getPlayerColor(playerId) {
    if (!playerId) return PLAYER_COLORS[0];
    let hash = 0;
    for (let i = 0; i < playerId.length; i++) {
        hash = (hash << 5) - hash + playerId.charCodeAt(i);
        hash |= 0;
    }
    const index = Math.abs(hash) % PLAYER_COLORS.length;
    return PLAYER_COLORS[index];
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
