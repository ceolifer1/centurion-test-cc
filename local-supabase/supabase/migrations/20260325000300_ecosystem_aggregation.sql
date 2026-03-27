-- ============================================================
-- SITE MONITORING — CONSOLIDATED MIGRATION: COMMANDCENTER ONLY
-- Deploy to: commandcenter
-- Via: run_database_migration MCP tool
-- ============================================================
-- This migration creates CommandCenter-specific aggregation tables:
--   1. ecosystem_logs — aggregated logs from all sites
--   2. ecosystem_reports — aggregated bug reports + feature requests
--   3. service_budgets — budget caps configuration
--   4. service_usage_log — external service usage tracking
--   5. usage_alerts — budget threshold breach records
--   6. suspicious_usage — flagged usage patterns
-- PLUS the same per-site tables (site_logs, reports, etc.) for CC's own use
-- ============================================================

-- ========== RUN THE ALL-SITES MIGRATION FIRST ==========
-- (site_logs, reports, report_comments, report_votes, report_attachments,
--  report_status_history, service_usage_local)
-- These are needed on CommandCenter too for its own local logging.


-- ========== 1. ECOSYSTEM LOGS (aggregated) ==========

CREATE TABLE IF NOT EXISTS ecosystem_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_log_id UUID,
  site_id TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  details JSONB DEFAULT '{}',
  source TEXT,
  user_id UUID,
  ip_address INET,
  user_agent TEXT,
  request_id TEXT,
  endpoint TEXT,
  stack_trace TEXT,
  resolution_status TEXT DEFAULT 'open',
  resolved_by UUID,
  resolved_at TIMESTAMPTZ,
  resolution_notes TEXT,
  site_created_at TIMESTAMPTZ NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(source_log_id, site_id)
);

CREATE INDEX IF NOT EXISTS idx_eco_logs_site ON ecosystem_logs(site_id);
CREATE INDEX IF NOT EXISTS idx_eco_logs_category ON ecosystem_logs(category);
CREATE INDEX IF NOT EXISTS idx_eco_logs_severity ON ecosystem_logs(severity);
CREATE INDEX IF NOT EXISTS idx_eco_logs_created ON ecosystem_logs(site_created_at DESC);
CREATE INDEX IF NOT EXISTS idx_eco_logs_critical ON ecosystem_logs(severity, site_created_at DESC) WHERE severity = 'critical';
CREATE INDEX IF NOT EXISTS idx_eco_logs_unresolved ON ecosystem_logs(resolution_status) WHERE resolution_status NOT IN ('resolved','false_positive');

ALTER TABLE ecosystem_logs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='ecosystem_logs' AND policyname='Super admins can view ecosystem logs') THEN
    CREATE POLICY "Super admins can view ecosystem logs" ON ecosystem_logs FOR SELECT
    USING (EXISTS (SELECT 1 FROM user_roles WHERE user_roles.user_id = auth.uid() AND user_roles.role = 'super_admin'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='ecosystem_logs' AND policyname='System inserts via service role') THEN
    CREATE POLICY "System inserts via service role" ON ecosystem_logs FOR INSERT WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='ecosystem_logs' AND policyname='Super admins can update resolution') THEN
    CREATE POLICY "Super admins can update resolution" ON ecosystem_logs FOR UPDATE
    USING (EXISTS (SELECT 1 FROM user_roles WHERE user_roles.user_id = auth.uid() AND user_roles.role = 'super_admin'));
  END IF;
END $$;


-- ========== 2. ECOSYSTEM REPORTS (aggregated) ==========

CREATE TABLE IF NOT EXISTS ecosystem_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_report_id UUID NOT NULL,
  site_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  submitted_by UUID,
  submitted_by_email TEXT,
  submitted_by_name TEXT,
  category TEXT,
  tags TEXT[],
  severity TEXT,
  status TEXT NOT NULL,
  priority INTEGER DEFAULT 0,
  assigned_to UUID,
  assigned_to_name TEXT,
  vote_count INTEGER DEFAULT 0,
  comment_count INTEGER DEFAULT 0,
  resolution_notes TEXT,
  resolved_at TIMESTAMPTZ,
  site_created_at TIMESTAMPTZ NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(source_report_id, site_id)
);

CREATE INDEX IF NOT EXISTS idx_eco_reports_site ON ecosystem_reports(site_id);
CREATE INDEX IF NOT EXISTS idx_eco_reports_type ON ecosystem_reports(type);
CREATE INDEX IF NOT EXISTS idx_eco_reports_status ON ecosystem_reports(status);
CREATE INDEX IF NOT EXISTS idx_eco_reports_priority ON ecosystem_reports(priority DESC);
CREATE INDEX IF NOT EXISTS idx_eco_reports_open ON ecosystem_reports(status, site_created_at DESC) WHERE status NOT IN ('resolved','closed','wont_fix');

ALTER TABLE ecosystem_reports ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='ecosystem_reports' AND policyname='Super admins view all ecosystem reports') THEN
    CREATE POLICY "Super admins view all ecosystem reports" ON ecosystem_reports FOR SELECT
    USING (EXISTS (SELECT 1 FROM user_roles WHERE user_roles.user_id = auth.uid() AND user_roles.role = 'super_admin'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='ecosystem_reports' AND policyname='System inserts ecosystem reports') THEN
    CREATE POLICY "System inserts ecosystem reports" ON ecosystem_reports FOR INSERT WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='ecosystem_reports' AND policyname='Super admins update ecosystem reports') THEN
    CREATE POLICY "Super admins update ecosystem reports" ON ecosystem_reports FOR UPDATE
    USING (EXISTS (SELECT 1 FROM user_roles WHERE user_roles.user_id = auth.uid() AND user_roles.role = 'super_admin'));
  END IF;
END $$;


-- ========== 3. SERVICE BUDGETS ==========

CREATE TABLE IF NOT EXISTS service_budgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  site_id TEXT,
  budget_period TEXT NOT NULL DEFAULT 'monthly' CHECK (budget_period IN ('daily','weekly','monthly')),
  soft_cap NUMERIC NOT NULL,
  hard_cap NUMERIC NOT NULL,
  cap_unit TEXT NOT NULL DEFAULT 'usd',
  cost_per_unit NUMERIC DEFAULT 0,
  current_usage NUMERIC DEFAULT 0,
  period_start TIMESTAMPTZ NOT NULL DEFAULT date_trunc('month', now()),
  is_active BOOLEAN DEFAULT true,
  notify_at_percent INTEGER[] DEFAULT '{50,75,90,100}',
  last_notified_percent INTEGER DEFAULT 0,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(service_name, site_id, budget_period)
);

ALTER TABLE service_budgets ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='service_budgets' AND policyname='Super admins manage budgets') THEN
    CREATE POLICY "Super admins manage budgets" ON service_budgets FOR ALL
    USING (EXISTS (SELECT 1 FROM user_roles WHERE user_roles.user_id = auth.uid() AND user_roles.role = 'super_admin'));
  END IF;
END $$;


-- ========== 4. SERVICE USAGE LOG ==========

CREATE TABLE IF NOT EXISTS service_usage_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_name TEXT NOT NULL,
  site_id TEXT NOT NULL,
  user_id UUID,
  ip_address INET,
  units_consumed NUMERIC NOT NULL DEFAULT 1,
  estimated_cost NUMERIC DEFAULT 0,
  endpoint TEXT,
  request_metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_usage_log_service ON service_usage_log(service_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_log_site ON service_usage_log(site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_log_user ON service_usage_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_log_ip ON service_usage_log(ip_address, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_log_period ON service_usage_log(service_name, site_id, created_at);

ALTER TABLE service_usage_log ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='service_usage_log' AND policyname='System inserts usage logs') THEN
    CREATE POLICY "System inserts usage logs" ON service_usage_log FOR INSERT WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='service_usage_log' AND policyname='Super admins read usage logs') THEN
    CREATE POLICY "Super admins read usage logs" ON service_usage_log FOR SELECT
    USING (EXISTS (SELECT 1 FROM user_roles WHERE user_roles.user_id = auth.uid() AND user_roles.role IN ('super_admin','admin')));
  END IF;
END $$;


-- ========== 5. USAGE ALERTS ==========

CREATE TABLE IF NOT EXISTS usage_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_id UUID REFERENCES service_budgets(id),
  service_name TEXT NOT NULL,
  site_id TEXT,
  alert_type TEXT NOT NULL CHECK (alert_type IN ('soft_cap_warning','hard_cap_reached','suspicious_usage','unusual_spike')),
  threshold_percent INTEGER,
  current_usage NUMERIC,
  cap_value NUMERIC,
  message TEXT NOT NULL,
  details JSONB DEFAULT '{}',
  acknowledged BOOLEAN DEFAULT false,
  acknowledged_by UUID,
  acknowledged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_usage_alerts_unacked ON usage_alerts(acknowledged, created_at DESC) WHERE NOT acknowledged;

ALTER TABLE usage_alerts ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='usage_alerts' AND policyname='Super admins manage alerts') THEN
    CREATE POLICY "Super admins manage alerts" ON usage_alerts FOR ALL
    USING (EXISTS (SELECT 1 FROM user_roles WHERE user_roles.user_id = auth.uid() AND user_roles.role = 'super_admin'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='usage_alerts' AND policyname='System inserts alerts') THEN
    CREATE POLICY "System inserts alerts" ON usage_alerts FOR INSERT WITH CHECK (true);
  END IF;
END $$;


-- ========== 6. SUSPICIOUS USAGE ==========

CREATE TABLE IF NOT EXISTS suspicious_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_name TEXT NOT NULL,
  site_id TEXT NOT NULL,
  user_id UUID,
  ip_address INET,
  pattern_type TEXT NOT NULL CHECK (pattern_type IN ('rate_spike','unusual_hours','repeated_failures','geo_anomaly','bulk_operation','new_user_high_usage')),
  severity TEXT NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  description TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}',
  status TEXT DEFAULT 'open' CHECK (status IN ('open','investigating','resolved','false_positive')),
  resolved_by UUID,
  resolved_at TIMESTAMPTZ,
  resolution_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_suspicious_open ON suspicious_usage(status, created_at DESC) WHERE status NOT IN ('resolved','false_positive');
CREATE INDEX IF NOT EXISTS idx_suspicious_user ON suspicious_usage(user_id);
CREATE INDEX IF NOT EXISTS idx_suspicious_ip ON suspicious_usage(ip_address);

ALTER TABLE suspicious_usage ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='suspicious_usage' AND policyname='Super admins manage suspicious usage') THEN
    CREATE POLICY "Super admins manage suspicious usage" ON suspicious_usage FOR ALL
    USING (EXISTS (SELECT 1 FROM user_roles WHERE user_roles.user_id = auth.uid() AND user_roles.role = 'super_admin'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='suspicious_usage' AND policyname='System inserts suspicious usage') THEN
    CREATE POLICY "System inserts suspicious usage" ON suspicious_usage FOR INSERT WITH CHECK (true);
  END IF;
END $$;


-- ========== 7. BUDGET PERIOD RESET FUNCTION ==========

CREATE OR REPLACE FUNCTION reset_budget_periods() RETURNS void AS $$
BEGIN
  UPDATE service_budgets SET
    current_usage = 0,
    period_start = CASE
      WHEN budget_period = 'daily' THEN date_trunc('day', now())
      WHEN budget_period = 'weekly' THEN date_trunc('week', now())
      WHEN budget_period = 'monthly' THEN date_trunc('month', now())
    END,
    last_notified_percent = 0,
    updated_at = now()
  WHERE is_active = true AND CASE
    WHEN budget_period = 'daily' THEN period_start < date_trunc('day', now())
    WHEN budget_period = 'weekly' THEN period_start < date_trunc('week', now())
    WHEN budget_period = 'monthly' THEN period_start < date_trunc('month', now())
  END;
END;
$$ LANGUAGE plpgsql;


-- ========== 8. DEFAULT BUDGET CONFIGURATION ==========

INSERT INTO service_budgets (service_name, display_name, site_id, budget_period, soft_cap, hard_cap, cap_unit, cost_per_unit, notify_at_percent)
VALUES
  ('resend', 'Resend Email Service', NULL, 'monthly', 8000, 10000, 'emails', 0.001, '{50,75,90,100}'),
  ('twilio_voice', 'Twilio Voice', 'leadcrm', 'monthly', 500, 750, 'minutes', 0.014, '{50,75,90,100}'),
  ('twilio_sms', 'Twilio SMS', 'leadcrm', 'monthly', 2000, 3000, 'messages', 0.0079, '{50,75,90,100}'),
  ('supabase_edge', 'Supabase Edge Invocations', NULL, 'monthly', 400000, 500000, 'requests', 0.000002, '{75,90,100}'),
  ('supabase_storage', 'Supabase Storage', NULL, 'monthly', 8, 10, 'gb', 0.021, '{75,90,100}'),
  ('openai', 'OpenAI API', NULL, 'monthly', 400, 500, 'usd', 1, '{50,75,90,100}'),
  ('anthropic', 'Anthropic API', NULL, 'monthly', 400, 500, 'usd', 1, '{50,75,90,100}')
ON CONFLICT DO NOTHING;
