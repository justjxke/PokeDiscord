FROM node:22-bookworm-slim

WORKDIR /app

ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

ENV NODE_ENV=production

COPY tsconfig.json ./
COPY src ./src

EXPOSE 3000

CMD ["pnpm", "start"]
