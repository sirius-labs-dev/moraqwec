import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, BN, Program, web3 } from "@coral-xyz/anchor";
import {
  Ed25519Program,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import nacl from "tweetnacl";
import { expect } from "chai";
import { Mora } from "../target/types/mora";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("mora — happy path", () => {
  const provider = AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.mora as Program<Mora>;
  const alice = (provider.wallet as anchor.Wallet).payer;

  const seed = new BN(Math.floor(Math.random() * 2 ** 31));
  const escrowAmount = new BN(0.1 * LAMPORTS_PER_SOL);
  const payAmount = new BN(0.03 * LAMPORTS_PER_SOL);
  const nonce = new BN(1);

  // Short-lived escrow so close_escrow can run in the same test cycle.
  const expiresAt = new BN(Math.floor(Date.now() / 1000) + 6);

  const bob = Keypair.generate();

  let escrowPda: PublicKey;
  let receiptPda: PublicKey;

  before(() => {
    [escrowPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("escrow"),
        alice.publicKey.toBuffer(),
        seed.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    [receiptPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("receipt"),
        escrowPda.toBuffer(),
        nonce.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
  });

  it("create_escrow locks SOL into a PDA", async () => {
    await program.methods
      .createEscrow(seed, escrowAmount, expiresAt)
      .accounts({
        authority: alice.publicKey,
        escrow: escrowPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const e = await program.account.escrow.fetch(escrowPda);
    expect(e.authority.toBase58()).to.equal(alice.publicKey.toBase58());
    expect(e.seed.toString()).to.equal(seed.toString());
    expect(e.amount.toString()).to.equal(escrowAmount.toString());
    expect(e.spent.toString()).to.equal("0");
    expect(e.expiresAt.toString()).to.equal(expiresAt.toString());
  });

  it("settle pays bob via an Ed25519-signed voucher", async () => {
    // Canonical voucher: "MORA" | escrow | nonce LE | payee | amount LE
    const message = Buffer.concat([
      Buffer.from("MORA"),
      escrowPda.toBuffer(),
      nonce.toArrayLike(Buffer, "le", 8),
      bob.publicKey.toBuffer(),
      payAmount.toArrayLike(Buffer, "le", 8),
    ]);
    expect(message.length).to.equal(84);

    const signature = nacl.sign.detached(message, alice.secretKey);

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: alice.publicKey.toBytes(),
      message,
      signature,
    });

    const settleIx = await program.methods
      .settle(nonce, payAmount)
      .accounts({
        submitter: alice.publicKey,
        escrow: escrowPda,
        payee: bob.publicKey,
        receipt: receiptPda,
        ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(ed25519Ix).add(settleIx);
    await provider.sendAndConfirm(tx, []);

    const bobBal = await provider.connection.getBalance(bob.publicKey);
    expect(bobBal).to.equal(payAmount.toNumber());

    const e = await program.account.escrow.fetch(escrowPda);
    expect(e.spent.toString()).to.equal(payAmount.toString());

    const r = await program.account.receipt.fetch(receiptPda);
    expect(r.escrow.toBase58()).to.equal(escrowPda.toBase58());
    expect(r.nonce.toString()).to.equal(nonce.toString());
  });

  it("settle rejects a replay of the same nonce", async () => {
    // Re-build the same voucher and try to settle again — Receipt PDA
    // init should reject the second attempt.
    const message = Buffer.concat([
      Buffer.from("MORA"),
      escrowPda.toBuffer(),
      nonce.toArrayLike(Buffer, "le", 8),
      bob.publicKey.toBuffer(),
      payAmount.toArrayLike(Buffer, "le", 8),
    ]);
    const signature = nacl.sign.detached(message, alice.secretKey);
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: alice.publicKey.toBytes(),
      message,
      signature,
    });
    const settleIx = await program.methods
      .settle(nonce, payAmount)
      .accounts({
        submitter: alice.publicKey,
        escrow: escrowPda,
        payee: bob.publicKey,
        receipt: receiptPda,
        ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    const tx = new Transaction().add(ed25519Ix).add(settleIx);
    let threw = false;
    try {
      await provider.sendAndConfirm(tx, []);
    } catch {
      threw = true;
    }
    expect(threw).to.equal(true);
  });

  it("close_escrow refunds the remainder after expiry", async () => {
    const now = Math.floor(Date.now() / 1000);
    const waitMs = (expiresAt.toNumber() - now) * 1000 + 2000;
    if (waitMs > 0) await sleep(waitMs);

    const before = await provider.connection.getBalance(alice.publicKey);
    await program.methods
      .closeEscrow()
      .accounts({
        authority: alice.publicKey,
        escrow: escrowPda,
      })
      .rpc();
    const after = await provider.connection.getBalance(alice.publicKey);

    // Alice gets back: remaining escrow lamports + rent (Anchor close),
    // minus the tx fee. Must be a net gain that includes most of the
    // unspent 0.07 SOL.
    const delta = after - before;
    expect(delta).to.be.greaterThan((escrowAmount.toNumber() - payAmount.toNumber()) - 100_000);

    // Account is gone.
    const acc = await provider.connection.getAccountInfo(escrowPda);
    expect(acc).to.equal(null);
  });
});
