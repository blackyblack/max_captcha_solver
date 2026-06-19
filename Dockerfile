ARG PLAYWRIGHT_VERSION=1.61.0
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-jammy
ARG PLAYWRIGHT_VERSION

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev \
    && node -e "const fs = require('fs'); const expected = process.argv[1]; const actual = require('playwright/package.json').version; const { chromium } = require('playwright'); const executablePath = chromium.executablePath(); if (actual !== expected) { console.error('Playwright npm package ' + actual + ' does not match Docker image ' + expected); process.exit(1); } if (!fs.existsSync(executablePath)) { console.error('Chromium executable is missing at ' + executablePath); process.exit(1); }" "$PLAYWRIGHT_VERSION"
COPY src ./src

ENV NODE_ENV=production \
    SOLVE_PORT=3000 \
    SOLVE_HOST=0.0.0.0 \
    OPERATOR_PORT=3001 \
    OPERATOR_HOST=0.0.0.0 \
    CAPTCHA_ALLOWED_HOSTS=id.vk.ru \
    CALLBACK_ALLOWED_HOSTS=127.0.0.1,localhost,::1,host.docker.internal \
    DISPLAY=:99

EXPOSE 3000 3001
CMD ["bash", "-lc", "Xvfb ${DISPLAY} -screen 0 1280x800x24 >/tmp/xvfb.log 2>&1 & node src/server.js"]
