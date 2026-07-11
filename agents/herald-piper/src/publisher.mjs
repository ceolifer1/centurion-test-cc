// Playwright publisher. The browser is provided by the Fargate base image
// (mcr.microsoft.com/playwright); `playwright` is imported lazily so unit tests
// (which inject launchBrowser/probe/publish) never need it installed. DRY-RUN is
// the default and reaches NO real profile (SPEC-C section 9 / P1 Build Plan 4).
const HOME = {
  linkedin_personal: 'https://www.linkedin.com/feed/',
  linkedin_company: 'https://www.linkedin.com/feed/',
  x: 'https://x.com/home',
  google_business: 'https://business.google.com/',
};

export async function launchBrowser({ fingerprint } = {}) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({
    userAgent: fingerprint?.userAgent || undefined,
    viewport: fingerprint?.viewport || undefined,
  });
  return { browser, context };
}

// Login-state probe (SPEC-C 5.3): every run begins here. Load the platform home
// READ-ONLY and check an authenticated DOM marker. If logged out/challenged the
// caller marks the session INVALID and stops - this function NEVER logs in.
export async function probeLoginState({ context, platform, probe }) {
  if (probe) return probe({ context, platform });
  const page = await context.newPage();
  try {
    await page.goto(HOME[platform] || HOME.linkedin_personal, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const loggedIn = await page.evaluate(() =>
      !document.querySelector('input[name="session_password"], input[autocomplete="current-password"], form[action*="login"]'));
    return { loggedIn: !!loggedIn };
  } catch {
    return { loggedIn: false, reason: 'probe_error' };
  } finally { await page.close().catch(() => {}); }
}

// Publish. DRY-RUN (default) posts NOWHERE real: it records what WOULD post to a
// private/test surface and returns a `dryrun:` external_ref. LIVE requires BOTH
// dryRun=false AND an explicitly injected livePost - Stage 2 never wires a real
// poster, so live mode throws unless a caller opts in deliberately.
export async function publish({ context, item, dryRun = true, testSurface = 'mock://piper-dryrun', livePost, now = () => new Date().toISOString() }) {
  if (dryRun) {
    return {
      posted: true, dryRun: true,
      wouldPost: { platform: item.platform, kind: item.kind, body: item.body },
      externalRef: `dryrun:${testSurface}:${item.id}`, surface: testSurface, at: now(),
    };
  }
  if (typeof livePost !== 'function') {
    throw new Error('live posting is not enabled in Stage 2 (dry-run only; no live poster wired)');
  }
  const externalRef = await livePost({ context, item });
  return { posted: true, dryRun: false, externalRef, at: now() };
}
