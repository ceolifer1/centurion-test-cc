# HERALD Piper - Fargate browser publisher (SPEC-B section 4.2).
# Pinned Playwright base image (Chromium + system deps preinstalled). The agent's
# Node code sits on top; @aws-sdk/* are installed (the base image ships the
# browser, not the aws-sdk). Browsers live at /ms-playwright in the base image,
# so npm never re-downloads them. Runs as the non-root pwuser (least privilege).
FROM mcr.microsoft.com/playwright:v1.45.0-jammy

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    HERALD_LIVE=false

WORKDIR /app

# Install runtime deps first for layer caching. No package-lock is committed, so
# use `npm install` with the pinned versions from package.json.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

# Cookies never touch disk (SPEC-C): no volumes, ephemeral FS only. The task
# def mounts nothing and sets ephemeral storage to minimum (infra/envs stack).
USER pwuser

# Runtime input arrives as env on the RunTask override: RUN_ID + CONTENT_ID
# (or PAYLOAD_REF). Dry-run is the default; live requires HERALD_LIVE=true.
ENTRYPOINT ["node", "src/entry.mjs"]
