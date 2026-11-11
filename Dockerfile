FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
# Dane (baza i pliki modeli) trzymamy poza obrazem, w wolumenie /data.
RUN mkdir /data && chown node:node /data
ENV DATA_DIR=/data PORT=3000
VOLUME /data
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO /dev/null http://localhost:3000/api/config || exit 1
CMD ["node", "server/server.js"]
