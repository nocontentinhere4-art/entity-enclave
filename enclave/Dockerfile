# Entity enclave image: Node service + zingo-cli (Zcash light wallet). Built reproducibly; the resulting
# compose hash is what the attestation commits to. Keep this file boring: every change moves the hash.
FROM rust:1.90-bookworm AS zingo
RUN apt-get update && apt-get install -y --no-install-recommends build-essential pkg-config libssl-dev protobuf-compiler git && rm -rf /var/lib/apt/lists/*
WORKDIR /src
# zingo-cli v6 built WITHOUT the Nym mixnet (`clearnet-test-mode`): the wallet talks to the indexer directly over TLS.
# Reason: from a 1-vCPU CVM the mixnet never proves an exit (every birth fails), so no sync was ever possible.
# Cost: the indexer sees the CVM's IP. Treasury privacy still rests on shielded ZEC. Revisit when the mixnet works here.
RUN git clone --depth 1 --branch zingolib_v6.0.0 https://github.com/zingolabs/zingolib . \
 && cargo build --release -p zingo-cli --no-default-features --features clearnet-test-mode

FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
COPY charter.md ./charter.md
COPY --from=zingo /src/target/release/zingo-cli /usr/local/bin/zingo-cli
ENV STATE_DIR=/state PORT=8080 ZINGO_BIN=/usr/local/bin/zingo-cli
VOLUME ["/state"]
EXPOSE 8080
CMD ["node", "src/index.mjs"]
