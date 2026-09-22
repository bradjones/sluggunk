// Game Session Management (Create, Join, Admin Promotion, and Roster Sync)
import { getSupabase, isConfigured } from './supabase.js';
import { getCurrentUser, getCurrentProfile } from './auth.js';
import { showToast, closeModal, openModal } from './ui.js';

let currentSession = null;
let sessionPlayers = [];
let isCurrentUserAdmin = false;
let sessionChannel = null;
let onSessionChangedCallback = null;

const STORAGE_KEY = 'slugs_active_session_id';

export function getCurrentSession() {
    return currentSession;
}

export function getSessionPlayers() {
    return sessionPlayers;
}

export function isAdmin() {
    return isCurrentUserAdmin;
}

/**
 * Initializes session listeners and restores active session if saved
 */
export function initSessions(onSessionChanged) {
    onSessionChangedCallback = onSessionChanged;

    setupUIEventListeners();

    // Check if user previously had an active session stored
    const savedSessionId = localStorage.getItem(STORAGE_KEY);
    if (savedSessionId && isConfigured()) {
        loadSession(savedSessionId).catch(err => {
            console.warn('Could not restore saved session:', err);
            localStorage.removeItem(STORAGE_KEY);
        });
    }
}

/**
 * Attaches DOM button listeners
 */
function setupUIEventListeners() {
    const btnCreate = document.getElementById('btn-create-session');
    const inputName = document.getElementById('input-new-session-name');
    const btnJoin = document.getElementById('btn-join-session');
    const inputCode = document.getElementById('input-join-code');
    const btnCopy = document.getElementById('btn-copy-code');
    const btnLeave = document.getElementById('btn-leave-session');
    const btnEnd = document.getElementById('btn-end-session');

    // Create session
    btnCreate?.addEventListener('click', async () => {
        const user = getCurrentUser();
        if (!user) {
            showToast('Please sign in first to create a session.', 'warning');
            openModal('modal-auth');
            return;
        }

        const name = inputName.value.trim() || 'Slug Arena';
        btnCreate.disabled = true;
        btnCreate.textContent = 'Creating...';

        try {
            await createSession(name);
            inputName.value = '';
            showToast(`Session "${name}" created!`, 'success');
        } catch (err) {
            console.error('Create session error:', err);
            showToast(err.message || 'Failed to create session.', 'error');
        } finally {
            btnCreate.disabled = false;
            btnCreate.textContent = 'Create Session';
        }
    });

    // Join session
    btnJoin?.addEventListener('click', async () => {
        const user = getCurrentUser();
        if (!user) {
            showToast('Please sign in first to join a session.', 'warning');
            openModal('modal-auth');
            return;
        }

        const code = inputCode.value.trim().toUpperCase();
        if (!code) {
            showToast('Please enter a 6-character session code.', 'warning');
            return;
        }

        btnJoin.disabled = true;
        btnJoin.textContent = 'Joining...';

        try {
            await joinSessionByCode(code);
            inputCode.value = '';
            showToast(`Joined session!`, 'success');
        } catch (err) {
            console.error('Join session error:', err);
            showToast(err.message || 'Failed to join session.', 'error');
        } finally {
            btnJoin.disabled = false;
            btnJoin.textContent = 'Join';
        }
    });

    // Copy join code
    btnCopy?.addEventListener('click', () => {
        if (!currentSession?.join_code) return;
        navigator.clipboard?.writeText(currentSession.join_code).then(() => {
            showToast(`Code ${currentSession.join_code} copied to clipboard!`, 'info');
        }).catch(() => {
            showToast(`Join code: ${currentSession.join_code}`, 'info');
        });
    });

    // Leave session
    btnLeave?.addEventListener('click', () => {
        leaveCurrentSession();
        showToast('Left session.', 'info');
    });

    // End session (Admin only)
    btnEnd?.addEventListener('click', async () => {
        if (!isCurrentUserAdmin) {
            showToast('Only session admins can end the game.', 'error');
            return;
        }

        if (confirm('Are you sure you want to end this game session for all players?')) {
            await endCurrentSession();
        }
    });
}

/**
 * Creates a brand new game session with a unique 6-character code
 */
export async function createSession(sessionName) {
    const supabase = getSupabase();
    const user = getCurrentUser();
    if (!supabase || !user) throw new Error('Authentication required.');

    const joinCode = generateUniqueCode();

    // 1. Insert session row
    const { data: session, error: sessionErr } = await supabase
        .from('sessions')
        .insert({
            name: sessionName,
            join_code: joinCode,
            created_by: user.id,
            status: 'active'
        })
        .select()
        .single();

    if (sessionErr) throw sessionErr;

    // 2. Add creator as admin player
    const { error: playerErr } = await supabase
        .from('session_players')
        .insert({
            session_id: session.id,
            player_id: user.id,
            is_admin: true
        });

    if (playerErr) throw playerErr;

    // 3. Set as active
    localStorage.setItem(STORAGE_KEY, session.id);
    await loadSession(session.id);
}

/**
 * Joins an active session using 6-character join code
 */
export async function joinSessionByCode(code) {
    const supabase = getSupabase();
    const user = getCurrentUser();
    if (!supabase || !user) throw new Error('Authentication required.');

    // 1. Find session by join code
    const { data: session, error: findErr } = await supabase
        .from('sessions')
        .select('*')
        .eq('join_code', code)
        .eq('status', 'active')
        .single();

    if (findErr || !session) {
        throw new Error('Active session with this code was not found.');
    }

    // 2. Upsert player into session_players
    const { error: joinErr } = await supabase
        .from('session_players')
        .upsert({
            session_id: session.id,
            player_id: user.id,
            is_admin: session.created_by === user.id
        }, { onConflict: 'session_id,player_id' });

    if (joinErr) throw joinErr;

    localStorage.setItem(STORAGE_KEY, session.id);
    await loadSession(session.id);
}

/**
 * Loads session metadata and player roster from Supabase
 */
export async function loadSession(sessionId) {
    const supabase = getSupabase();
    const user = getCurrentUser();
    if (!supabase) return;

    // 1. Fetch session record
    const { data: session, error: sessionErr } = await supabase
        .from('sessions')
        .select('*')
        .eq('id', sessionId)
        .single();

    if (sessionErr || !session || session.status === 'ended') {
        leaveCurrentSession();
        return;
    }

    currentSession = session;

    // 2. Fetch all players in session with their profile names
    await refreshSessionPlayers();

    // 3. Subscribe to Realtime changes for this session
    subscribeToSessionRealtime(sessionId);

    // 4. Update UI
    renderSessionUI();

    if (typeof onSessionChangedCallback === 'function') {
        onSessionChangedCallback(currentSession, sessionPlayers, isCurrentUserAdmin);
    }
}

/**
 * Refreshes the list of players in the current session
 */
async function refreshSessionPlayers() {
    if (!currentSession) return;
    const supabase = getSupabase();
    const user = getCurrentUser();

    const { data: players, error } = await supabase
        .from('session_players')
        .select(`
            id,
            session_id,
            player_id,
            is_admin,
            joined_at,
            profiles ( display_name )
        `)
        .eq('session_id', currentSession.id);

    if (!error && players) {
        sessionPlayers = players;
        const selfMember = players.find(p => p.player_id === user?.id);
        isCurrentUserAdmin = (currentSession.created_by === user?.id) || (selfMember?.is_admin === true);
    }
}

/**
 * Subscribes to Supabase Realtime changes for this session & its players
 */
function subscribeToSessionRealtime(sessionId) {
    const supabase = getSupabase();
    if (!supabase) return;

    if (sessionChannel) {
        supabase.removeChannel(sessionChannel);
    }

    sessionChannel = supabase.channel(`session-${sessionId}`)
        .on('postgres_changes', {
            event: '*',
            schema: 'public',
            table: 'session_players',
            filter: `session_id=eq.${sessionId}`
        }, async () => {
            console.log('Session players updated via Realtime');
            await refreshSessionPlayers();
            renderSessionUI();
            if (typeof onSessionChangedCallback === 'function') {
                onSessionChangedCallback(currentSession, sessionPlayers, isCurrentUserAdmin);
            }
        })
        .on('postgres_changes', {
            event: 'UPDATE',
            schema: 'public',
            table: 'sessions',
            filter: `id=eq.${sessionId}`
        }, (payload) => {
            if (payload.new?.status === 'ended') {
                showToast('This session has been ended by an admin.', 'warning');
                leaveCurrentSession();
            }
        })
        .subscribe();
}

/**
 * Promotes a player to Admin status (Admin only)
 */
export async function promotePlayerToAdmin(targetPlayerId, displayName) {
    if (!isCurrentUserAdmin || !currentSession) {
        showToast('Admin rights required to promote players.', 'error');
        return;
    }

    const supabase = getSupabase();
    const { error } = await supabase
        .from('session_players')
        .update({ is_admin: true })
        .eq('session_id', currentSession.id)
        .eq('player_id', targetPlayerId);

    if (error) {
        showToast(`Failed to promote player: ${error.message}`, 'error');
    } else {
        showToast(`${displayName} is now an Admin!`, 'success');
        await refreshSessionPlayers();
        renderSessionUI();
    }
}

/**
 * Leaves the active session locally
 */
export function leaveCurrentSession() {
    currentSession = null;
    sessionPlayers = [];
    isCurrentUserAdmin = false;
    localStorage.removeItem(STORAGE_KEY);

    if (sessionChannel) {
        const supabase = getSupabase();
        supabase?.removeChannel(sessionChannel);
        sessionChannel = null;
    }

    renderSessionUI();

    if (typeof onSessionChangedCallback === 'function') {
        onSessionChangedCallback(null, [], false);
    }
}

/**
 * Ends session for everyone (Admin only)
 */
async function endCurrentSession() {
    if (!isCurrentUserAdmin || !currentSession) return;
    const supabase = getSupabase();

    const { error } = await supabase
        .from('sessions')
        .update({ status: 'ended' })
        .eq('id', currentSession.id);

    if (error) {
        showToast(error.message, 'error');
    } else {
        showToast('Session ended successfully.', 'info');
        leaveCurrentSession();
    }
}

/**
 * Updates UI according to session state
 */
export function renderSessionUI() {
    const activeInfo = document.getElementById('session-active-info');
    const joinCreate = document.getElementById('session-join-create');
    const nameDisplay = document.getElementById('session-name-display');
    const codeDisplay = document.getElementById('session-code-display');
    const countDisplay = document.getElementById('session-player-count');
    const rosterContainer = document.getElementById('session-players-container');
    const adminControls = document.getElementById('session-admin-controls');

    if (currentSession) {
        if (activeInfo) activeInfo.style.display = 'block';
        if (joinCreate) joinCreate.style.display = 'none';
        if (nameDisplay) nameDisplay.textContent = currentSession.name;
        if (codeDisplay) codeDisplay.textContent = currentSession.join_code;
        if (countDisplay) countDisplay.textContent = sessionPlayers.length;

        // Render player roster
        if (rosterContainer) {
            rosterContainer.innerHTML = '';
            const user = getCurrentUser();

            sessionPlayers.forEach(member => {
                const name = member.profiles?.display_name || 'Pilot';
                const isSelf = member.player_id === user?.id;
                const isAdminMember = member.is_admin;

                const row = document.createElement('div');
                row.className = 'banner';
                row.style.padding = '8px 12px';
                row.style.fontSize = '0.88rem';

                let badgeHtml = isAdminMember ? '<span style="color: #f59e0b; font-size: 0.75rem; font-weight: 700; margin-left: 6px;">👑 ADMIN</span>' : '';
                if (isSelf) {
                    badgeHtml += ' <span style="color: var(--primary); font-size: 0.75rem;">(You)</span>';
                }

                let actionHtml = '';
                // Admin can promote non-admin players
                if (isCurrentUserAdmin && !isAdminMember && !isSelf) {
                    actionHtml = `<button class="btn btn-secondary btn-promote" style="min-height: auto; padding: 4px 8px; font-size: 0.75rem;">Promote</button>`;
                }

                row.innerHTML = `
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <span>🐌</span>
                        <span style="font-weight: 600;">${name}</span>
                        ${badgeHtml}
                    </div>
                    ${actionHtml}
                `;

                // Wire up promote button
                const promoteBtn = row.querySelector('.btn-promote');
                promoteBtn?.addEventListener('click', () => {
                    promotePlayerToAdmin(member.player_id, name);
                });

                rosterContainer.appendChild(row);
            });
        }

        if (adminControls) {
            adminControls.style.display = isCurrentUserAdmin ? 'block' : 'none';
        }
    } else {
        if (activeInfo) activeInfo.style.display = 'none';
        if (joinCreate) joinCreate.style.display = 'block';
    }
}

/**
 * Generates an uppercase 6-character alphanumeric code
 */
function generateUniqueCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Avoid 0/O and 1/I
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}
