# MORA × QVAC — Offline Payments + Offline AI on Solana

> MORA handles payments without internet. QVAC handles AI without cloud.
> Together: a merchant in Lagos receives a payment and gets a human-readable
> explanation in their local language — entirely offline.

**Colosseum Frontier 2026 · Tether QVAC Track Submission**

---

## The Problem

MORA lets users send SOL offline via cryptographic voucher chains. But the
payment confirmation is a raw 84-byte blob — not human-readable. For a merchant
in Lagos, Nairobi, or Jakarta with no internet and no technical background,
this is a barrier.

QVAC solves the last mile: a local AI model explains the payment in plain
language, in any language, without any cloud dependency.

---

## How QVAC Is Used

QVAC's `LLAMA_3_2_1B_INST_Q4_0` model runs locally via `@qvac/sdk`.
No API key. No cloud. No internet required after the first model download.

When a MORA voucher is received, the script:
1. Parses the voucher (amount, nonce, payee, escrow)
2. Loads the QVAC model on-device
3. Generates a plain-language explanation in the requested language
4. Outputs it locally — no data leaves the device

```typescript
import { loadModel, LLAMA_3_2_1B_INST_Q4_0, completion, unloadModel } from "@qvac/sdk";

const modelId = await loadModel({
  modelSrc: LLAMA_3_2_1B_INST_Q4_0,
  modelType: "llm",
});

const result = completion({ modelId, history, stream: true });
for await (const token of result.tokenStream) {
  process.stdout.write(token);
}
```

---

## Demo Output

```
╔═══════════════════════════════════════════╗
║  MORA × QVAC — Offline Payment Explainer  ║
╚═══════════════════════════════════════════╝

Payment details:
  Amount:  0.0100 SOL (10000000 lamports)
  Nonce:   1
  Payee:   bbbbbbbbbbbbbbbb...

[QVAC] Loading local AI model (no cloud required)...
[QVAC] Model ready.
[QVAC] Generating explanation in English...

──────────────────────────────────────────────────
The amount 0.0100 SOL was paid using MORA offline
payments on Solana. This payment is cryptographically
verified and cannot be replayed.
──────────────────────────────────────────────────

✓ Payment explained locally. No cloud required.
✓ MORA voucher verified offline.
✓ QVAC AI ran entirely on this device.
```

---

## Setup

```bash
git clone https://github.com/sirius-labs-dev/moraqwec
cd moraqwec
npm install

# Run demo (downloads ~773MB model on first run)
npx tsx cli/mora-qvac.ts demo

# Explain in a specific language
npx tsx cli/mora-qvac.ts demo --lang Yoruba
npx tsx cli/mora-qvac.ts demo --lang Turkish
npx tsx cli/mora-qvac.ts demo --lang Arabic

# Explain a real voucher
npx tsx cli/mora-qvac.ts explain --voucher <base64> --lang English
```

---

## Why QVAC Is Central

| Without QVAC | With QVAC |
|-------------|-----------|
| Raw bytes: `MORA\xaa\xbb...` | "A payment of 0.01 SOL was received and verified." |
| English only (technical) | Any language, offline |
| Requires developer | Works for any merchant |

QVAC is not a wrapper here. It is the only component that makes the payment
human-readable to a non-technical merchant in a low-connectivity environment.
Remove QVAC and the merchant sees a base64 string. This is load-bearing.

---

## Architecture

```
MORA voucher (offline, no internet)
       │
       ▼
cli/mora-qvac.ts
       │
       ├── Parse voucher (amount, nonce, payee)
       │
       └── QVAC LLM (local, no cloud)
               │
               ▼
       Plain-language explanation
       in any language, on-device
```

---

## MORA Program

Deployed on Solana devnet:
`9fcXHD3pHDKLX79JuVgCEKQiqYkvVqFtpoAEVjBq4aJ8`

Live demo: [mora-sand.vercel.app](https://mora-sand.vercel.app)

---

## License

Apache 2.0
