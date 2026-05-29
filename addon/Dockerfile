# Builds the Jarvis Guardian. Runs both as an HA add-on and as a standalone container.
FROM node:20-alpine
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install
COPY src ./src
RUN npm run build
EXPOSE 8099
CMD ["node", "dist/index.js"]
