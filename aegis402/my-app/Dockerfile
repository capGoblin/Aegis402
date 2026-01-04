# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

COPY package.json ./
# Install only production dependencies
RUN npm install --production

# Copy built artifacts from builder
COPY --from=builder /app/dist ./dist

# Expose the server port
EXPOSE 10001

CMD ["npm", "start"]
