//! Mora — minimal offline payment escrow.
//!
//! 3 instructions:
//!   create_escrow  Alice locks SOL into a PDA with an expiry.
//!   settle         Anyone submits an Ed25519-signed voucher to pay a payee.
//!   close_escrow   After expiry, Alice reclaims the remainder.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use solana_instructions_sysvar::{
    load_current_index_checked, load_instruction_at_checked, ID as IX_SYSVAR_ID,
};
use solana_sdk_ids::ed25519_program;

declare_id!("9fcXHD3pHDKLX79JuVgCEKQiqYkvVqFtpoAEVjBq4aJ8");

const VOUCHER_DOMAIN: &[u8; 4] = b"MORA";
const VOUCHER_MSG_LEN: usize = 84; // 4 + 32 + 8 + 32 + 8

#[program]
pub mod mora {
    use super::*;

    pub fn create_escrow(
        ctx: Context<CreateEscrow>,
        seed: u64,
        amount: u64,
        expires_at: i64,
    ) -> Result<()> {
        require!(amount > 0, MoraError::ZeroAmount);
        let now = Clock::get()?.unix_timestamp;
        require!(expires_at > now, MoraError::InvalidExpiry);

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                system_program::Transfer {
                    from: ctx.accounts.authority.to_account_info(),
                    to: ctx.accounts.escrow.to_account_info(),
                },
            ),
            amount,
        )?;

        let e = &mut ctx.accounts.escrow;
        e.authority = ctx.accounts.authority.key();
        e.seed = seed;
        e.amount = amount;
        e.spent = 0;
        e.expires_at = expires_at;
        e.bump = ctx.bumps.escrow;
        Ok(())
    }

    pub fn settle(ctx: Context<Settle>, nonce: u64, amount: u64) -> Result<()> {
        require!(amount > 0, MoraError::ZeroAmount);

        let e = &mut ctx.accounts.escrow;
        let payee = ctx.accounts.payee.key();
        require!(payee != e.authority, MoraError::SelfPayment);

        let now = Clock::get()?.unix_timestamp;
        require!(now < e.expires_at, MoraError::Expired);

        let remaining = e.amount.checked_sub(e.spent).ok_or(MoraError::Underflow)?;
        require!(amount <= remaining, MoraError::InsufficientFunds);

        // Voucher must be signed by escrow.authority via the Ed25519 native
        // program in the immediately preceding instruction.
        let msg = build_voucher_msg(&e.key(), nonce, &payee, amount);
        verify_ed25519_sig(
            &ctx.accounts.ix_sysvar.to_account_info(),
            &e.authority,
            &msg,
        )?;

        // Pay payee from PDA lamports.
        let e_ai = e.to_account_info();
        let p_ai = ctx.accounts.payee.to_account_info();
        **e_ai.try_borrow_mut_lamports()? = e_ai
            .lamports()
            .checked_sub(amount)
            .ok_or(MoraError::Underflow)?;
        **p_ai.try_borrow_mut_lamports()? = p_ai
            .lamports()
            .checked_add(amount)
            .ok_or(MoraError::Overflow)?;

        e.spent = e.spent.checked_add(amount).ok_or(MoraError::Overflow)?;

        let r = &mut ctx.accounts.receipt;
        r.escrow = e.key();
        r.nonce = nonce;
        r.bump = ctx.bumps.receipt;
        Ok(())
    }

    pub fn close_escrow(ctx: Context<CloseEscrow>) -> Result<()> {
        let e = &ctx.accounts.escrow;
        let now = Clock::get()?.unix_timestamp;
        require!(now >= e.expires_at, MoraError::NotExpired);
        // Anchor's `close = authority` returns all remaining lamports
        // (rent + unspent balance) to the authority.
        Ok(())
    }
}

// ---------- voucher ---------------------------------------------------

fn build_voucher_msg(
    escrow: &Pubkey,
    nonce: u64,
    payee: &Pubkey,
    amount: u64,
) -> [u8; VOUCHER_MSG_LEN] {
    let mut buf = [0u8; VOUCHER_MSG_LEN];
    buf[0..4].copy_from_slice(VOUCHER_DOMAIN);
    buf[4..36].copy_from_slice(escrow.as_ref());
    buf[36..44].copy_from_slice(&nonce.to_le_bytes());
    buf[44..76].copy_from_slice(payee.as_ref());
    buf[76..84].copy_from_slice(&amount.to_le_bytes());
    buf
}

/// Require the previous instruction to be the Ed25519 native program with a
/// single self-contained signature over (`expected_signer`, `expected_msg`).
fn verify_ed25519_sig(
    ix_sysvar: &AccountInfo,
    expected_signer: &Pubkey,
    expected_msg: &[u8],
) -> Result<()> {
    let cur = load_current_index_checked(ix_sysvar)? as usize;
    require!(cur >= 1, MoraError::Ed25519IxMissing);
    let prev = load_instruction_at_checked(cur - 1, ix_sysvar)?;
    require_keys_eq!(prev.program_id, ed25519_program::ID, MoraError::WrongVerifyProgram);
    require!(prev.data.len() >= 16, MoraError::MalformedSig);
    require!(prev.data[0] == 1, MoraError::MalformedSig);

    let read_u16 = |off: usize| u16::from_le_bytes([prev.data[off], prev.data[off + 1]]);
    let pk_off = read_u16(6) as usize;
    let msg_off = read_u16(10) as usize;
    let msg_len = read_u16(12) as usize;
    // All instruction_index fields must be 0xFFFF (self-contained).
    require!(
        read_u16(4) == u16::MAX && read_u16(8) == u16::MAX && read_u16(14) == u16::MAX,
        MoraError::MalformedSig
    );

    let pk_end = pk_off.checked_add(32).ok_or(MoraError::MalformedSig)?;
    let msg_end = msg_off.checked_add(msg_len).ok_or(MoraError::MalformedSig)?;
    require!(
        pk_end <= prev.data.len() && msg_end <= prev.data.len(),
        MoraError::MalformedSig
    );

    require!(
        &prev.data[pk_off..pk_end] == expected_signer.as_ref(),
        MoraError::SignerMismatch
    );
    require!(msg_len == expected_msg.len(), MoraError::MsgMismatch);
    require!(
        &prev.data[msg_off..msg_end] == expected_msg,
        MoraError::MsgMismatch
    );
    Ok(())
}

// ---------- accounts --------------------------------------------------

#[derive(Accounts)]
#[instruction(seed: u64)]
pub struct CreateEscrow<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Escrow::INIT_SPACE,
        seeds = [b"escrow", authority.key().as_ref(), &seed.to_le_bytes()],
        bump,
    )]
    pub escrow: Account<'info, Escrow>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct Settle<'info> {
    #[account(mut)]
    pub submitter: Signer<'info>,
    #[account(
        mut,
        seeds = [b"escrow", escrow.authority.as_ref(), &escrow.seed.to_le_bytes()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, Escrow>,
    /// CHECK: pubkey is bound by the signed voucher message.
    #[account(mut)]
    pub payee: UncheckedAccount<'info>,
    #[account(
        init,
        payer = submitter,
        space = 8 + Receipt::INIT_SPACE,
        seeds = [b"receipt", escrow.key().as_ref(), &nonce.to_le_bytes()],
        bump,
    )]
    pub receipt: Account<'info, Receipt>,
    /// CHECK: address-constrained.
    #[account(address = IX_SYSVAR_ID)]
    pub ix_sysvar: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseEscrow<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        close = authority,
        seeds = [b"escrow", authority.key().as_ref(), &escrow.seed.to_le_bytes()],
        bump = escrow.bump,
        has_one = authority,
    )]
    pub escrow: Account<'info, Escrow>,
}

// ---------- state -----------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct Escrow {
    pub authority: Pubkey,
    pub seed: u64,
    pub amount: u64,
    pub spent: u64,
    pub expires_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Receipt {
    pub escrow: Pubkey,
    pub nonce: u64,
    pub bump: u8,
}

// ---------- errors ----------------------------------------------------

#[error_code]
pub enum MoraError {
    #[msg("amount must be > 0")]
    ZeroAmount,
    #[msg("expires_at must be in the future")]
    InvalidExpiry,
    #[msg("escrow expired")]
    Expired,
    #[msg("escrow not yet expired")]
    NotExpired,
    #[msg("insufficient escrow funds")]
    InsufficientFunds,
    #[msg("payee equals authority — self-payment forbidden")]
    SelfPayment,
    #[msg("Ed25519 verify ix not present at expected index")]
    Ed25519IxMissing,
    #[msg("preceding instruction is not the Ed25519 native program")]
    WrongVerifyProgram,
    #[msg("Ed25519 ix data malformed")]
    MalformedSig,
    #[msg("Ed25519 signer does not match escrow.authority")]
    SignerMismatch,
    #[msg("Ed25519 message does not match expected voucher bytes")]
    MsgMismatch,
    #[msg("integer underflow")]
    Underflow,
    #[msg("integer overflow")]
    Overflow,
}
