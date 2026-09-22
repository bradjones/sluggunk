// Slugs - Application Bootstrap & Main Coordinator
import { isConfigured } from './supabase.js';
import { initMap } from './map.js';
import { openModal, closeModal, setupModalListeners, showToast } from './ui.js';
import { initAuth, getCurrentUser, getCurrentProfile } from './auth.js';
import { initSessions, getCurrentSession } from './sessions.js';
import { 
    initGame, 
    syncGameState, 
    loadAndRenderLeaderboard,
    toggleSound,
    updateSoundButtonUI,
    updateUserProfileStats
} from './game.js';

document.addEventListener('DOMContentLoaded', () => {
    // 1. Initialize modal dismissal and interactive triggers
    setupModalListeners();

    // 2. Initialize Leaflet map and GPS tracking
    try {
        initMap();
    } catch (err) {
        console.error('Failed to initialize map:', err);
    }

    // 3. Initialize Game Action Handlers (pins, recenter, stuns)
    initGame();
    updateSoundButtonUI();

    // 4. Initialize Authentication and Profile Sync
    initAuth((user, profile) => {
        updateHUDStatus();
        syncGameState();

        if (user && !getCurrentSession()) {
            // Suggest joining or creating a session if not in one
            setTimeout(() => {
                if (!getCurrentSession()) {
                    openModal('modal-session');
                }
            }, 500);
        }
    });

    // 5. Initialize Session Management
    initSessions((session, players, isAdmin) => {
        updateHUDStatus();
        syncGameState();
    });

    // 6. Check configuration on boot
    if (!isConfigured()) {
        console.log('Supabase configuration needed. Opening setup modal.');
        openModal('modal-setup');
    } else {
        setTimeout(() => {
            if (!getCurrentUser()) {
                openModal('modal-auth');
            }
        }, 600);
    }

    // 7. Header action buttons
    document.getElementById('btn-close-setup')?.addEventListener('click', () => {
        closeModal('modal-setup');
    });

    document.getElementById('btn-rules')?.addEventListener('click', () => {
        openModal('modal-rules');
    });

    document.getElementById('btn-leaderboard')?.addEventListener('click', () => {
        loadAndRenderLeaderboard();
        openModal('modal-leaderboard');
    });

    document.getElementById('btn-refresh-leaderboard')?.addEventListener('click', () => {
        loadAndRenderLeaderboard();
        showToast('Leaderboard refreshed', 'info', 1200);
    });

    document.getElementById('btn-session')?.addEventListener('click', () => {
        openModal('modal-session');
    });

    document.getElementById('btn-user')?.addEventListener('click', () => {
        if (!isConfigured()) {
            openModal('modal-setup');
        } else {
            updateUserProfileStats();
            updateSoundButtonUI();
            openModal('modal-auth');
        }
    });

    document.getElementById('btn-toggle-sound')?.addEventListener('click', () => {
        const enabled = toggleSound();
        showToast(enabled ? 'Sound effects enabled 🔊' : 'Sound effects muted 🔇', 'info', 1500);
    });

    // 8. Mobile visibility and connectivity listeners
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            syncGameState();
        }
    });

    window.addEventListener('online', () => {
        showToast('🟢 Online! Reconnected to session.', 'success', 2500);
        syncGameState();
    });

    window.addEventListener('offline', () => {
        showToast('🔴 Offline: Waiting for connection...', 'warning', 4000);
    });

    console.log('Slugs Phase 7 (Scoring & Polish) initialized.');
});

function updateHUDStatus() {
    const user = getCurrentUser();
    const profile = getCurrentProfile();
    const session = getCurrentSession();
    const statusText = document.getElementById('status-text');

    if (!user) {
        if (statusText) statusText.textContent = 'Sign in to crawl';
        return;
    }

    const name = profile?.display_name || user.email.split('@')[0];
    if (session) {
        if (statusText) statusText.textContent = `${name} • [${session.join_code}]`;
    } else {
        if (statusText) statusText.textContent = `${name} • No Session`;
    }
}
