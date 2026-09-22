// Configuration for Supabase connection
// Replace these with your actual Project URL and public anon key from:
// Supabase Dashboard -> Project Settings -> API

export const CONFIG = {
    SUPABASE_URL: 'https://tnuskkjozqbaizpmvpzj.supabase.co', // e.g. https://xyzcompany.supabase.co
    SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRudXNra2pvenFiYWl6cG12cHpqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAwNjE5MzUsImV4cCI6MjEwNTYzNzkzNX0.704nnnuW4dpoNR-85_jppbtlBIy0zxrVyjeuTxU04G8', // public anon key

    // Game balance constants
    GAME_SPEED_KMH: 1.0,               // Default avatar travel speed in km/h
    TICK_INTERVAL_MS: 4000,            // Collision and position calculation interval (4s)
    PATH_EXPIRATION_MS: 3600 * 1000,   // Completed path stays active for 1 hour
    STUN_DURATION_MS: 3600 * 1000,     // Player stun duration: 1 hour
    MAP_DEFAULT_ZOOM: 16,              // Initial street level zoom
};
