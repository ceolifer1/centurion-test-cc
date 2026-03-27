-- ============================================================
-- Migration 000: Bootstrap Base Tables for Local Development
-- Creates minimal versions of tables that exist in production
-- so that subsequent migrations can reference them safely.
-- ============================================================

-- Profiles table (exists in all production instances)
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  full_name TEXT,
  role TEXT DEFAULT 'user',
  avatar_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_profile" ON public.profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid());

CREATE POLICY "users_update_own_profile" ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid());

-- User roles table
CREATE TABLE IF NOT EXISTS public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'user',
  site TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- Companies table
CREATE TABLE IF NOT EXISTS public.companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  domain TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;

-- Partner agencies table
CREATE TABLE IF NOT EXISTS public.partner_agencies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  contact_email TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.partner_agencies ENABLE ROW LEVEL SECURITY;

-- MCP connections table (used by CommandCenter dashboard)
CREATE TABLE IF NOT EXISTS public.mcp_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site TEXT NOT NULL,
  connection_type TEXT,
  status TEXT DEFAULT 'active',
  last_heartbeat TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.mcp_connections ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.profiles IS 'Local dev bootstrap - minimal profiles table';
COMMENT ON TABLE public.mcp_connections IS 'Local dev bootstrap - ecosystem connection tracking';
