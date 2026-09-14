PUBLIC_URL ?= /
export MSYS_NO_PATHCONV=1

deploy:
	unset CARGO_BUILD_TARGET; cargo install --locked --root ./target trunk
	./target/bin/trunk build --release --public-url "$(PUBLIC_URL)"

deploy-cross:
	docker run --rm --pull=always -v "$(PWD)":/src -w /src -e CARGO_TARGET_DIR=/tmp/target ghcr.io/lzpel/cross-wasm32-unknown-unknown:latest make deploy

