FROM oven/bun:1.4.4
WORKDIR /app

COPY package.json bun.lock ./
COPY scripts/prepare.mjs ./scripts/prepare.mjs
RUN HUSKY=0 bun install --frozen-lockfile --production

COPY --chown=bun:bun src ./src
USER bun
EXPOSE 3000
CMD ["bun", "run", "start"]
