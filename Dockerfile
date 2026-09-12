FROM node:22-bullseye

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p /app/data

CMD ["node", "sniper.js"]
