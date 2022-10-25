# Builds a very small (~50MB) Docker image by using the pre-built alpine binary, rather than building the project in-container.
FROM alpine:3.16.2

COPY dist-standalone/peering-server-alpine /peer-server

EXPOSE 8080/tcp

ENTRYPOINT ["/peer-server"]
