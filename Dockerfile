FROM mcr.microsoft.com/playwright:v1.55.0-noble

WORKDIR /app

# Install FFmpeg
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install Node dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy backend code
COPY . .

ENV NODE_ENV=production

EXPOSE 3000

CMD ["npm", "start"]
