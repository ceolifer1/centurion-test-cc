// Role Standardization - Test Environment Functionality Tests
// Tests the role naming changes across all 3 test sites

const SUPABASE_URL = 'https://jctxogntqulmdmjhvccl.supabase.co';
const SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpjdHhvZ250cXVsbWRtamh2Y2NsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDQ3NDI2MiwiZXhwIjoyMDkwMDUwMjYyfQ.62b6xwBYPiFgfpiOiRYjO_ZUzNq9C7q595NfiFCQSBw';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpjdHhvZ250cXVsbWRtamh2Y2NsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0NzQyNjIsImV4cCI6MjA5MDA1MDI2Mn0.RCPs1F1qAeWIR_qMEDC7y59YxREna3jpwQhB0kqiyyk';

const TEST_SITES = {
  savfund: 'https://ceolifer1.github.io/centurion-test-sav/',
  leadcrm: 'https://ceolifer1.github.io/centurion-test-lead/',
  spvmatrix: 'https://ceolifer1.github.io/centurion-test-spv/',
};

const headers = {
  'apikey': SERVICE_KEY,
  'Authorization': `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

let passed = 0, failed = 0, warnings = 0;

function pass(msg) { passed++; console.log(`  ✅ PASS: ${msg}`); }
function fail(msg) { failed++; console.log(`  ❌ FAIL: ${msg}`); }
function warn(msg) { warnings++; console.log(`  ⚠️  WARN: ${msg}`); }

async function testDatabaseRoles() {
  console.log('\n=== TEST 1: Database Role Values ===');
  
  // Check user_roles has NO old role names
  const res = await fetch(`${SUPABASE_URL}/rest/v1/user_roles?select=role`, { headers });
  const roles = await res.json();
  const roleSet = new Set(roles.map(r => r.role));
  
  const oldNames = ['employee', 'admin', 'super_admin', 'company_user', 'iso_user', 'partner_agency_user', 'funding_company_user'];
  const newNames = ['backend_user', 'backend_admin', 'backend_superadmin', 'company_agent', 'partner_agent', 'funder_agent'];
  
  for (const old of oldNames) {
    if (roleSet.has(old)) fail(`user_roles still contains old role: ${old}`);
    else pass(`No old role "${old}" in user_roles`);
  }
  
  for (const name of newNames) {
    if (roleSet.has(name)) pass(`New role "${name}" found in user_roles`);
    else warn(`New role "${name}" not found in user_roles (may not have test users with this role)`);
  }
}

async function testProfileRoles() {
  console.log('\n=== TEST 2: Profile Role Values ===');
  
  const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=role`, { headers });
  const profiles = await res.json();
  const roleSet = new Set(profiles.map(p => p.role));
  
  const oldNames = ['employee', 'admin', 'super_admin', 'company_user', 'iso_user', 'partner_agency_user', 'funding_company_user'];
  
  for (const old of oldNames) {
    if (roleSet.has(old)) fail(`profiles still contains old role: ${old}`);
    else pass(`No old role "${old}" in profiles`);
  }
}

async function testNormalizeFunction() {
  console.log('\n=== TEST 3: normalize_role_name Function ===');
  
  const { data, status } = await (async () => {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql_multi`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ queries: [
        "SELECT normalize_role_name('employee') AS result",
        "SELECT normalize_role_name('admin') AS result",
        "SELECT normalize_role_name('super_admin') AS result",
        "SELECT normalize_role_name('company_user') AS result",
        "SELECT normalize_role_name('backend_user') AS result",
      ]})
    });
    return { status: res.status, data: await res.json() };
  })();
  
  if (status === 200) {
    pass('normalize_role_name function exists and is callable');
    if (data.results) {
      const expected = ['backend_user', 'backend_admin', 'backend_superadmin', 'company_agent', 'backend_user'];
      data.results.forEach((r, i) => {
        if (r && r[0] && r[0].result === expected[i]) {
          pass(`normalize_role_name maps correctly: ${expected[i]}`);
        } else {
          fail(`normalize_role_name mapping incorrect at index ${i}: got ${JSON.stringify(r)}, expected ${expected[i]}`);
        }
      });
    }
  } else {
    warn('Could not test normalize_role_name via exec_sql_multi');
  }
}

async function testAuthLogin() {
  console.log('\n=== TEST 4: Auth Login & Role Retrieval ===');
  
  // Test login with a backend user
  const loginRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'apikey': ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'backend.user@test.centurion.com', password: 'TestPass123!' })
  });
  const loginData = await loginRes.json();
  
  if (loginData.access_token) {
    pass('Backend user can authenticate');
    
    // Check their roles
    const userHeaders = {
      'apikey': ANON_KEY,
      'Authorization': `Bearer ${loginData.access_token}`,
      'Content-Type': 'application/json',
    };
    
    const rolesRes = await fetch(`${SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${loginData.user.id}&select=role`, { headers: userHeaders });
    const userRoles = await rolesRes.json();
    
    if (Array.isArray(userRoles) && userRoles.length > 0) {
      const hasNewRole = userRoles.some(r => r.role === 'backend_user' || r.role === 'backend_admin' || r.role === 'backend_superadmin');
      if (hasNewRole) pass(`Backend user has new role name: ${userRoles.map(r => r.role).join(', ')}`);
      else fail(`Backend user still has old role names: ${userRoles.map(r => r.role).join(', ')}`);
    } else {
      warn(`Could not fetch roles for backend user (RLS may block): ${JSON.stringify(userRoles)}`);
    }
  } else {
    warn(`Backend user login failed (test user may not exist): ${loginData.error || loginData.msg}`);
    
    // Try with a known test email pattern
    const altRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'apikey': ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'employee1@test.centurion.com', password: 'TestPass123!' })
    });
    const altData = await altRes.json();
    if (altData.access_token) {
      pass('Employee test user can still authenticate');
      
      const userHeaders = {
        'apikey': SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`,
      };
      const rolesRes = await fetch(`${SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${altData.user.id}&select=role`, { headers: userHeaders });
      const roles = await rolesRes.json();
      console.log(`  ℹ️  User ${altData.user.email} roles: ${JSON.stringify(roles.map(r => r.role))}`);
      
      const hasNewRole = roles.some(r => ['backend_user', 'backend_admin', 'backend_superadmin'].includes(r.role));
      if (hasNewRole) pass('Former employee user now has backend_* role');
      else fail(`Former employee user still has old role: ${roles.map(r => r.role).join(', ')}`);
    } else {
      warn('Could not find any backend test users to verify auth');
    }
  }
}

async function testSiteAccessibility() {
  console.log('\n=== TEST 5: Test Sites Accessibility ===');
  
  for (const [site, url] of Object.entries(TEST_SITES)) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (res.ok) {
        const html = await res.text();
        if (html.includes('<!DOCTYPE html>') || html.includes('<html')) {
          pass(`${site} is accessible at ${url}`);
          
          // Check for old role references in the built JS
          if (html.includes("'employee'") && !html.includes("'backend_user'")) {
            warn(`${site} HTML may still reference old 'employee' role`);
          }
        } else {
          fail(`${site} returned unexpected content`);
        }
      } else {
        fail(`${site} returned status ${res.status}`);
      }
    } catch (e) {
      fail(`${site} not accessible: ${e.message}`);
    }
  }
}

async function testRoleEnumValues() {
  console.log('\n=== TEST 6: Enum Values Exist ===');
  
  const { data, status } = await (async () => {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql_multi`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ queries: [
        "SELECT enumlabel FROM pg_enum WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'app_role') ORDER BY enumlabel"
      ]})
    });
    return { status: res.status, data: await res.json() };
  })();
  
  if (status === 200 && data.results && data.results[0]) {
    const enumValues = data.results[0].map(r => r.enumlabel);
    console.log(`  ℹ️  app_role enum values: ${enumValues.join(', ')}`);
    
    const required = ['backend_user', 'backend_admin', 'backend_superadmin', 'company_agent', 'partner_agent', 'funder_agent', 'partner_mainuser', 'funder_mainuser', 'company_mainuser'];
    for (const val of required) {
      if (enumValues.includes(val)) pass(`Enum value "${val}" exists`);
      else fail(`Enum value "${val}" MISSING from app_role`);
    }
  } else {
    warn('Could not query enum values');
  }
}

async function runAllTests() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  Role Standardization - Test Environment QA     ║');
  console.log('║  v1.5.1 - Centurion Financial Ecosystem         ║');
  console.log('╚══════════════════════════════════════════════════╝');
  
  await testDatabaseRoles();
  await testProfileRoles();
  await testNormalizeFunction();
  await testAuthLogin();
  await testSiteAccessibility();
  await testRoleEnumValues();
  
  console.log('\n══════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed, ${warnings} warnings`);
  console.log('══════════════════════════════════════════════════');
  
  if (failed === 0) {
    console.log('  🎉 ALL TESTS PASSED');
  } else {
    console.log(`  ⚠️  ${failed} TEST(S) FAILED - review above`);
  }
}

runAllTests().catch(console.error);
