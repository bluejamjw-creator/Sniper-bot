FROM node:20-bullseye

# Set working directory
WORKDIR /app

# Install Node dependencies first (better caching)
COPY package*.json ./
RUN npm install --omit=dev

# Copy all project files
COPY . .

# Ensure data folder exists
RUN mkdir -p /app/data

# Start the bot
CMD ["node", "sniper.js"]
