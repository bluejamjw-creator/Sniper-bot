FROM node:20-bullseye

# Install Python
RUN apt-get update && apt-get install -y python3 python3-pip

WORKDIR /app

# Copy everything
COPY . .

# Install deps
RUN npm install
RUN pip3 install -r requirements.txt

# Start both
CMD ["sh", "start.sh"]
