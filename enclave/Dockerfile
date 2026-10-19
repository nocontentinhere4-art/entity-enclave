# Entity enclave image: Node service + zingo-cli (Zcash light wallet). Built reproducibly; the resulting
# compose hash is what the attestation commits to. Keep this file boring: every change moves the hash.
FROM rust:1.90-bookworm AS zingo
RUN apt-get update && apt-get install -y --no-install-recommends build-essential pkg-config libssl-dev protobuf-compiler git && rm -rf /var/lib/apt/lists/*
WORKDIR /src
# The mixnet exit proof gets 3.5 s upstream (tuned on a desktop); a 1-vCPU CVM needs more or every birth fails.
RUN git clone --depth 1 --branch zingolib_v7.0.0 https://github.com/zingolabs/zingolib . \
 && grep -q 'SENTINEL_BUDGET: Duration = Duration::from_millis(3_500)' zingo-netutils/src/time.rs \
 && sed -i 's/SENTINEL_BUDGET: Duration = Duration::from_millis(3_500)/SENTINEL_BUDGET: Duration = Duration::from_millis(15_000)/' zingo-netutils/src/time.rs \
 && cargo build --release -p zingo-cli \
 && (cd zingo-netutils && cargo build --release --features nym --bin nym-proxy)

FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
COPY charter.md ./charter.md
COPY --from=zingo /src/target/release/zingo-cli /usr/local/bin/zingo-cli
COPY --from=zingo /src/zingo-netutils/target/release/nym-proxy /usr/local/bin/nym-proxy
ENV STATE_DIR=/state PORT=8080 ZINGO_BIN=/usr/local/bin/zingo-cli NYM_PROXY=/usr/local/bin/nym-proxy
VOLUME ["/state"]
EXPOSE 8080
CMD ["node", "src/index.mjs"]
