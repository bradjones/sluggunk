-- ==============================================================================
-- SLUGS - PostgreSQL Schema for Supabase
-- Run this script in your Supabase SQL Editor (Dashboard -> SQL Editor -> New Query)
-- ==============================================================================

-- 1. Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. Clean up existing tables if re-running (safe order)
-- DROP TABLE IF EXISTS stuns CASCADE;
-- DROP TABLE IF EXISTS attempts CASCADE;
-- DROP TABLE IF EXISTS session_players CASCADE;
-- DROP TABLE IF EXISTS sessions CASCADE;
-- DROP TABLE IF EXISTS profiles CASCADE;

-- ------------------------------------------------------------------------------
-- Table: profiles
-- Extends Supabase auth.users with display name and avatar preferences
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    avatar_color TEXT DEFAULT '#4ade80',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trigger to automatically create a profile when a new user registers
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, display_name)
    VALUES (
        NEW.id,
        COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1))
    )
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Auto-confirm any existing unconfirmed users
UPDATE auth.users SET email_confirmed_at = NOW() WHERE email_confirmed_at IS NULL;

-- Automatically auto-confirm future user registrations so email confirmation is never required
CREATE OR REPLACE FUNCTION public.auto_confirm_new_user()
RETURNS TRIGGER AS $$
BEGIN
    NEW.email_confirmed_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created_confirm ON auth.users;
CREATE TRIGGER on_auth_user_created_confirm
    BEFORE INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.auto_confirm_new_user();

-- ------------------------------------------------------------------------------
-- Table: sessions
-- Game sessions (can run for an hour, a day, or weeks)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    join_code VARCHAR(10) NOT NULL UNIQUE,
    created_by UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
    speed_kmh DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ends_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sessions_join_code ON sessions(join_code);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

-- ------------------------------------------------------------------------------
-- Table: session_players
-- Membership & admin status within a game session
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS session_players (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    player_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    is_admin BOOLEAN NOT NULL DEFAULT FALSE,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (session_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_session_players_session ON session_players(session_id);
CREATE INDEX IF NOT EXISTS idx_session_players_player ON session_players(player_id);

-- ------------------------------------------------------------------------------
-- Table: attempts
-- Each player's path attempt: start -> moving -> completed / voided
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attempts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    player_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    start_lat DOUBLE PRECISION NOT NULL,
    start_lng DOUBLE PRECISION NOT NULL,
    end_lat DOUBLE PRECISION,
    end_lng DOUBLE PRECISION,
    status TEXT NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'moving', 'completed', 'voided')),
    move_started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    score DOUBLE PRECISION DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attempts_session_status ON attempts(session_id, status);
CREATE INDEX IF NOT EXISTS idx_attempts_expires_at ON attempts(expires_at);
CREATE INDEX IF NOT EXISTS idx_attempts_player ON attempts(player_id);

-- ------------------------------------------------------------------------------
-- Table: stuns
-- Cooldown records when a player's path intersects an existing trail
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stuns (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    player_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    stunned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    stunned_until TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 hour'),
    caused_by_attempt UUID REFERENCES attempts(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_stuns_player_active ON stuns(player_id, stunned_until);

-- ------------------------------------------------------------------------------
-- Enable Row Level Security (RLS)
-- ------------------------------------------------------------------------------
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_players ENABLE ROW LEVEL SECURITY;
ALTER TABLE attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE stuns ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------------------------
-- RLS Policies
-- ------------------------------------------------------------------------------

-- Profiles: Authenticated users can view all profiles; update only own
CREATE POLICY "Allow authenticated to view profiles"
    ON profiles FOR SELECT TO authenticated
    USING (true);

CREATE POLICY "Allow users to update own profile"
    ON profiles FOR UPDATE TO authenticated
    USING (auth.uid() = id);

CREATE POLICY "Allow users to insert own profile"
    ON profiles FOR INSERT TO authenticated
    WITH CHECK (auth.uid() = id);

-- Sessions: Authenticated can view all active/ended sessions; insert new session
CREATE POLICY "Allow authenticated to view sessions"
    ON sessions FOR SELECT TO authenticated
    USING (true);

CREATE POLICY "Allow authenticated to create session"
    ON sessions FOR INSERT TO authenticated
    WITH CHECK (auth.uid() = created_by);

CREATE POLICY "Allow session creator or admins to update session"
    ON sessions FOR UPDATE TO authenticated
    USING (
        auth.uid() = created_by OR
        EXISTS (
            SELECT 1 FROM session_players
            WHERE session_players.session_id = sessions.id
              AND session_players.player_id = auth.uid()
              AND session_players.is_admin = true
        )
    );

-- Session Players: View members of sessions, join session, admins can update
CREATE POLICY "Allow authenticated to view session players"
    ON session_players FOR SELECT TO authenticated
    USING (true);

CREATE POLICY "Allow authenticated to join a session"
    ON session_players FOR INSERT TO authenticated
    WITH CHECK (auth.uid() = player_id);

CREATE POLICY "Allow admins to update session players (e.g. promote)"
    ON session_players FOR UPDATE TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM session_players sp
            WHERE sp.session_id = session_players.session_id
              AND sp.player_id = auth.uid()
              AND sp.is_admin = true
        ) OR
        EXISTS (
            SELECT 1 FROM sessions s
            WHERE s.id = session_players.session_id
              AND s.created_by = auth.uid()
        )
    );

-- Attempts: View attempts for any session, insert/update own
CREATE POLICY "Allow authenticated to view attempts"
    ON attempts FOR SELECT TO authenticated
    USING (true);

CREATE POLICY "Allow players to insert own attempt"
    ON attempts FOR INSERT TO authenticated
    WITH CHECK (auth.uid() = player_id);

CREATE POLICY "Allow players to update own attempt"
    ON attempts FOR UPDATE TO authenticated
    USING (auth.uid() = player_id);

-- Stuns: View stuns, insert stun record
CREATE POLICY "Allow authenticated to view stuns"
    ON stuns FOR SELECT TO authenticated
    USING (true);

CREATE POLICY "Allow players to record stuns"
    ON stuns FOR INSERT TO authenticated
    WITH CHECK (true);

-- ------------------------------------------------------------------------------
-- Realtime Subscriptions Configuration
-- ------------------------------------------------------------------------------
-- Add tables to the Supabase Realtime publication so clients get live push updates
ALTER PUBLICATION supabase_realtime ADD TABLE sessions;
ALTER PUBLICATION supabase_realtime ADD TABLE session_players;
ALTER PUBLICATION supabase_realtime ADD TABLE attempts;
ALTER PUBLICATION supabase_realtime ADD TABLE stuns;
