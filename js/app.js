// Slugs - Application Bootstrap & Main Coordinator
import { isConfigured, getSupabase } from './supabase.js';
import { initMap } from './map.js';
import { openModal, closeModal, setupModalListeners, showToast } from './ui.js';

document.addEventListener('DOMContentLoaded', () => {
    // 1. Initialize modal dismissal and interactive triggers
    setupModalListeners();

    // 2. Initialize Leaflet map and GPS tracking
    try {
        initMap();
    } catch (err) {
        console.error('Failed to initialize map:', err);
    }

    // 3. Check Supabase connection credentials
    if (!isConfigured()) {
        console.log('Supabase configuration needed. Opening setup modal.');
        openModal('modal-setup');
    } else {
        const supabase = getSupabase();
        console.log('Supabase client initialized successfully.');
        // Check active session or prompt auth modal if not signed in
        supabase.auth.getSession().then(({ data: { session } }) => {
            if (!session) {
                openModal('modal-auth');
            } else {
                showToast(`Welcome back! Signed in as ${session.user.email}`, 'success');
            }
        });
    }

    // 4. Header action buttons
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

    console.log('Slugs Phase 1 initialized.');
});
