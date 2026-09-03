FROM node:22-bookworm-slim AS dependencies
WORKDIR /app/lab
COPY lab/package*.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    STATE_DIR=/state
WORKDIR /app
COPY --from=dependencies /app/lab/node_modules ./lab/node_modules
COPY index.html manifest.webmanifest sw.js photo-formats.js photo-codecs.js theme.css theme.js ./
COPY codecs ./codecs
COPY branding ./branding
COPY icons ./icons
COPY lab ./lab
RUN chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "lab/server.js"]
