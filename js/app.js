// Slugs - Application Bootstrap & Main Coordinator
import { isConfigured } from './supabase.js';
import { initMap } from './map.js';
import { openModal, closeModal, setupModalListeners, showToast } from './ui.js';
import { initAuth, getCurrentUser, getCurrentProfile } from './auth.js';

document.addEventListener('DOMContentLoaded', () => {
    // 1. Initialize modal dismissal and interactive triggers
    setupModalListeners();

    // 2. Initialize Leaflet map and GPS tracking
    try {
        initMap();
    } catch (err) {
        console.error('Failed to initialize map:', err);
    }

    // 3. Initialize Authentication and Profile Sync
    initAuth((user, profile) => {
        const statusText = document.getElementById('status-text');
        if (user) {
            const name = profile?.display_name || user.email.split('@')[0];
            if (statusText) statusText.textContent = `${name}: Ready`;
        } else {
            if (statusText) statusText.textContent = 'Sign in to crawl';
        }
    });

    // 4. Check configuration on boot
    if (!isConfigured()) {
        console.log('Supabase configuration needed. Opening setup modal.');
        openModal('modal-setup');
    } else {
        // If configured but user is not logged in, prompt sign in
        setTimeout(() => {
            if (!getCurrentUser()) {
                openModal('modal-auth');
            }
        }, 600);
    }

    // 5. Header action buttons
    document.getElementById('btn-close-setup')?.addEventListener('click', () => {
        closeModal('modal-setup');
    });

    document.getElementById('btn-leaderboard')?.addEventListener('click', () => {
        openModal('modal-leaderboard');
    });

    document.getElementById('btn-session')?.addEventListener('click', () => {
        openModal('modal-session');
    });

    document.getElementById('btn-user')?.addEventListener('click', () => {
        if (!isConfigured()) {
            openModal('modal-setup');
        } else {
            openModal('modal-auth');
        }
    });

    console.log('Slugs Phase 2 (Authentication) initialized.');
});
