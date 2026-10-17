# Dev-grade container image for the app and the scheduler worker.
# Production hardening (non-root user, standalone output) is a deploy-time concern.
FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["npm", "run", "dev"]
