FROM node:20-bookworm-slim

# ca-certificates: HTTPS upstream channels need a CA bundle. node:20-bookworm-slim ships
# without one (/etc/ssl/certs missing), which makes every https:// channel fail with
# UNABLE_TO_VERIFY_LEAF_SIGNATURE / "unable to verify the first certificate".
# ffmpeg: some upstreams only return HEVC/H.265, which Chrome and Firefox cannot decode.
# The gateway transcodes those to H.264 on demand for /content?format=h264.
#
# ffmpeg + ca-certificates are installed from packages vendored in .docker-ffmpeg-debs/
# (regenerate with tools/fetch-ffmpeg-debs.sh). Rationale: this image build must not
# depend on apt reaching a mirror. The node image ships /etc/apt/sources.list.d/debian.sources
# pointing at deb.debian.org, and on networks where that host is unreachable apt-get hangs
# indefinitely (the http method never times out), which stalled this build for ~1 hour.
# Installing vendored debs keeps the build deterministic and offline.
COPY .docker-ffmpeg-debs /tmp/ffmpeg-debs
RUN set -eux; \
    dpkg --install /tmp/ffmpeg-debs/*.deb; \
    rm -rf /tmp/ffmpeg-debs /var/lib/apt/lists/*; \
    ffmpeg -version | head -1; \
    ffprobe -version | head -1

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Transcoded H.264 renditions are cached here; docker-compose mounts a volume on it
# so they survive container restarts.
RUN mkdir -p /app/content-cache
ENV CONTENT_CACHE_DIR=/app/content-cache

EXPOSE 3000

CMD ["npm", "start"]
