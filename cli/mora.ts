#!/usr/bin/env node
/**
 * Mora CLI — devnet prototype.
 *
 *   mora create  --amount <sol>   --expires-in <secs>   [--seed <u64>]
 *   mora voucher --escrow <pda>   --nonce <u64> --to <pubkey> --amount <sol>
 *   mora settle  --voucher <b64>
 *   mora close   --escrow <pda>
 *   mora status  --escrow <pda>
 *
 * The `voucher` command runs entirely offline: it builds the canonical 84-byte
 * message, signs it with the local wallet, and prints a base64 blob (which is
 * what would otherwise be encoded into a QR code on a phone).
 */

import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, BN, Program, Wallet, web3 } from "@coral-xyz/anchor";
import {
  Connection,
  Ed25519Program,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import { Command } from "commander";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import nacl from "tweetnacl";
import qrcodeTerminal from "qrcode-terminal";
import idl from "../target/idl/mora.json";
import type { Mora } from "../target/types/mora";

const DEFAULT_RPC = "https://api.devnet.solana.com";
const DEFAULT_KEYPAIR = path.join(os.homedir(), ".config/solana/id.json");

function loadKeypair(p: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function makeProvider(rpcUrl: string, keypairPath: string): AnchorProvider {
  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = new Wallet(loadKeypair(keypairPath));
  return new AnchorProvider(connection, wallet, { commitment: "confirmed" });
}

function makeProgram(provider: AnchorProvider): Program<Mora> {
  return new Program<Mora>(idl as any, provider);
}

function lamportsFromSol(s: string): BN {
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`bad amount: ${s}`);
  return new BN(Math.round(n * LAMPORTS_PER_SOL));
}

function findEscrowPda(programId: PublicKey, authority: PublicKey, seed: BN) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), authority.toBuffer(), seed.toArrayLike(Buffer, "le", 8)],
    programId
  );
}

function findReceiptPda(programId: PublicKey, escrow: PublicKey, nonce: BN) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("receipt"), escrow.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)],
    programId
  );
}

function buildVoucherMessage(
  escrow: PublicKey,
  nonce: BN,
  payee: PublicKey,
  amount: BN
): Buffer {
  return Buffer.concat([
    Buffer.from("MORA"),
    escrow.toBuffer(),
    nonce.toArrayLike(Buffer, "le", 8),
    payee.toBuffer(),
    amount.toArrayLike(Buffer, "le", 8),
  ]);
}

// ---------------------------------------------------------------------

const program = new Command();
program
  .name("mora")
  .description("Mora — offline payment escrow CLI")
  .option("-r, --rpc <url>", "RPC URL", DEFAULT_RPC)
  .option("-k, --keypair <path>", "Keypair file", DEFAULT_KEYPAIR);

program
  .command("create")
  .description("Open a fresh escrow PDA and lock SOL into it")
  .requiredOption("-a, --amount <sol>", "Escrow amount in SOL")
  .requiredOption("-e, --expires-in <secs>", "Seconds until expiry")
  .option("-s, --seed <u64>", "Optional seed (default: random)")
  .action(async (opts) => {
    const root = program.opts();
    const provider = makeProvider(root.rpc, root.keypair);
    anchor.setProvider(provider);
    const prog = makeProgram(provider);

    const seed = opts.seed
      ? new BN(opts.seed)
      : new BN(Math.floor(Math.random() * 2 ** 31));
    const amount = lamportsFromSol(opts.amount);
    const expiresAt = new BN(Math.floor(Date.now() / 1000) + Number(opts.expiresIn));

    const [escrow] = findEscrowPda(prog.programId, provider.wallet.publicKey, seed);

    const sig = await prog.methods
      .createEscrow(seed, amount, expiresAt)
      .accounts({
        authority: provider.wallet.publicKey,
        escrow,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log(JSON.stringify({
      escrow: escrow.toBase58(),
      seed: seed.toString(),
      amount_lamports: amount.toString(),
      expires_at: expiresAt.toString(),
      tx: sig,
    }, null, 2));
  });

program
  .command("voucher")
  .description("Sign an offline voucher (no network call)")
  .requiredOption("-e, --escrow <pda>", "Escrow PDA")
  .requiredOption("-n, --nonce <u64>", "Voucher nonce (unique per escrow)")
  .requiredOption("-t, --to <pubkey>", "Payee pubkey")
  .requiredOption("-a, --amount <sol>", "Amount in SOL")
  .option("--qr", "Also print the voucher as a QR code on stdout")
  .action((opts) => {
    const root = program.opts();
    const wallet = loadKeypair(root.keypair);

    const escrow = new PublicKey(opts.escrow);
    const payee = new PublicKey(opts.to);
    const nonce = new BN(opts.nonce);
    const amount = lamportsFromSol(opts.amount);

    const message = buildVoucherMessage(escrow, nonce, payee, amount);
    if (message.length !== 84) throw new Error("voucher length mismatch");

    const signature = nacl.sign.detached(message, wallet.secretKey);

    const blob = Buffer.concat([message, Buffer.from(signature)]).toString("base64");
    console.log(JSON.stringify({
      escrow: escrow.toBase58(),
      nonce: nonce.toString(),
      payee: payee.toBase58(),
      amount_lamports: amount.toString(),
      voucher_b64: blob,
    }, null, 2));

    if (opts.qr) {
      console.log("");
      qrcodeTerminal.generate(blob, { small: true });
    }
  });

program
  .command("settle")
  .description("Submit a previously signed voucher to the chain")
  .requiredOption("-v, --voucher <b64>", "Base64 voucher blob from `mora voucher`")
  .action(async (opts) => {
    const root = program.opts();
    const provider = makeProvider(root.rpc, root.keypair);
    anchor.setProvider(provider);
    const prog = makeProgram(provider);

    const blob = Buffer.from(opts.voucher, "base64");
    if (blob.length !== 84 + 64) throw new Error("voucher blob: wrong length");
    const message = blob.subarray(0, 84);
    const signature = blob.subarray(84);

    const escrow = new PublicKey(message.subarray(4, 36));
    const nonce = new BN(message.subarray(36, 44), "le");
    const payee = new PublicKey(message.subarray(44, 76));
    const amount = new BN(message.subarray(76, 84), "le");

    const escrowAcc = await prog.account.escrow.fetch(escrow);

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: escrowAcc.authority.toBytes(),
      message,
      signature,
    });

    const [receipt] = findReceiptPda(prog.programId, escrow, nonce);

    const settleIx = await prog.methods
      .settle(nonce, amount)
      .accounts({
        submitter: provider.wallet.publicKey,
        escrow,
        payee,
        receipt,
        ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(ed25519Ix).add(settleIx);
    const sig = await provider.sendAndConfirm(tx, []);

    console.log(JSON.stringify({
      tx: sig,
      escrow: escrow.toBase58(),
      nonce: nonce.toString(),
      payee: payee.toBase58(),
      amount_lamports: amount.toString(),
      receipt: receipt.toBase58(),
    }, null, 2));
  });

program
  .command("close")
  .description("Close an expired escrow and reclaim the remainder")
  .requiredOption("-e, --escrow <pda>", "Escrow PDA")
  .action(async (opts) => {
    const root = program.opts();
    const provider = makeProvider(root.rpc, root.keypair);
    anchor.setProvider(provider);
    const prog = makeProgram(provider);

    const escrow = new PublicKey(opts.escrow);

    const sig = await prog.methods
      .closeEscrow()
      .accounts({
        authority: provider.wallet.publicKey,
        escrow,
      })
      .rpc();

    console.log(JSON.stringify({ tx: sig, closed: escrow.toBase58() }, null, 2));
  });

program
  .command("list")
  .description("List all escrows owned by the local wallet")
  .action(async () => {
    const root = program.opts();
    const provider = makeProvider(root.rpc, root.keypair);
    anchor.setProvider(provider);
    const prog = makeProgram(provider);

    const accounts = await prog.account.escrow.all([
      {
        memcmp: {
          offset: 8, // skip Anchor discriminator; first field is `authority` (Pubkey)
          bytes: provider.wallet.publicKey.toBase58(),
        },
      },
    ]);
    const now = Math.floor(Date.now() / 1000);
    const rows = accounts.map((a) => ({
      escrow: a.publicKey.toBase58(),
      seed: a.account.seed.toString(),
      amount_lamports: a.account.amount.toString(),
      spent_lamports: a.account.spent.toString(),
      remaining_lamports: a.account.amount.sub(a.account.spent).toString(),
      expires_at: a.account.expiresAt.toString(),
      expired: now >= a.account.expiresAt.toNumber(),
    }));
    console.log(JSON.stringify({ count: rows.length, escrows: rows }, null, 2));
  });

program
  .command("status")
  .description("Show on-chain state of an escrow")
  .requiredOption("-e, --escrow <pda>", "Escrow PDA")
  .action(async (opts) => {
    const root = program.opts();
    const provider = makeProvider(root.rpc, root.keypair);
    anchor.setProvider(provider);
    const prog = makeProgram(provider);

    const escrow = new PublicKey(opts.escrow);
    const acc = await prog.account.escrow.fetchNullable(escrow);
    if (!acc) {
      console.log(JSON.stringify({ escrow: escrow.toBase58(), exists: false }, null, 2));
      return;
    }
    const lamports = await provider.connection.getBalance(escrow);
    const now = Math.floor(Date.now() / 1000);
    console.log(JSON.stringify({
      escrow: escrow.toBase58(),
      authority: acc.authority.toBase58(),
      seed: acc.seed.toString(),
      amount_lamports: acc.amount.toString(),
      spent_lamports: acc.spent.toString(),
      remaining_lamports: acc.amount.sub(acc.spent).toString(),
      pda_lamports: lamports,
      expires_at: acc.expiresAt.toString(),
      seconds_to_expiry: acc.expiresAt.toNumber() - now,
      expired: now >= acc.expiresAt.toNumber(),
    }, null, 2));
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(e.message ?? String(e));
  process.exit(1);
});
