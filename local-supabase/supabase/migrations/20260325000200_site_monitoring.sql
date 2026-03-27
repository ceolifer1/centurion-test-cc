-- ============================================================
-- SITE MONITORING — CONSOLIDATED MIGRATION: ALL SATELLITE SITES
-- Deploy to: savfund, leadcrm, spvmatrix, centurion
-- Via: run_database_migration MCP tool
-- ============================================================
-- This migration creates:
--   1. site_logs — unified logging table
--   2. reports — bug reports + feature requests (replaces old bug_reports)
--   3. report_comments, report_votes, report_attachments, report_status_history
--   4. service_usage_local — local service usage tracking
-- ============================================================

-- ========== 1. SITE LOGS ==========

CREATE TABLE IF NOT EXISTS site_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('SECURITY','RATE_LIMIT','EDGE_FUNC','PLATFORM','SYSTEM_ERROR','INFRA')),
  severity TEXT NOT NULL CHECK (severity IN ('info','warning','error','critical')),
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
  resolution_status TEXT DEFAULT 'open' CHECK (resolution_status IN ('open','acknowledged','investigating','resolved','false_positive')),
  resolved_by UUID,
  resolved_at TIMESTAMPTZ,
  resolution_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_site_logs_category ON site_logs(category);
CREATE INDEX IF NOT EXISTS idx_site_logs_severity ON site_logs(severity);
CREATE INDEX IF NOT EXISTS idx_site_logs_created_at ON site_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_site_logs_event_type ON site_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_site_logs_user_id ON site_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_site_logs_ip_address ON site_logs(ip_address);
CREATE INDEX IF NOT EXISTS idx_site_logs_resolution ON site_logs(resolution_status) WHERE resolution_status != 'resolved';
CREATE INDEX IF NOT EXISTS idx_site_logs_critical ON site_logs(severity, created_at DESC) WHERE severity = 'critical';

ALTER TABLE site_logs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'site_logs' AND policyname = 'Super admins can view all logs') THEN
    CREATE POLICY "Super admins can view all logs" ON site_logs FOR SELECT
    USING (EXISTS (SELECT 1 FROM user_roles WHERE user_roles.user_id = auth.uid() AND user_roles.role IN ('super_admin','admin')));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'site_logs' AND policyname = 'System can insert logs') THEN
    CREATE POLICY "System can insert logs" ON site_logs FOR INSERT WITH CHECK (true);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION update_site_logs_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS site_logs_updated_at ON site_logs;
CREATE TRIGGER site_logs_updated_at BEFORE UPDATE ON site_logs FOR EACH ROW EXECUTE FUNCTION update_site_logs_updated_at();

CREATE OR REPLACE FUNCTION cleanup_old_site_logs() RETURNS void AS $$
BEGIN
  DELETE FROM site_logs WHERE (severity IN ('info','warning') AND created_at < now() - interval '90 days')
    OR (severity IN ('error','critical') AND created_at < now() - interval '365 days');
END;
$$ LANGUAGE plpgsql;


-- ========== 2. REPORTS (BUG + FEATURE REQUESTS) ==========

CREATE TABLE IF NOT EXISTS reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('bug','feature_request')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  submitted_by UUID NOT NULL,
  submitted_by_email TEXT,
  submitted_by_name TEXT,
  category TEXT DEFAULT 'general' CHECK (category IN ('general','ui','performance','security','data','integration','auth','billing','workflow','mobile','api','other')),
  tags TEXT[] DEFAULT '{}',
  severity TEXT CHECK (severity IN ('low','medium','high','critical')),
  steps_to_reproduce TEXT,
  expected_behavior TEXT,
  actual_behavior TEXT,
  browser_info TEXT,
  page_url TEXT,
  use_case TEXT,
  proposed_solution TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','triaged','in_progress','needs_info','resolved','wont_fix','duplicate','closed')),
  priority INTEGER DEFAULT 0,
  assigned_to UUID,
  assigned_to_name TEXT,
  duplicate_of UUID,
  resolution_notes TEXT,
  resolved_by UUID,
  resolved_at TIMESTAMPTZ,
  vote_count INTEGER DEFAULT 0,
  comment_count INTEGER DEFAULT 0,
  view_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reports_type ON reports(type);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_category ON reports(category);
CREATE INDEX IF NOT EXISTS idx_reports_severity ON reports(severity);
CREATE INDEX IF NOT EXISTS idx_reports_submitted_by ON reports(submitted_by);
CREATE INDEX IF NOT EXISTS idx_reports_priority ON reports(priority DESC);
CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_open ON reports(status, created_at DESC) WHERE status NOT IN ('resolved','closed','wont_fix');

CREATE TABLE IF NOT EXISTS report_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id UUID NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  user_name TEXT,
  user_email TEXT,
  is_admin BOOLEAN DEFAULT false,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_report_comments_report ON report_comments(report_id, created_at);

CREATE TABLE IF NOT EXISTS report_votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id UUID NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  vote_type TEXT NOT NULL CHECK (vote_type IN ('up','down')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(report_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_report_votes_report ON report_votes(report_id);

CREATE TABLE IF NOT EXISTS report_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id UUID NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_url TEXT NOT NULL,
  file_type TEXT,
  file_size INTEGER,
  uploaded_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_report_attachments_report ON report_attachments(report_id);

CREATE TABLE IF NOT EXISTS report_status_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id UUID NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  old_status TEXT,
  new_status TEXT NOT NULL,
  changed_by UUID NOT NULL,
  changed_by_name TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_report_history ON report_status_history(report_id, created_at);

-- Triggers for reports
CREATE OR REPLACE FUNCTION update_report_vote_count() RETURNS TRIGGER AS $$
BEGIN
  UPDATE reports SET vote_count = (
    SELECT COALESCE(SUM(CASE WHEN vote_type='up' THEN 1 ELSE -1 END),0)
    FROM report_votes WHERE report_id = COALESCE(NEW.report_id, OLD.report_id)
  ), updated_at = now() WHERE id = COALESCE(NEW.report_id, OLD.report_id);
  RETURN COALESCE(NEW, OLD);
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS report_vote_count_trigger ON report_votes;
CREATE TRIGGER report_vote_count_trigger AFTER INSERT OR DELETE ON report_votes FOR EACH ROW EXECUTE FUNCTION update_report_vote_count();

CREATE OR REPLACE FUNCTION update_report_comment_count() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN UPDATE reports SET comment_count = comment_count+1, updated_at=now() WHERE id=NEW.report_id;
  ELSIF TG_OP = 'DELETE' THEN UPDATE reports SET comment_count = GREATEST(comment_count-1,0), updated_at=now() WHERE id=OLD.report_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS report_comment_count_trigger ON report_comments;
CREATE TRIGGER report_comment_count_trigger AFTER INSERT OR DELETE ON report_comments FOR EACH ROW EXECUTE FUNCTION update_report_comment_count();

CREATE OR REPLACE FUNCTION calculate_report_priority() RETURNS TRIGGER AS $$
BEGIN
  NEW.priority = (CASE NEW.severity WHEN 'critical' THEN 40 WHEN 'high' THEN 30 WHEN 'medium' THEN 20 WHEN 'low' THEN 10 ELSE 15 END) + COALESCE(NEW.vote_count,0)*2;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS report_priority_trigger ON reports;
CREATE TRIGGER report_priority_trigger BEFORE INSERT OR UPDATE OF severity, vote_count ON reports FOR EACH ROW EXECUTE FUNCTION calculate_report_priority();

CREATE OR REPLACE FUNCTION log_report_status_change() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO report_status_history (report_id, old_status, new_status, changed_by) VALUES (NEW.id, OLD.status, NEW.status, auth.uid());
  END IF;
  NEW.updated_at = now();
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS report_status_change_trigger ON reports;
CREATE TRIGGER report_status_change_trigger BEFORE UPDATE ON reports FOR EACH ROW EXECUTE FUNCTION log_report_status_change();

-- RLS for reports
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_status_history ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='reports' AND policyname='Users can view all reports') THEN
    CREATE POLICY "Users can view all reports" ON reports FOR SELECT USING (auth.uid() IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='reports' AND policyname='Users can submit reports') THEN
    CREATE POLICY "Users can submit reports" ON reports FOR INSERT WITH CHECK (auth.uid() = submitted_by);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='reports' AND policyname='Admins can update reports') THEN
    CREATE POLICY "Admins can update reports" ON reports FOR UPDATE USING (
      submitted_by = auth.uid() OR EXISTS (SELECT 1 FROM user_roles WHERE user_roles.user_id = auth.uid() AND user_roles.role IN ('super_admin','admin'))
    );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='report_comments' AND policyname='Users can view comments') THEN
    CREATE POLICY "Users can view comments" ON report_comments FOR SELECT USING (auth.uid() IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='report_comments' AND policyname='Users can add comments') THEN
    CREATE POLICY "Users can add comments" ON report_comments FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='report_votes' AND policyname='Users can view votes') THEN
    CREATE POLICY "Users can view votes" ON report_votes FOR SELECT USING (auth.uid() IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='report_votes' AND policyname='Users can vote') THEN
    CREATE POLICY "Users can vote" ON report_votes FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='report_votes' AND policyname='Users can change their vote') THEN
    CREATE POLICY "Users can change their vote" ON report_votes FOR DELETE USING (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='report_attachments' AND policyname='Users can view attachments') THEN
    CREATE POLICY "Users can view attachments" ON report_attachments FOR SELECT USING (auth.uid() IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='report_attachments' AND policyname='Users can upload attachments') THEN
    CREATE POLICY "Users can upload attachments" ON report_attachments FOR INSERT WITH CHECK (auth.uid() = uploaded_by);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='report_status_history' AND policyname='Users can view status history') THEN
    CREATE POLICY "Users can view status history" ON report_status_history FOR SELECT USING (auth.uid() IS NOT NULL);
  END IF;
END $$;


-- ========== 3. SERVICE USAGE LOCAL ==========

CREATE TABLE IF NOT EXISTS service_usage_local (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_name TEXT NOT NULL,
  user_id UUID,
  ip_address INET,
  units_consumed NUMERIC DEFAULT 1,
  endpoint TEXT,
  metadata JSONB DEFAULT '{}',
  budget_check_result TEXT DEFAULT 'allowed' CHECK (budget_check_result IN ('allowed','warned','blocked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_local_usage_service ON service_usage_local(service_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_local_usage_user ON service_usage_local(user_id, created_at DESC);

ALTER TABLE service_usage_local ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='service_usage_local' AND policyname='System inserts local usage') THEN
    CREATE POLICY "System inserts local usage" ON service_usage_local FOR INSERT WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='service_usage_local' AND policyname='Admins read local usage') THEN
    CREATE POLICY "Admins read local usage" ON service_usage_local FOR SELECT
    USING (EXISTS (SELECT 1 FROM user_roles WHERE user_roles.user_id = auth.uid() AND user_roles.role IN ('super_admin','admin')));
  END IF;
END $$;
