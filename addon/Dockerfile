# Builds the Cooper Guardian. Runs both as an HA add-on and as a standalone container.
FROM node:20-alpine
WORKDIR /app
# build deps for better-sqlite3's native module (no musl prebuild); removed after install
RUN apk add --no-cache --virtual .build python3 make g++
COPY package.json tsconfig.json ./
RUN npm install
COPY src ./src
RUN npm run build
RUN apk del .build
EXPOSE 8099
CMD ["node", "dist/index.js"]
