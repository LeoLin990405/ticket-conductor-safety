# Offline safety checks. No Forge CLI and no Jira site.
#   docker build -t ticket-conductor-safety .
#   docker run --rm ticket-conductor-safety
FROM node:22.23.4-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
CMD ["npm", "run", "offline"]
