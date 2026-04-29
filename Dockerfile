FROM mcr.microsoft.com/playwright:v1.44.1-jammy

WORKDIR /app

COPY playwright-bot/package*.json ./playwright-bot/
WORKDIR /app/playwright-bot
RUN npm ci

COPY playwright-bot/. .
RUN npm run build

CMD ["npm", "start"]