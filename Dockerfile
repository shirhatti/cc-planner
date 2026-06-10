# Claude Code Web TTY — browser client for Claude Code sessions, built on
# the cc-planner VFS infra for its repo workspaces.
#
# Lazy hydration (default):
#   docker build -t cc-planner .
#   docker run -p 3000:3000 -e ANTHROPIC_API_KEY=... cc-planner
#   The browser asks for an owner/repo; it is blob-less-cloned per session and
#   file contents are hydrated on demand.
#
# Baked repo (cloned into the image at build time, no clone/hydration at runtime):
#   docker build -t cc-planner --build-arg BAKE_REPO=owner/repo [--build-arg BAKE_REF=main] .
#   For a private repo, pass a token at build time:
#     --build-arg BAKE_TOKEN=$(gh auth token)
#   (Note: build args are recorded in image metadata — prefer a public repo or
#   an ephemeral fine-grained token.)

FROM oven/bun:1

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock ./
# --ignore-scripts: skips the husky "prepare" hook, which needs a .git dir
RUN bun install --frozen-lockfile --ignore-scripts

COPY tsconfig.json vite.config.ts ./
COPY preload ./preload
COPY scripts ./scripts
COPY web ./web

RUN bun run build

ARG BAKE_REPO=
ARG BAKE_REF=
ARG BAKE_TOKEN=
RUN if [ -n "$BAKE_REPO" ]; then \
  git clone --depth 1 ${BAKE_REF:+--branch "$BAKE_REF"} \
  "https://${BAKE_TOKEN:+x-access-token:$BAKE_TOKEN@}github.com/$BAKE_REPO.git" /repo \
  && git -C /repo remote set-url origin "https://github.com/$BAKE_REPO.git"; \
  fi

# web/server.ts switches to baked mode iff CC_BAKED_REPO_PATH exists
ENV CC_BAKED_REPO=$BAKE_REPO \
  CC_BAKED_REPO_PATH=/repo \
  PORT=3000

EXPOSE 3000
CMD ["bun", "run", "web/server.ts"]
