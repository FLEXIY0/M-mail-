# Include custom targets and environment variables here

## Builds dist/<id>-<version>-linux-amd64.tar.gz, a smaller bundle for the
## most common server platform.
.PHONY: dist-linux-amd64
dist-linux-amd64: dist
	./build/bundle-platform.sh linux-amd64
