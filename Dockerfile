# Builds a very small (~50MB) Docker image by using the pre-built alpine binary, rather than building the project in-container.
FROM alpine:3.16.2

RUN apk add --no-cache wget && \
    wget -O peer-server -q https://github.com/shadowmoose/switchboard.js/releases/latest/download/peering-server-alpine && \
    chmod +x peer-server && \
    apk --purge del wget

EXPOSE 8080/tcp

ENTRYPOINT ["./peer-server"]
