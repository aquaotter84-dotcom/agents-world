# The always-on world, in one container.
#
# Nothing in here is host-specific. It is Node, this repository, and one command
# that keeps the world ticking while also serving the app the keeper watches it
# through. Railway, Fly, Render, a VPS behind Caddy, a Raspberry Pi on a shelf:
# the same image and the same command everywhere, so changing hosts is a change
# of address, not a change of world.
#
#   docker build -f deploy/Dockerfile -t agents-world .
#   docker run -d -p 4321:4321 -v agents-world-data:/data agents-world
#
# The tradeoffs between hosts are written up in the README, under
# "The always-on world".

FROM node:20-alpine

WORKDIR /world

# There is no build step and there are no runtime dependencies: the engine, the
# runner and the web server use Node's standard library and nothing else. What
# gets copied is what gets run.
COPY engine ./engine
COPY server ./server
COPY app ./app
COPY tools ./tools
COPY package.json ./package.json

ENV NODE_ENV=production PORT=4321
# One file is the whole world. Mount a volume here and it survives redeploys;
# lose it and the world is gone, which is the honest cost of a single save.
ENV AGENTS_WORLD_SAVE=/data/world.json
VOLUME /data

# A fresh container starts with no key, so it cannot spend money on model calls
# until the keeper hands it one: the engine decides every moment by itself,
# which is the same world, just quieter. Set BLUESMINDS_API_KEY to let a model
# write the biggest beats.
ENV AGENTS_WORLD_OFFLINE=1

EXPOSE 4321

# Not `npm start`: npm would add a process between the platform's signals and
# the world, and a world that does not hear SIGTERM does not save on the way out.
CMD ["node", "server/service.js"]
