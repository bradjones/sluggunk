// Authentication and User Profile Management
import { getSupabase, isConfigured } from './supabase.js';
import { showToast, closeModal, openModal } from './ui.js';

let currentUser = null;
let currentProfile = null;
let isRegisterMode = true; // Default tab is Register

export function getCurrentUser() {
    return currentUser;
}

export function getCurrentProfile() {
    return currentProfile;
}

/**
 * Initializes authentication listeners, tab controls, and form handlers
 */
export function initAuth(onUserChanged) {
    setupAuthTabs();
    setupAuthForm(onUserChanged);
    setupProfileControls(onUserChanged);

    if (!isConfigured()) {
        return;
    }

    const supabase = getSupabase();
    if (!supabase) return;

    // Listen to live auth state changes (sign in, sign out, token refresh)
    supabase.auth.onAuthStateChange(async (event, session) => {
        console.log(`Auth event: ${event}`, session?.user?.email);
        currentUser = session?.user || null;

        if (currentUser) {
            await loadProfile(currentUser.id);
            renderAuthenticatedUI();
        } else {
            currentProfile = null;
            renderUnauthenticatedUI();
        }

        if (typeof onUserChanged === 'function') {
            onUserChanged(currentUser, currentProfile);
        }
    });

    // Check existing session on boot
    supabase.auth.getSession().then(async ({ data: { session } }) => {
        if (session?.user) {
            currentUser = session.user;
            await loadProfile(currentUser.id);
            renderAuthenticatedUI();
            if (typeof onUserChanged === 'function') {
                onUserChanged(currentUser, currentProfile);
            }
        }
    });
}

/**
 * Loads or provisions the user profile from `profiles` table
 */
async function loadProfile(userId) {
    const supabase = getSupabase();
    if (!supabase) return;

    try {
        const { data, error } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', userId)
            .single();

        if (error && error.code !== 'PGRST116') {
            console.error('Error fetching profile:', error);
        }

        if (data) {
            currentProfile = data;
        } else {
            // Profile trigger fallback: ensure profile row exists
            const fallbackName = currentUser.user_metadata?.display_name || 
                                 currentUser.email.split('@')[0];
            const { data: newProfile, error: insertError } = await supabase
                .from('profiles')
                .upsert({ id: userId, display_name: fallbackName })
                .select()
                .single();

            if (!insertError && newProfile) {
                currentProfile = newProfile;
            } else {
                currentProfile = { id: userId, display_name: fallbackName };
            }
        }
    } catch (err) {
        console.error('Profile load error:', err);
    }
}

/**
 * Switch tabs between Sign In and Register
 */
function setupAuthTabs() {
    const tabLogin = document.getElementById('tab-login');
    const tabRegister = document.getElementById('tab-register');
    const groupName = document.getElementById('group-display-name');
    const inputName = document.getElementById('input-display-name');
    const btnSubmit = document.getElementById('btn-auth-submit');
    const authTitle = document.getElementById('auth-title');

    function setTab(register) {
        isRegisterMode = register;
        if (isRegisterMode) {
            tabRegister.className = 'btn btn-primary';
            tabLogin.className = 'btn btn-secondary';
            groupName.style.display = 'flex';
            inputName.required = true;
            btnSubmit.textContent = 'Create Account';
            authTitle.textContent = '🐌 Join Slugs';
        } else {
            tabRegister.className = 'btn btn-secondary';
            tabLogin.className = 'btn btn-primary';
            groupName.style.display = 'none';
            inputName.required = false;
            btnSubmit.textContent = 'Sign In';
            authTitle.textContent = '🐌 Welcome Back';
        }
    }

    tabLogin?.addEventListener('click', () => setTab(false));
    tabRegister?.addEventListener('click', () => setTab(true));
}

/**
 * Handles submission of Login/Register form
 */
function setupAuthForm(onUserChanged) {
    const form = document.getElementById('form-auth');
    const emailInput = document.getElementById('input-email');
    const passInput = document.getElementById('input-password');
    const nameInput = document.getElementById('input-display-name');
    const btnSubmit = document.getElementById('btn-auth-submit');

    form?.addEventListener('submit', async (e) => {
        e.preventDefault();

        if (!isConfigured()) {
            openModal('modal-setup');
            return;
        }

        const supabase = getSupabase();
        const email = emailInput.value.trim();
        const password = passInput.value;
        const displayName = nameInput.value.trim();

        btnSubmit.disabled = true;
        btnSubmit.textContent = isRegisterMode ? 'Creating account...' : 'Signing in...';

        try {
            if (isRegisterMode) {
                // Sign Up
                const { data, error } = await supabase.auth.signUp({
                    email,
                    password,
                    options: {
                        data: { display_name: displayName }
                    }
                });

                if (error) throw error;

                showToast(`Welcome ${displayName}! Account created.`, 'success');
                closeModal('modal-auth');
            } else {
                // Sign In
                const { data, error } = await supabase.auth.signInWithPassword({
                    email,
                    password
                });

                if (error) throw error;

                showToast('Signed in successfully!', 'success');
                closeModal('modal-auth');
            }
        } catch (err) {
            console.error('Auth error:', err);
            showToast(err.message || 'Authentication failed.', 'error');
        } finally {
            btnSubmit.disabled = false;
            btnSubmit.textContent = isRegisterMode ? 'Create Account' : 'Sign In';
        }
    });
}

/**
 * Handles updating display name and signing out
 */
function setupProfileControls(onUserChanged) {
    const btnLogout = document.getElementById('btn-logout');
    const btnUpdateName = document.getElementById('btn-update-name');
    const inputUpdateName = document.getElementById('input-update-name');

    btnLogout?.addEventListener('click', async () => {
        const supabase = getSupabase();
        if (!supabase) return;

        const { error } = await supabase.auth.signOut();
        if (error) {
            showToast(error.message, 'error');
        } else {
            showToast('Signed out.', 'info');
            closeModal('modal-auth');
        }
    });

    btnUpdateName?.addEventListener('click', async () => {
        const newName = inputUpdateName.value.trim();
        if (!newName) {
            showToast('Please enter a display name', 'warning');
            return;
        }

        const supabase = getSupabase();
        if (!supabase || !currentUser) return;

        btnUpdateName.disabled = true;
        try {
            const { error } = await supabase
                .from('profiles')
                .update({ display_name: newName })
                .eq('id', currentUser.id);

            if (error) throw error;

            currentProfile.display_name = newName;
            document.getElementById('profile-display-name').textContent = newName;
            inputUpdateName.value = '';
            showToast('Display name updated!', 'success');

            if (typeof onUserChanged === 'function') {
                onUserChanged(currentUser, currentProfile);
            }
        } catch (err) {
            showToast(err.message, 'error');
        } finally {
            btnUpdateName.disabled = false;
        }
    });
}

/**
 * Renders UI when user is signed in
 */
function renderAuthenticatedUI() {
    const formContainer = document.getElementById('auth-form-container');
    const profileContainer = document.getElementById('auth-profile-container');
    const profileName = document.getElementById('profile-display-name');
    const profileEmail = document.getElementById('profile-email');
    const authTitle = document.getElementById('auth-title');

    if (formContainer) formContainer.style.display = 'none';
    if (profileContainer) profileContainer.style.display = 'block';

    const displayName = currentProfile?.display_name || currentUser?.email.split('@')[0] || 'Player';
    if (profileName) profileName.textContent = displayName;
    if (profileEmail) profileEmail.textContent = currentUser.email;
    if (authTitle) authTitle.textContent = `🐌 Pilot: ${displayName}`;
}

/**
 * Renders UI when user is logged out
 */
function renderUnauthenticatedUI() {
    const formContainer = document.getElementById('auth-form-container');
    const profileContainer = document.getElementById('auth-profile-container');
    const authTitle = document.getElementById('auth-title');

    if (formContainer) formContainer.style.display = 'block';
    if (profileContainer) profileContainer.style.display = 'none';
    if (authTitle) authTitle.textContent = '🐌 Welcome to Slugs';
}
