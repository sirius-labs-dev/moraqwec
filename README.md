# Mora

Offline payment escrow on Solana — devnet prototype.

- **On-chain program (devnet):** [`9fcXHD3pHDKLX79JuVgCEKQiqYkvVqFtpoAEVjBq4aJ8`](https://explorer.solana.com/address/9fcXHD3pHDKLX79JuVgCEKQiqYkvVqFtpoAEVjBq4aJ8?cluster=devnet)
- **3 instructions:** `create_escrow`, `settle`, `close_escrow`
- **Voucher:** 84-byte Ed25519-signed message — `"MORA" | escrow | nonce | payee | amount`

## Repo layout

```
programs/mora/        Anchor program (Rust)
cli/mora.ts           TypeScript CLI for create/voucher/settle/close
tests/mora.ts         Anchor TS tests (localnet + devnet smoke)
web/                  Vanilla HTML/CSS/JS demo (deployable as a static site)
```

## Web demo

Two-phone visualization (Alice signer + Bob POS) with simulated Bluetooth
transport (`BroadcastChannel`), off-chain hash chain, and on-chain settle.
Uses Phantom (optional) for funding the in-browser test keys.

### Run locally

```bash
npm install
npm run web
# open http://localhost:5173/
```

### Deploy to Vercel

The repo root has a `vercel.json` that publishes the `web/` directory as a
static site (no build step):

```bash
npm install -g vercel
vercel --prod
```

Or push to GitHub and import in the Vercel dashboard — the included
`vercel.json` + `.vercelignore` configure the project automatically. Set
the **Root Directory** to the repo root (default), Vercel will pick up
`outputDirectory: "web"`.

The site only needs:
- `web/index.html`
- `web/styles.css`
- `web/mora.json` (Anchor IDL, fetched at runtime)

External deps (`@solana/web3.js`, `@coral-xyz/anchor`, `tweetnacl`, `qrcode`)
are loaded from `esm.sh` CDN, so there is no bundler / build step.

## CLI

```bash
npx tsx cli/mora.ts --help
```

Commands: `create`, `voucher` (offline sign), `settle`, `close`, `status`,
`list`. Reads keypair from `~/.config/solana/id.json` by default.

## Tests

```bash
# localnet (start a validator first)
solana-test-validator --reset --quiet --ledger /tmp/test-ledger &
solana airdrop 100 $(solana-keygen pubkey ~/.config/solana/id.json) --url http://127.0.0.1:8899
anchor test --skip-local-validator   # uses [provider] cluster from Anchor.toml

# devnet smoke (program already deployed)
anchor test --skip-local-validator --skip-deploy --skip-build --provider.cluster devnet
```

4 / 4 happy-path tests passing on both localnet and devnet:

- `create_escrow` locks SOL into a PDA
- `settle` pays via Ed25519-verified voucher
- replay of the same nonce is rejected (Receipt PDA `init`)
- `close_escrow` refunds remainder after expiry
