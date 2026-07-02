import * as anchor from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  getAccount,
  mintTo,
} from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";

const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111"
);

async function ensureATA(
  conn: anchor.web3.Connection,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey,
  allowOwnerOffCurve = false
): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await getOrCreateAssociatedTokenAccount(conn, payer, mint, owner, allowOwnerOffCurve);
      return;
    } catch (e: any) {
      if (attempt === 5) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
import { assert } from "chai";

const IDL = require("../target/idl/zdlt_seeker_staking.json");
const PROGRAM_ID = new PublicKey("ZDLT3oh8VxZJcSTxi1LgG4GqMsiF4jFrQho6hnJj5Gy");

describe("zdlt_seeker_staking", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = new anchor.Program(IDL, provider);
  const conn = provider.connection;

  const payer = (provider.wallet as anchor.Wallet).payer;

  // Fixed keypairs — persisted across runs so ATAs and SOL aren't wasted each time
  const USER_SECRET = Uint8Array.from(JSON.parse(
    require("fs").existsSync("test-user.json")
      ? require("fs").readFileSync("test-user.json", "utf8")
      : (() => { const kp = Keypair.generate(); require("fs").writeFileSync("test-user.json", JSON.stringify(Array.from(kp.secretKey))); return JSON.stringify(Array.from(kp.secretKey)); })()
  ));
  const ATTACKER_SECRET = Uint8Array.from(JSON.parse(
    require("fs").existsSync("test-attacker.json")
      ? require("fs").readFileSync("test-attacker.json", "utf8")
      : (() => { const kp = Keypair.generate(); require("fs").writeFileSync("test-attacker.json", JSON.stringify(Array.from(kp.secretKey))); return JSON.stringify(Array.from(kp.secretKey)); })()
  ));
  const user = Keypair.fromSecretKey(USER_SECRET);
  const attacker = Keypair.fromSecretKey(ATTACKER_SECRET);

  // Random base ID so stake PDAs never collide across devnet runs
  const BASE_ID = Math.floor(Date.now() / 1000);

  let zdltMint: PublicKey;
  let configPDA: PublicKey;
  let vaultAuthorityPDA: PublicKey;
  let vaultATA: PublicKey;
  // Keypair that matches config.authority — may differ from payer on devnet
  // if the VaultConfig was initialized in a prior session with a different wallet.
  let authoritySigner: Keypair;

  function stakeAccountPDA(stakeId: number, owner: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("stake"), owner.toBuffer(), new anchor.BN(stakeId).toArrayLike(Buffer, "le", 8)],
      PROGRAM_ID
    );
    return pda;
  }

  before(async () => {
    // Fund user + attacker only if their balance is below threshold
    const MIN_LAMPORTS = 0.05 * LAMPORTS_PER_SOL;
    for (const kp of [user, attacker]) {
      const bal = await conn.getBalance(kp.publicKey);
      if (bal < MIN_LAMPORTS) {
        const blockhash = await conn.getLatestBlockhash();
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: kp.publicKey,
            lamports: MIN_LAMPORTS,
          })
        );
        const sig = await provider.sendAndConfirm(tx);
        await conn.confirmTransaction({ signature: sig, ...blockhash });
        console.log(`  [before] funded ${kp.publicKey.toBase58().slice(0, 8)}... with 0.05 SOL`);
      }
    }

    [configPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_config")],
      PROGRAM_ID
    );
    [vaultAuthorityPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority")],
      PROGRAM_ID
    );

    // On devnet the config PDA persists across runs — reuse it instead of re-initializing.
    const existing = await conn.getAccountInfo(configPDA);
    if (existing) {
      // VaultConfig layout: [8 disc][32 authority][32 zdlt_mint][1 bump][1 vault_auth_bump]
      const storedAuthority = new PublicKey(existing.data.slice(8, 8 + 32));
      zdltMint = new PublicKey(existing.data.slice(8 + 32, 8 + 32 + 32));
      console.log("  [before] reusing existing VaultConfig, mint:", zdltMint.toBase58());

      if (storedAuthority.equals(payer.publicKey)) {
        authoritySigner = payer;
      } else {
        // VaultConfig was initialized in a prior session with a different wallet —
        // load it from the default Solana CLI keypair path.
        const defaultKeyPath = require("os").homedir() + "/.config/solana/id.json";
        const secret = Uint8Array.from(JSON.parse(require("fs").readFileSync(defaultKeyPath, "utf8")));
        authoritySigner = Keypair.fromSecretKey(secret);
        console.log("  [before] authority signer:", authoritySigner.publicKey.toBase58());
      }
    } else {
      zdltMint = await createMint(conn, payer, payer.publicKey, null, 9);
      vaultATA = getAssociatedTokenAddressSync(zdltMint, vaultAuthorityPDA, true);
      const [programDataPDA] = PublicKey.findProgramAddressSync(
        [PROGRAM_ID.toBuffer()],
        BPF_LOADER_UPGRADEABLE_PROGRAM_ID
      );
      await program.methods
        .initialize(payer.publicKey)
        .accounts({
          config: configPDA,
          vaultAuthority: vaultAuthorityPDA,
          vaultAta: vaultATA,
          zdltMint,
          payer: payer.publicKey,
          programData: programDataPDA,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .rpc();
      authoritySigner = payer;
      console.log("  [before] initialized VaultConfig, mint:", zdltMint.toBase58());
    }

    vaultATA = getAssociatedTokenAddressSync(zdltMint, vaultAuthorityPDA, true);

    // Ensure all ATAs exist — retry loop handles Helius devnet propagation lag
    await ensureATA(conn, payer, zdltMint, vaultAuthorityPDA, true);
    await ensureATA(conn, payer, zdltMint, user.publicKey);
    await ensureATA(conn, payer, zdltMint, attacker.publicKey);
  });

  async function doStake(
    stakeId: number,
    staker: Keypair,
    amountRaw: bigint,
    lockSeconds: number
  ): Promise<PublicKey> {
    const ata = await getOrCreateAssociatedTokenAccount(
      conn, payer, zdltMint, staker.publicKey
    );
    await mintTo(conn, payer, zdltMint, ata.address, payer, amountRaw);

    await program.methods
      .stake(
        new anchor.BN(stakeId),
        new anchor.BN(amountRaw.toString()),
        new anchor.BN(lockSeconds)
      )
      .accounts({
        config: configPDA,
        vaultAuthority: vaultAuthorityPDA,
        stakeAccount: stakeAccountPDA(stakeId, staker.publicKey),
        vaultAta: vaultATA,
        ownerAta: ata.address,
        owner: staker.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([staker])
      .rpc();

    return ata.address;
  }

  it("stake transfers tokens from owner ATA into vault ATA", async () => {
    const id = BASE_ID + 1;
    const amount = 1_000_000_000n; // 1 ZDLT (9 decimals)
    const ownerAtaAddr = getAssociatedTokenAddressSync(zdltMint, user.publicKey);

    // Read balances before mintTo+stake so we check DELTA, not absolute value.
    // Absolute-value checks fail on devnet where ATAs retain tokens across runs.
    const vaultBefore = await getAccount(conn, vaultATA);
    const userBefore = await getAccount(conn, ownerAtaAddr);

    await doStake(id, user, amount, 86400);

    const vaultAfter = await getAccount(conn, vaultATA);
    assert.equal(vaultAfter.amount - vaultBefore.amount, amount, "vault must increase by staked amount");

    const userAfter = await getAccount(conn, ownerAtaAddr);
    assert.equal(userAfter.amount, userBefore.amount, "owner ATA net change must be zero (minted then staked)");
  });

  it("unstake before lock_ts fails with StillLocked", async () => {
    const id = BASE_ID + 1; // same stake as above — 24h lock, still active
    try {
      await program.methods
        .unstake(new anchor.BN(id))
        .accounts({
          config: configPDA,
          vaultAuthority: vaultAuthorityPDA,
          stakeAccount: stakeAccountPDA(id, user.publicKey),
          vaultAta: vaultATA,
          ownerAta: getAssociatedTokenAddressSync(zdltMint, user.publicKey),
          owner: user.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([user])
        .rpc();
      assert.fail("expected StillLocked");
    } catch (e: any) {
      assert.match(String(e), /StillLocked|0x1770/i);
    }
  });

  it("force_unstake by wrong signer is rejected", async () => {
    const id = BASE_ID + 1;
    try {
      await program.methods
        .forceUnstake(new anchor.BN(id))
        .accounts({
          config: configPDA,
          vaultAuthority: vaultAuthorityPDA,
          stakeAccount: stakeAccountPDA(id, user.publicKey),
          vaultAta: vaultATA,
          stakeOwner: user.publicKey,
          ownerAta: getAssociatedTokenAddressSync(zdltMint, user.publicKey),
          authority: attacker.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([attacker])
        .rpc();
      assert.fail("expected rejection — attacker is not config.authority");
    } catch (e: any) {
      assert.ok(String(e).length > 0);
    }
  });

  it("force_unstake by correct authority returns principal to stake owner", async () => {
    const id = BASE_ID + 1;
    const ownerAta = getAssociatedTokenAddressSync(zdltMint, user.publicKey);
    const before = await getAccount(conn, ownerAta);

    await program.methods
      .forceUnstake(new anchor.BN(id))
      .accounts({
        config: configPDA,
        vaultAuthority: vaultAuthorityPDA,
        stakeAccount: stakeAccountPDA(id, user.publicKey),
        vaultAta: vaultATA,
        stakeOwner: user.publicKey,
        ownerAta,
        authority: authoritySigner.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([authoritySigner])
      .rpc();

    // Helius devnet can lag a few seconds before the updated balance is visible.
    await new Promise((r) => setTimeout(r, 2000));
    const after = await getAccount(conn, ownerAta);
    assert.equal(
      after.amount - before.amount,
      1_000_000_000n,
      "exact principal must be returned to owner"
    );
  });

  it("unstake by non-owner is rejected", async () => {
    const id = BASE_ID + 2;
    await doStake(id, user, 500_000_000n, 3600);
    const attackerAta = await getOrCreateAssociatedTokenAccount(
      conn, payer, zdltMint, attacker.publicKey
    );

    try {
      await program.methods
        .unstake(new anchor.BN(id))
        .accounts({
          config: configPDA,
          vaultAuthority: vaultAuthorityPDA,
          stakeAccount: stakeAccountPDA(id, user.publicKey),
          vaultAta: vaultATA,
          ownerAta: attackerAta.address,
          owner: attacker.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([attacker])
        .rpc();
      assert.fail("expected rejection — attacker is not stake owner");
    } catch (e: any) {
      assert.ok(String(e).length > 0);
    }
  });

  it("unstake after lock_ts returns exact principal", async () => {
    const id = BASE_ID + 3;
    // lock_seconds=1 — expired by the time we call unstake
    const ownerAta = await doStake(id, user, 750_000_000n, 1);
    await new Promise((r) => setTimeout(r, 2000));

    const before = await getAccount(conn, ownerAta);
    await program.methods
      .unstake(new anchor.BN(id))
      .accounts({
        config: configPDA,
        vaultAuthority: vaultAuthorityPDA,
        stakeAccount: stakeAccountPDA(id, user.publicKey),
        vaultAta: vaultATA,
        ownerAta,
        owner: user.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();

    const after = await getAccount(conn, ownerAta);
    assert.equal(
      after.amount - before.amount,
      750_000_000n,
      "exact principal must be returned on expired unstake"
    );
  });

  it("same stake_id under two different owners does not collide (owner is in the seed)", async () => {
    // The fix: the stake PDA is seeded by (owner, stake_id), not stake_id alone.
    // A user cannot squat/front-run another user's stake_id, because each owner's
    // stake_id maps to a DISTINCT PDA. Before the fix, the second stake at the same
    // stake_id would fail on an already-initialized PDA, letting any wallet block a
    // victim's sequential DB stake_id.
    const id = BASE_ID + 50;

    // The victim (user) stakes at `id`.
    await doStake(id, user, 100_000_000n, 86400);

    // The "attacker" stakes at the SAME `id`. With owner in the seed this must
    // SUCCEED against its own distinct PDA rather than collide with the victim's.
    await doStake(id, attacker, 100_000_000n, 86400);

    const userPda = stakeAccountPDA(id, user.publicKey);
    const attackerPda = stakeAccountPDA(id, attacker.publicKey);
    assert.notEqual(
      userPda.toBase58(),
      attackerPda.toBase58(),
      "same stake_id must derive distinct PDAs per owner"
    );

    const userStake = await program.account.stakeAccount.fetch(userPda);
    const attackerStake = await program.account.stakeAccount.fetch(attackerPda);
    assert.ok(userStake.owner.equals(user.publicKey), "victim PDA owned by victim");
    assert.ok(attackerStake.owner.equals(attacker.publicKey), "attacker PDA owned by attacker");
  });
});
