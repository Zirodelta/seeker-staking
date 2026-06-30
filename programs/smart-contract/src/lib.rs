use anchor_lang::{prelude::*, solana_program::bpf_loader_upgradeable};

#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "ZDLT Seeker Staking",
    project_url: "https://zirodelta.com",
    contacts: "email:security@zirodelta.com",
    policy: "https://zirodelta.com/security-policy",
    preferred_languages: "en,id"
}
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer},
};

declare_id!("ZDLT3oh8VxZJcSTxi1LgG4GqMsiF4jFrQho6hnJj5Gy");

// ── Seeds ─────────────────────────────────────────────────────────────────────

const VAULT_CONFIG_SEED: &[u8] = b"vault_config";
const VAULT_AUTH_SEED: &[u8] = b"vault_authority";
const STAKE_SEED: &[u8] = b"stake";

// ── State ─────────────────────────────────────────────────────────────────────

#[account]
pub struct VaultConfig {
    /// Backend API keypair — gates force_unstake.
    pub authority: Pubkey,
    pub zdlt_mint: Pubkey,
    pub bump: u8,
    /// Bump for the vault_authority PDA (stored so CPI signing is cheap).
    pub vault_auth_bump: u8,
}

impl VaultConfig {
    pub const LEN: usize = 8 + 32 + 32 + 1 + 1;
}

#[account]
pub struct StakeAccount {
    /// User wallet — receives principal back on unstake.
    pub owner: Pubkey,
    /// Raw SPL token units (= DB amount_zdlt × 10^zdlt_decimals).
    pub amount: u64,
    /// Unix timestamp after which permissionless unstake is allowed.
    pub unlock_ts: i64,
    /// Matches zdlt_stakes.id in the API DB — links on-chain ↔ off-chain.
    pub stake_id: u64,
    pub bump: u8,
}

impl StakeAccount {
    pub const LEN: usize = 8 + 32 + 8 + 8 + 8 + 1;
}

// ── Errors ────────────────────────────────────────────────────────────────────

#[error_code]
pub enum VaultError {
    #[msg("Stake is still locked; unlock_ts has not been reached")]
    StillLocked,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("lock_seconds must be positive")]
    InvalidLockDuration,
    #[msg("Stake owner mismatch")]
    OwnerMismatch,
    #[msg("Arithmetic overflow computing unlock timestamp")]
    Overflow,
    #[msg("Caller is not the program upgrade authority")]
    Unauthorized,
}

// ── Program ───────────────────────────────────────────────────────────────────

#[program]
pub mod zdlt_seeker_staking {
    use super::*;

    /// One-time setup: record the authority keypair, mint, and create the
    /// vault token account owned by the vault_authority PDA.
    /// Gated to the program upgrade authority to prevent front-running.
    pub fn initialize(ctx: Context<Initialize>, authority: Pubkey) -> Result<()> {
        // Verify program_data is the canonical PDA for this program.
        let (expected_program_data, _) =
            Pubkey::find_program_address(&[crate::ID.as_ref()], &bpf_loader_upgradeable::ID);
        require!(
            ctx.accounts.program_data.key() == expected_program_data,
            VaultError::Unauthorized
        );

        // Parse upgrade_authority_address from raw ProgramData account bytes.
        // UpgradeableLoaderState::ProgramData (bincode):
        //   [0..4]  variant index = 3 (u32 LE)
        //   [4..12] slot (u64 LE)
        //   [12]    Some = 1 / None = 0
        //   [13..45] Pubkey (32 bytes, only present when Some)
        let data = ctx.accounts.program_data.try_borrow_data()?;
        require!(data.len() >= 45, VaultError::Unauthorized);
        let variant = u32::from_le_bytes(data[0..4].try_into().unwrap());
        require!(variant == 3, VaultError::Unauthorized);
        require!(data[12] == 1, VaultError::Unauthorized); // Some(authority)
        let upgrade_authority = Pubkey::try_from(&data[13..45]).unwrap();
        require!(
            upgrade_authority == ctx.accounts.payer.key(),
            VaultError::Unauthorized
        );

        let config = &mut ctx.accounts.config;
        config.authority = authority;
        config.zdlt_mint = ctx.accounts.zdlt_mint.key();
        config.bump = ctx.bumps.config;
        config.vault_auth_bump = ctx.bumps.vault_authority;
        Ok(())
    }

    /// Transfer `amount` raw token units from the user's ATA to the vault and
    /// create a StakeAccount PDA.  `stake_id` must match the DB row ID so the
    /// API can derive the PDA address deterministically.
    pub fn stake(
        ctx: Context<Stake>,
        stake_id: u64,
        amount: u64,
        lock_seconds: i64,
    ) -> Result<()> {
        require!(amount > 0, VaultError::ZeroAmount);
        require!(lock_seconds > 0, VaultError::InvalidLockDuration);

        let unlock_ts = Clock::get()?
            .unix_timestamp
            .checked_add(lock_seconds)
            .ok_or(VaultError::Overflow)?;

        let acct = &mut ctx.accounts.stake_account;
        acct.owner = ctx.accounts.owner.key();
        acct.amount = amount;
        acct.unlock_ts = unlock_ts;
        acct.stake_id = stake_id;
        acct.bump = ctx.bumps.stake_account;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.owner_ata.to_account_info(),
                    to: ctx.accounts.vault_ata.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
        )
    }

    /// Permissionless unstake — caller must be the stake owner; lock period
    /// must have elapsed.  Closes the StakeAccount and returns principal.
    pub fn unstake(ctx: Context<Unstake>, stake_id: u64) -> Result<()> {
        let _ = stake_id; // used in PDA seed via #[instruction] — not needed in body
        let now = Clock::get()?.unix_timestamp;
        require!(now >= ctx.accounts.stake_account.unlock_ts, VaultError::StillLocked);

        let bump = ctx.accounts.config.vault_auth_bump;
        let seeds: &[&[u8]] = &[VAULT_AUTH_SEED, &[bump]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault_ata.to_account_info(),
                    to: ctx.accounts.owner_ata.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[seeds],
            ),
            ctx.accounts.stake_account.amount,
        )
    }

    /// Authority-gated unstake — the API backend signs as `authority`.
    /// Used for early exit or forced close; no time-lock check.
    /// Forfeit logic (zeroing accrual, re-adding ZDLT to reserve) is handled
    /// entirely in the API layer.
    pub fn force_unstake(ctx: Context<ForceUnstake>, stake_id: u64) -> Result<()> {
        let _ = stake_id;
        let bump = ctx.accounts.config.vault_auth_bump;
        let seeds: &[&[u8]] = &[VAULT_AUTH_SEED, &[bump]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault_ata.to_account_info(),
                    to: ctx.accounts.owner_ata.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[seeds],
            ),
            ctx.accounts.stake_account.amount,
        )
    }
}

// ── Account Contexts ──────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = payer,
        space = VaultConfig::LEN,
        seeds = [VAULT_CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, VaultConfig>,

    /// CHECK: PDA that will own the vault ATA — no on-chain data.
    #[account(seeds = [VAULT_AUTH_SEED], bump)]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = payer,
        associated_token::mint = zdlt_mint,
        associated_token::authority = vault_authority,
    )]
    pub vault_ata: Account<'info, TokenAccount>,

    pub zdlt_mint: Account<'info, Mint>,

    /// The upgrade authority of this program must sign; prevents any third
    /// party from front-running the one-time initialize call on deployment.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// This program's ProgramData account — verified in the instruction body
    /// to be the canonical data account for crate::ID, with payer as the
    /// upgrade authority.
    /// CHECK: verified manually in initialize() against bpf_loader_upgradeable PDA and upgrade authority.
    pub program_data: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[derive(Accounts)]
#[instruction(stake_id: u64)]
pub struct Stake<'info> {
    #[account(seeds = [VAULT_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, VaultConfig>,

    /// CHECK: PDA that owns the vault ATA — verified by vault_ata constraint.
    #[account(seeds = [VAULT_AUTH_SEED], bump = config.vault_auth_bump)]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = owner,
        space = StakeAccount::LEN,
        seeds = [STAKE_SEED, &stake_id.to_le_bytes()],
        bump,
    )]
    pub stake_account: Account<'info, StakeAccount>,

    #[account(
        mut,
        associated_token::mint = config.zdlt_mint,
        associated_token::authority = vault_authority,
    )]
    pub vault_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = config.zdlt_mint,
        associated_token::authority = owner,
    )]
    pub owner_ata: Account<'info, TokenAccount>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[derive(Accounts)]
#[instruction(stake_id: u64)]
pub struct Unstake<'info> {
    #[account(seeds = [VAULT_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, VaultConfig>,

    /// CHECK: PDA that owns the vault ATA — verified by vault_ata constraint.
    #[account(seeds = [VAULT_AUTH_SEED], bump = config.vault_auth_bump)]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [STAKE_SEED, &stake_id.to_le_bytes()],
        bump = stake_account.bump,
        has_one = owner @ VaultError::OwnerMismatch,
        close = owner,
    )]
    pub stake_account: Account<'info, StakeAccount>,

    #[account(
        mut,
        associated_token::mint = config.zdlt_mint,
        associated_token::authority = vault_authority,
    )]
    pub vault_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = config.zdlt_mint,
        associated_token::authority = owner,
    )]
    pub owner_ata: Account<'info, TokenAccount>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[derive(Accounts)]
#[instruction(stake_id: u64)]
pub struct ForceUnstake<'info> {
    #[account(seeds = [VAULT_CONFIG_SEED], bump = config.bump, has_one = authority)]
    pub config: Account<'info, VaultConfig>,

    /// CHECK: PDA that owns the vault ATA — verified by vault_ata constraint.
    #[account(seeds = [VAULT_AUTH_SEED], bump = config.vault_auth_bump)]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [STAKE_SEED, &stake_id.to_le_bytes()],
        bump = stake_account.bump,
        constraint = stake_account.owner == stake_owner.key() @ VaultError::OwnerMismatch,
        close = stake_owner,
    )]
    pub stake_account: Account<'info, StakeAccount>,

    #[account(
        mut,
        associated_token::mint = config.zdlt_mint,
        associated_token::authority = vault_authority,
    )]
    pub vault_ata: Account<'info, TokenAccount>,

    /// Stake owner — receives principal; does not need to sign.
    /// CHECK: verified against stake_account.owner in constraint above.
    #[account(mut)]
    pub stake_owner: SystemAccount<'info>,

    #[account(
        mut,
        associated_token::mint = config.zdlt_mint,
        associated_token::authority = stake_owner,
    )]
    pub owner_ata: Account<'info, TokenAccount>,

    /// The API backend keypair — must match config.authority.
    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}
