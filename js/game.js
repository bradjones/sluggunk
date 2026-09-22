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
import { 
    haversineDistance, 
    lerpCoordinates, 
    lineSegmentsIntersect, 
    getIntersectionPoint 
} from './geometry.js';
import { showToast, openModal } from './ui.js';
import { CONFIG } from './config.js';

let myActiveAttempt = null;
let isStunned = false;
let stunTimer = null;
let stunUntilDate = null;
let isStateSyncing = true; // Prevents race conditions on page load

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

    updateGameControls();
}

/**
 * Reloads attempt and stun status when session or user changes
 */
export async function syncGameState() {
    isStateSyncing = true;
    updateGameControls(); // Locks buttons into loading state

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
        isStateSyncing = false;
        updateGameControls();
        return;
    }

    try {
        await checkPlayerStun();
        await loadMyActiveAttempt();
        await loadSessionAttempts(session.id);
        subscribeToAttemptsRealtime(session.id);

        if (!movementLoopTimer) {
            startMovementLoop();
        }
    } catch (err) {
        console.error('Error syncing game state:', err);
    } finally {
        isStateSyncing = false;
        updateGameControls();
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

    // Guard against race conditions: check if attempt already exists in DB
    const { data: existing } = await supabase
        .from('attempts')
        .select(`*, profiles(display_name)`)
        .eq('session_id', session.id)
        .eq('player_id', user.id)
        .in('status', ['started', 'moving'])
        .order('created_at', { ascending: false })
        .limit(1);

    if (existing && existing.length > 0) {
        myActiveAttempt = existing[0];
        sessionAttempts.set(myActiveAttempt.id, myActiveAttempt);
        setStartPin(myActiveAttempt.start_lat, myActiveAttempt.start_lng);
        if (myActiveAttempt.status === 'moving' && myActiveAttempt.end_lat && myActiveAttempt.end_lng) {
            setEndPin(myActiveAttempt.end_lat, myActiveAttempt.end_lng);
            setRoutePreview(
                { lat: myActiveAttempt.start_lat, lng: myActiveAttempt.start_lng },
                { lat: myActiveAttempt.end_lat, lng: myActiveAttempt.end_lng }
            );
        }
        updateGameControls();
        showToast('Resumed active route!', 'info');
        return;
    }

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
                    } else {
                        const victimName = newRecord.profiles?.display_name || 'A slug';
                        showToast(`💥 ${victimName} was intercepted and squished!`, 'warning', 4000);
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

                // --- COLLISION DETECTION & SPOILER MECHANIC (Phase 6) ---
                if (isSelf && myActiveAttempt?.id === attempt.id) {
                    const collision = checkPathCollision(attempt, currentPos, now, speedMps);
                    if (collision) {
                        voidMyAttempt(attempt, collision.spoilerPlayerName, collision.hitPoint);
                        return;
                    }
                } else if (!isSelf) {
                    // For remote slugs: verify if they crossed an obstacle
                    const collision = checkPathCollision(attempt, currentPos, now, speedMps);
                    if (collision && now >= collision.collisionTime) {
                        removeSlugAvatar(attempt.id);
                        removeTraveledTrail(attempt.id);
                        sessionAttempts.delete(attempt.id);
                        return;
                    }
                }

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
        
        // Refresh leaderboard if it is currently open
        const leaderboardModal = document.getElementById('modal-leaderboard');
        if (leaderboardModal?.classList.contains('active')) {
            loadAndRenderLeaderboard();
        }
    }
}

/**
 * Plays a quick synth squish sound effect when a slug is voided (Web Audio API)
 */
function playSquishSound() {
    try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;
        const audioCtx = new AudioContextClass();
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);

        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(340, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(50, audioCtx.currentTime + 0.35);

        gain.gain.setValueAtTime(0.25, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.35);

        osc.start();
        osc.stop(audioCtx.currentTime + 0.36);
    } catch (e) {
        // Audio may be prevented until user gesture
    }
}

/**
 * Checks if a moving attempt's traveled trail intersects any active trail of OTHER players.
 * Returns null if no collision, or { obstacleAttempt, spoilerPlayerName, hitPoint, collisionTime } if collided.
 */
function checkPathCollision(attempt, currentPos, now, speedMps) {
    const myStart = { lat: attempt.start_lat, lng: attempt.start_lng };
    const myCurrent = { lat: currentPos.lat, lng: currentPos.lng };
    const myStartTime = new Date(attempt.move_started_at).getTime();

    for (const [otherId, other] of sessionAttempts.entries()) {
        // 1. Ignore self-collision (own past or present attempts never void own slug)
        if (other.player_id === attempt.player_id) continue;

        // 2. Ignore invalid or voided attempts
        if (other.status !== 'completed' && other.status !== 'moving') continue;

        const otherName = other.profiles?.display_name || 'Another player';

        if (other.status === 'completed') {
            // Check if completed path is still active (within 1 hour)
            const expiresAtMs = other.expires_at ? new Date(other.expires_at).getTime() : 0;
            if (expiresAtMs <= now) continue;

            const otherStart = { lat: other.start_lat, lng: other.start_lng };
            const otherEnd = { lat: other.end_lat, lng: other.end_lng };

            // Check segment intersection: my traveled path vs other completed path
            if (lineSegmentsIntersect(myStart, myCurrent, otherStart, otherEnd)) {
                const hitPoint = getIntersectionPoint(myStart, myCurrent, otherStart, otherEnd);
                if (!hitPoint) continue;

                // Doorstep check: Ignore if within 10m of start pin of either player
                const distFromMyStart = haversineDistance(myStart.lat, myStart.lng, hitPoint.lat, hitPoint.lng);
                const distFromOtherStart = haversineDistance(otherStart.lat, otherStart.lng, hitPoint.lat, hitPoint.lng);
                if (distFromMyStart < 10 || distFromOtherStart < 10) continue;

                // Temporal check: Did my slug reach hitPoint AFTER the other path reached hitPoint?
                const myTimeAtHitMs = myStartTime + (distFromMyStart / speedMps) * 1000;

                let otherTimeAtHitMs = 0;
                if (other.move_started_at) {
                    const otherDist = haversineDistance(otherStart.lat, otherStart.lng, hitPoint.lat, hitPoint.lng);
                    otherTimeAtHitMs = new Date(other.move_started_at).getTime() + (otherDist / speedMps) * 1000;
                } else if (other.completed_at) {
                    otherTimeAtHitMs = new Date(other.completed_at).getTime();
                }

                // If I arrived after or simultaneously with the other path -> collision!
                if (myTimeAtHitMs >= otherTimeAtHitMs - 1000) {
                    return {
                        obstacleAttempt: other,
                        spoilerPlayerName: otherName,
                        hitPoint,
                        collisionTime: myTimeAtHitMs
                    };
                }
            }
        } else if (other.status === 'moving') {
            if (!other.end_lat || !other.end_lng || !other.move_started_at) continue;

            const otherStart = { lat: other.start_lat, lng: other.start_lng };
            const otherEnd = { lat: other.end_lat, lng: other.end_lng };

            // Calculate other slug's current position right now
            const otherTotalDist = haversineDistance(otherStart.lat, otherStart.lng, otherEnd.lat, otherEnd.lng);
            const otherTotalSeconds = otherTotalDist / speedMps;
            const otherElapsed = (now - new Date(other.move_started_at).getTime()) / 1000;
            const otherProgress = Math.min(1.0, Math.max(0.0, otherElapsed / otherTotalSeconds));
            const otherCurrent = lerpCoordinates(otherStart, otherEnd, otherProgress);

            // Check if my traveled trail intersects other's traveled trail
            if (lineSegmentsIntersect(myStart, myCurrent, otherStart, otherCurrent)) {
                const hitPoint = getIntersectionPoint(myStart, myCurrent, otherStart, otherCurrent);
                if (!hitPoint) continue;

                // Doorstep check
                const distFromMyStart = haversineDistance(myStart.lat, myStart.lng, hitPoint.lat, hitPoint.lng);
                const distFromOtherStart = haversineDistance(otherStart.lat, otherStart.lng, hitPoint.lat, hitPoint.lng);
                if (distFromMyStart < 10 || distFromOtherStart < 10) continue;

                const myTimeAtHitMs = myStartTime + (distFromMyStart / speedMps) * 1000;
                const otherStartTime = new Date(other.move_started_at).getTime();
                const otherTimeAtHitMs = otherStartTime + (distFromOtherStart / speedMps) * 1000;

                // If I arrived after the other slug, OR if both arrived simultaneously (within 5 seconds)
                if (myTimeAtHitMs >= otherTimeAtHitMs - 5000) {
                    return {
                        obstacleAttempt: other,
                        spoilerPlayerName: otherName,
                        hitPoint,
                        collisionTime: myTimeAtHitMs
                    };
                }
            }
        }
    }

    return null;
}

/**
 * Voids player's active attempt upon collision, triggers feedback, and starts 1-hour stun
 */
async function voidMyAttempt(attempt, spoilerPlayerName, hitPoint) {
    if (!myActiveAttempt || myActiveAttempt.id !== attempt.id || myActiveAttempt.status === 'voided') {
        return;
    }

    // Set local state immediately
    myActiveAttempt = { ...attempt, status: 'voided' };
    sessionAttempts.delete(attempt.id);

    removeSlugAvatar(attempt.id);
    removeTraveledTrail(attempt.id);
    clearMapArtifacts();

    // Visual, haptic, and audio feedback
    playSquishSound();
    if (navigator.vibrate) {
        try { navigator.vibrate([200, 100, 200, 100, 400]); } catch (e) {}
    }
    const appEl = document.getElementById('app') || document.body;
    appEl.classList.add('collision-shake');
    setTimeout(() => appEl.classList.remove('collision-shake'), 600);

    showToast(`💥 SQUISHED! Intercepted by ${spoilerPlayerName}'s path! Stunned for 1 hour.`, 'error', 8000);

    const supabase = getSupabase();
    if (!supabase) return;

    const now = new Date();
    const stunUntil = new Date(now.getTime() + CONFIG.STUN_DURATION_MS).toISOString();

    try {
        // 1. Update attempt status in DB
        await supabase
            .from('attempts')
            .update({
                status: 'voided',
                completed_at: now.toISOString()
            })
            .eq('id', attempt.id);

        // 2. Record stun in DB
        await supabase
            .from('stuns')
            .insert({
                session_id: attempt.session_id,
                player_id: attempt.player_id,
                stunned_at: now.toISOString(),
                stunned_until: stunUntil,
                caused_by_attempt: attempt.id
            });

        // 3. Start local stun cooldown
        isStunned = true;
        stunUntilDate = new Date(stunUntil);
        startStunCountdown();
        updateGameControls();
    } catch (err) {
        console.error('Error recording void & stun:', err);
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
 * Queries completed attempts and renders ranked leaderboard
 */
export async function loadAndRenderLeaderboard() {
    const listContainer = document.getElementById('leaderboard-list');
    if (!listContainer) return;

    const session = getCurrentSession();
    if (!session) {
        listContainer.innerHTML = '<p style="color: var(--text-muted); text-align: center; padding: 20px;">Join or create a session to see the leaderboard.</p>';
        return;
    }

    const supabase = getSupabase();
    if (!supabase) return;

    listContainer.innerHTML = '<p style="color: var(--text-muted); text-align: center; padding: 20px;">Loading scores...</p>';

    try {
        const { data: attempts, error } = await supabase
            .from('attempts')
            .select(`
                id,
                player_id,
                score,
                status,
                profiles ( display_name )
            `)
            .eq('session_id', session.id)
            .eq('status', 'completed');

        if (error) throw error;

        // Group scores by player
        const playerStats = new Map();

        // Include all session members even with 0 points
        const { getSessionPlayers } = await import('./sessions.js');
        const players = getSessionPlayers();
        players.forEach(p => {
            playerStats.set(p.player_id, {
                playerId: p.player_id,
                name: p.profiles?.display_name || 'Pilot',
                totalScore: 0,
                completedCount: 0
            });
        });

        attempts?.forEach(att => {
            const current = playerStats.get(att.player_id) || {
                playerId: att.player_id,
                name: att.profiles?.display_name || 'Pilot',
                totalScore: 0,
                completedCount: 0
            };
            current.totalScore += Math.round(att.score || 0);
            current.completedCount += 1;
            playerStats.set(att.player_id, current);
        });

        const sorted = Array.from(playerStats.values()).sort((a, b) => b.totalScore - a.totalScore);

        if (sorted.length === 0 || sorted.every(s => s.totalScore === 0)) {
            listContainer.innerHTML = '<p style="color: var(--text-muted); text-align: center; padding: 20px;">No completed paths yet in this session. Crawl your first route to score!</p>';
            return;
        }

        listContainer.innerHTML = '';
        const user = getCurrentUser();

        sorted.forEach((stat, index) => {
            const isSelf = user && stat.playerId === user.id;
            const row = document.createElement('div');
            row.className = 'banner';
            row.style.padding = '10px 14px';

            let medal = `#${index + 1}`;
            if (index === 0) medal = '🥇';
            if (index === 1) medal = '🥈';
            if (index === 2) medal = '🥉';

            row.innerHTML = `
                <div style="display: flex; align-items: center; gap: 10px;">
                    <span style="font-size: 1.15rem; font-weight: 700; width: 26px; text-align: center;">${medal}</span>
                    <div>
                        <div style="font-weight: 700; font-size: 0.95rem;">
                            ${stat.name} ${isSelf ? '<span style="color: var(--primary); font-size: 0.75rem;">(You)</span>' : ''}
                        </div>
                        <div style="color: var(--text-muted); font-size: 0.75rem;">
                            ${stat.completedCount} path${stat.completedCount === 1 ? '' : 's'} completed
                        </div>
                    </div>
                </div>
                <div style="font-weight: 800; font-size: 1.15rem; color: var(--primary);">
                    ${stat.totalScore.toLocaleString()}m
                </div>
            `;
            listContainer.appendChild(row);
        });
    } catch (err) {
        console.error('Error rendering leaderboard:', err);
        listContainer.innerHTML = `<p style="color: var(--danger); text-align: center; padding: 20px;">Error loading scores: ${err.message}</p>`;
    }
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
    if (isStateSyncing) {
        showToast('Checking game status, please wait a moment...', 'info');
        return false;
    }

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

    if (isStateSyncing) {
        btnDropStart.style.display = 'flex';
        btnDropStart.disabled = true;
        btnDropStart.innerHTML = '<span>⏳</span> Checking status...';
        btnDropEnd.style.display = 'none';
        btnCancel.style.display = 'none';
        return;
    }

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
