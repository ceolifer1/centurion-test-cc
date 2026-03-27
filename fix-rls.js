const { Client } = require('pg');
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

async function main() {
  // Resolve DNS first since Node.js may not handle IPv6-only hostnames
  const { resolve6 } = require('dns').promises;
  let host;
  try {
    const addrs = await resolve6('db.jctxogntqulmdmjhvccl.supabase.co');
    host = addrs[0];
    console.log('Resolved to IPv6:', host);
  } catch {
    host = 'db.jctxogntqulmdmjhvccl.supabase.co';
    console.log('Using hostname directly');
  }
  const client = new Client({
    host: host,
    port: 5432,
    user: 'postgres',
    password: '0IYhymNSstHjtFPNROyncdhC',
    database: 'postgres',
    ssl: { rejectUnauthorized: false }
  });

  await client.connect();
  console.log('Connected to DB');

  // Check existing policies
  const policies = await client.query("SELECT policyname, cmd, qual FROM pg_policies WHERE tablename = 'user_roles'");
  console.log('Existing policies:');
  policies.rows.forEach(p => console.log('  ', p.policyname, '|', p.cmd));

  // Check RLS status
  const rls = await client.query("SELECT relrowsecurity FROM pg_class WHERE relname = 'user_roles'");
  console.log('RLS enabled:', rls.rows[0] ? rls.rows[0].relrowsecurity : 'table not found');

  // Add SELECT policy if needed
  const hasSelect = policies.rows.some(p => p.cmd === 'SELECT');
  if (!hasSelect) {
    console.log('No SELECT policy found. Adding...');
    await client.query(`
      CREATE POLICY "Users can read own roles"
      ON public.user_roles
      FOR SELECT
      USING (auth.uid() = user_id)
    `);
    console.log('SELECT policy added!');
  } else {
    console.log('SELECT policy already exists');
  }

  // Verify
  const updated = await client.query("SELECT policyname, cmd FROM pg_policies WHERE tablename = 'user_roles'");
  console.log('Updated policies:');
  updated.rows.forEach(p => console.log('  ', p.policyname, '|', p.cmd));

  await client.end();
  console.log('Done');
}

main().catch(e => console.error('Error:', e.message));
