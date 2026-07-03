FROM node:24-alpine

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build

# Create auth_info directory and setup permissions
RUN mkdir -p auth_info && chown -R node:node /app

USER node

EXPOSE 5000

CMD ["npm", "start"]
