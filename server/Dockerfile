FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod .
COPY main.go .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/cap-server .

FROM gcr.io/distroless/static:nonroot
COPY --from=build /out/cap-server /cap-server
EXPOSE 8585
USER nonroot:nonroot
ENTRYPOINT ["/cap-server"]
