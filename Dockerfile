FROM mcr.microsoft.com/playwright:v1.45.0-jammy

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY src ./src

ENV NODE_ENV=production \
    SOLVE_PORT=3000 \
    SOLVE_HOST=127.0.0.1 \
    OPERATOR_PORT=3001 \
    OPERATOR_HOST=0.0.0.0 \
    DISPLAY=:99

EXPOSE 3001
CMD ["bash", "-lc", "Xvfb ${DISPLAY} -screen 0 1280x800x24 >/tmp/xvfb.log 2>&1 & node src/server.js"]
