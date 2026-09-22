// Supabase client initialization wrapper
import { CONFIG } from './config.js';

let client = null;

export function isConfigured() {
    return CONFIG.SUPABASE_URL && 
           CONFIG.SUPABASE_ANON_KEY && 
           CONFIG.SUPABASE_URL !== 'YOUR_SUPABASE_PROJECT_URL' && 
           CONFIG.SUPABASE_ANON_KEY !== 'YOUR_SUPABASE_ANON_KEY';
}

export function getSupabase() {
    if (!isConfigured()) {
        console.warn('Supabase is not configured yet. Please update js/config.js with your project credentials.');
        return null;
    }
    if (!client) {
        if (!window.supabase || !window.supabase.createClient) {
            throw new Error('Supabase client library not found. Check that the script tag in index.html loaded.');
        }
        client = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
            auth: {
                persistSession: true,
                autoRefreshToken: true,
                detectSessionInUrl: true
            }
        });
    }
    return client;
}
