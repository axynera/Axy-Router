FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod .
COPY go.sum .
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/axy-router .

FROM alpine:3.22
RUN adduser -D -u 10001 axy && mkdir -p /app/data && chown -R axy:axy /app
WORKDIR /app
COPY --from=build /out/axy-router /app/axy-router
USER axy
ENV PORT=3000
ENTRYPOINT ["/app/axy-router"]