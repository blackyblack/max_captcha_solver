ARG PLAYWRIGHT_VERSION=1.61.0
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-jammy
ARG PLAYWRIGHT_VERSION

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci \
    && node -e "const fs = require('fs'); const expected = process.argv[1]; const actual = require('playwright/package.json').version; const { chromium } = require('playwright'); const executablePath = chromium.executablePath(); if (actual !== expected) { console.error('Playwright npm package ' + actual + ' does not match Docker image ' + expected); process.exit(1); } if (!fs.existsSync(executablePath)) { console.error('Chromium executable is missing at ' + executablePath); process.exit(1); }" "$PLAYWRIGHT_VERSION"
COPY src ./src
COPY tsconfig.json ./
RUN npm run build \
    && npm prune --omit=dev

ENV NODE_ENV=production \
    SOLVE_HOST=0.0.0.0 \
    DISPLAY=:99

EXPOSE 3000 3001
CMD ["bash", "-lc", ": \"${DISPLAY:=:99}\"; export DISPLAY; display_number=\"${DISPLAY#*:}\"; display_number=\"${display_number%%.*}\"; Xvfb \"$DISPLAY\" -screen 0 1280x800x24 >/tmp/xvfb.log 2>&1 & xvfb_pid=$!; for i in $(seq 1 50); do kill -0 \"$xvfb_pid\" 2>/dev/null || { cat /tmp/xvfb.log >&2; exit 1; }; [ -S \"/tmp/.X11-unix/X${display_number}\" ] && break; sleep 0.1; done; [ -S \"/tmp/.X11-unix/X${display_number}\" ] || { cat /tmp/xvfb.log >&2; exit 1; }; node dist/server.js"]
