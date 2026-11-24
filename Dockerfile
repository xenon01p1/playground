FROM oven/bun:1.4.4
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --chown=bun:bun src ./src
USER bun
EXPOSE 3000
CMD ["bun", "run", "start"]
