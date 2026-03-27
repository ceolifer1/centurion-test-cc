// Apply role standardization migration to test Supabase using fetch
const SUPABASE_URL = 'https://jctxogntqulmdmjhvccl.supabase.co';
const SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpjdHhvZ250cXVsbWRtamh2Y2NsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDQ3NDI2MiwiZXhwIjoyMDkwMDUwMjYyfQ.62b6xwBYPiFgfpiOiRYjO_ZUzNq9C7q595NfiFCQSBw';

const headers = {
  'apikey': SERVICE_ROLE_KEY,
  'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=representation'
};

async function query(table, params = '') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, { headers });
  return res.json();
}

async function update(table, matchCol, matchVal, updateCol, updateVal) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/${table}?${matchCol}=eq.${encodeURIComponent(matchVal)}`,
    {
      method: 'PATCH',
      headers: { ...headers, 'Prefer': 'return=representation' },
      body: JSON.stringify({ [updateCol]: updateVal })
    }
  );
  const data = await res.json();
  return { count: Array.isArray(data) ? data.length : 0, error: data.error || null };
}

async function callRpc(fnName, args) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(args)
  });
  return { status: res.status, data: await res.json() };
}

async function run() {
  console.log('=== Test Supabase Role Migration ===\n');

  // Check current state
  const roles = await query('user_roles', 'select=role');
  const roleCounts = {};
  roles.forEach(r => { roleCounts[r.role] = (roleCounts[r.role] || 0) + 1; });
  console.log('Current user_roles:', JSON.stringify(roleCounts));

  // Try exec_sql_multi for enum changes
  const rpcResult = await callRpc('exec_sql_multi', {
    queries: [
      "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'backend_user' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'app_role')) THEN ALTER TYPE app_role ADD VALUE 'backend_user'; END IF; END $$",
      "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'backend_admin' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'app_role')) THEN ALTER TYPE app_role ADD VALUE 'backend_admin'; END IF; END $$",
      "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'backend_superadmin' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'app_role')) THEN ALTER TYPE app_role ADD VALUE 'backend_superadmin'; END IF; END $$",
      "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'company_agent' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'app_role')) THEN ALTER TYPE app_role ADD VALUE 'company_agent'; END IF; END $$",
      "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'company_mainuser' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'app_role')) THEN ALTER TYPE app_role ADD VALUE 'company_mainuser'; END IF; END $$",
      "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'partner_agent' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'app_role')) THEN ALTER TYPE app_role ADD VALUE 'partner_agent'; END IF; END $$",
      "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'partner_mainuser' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'app_role')) THEN ALTER TYPE app_role ADD VALUE 'partner_mainuser'; END IF; END $$",
      "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'funder_agent' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'app_role')) THEN ALTER TYPE app_role ADD VALUE 'funder_agent'; END IF; END $$",
      "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'funder_admin' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'app_role')) THEN ALTER TYPE app_role ADD VALUE 'funder_admin'; END IF; END $$",
      "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'funder_mainuser' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'app_role')) THEN ALTER TYPE app_role ADD VALUE 'funder_mainuser'; END IF; END $$"
    ]
  });
  console.log('Enum update via exec_sql_multi:', rpcResult.status, JSON.stringify(rpcResult.data).slice(0, 200));

  if (rpcResult.status !== 200) {
    console.log('\nexec_sql_multi not available. Enum values must be added via Supabase Dashboard SQL Editor.');
    console.log('URL: https://supabase.com/dashboard/project/jctxogntqulmdmjhvccl/sql/new');
    console.log('Attempting direct row updates (will fail if enum values dont exist yet)...\n');
  }

  // Update user_roles
  const mappings = [
    ['employee', 'backend_user'],
    ['admin', 'backend_admin'],
    ['super_admin', 'backend_superadmin'],
    ['company_user', 'company_agent'],
    ['iso_user', 'partner_agent'],
    ['partner_agency_user', 'partner_agent'],
    ['partner_agency', 'partner_agent'],
    ['funding_company_user', 'funder_agent'],
  ];

  console.log('\n--- Updating user_roles ---');
  for (const [oldRole, newRole] of mappings) {
    const result = await update('user_roles', 'role', oldRole, 'role', newRole);
    if (result.error) {
      console.log(`  ${oldRole} -> ${newRole}: ERROR - ${JSON.stringify(result.error)}`);
    } else {
      console.log(`  ${oldRole} -> ${newRole}: ${result.count} rows`);
    }
  }

  console.log('\n--- Updating profiles ---');
  for (const [oldRole, newRole] of mappings) {
    const result = await update('profiles', 'role', oldRole, 'role', newRole);
    if (result.error) {
      console.log(`  ${oldRole} -> ${newRole}: ERROR - ${JSON.stringify(result.error)}`);
    } else {
      console.log(`  ${oldRole} -> ${newRole}: ${result.count} rows`);
    }
  }

  // Also create normalize_role_name via exec_sql_multi if available
  if (rpcResult.status === 200) {
    const fnResult = await callRpc('exec_sql_multi', {
      queries: [
        "CREATE OR REPLACE FUNCTION normalize_role_name(role_name text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $f$ BEGIN RETURN CASE role_name WHEN 'employee' THEN 'backend_user' WHEN 'admin' THEN 'backend_admin' WHEN 'super_admin' THEN 'backend_superadmin' WHEN 'company_user' THEN 'company_agent' WHEN 'iso_user' THEN 'partner_agent' WHEN 'partner_agency_user' THEN 'partner_agent' WHEN 'partner_agency' THEN 'partner_agent' WHEN 'funding_company_user' THEN 'funder_agent' WHEN 'company' THEN 'company_agent' WHEN 'iso' THEN 'partner_mainuser' ELSE role_name END; END; $f$"
      ]
    });
    console.log('\nCreated normalize_role_name:', fnResult.status);
  }

  // Verify
  console.log('\n--- Final State ---');
  const finalRoles = await query('user_roles', 'select=role');
  const finalCounts = {};
  finalRoles.forEach(r => { finalCounts[r.role] = (finalCounts[r.role] || 0) + 1; });
  console.log('user_roles:', JSON.stringify(finalCounts));

  const finalProfiles = await query('profiles', 'select=role');
  const profileCounts = {};
  finalProfiles.forEach(r => { profileCounts[r.role] = (profileCounts[r.role] || 0) + 1; });
  console.log('profiles:', JSON.stringify(profileCounts));
}

run().catch(console.error);
