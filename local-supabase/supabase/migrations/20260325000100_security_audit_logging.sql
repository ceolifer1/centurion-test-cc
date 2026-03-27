-- ============================================================
-- Migration 001: Security Audit Logging Infrastructure
-- Apply to: ALL 5 Supabase instances
-- SEC-016 Fix: Deploy audit logging that was documented but never created
-- ============================================================

-- 1. Create the security audit log table
CREATE TABLE IF NOT EXISTS public.security_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,           -- auth_success, auth_failure, data_access, permission_denied, rate_limit, admin_action, bridge_request, error
  severity TEXT NOT NULL DEFAULT 'info', -- info, warning, error, critical
  actor_id UUID,                       -- User ID if authenticated
  actor_email TEXT,                     -- Email for readability
  actor_ip TEXT,                        -- Request IP
  actor_role TEXT,                      -- User's role at time of event
  auth_method TEXT,                     -- jwt, api_key, bridge_key, none
  resource_type TEXT,                   -- table, function, endpoint, tool
  resource_id TEXT,                     -- Specific resource identifier
  action TEXT NOT NULL,                 -- What was attempted
  details JSONB DEFAULT '{}',           -- Additional context
  request_path TEXT,                    -- API endpoint path
  user_agent TEXT,                      -- Client user agent
  site TEXT,                            -- Which site this log belongs to
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_audit_logs_event_type ON public.security_audit_logs (event_type);
CREATE INDEX IF NOT EXISTS idx_audit_logs_severity ON public.security_audit_logs (severity);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_id ON public.security_audit_logs (actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON public.security_audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_site ON public.security_audit_logs (site);
CREATE INDEX IF NOT EXISTS idx_audit_logs_auth_method ON public.security_audit_logs (auth_method);

-- Composite index for filtering by severity + time (common dashboard query)
CREATE INDEX IF NOT EXISTS idx_audit_logs_severity_time ON public.security_audit_logs (severity, created_at DESC);

-- 3. RLS on audit logs — admin-only read, system-only write
ALTER TABLE public.security_audit_logs ENABLE ROW LEVEL SECURITY;

-- Admins can read all audit logs
CREATE POLICY "admin_read_audit_logs" ON public.security_audit_logs
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('super_admin', 'admin')
    )
  );

-- No direct INSERT/UPDATE/DELETE by users — only via service_role or RPC
-- Service role bypasses RLS, so edge functions using service_role key can insert

-- 4. Auto-cleanup function for old logs (90 days for info/warning, 365 for error/critical)
CREATE OR REPLACE FUNCTION public.cleanup_old_audit_logs()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM public.security_audit_logs
  WHERE
    (severity IN ('info', 'warning') AND created_at < NOW() - INTERVAL '90 days')
    OR
    (severity IN ('error', 'critical') AND created_at < NOW() - INTERVAL '365 days');

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

-- 5. Insert audit log helper (callable from edge functions via RPC)
CREATE OR REPLACE FUNCTION public.insert_audit_log(
  p_event_type TEXT,
  p_severity TEXT DEFAULT 'info',
  p_actor_id UUID DEFAULT NULL,
  p_actor_email TEXT DEFAULT NULL,
  p_actor_ip TEXT DEFAULT NULL,
  p_actor_role TEXT DEFAULT NULL,
  p_auth_method TEXT DEFAULT NULL,
  p_resource_type TEXT DEFAULT NULL,
  p_resource_id TEXT DEFAULT NULL,
  p_action TEXT DEFAULT '',
  p_details JSONB DEFAULT '{}',
  p_request_path TEXT DEFAULT NULL,
  p_user_agent TEXT DEFAULT NULL,
  p_site TEXT DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  new_id BIGINT;
BEGIN
  INSERT INTO public.security_audit_logs (
    event_type, severity, actor_id, actor_email, actor_ip, actor_role,
    auth_method, resource_type, resource_id, action, details,
    request_path, user_agent, site
  ) VALUES (
    p_event_type, p_severity, p_actor_id, p_actor_email, p_actor_ip, p_actor_role,
    p_auth_method, p_resource_type, p_resource_id, p_action, p_details,
    p_request_path, p_user_agent, p_site
  )
  RETURNING id INTO new_id;

  RETURN new_id;
END;
$$;

-- Grant execute to authenticated users (RLS on the table still controls who can see logs)
GRANT EXECUTE ON FUNCTION public.insert_audit_log TO authenticated;
GRANT EXECUTE ON FUNCTION public.insert_audit_log TO service_role;

-- 6. Trigger to auto-log changes to sensitive tables

-- Generic audit trigger function
CREATE OR REPLACE FUNCTION public.audit_trigger_func()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO public.security_audit_logs (
    event_type, severity, actor_id, resource_type, resource_id,
    action, details, site
  ) VALUES (
    'data_access',
    CASE WHEN TG_OP = 'DELETE' THEN 'warning' ELSE 'info' END,
    auth.uid(),
    TG_TABLE_NAME,
    CASE
      WHEN TG_OP = 'DELETE' THEN OLD.id::TEXT
      ELSE NEW.id::TEXT
    END,
    TG_OP,
    jsonb_build_object(
      'table', TG_TABLE_NAME,
      'operation', TG_OP,
      'timestamp', NOW()
    ),
    current_setting('app.current_site', TRUE)
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- Apply audit triggers to sensitive tables (if they exist)
-- profiles table
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'profiles' AND table_schema = 'public') THEN
    DROP TRIGGER IF EXISTS audit_profiles ON public.profiles;
    CREATE TRIGGER audit_profiles
      AFTER INSERT OR UPDATE OR DELETE ON public.profiles
      FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_func();
  END IF;
END $$;

-- user_roles table
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_roles' AND table_schema = 'public') THEN
    DROP TRIGGER IF EXISTS audit_user_roles ON public.user_roles;
    CREATE TRIGGER audit_user_roles
      AFTER INSERT OR UPDATE OR DELETE ON public.user_roles
      FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_func();
  END IF;
END $$;

-- companies table
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'companies' AND table_schema = 'public') THEN
    DROP TRIGGER IF EXISTS audit_companies ON public.companies;
    CREATE TRIGGER audit_companies
      AFTER INSERT OR UPDATE OR DELETE ON public.companies
      FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_func();
  END IF;
END $$;

-- partner_agencies table
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'partner_agencies' AND table_schema = 'public') THEN
    DROP TRIGGER IF EXISTS audit_partner_agencies ON public.partner_agencies;
    CREATE TRIGGER audit_partner_agencies
      AFTER INSERT OR UPDATE OR DELETE ON public.partner_agencies
      FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_func();
  END IF;
END $$;

COMMENT ON TABLE public.security_audit_logs IS 'Security audit trail for all sites. Admin-only read via RLS. 90-day retention for info/warning, 365-day for error/critical.';
