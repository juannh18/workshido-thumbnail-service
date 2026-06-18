FROM node:20-slim

# Instalar LibreOffice y poppler-utils (pdftoppm)
RUN apt-get update && apt-get install -y \
    libreoffice \
    poppler-utils \
    libvips-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json .
RUN npm install

COPY server.js .

EXPOSE 3000

CMD ["node", "server.js"]
