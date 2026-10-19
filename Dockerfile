FROM node:24-slim
WORKDIR /app

COPY package.json package-lock.json ./
COPY sim/package.json sim/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3080
CMD ["npm", "start"]
