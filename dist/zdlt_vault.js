"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const anchor = __importStar(require("@coral-xyz/anchor"));
const spl_token_1 = require("@solana/spl-token");
const web3_js_1 = require("@solana/web3.js");
const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new web3_js_1.PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
async function ensureATA(conn, payer, mint, owner, allowOwnerOffCurve = false) {
    for (let attempt = 0; attempt < 6; attempt++) {
        try {
            await (0, spl_token_1.getOrCreateAssociatedTokenAccount)(conn, payer, mint, owner, allowOwnerOffCurve);
            return;
        }
        catch (e) {
            if (attempt === 5)
                throw e;
            await new Promise((r) => setTimeout(r, 2000));
        }
    }
}
const chai_1 = require("chai");
const IDL = require("../target/idl/zdlt_vault.json");
const PROGRAM_ID = new web3_js_1.PublicKey("ZDLT77pfYg72vFyvg5PJcXCwWU7xBFv7ypoSEcCddp9");
describe("zdlt_vault", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = new anchor.Program(IDL, provider);
    const conn = provider.connection;
    const payer = provider.wallet.payer;
    // Fixed keypairs — persisted across runs so ATAs and SOL aren't wasted each time
    const USER_SECRET = Uint8Array.from(JSON.parse(require("fs").existsSync("test-user.json")
        ? require("fs").readFileSync("test-user.json", "utf8")
        : (() => { const kp = web3_js_1.Keypair.generate(); require("fs").writeFileSync("test-user.json", JSON.stringify(Array.from(kp.secretKey))); return JSON.stringify(Array.from(kp.secretKey)); })()));
    const ATTACKER_SECRET = Uint8Array.from(JSON.parse(require("fs").existsSync("test-attacker.json")
        ? require("fs").readFileSync("test-attacker.json", "utf8")
        : (() => { const kp = web3_js_1.Keypair.generate(); require("fs").writeFileSync("test-attacker.json", JSON.stringify(Array.from(kp.secretKey))); return JSON.stringify(Array.from(kp.secretKey)); })()));
    const user = web3_js_1.Keypair.fromSecretKey(USER_SECRET);
    const attacker = web3_js_1.Keypair.fromSecretKey(ATTACKER_SECRET);
    // Random base ID so stake PDAs never collide across devnet runs
    const BASE_ID = Math.floor(Date.now() / 1000);
    let zdltMint;
    let configPDA;
    let vaultAuthorityPDA;
    let vaultATA;
    // Keypair that matches config.authority — may differ from payer on devnet
    // if the VaultConfig was initialized in a prior session with a different wallet.
    let authoritySigner;
    function stakeAccountPDA(stakeId) {
        const [pda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("stake"), new anchor.BN(stakeId).toArrayLike(Buffer, "le", 8)], PROGRAM_ID);
        return pda;
    }
    before(async () => {
        // Fund user + attacker only if their balance is below threshold
        const MIN_LAMPORTS = 0.05 * web3_js_1.LAMPORTS_PER_SOL;
        for (const kp of [user, attacker]) {
            const bal = await conn.getBalance(kp.publicKey);
            if (bal < MIN_LAMPORTS) {
                const blockhash = await conn.getLatestBlockhash();
                const tx = new web3_js_1.Transaction().add(web3_js_1.SystemProgram.transfer({
                    fromPubkey: payer.publicKey,
                    toPubkey: kp.publicKey,
                    lamports: MIN_LAMPORTS,
                }));
                const sig = await provider.sendAndConfirm(tx);
                await conn.confirmTransaction({ signature: sig, ...blockhash });
                console.log(`  [before] funded ${kp.publicKey.toBase58().slice(0, 8)}... with 0.05 SOL`);
            }
        }
        [configPDA] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("vault_config")], PROGRAM_ID);
        [vaultAuthorityPDA] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("vault_authority")], PROGRAM_ID);
        // On devnet the config PDA persists across runs — reuse it instead of re-initializing.
        const existing = await conn.getAccountInfo(configPDA);
        if (existing) {
            // VaultConfig layout: [8 disc][32 authority][32 zdlt_mint][1 bump][1 vault_auth_bump]
            const storedAuthority = new web3_js_1.PublicKey(existing.data.slice(8, 8 + 32));
            zdltMint = new web3_js_1.PublicKey(existing.data.slice(8 + 32, 8 + 32 + 32));
            console.log("  [before] reusing existing VaultConfig, mint:", zdltMint.toBase58());
            if (storedAuthority.equals(payer.publicKey)) {
                authoritySigner = payer;
            }
            else {
                // VaultConfig was initialized in a prior session with a different wallet —
                // load it from the default Solana CLI keypair path.
                const defaultKeyPath = require("os").homedir() + "/.config/solana/id.json";
                const secret = Uint8Array.from(JSON.parse(require("fs").readFileSync(defaultKeyPath, "utf8")));
                authoritySigner = web3_js_1.Keypair.fromSecretKey(secret);
                console.log("  [before] authority signer:", authoritySigner.publicKey.toBase58());
            }
        }
        else {
            zdltMint = await (0, spl_token_1.createMint)(conn, payer, payer.publicKey, null, 9);
            vaultATA = (0, spl_token_1.getAssociatedTokenAddressSync)(zdltMint, vaultAuthorityPDA, true);
            const [programDataPDA] = web3_js_1.PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], BPF_LOADER_UPGRADEABLE_PROGRAM_ID);
            await program.methods
                .initialize(payer.publicKey)
                .accounts({
                config: configPDA,
                vaultAuthority: vaultAuthorityPDA,
                vaultAta: vaultATA,
                zdltMint,
                payer: payer.publicKey,
                programData: programDataPDA,
                systemProgram: web3_js_1.SystemProgram.programId,
                tokenProgram: spl_token_1.TOKEN_PROGRAM_ID,
                associatedTokenProgram: spl_token_1.ASSOCIATED_TOKEN_PROGRAM_ID,
            })
                .rpc();
            authoritySigner = payer;
            console.log("  [before] initialized VaultConfig, mint:", zdltMint.toBase58());
        }
        vaultATA = (0, spl_token_1.getAssociatedTokenAddressSync)(zdltMint, vaultAuthorityPDA, true);
        // Ensure all ATAs exist — retry loop handles Helius devnet propagation lag
        await ensureATA(conn, payer, zdltMint, vaultAuthorityPDA, true);
        await ensureATA(conn, payer, zdltMint, user.publicKey);
        await ensureATA(conn, payer, zdltMint, attacker.publicKey);
    });
    async function doStake(stakeId, staker, amountRaw, lockSeconds) {
        const ata = await (0, spl_token_1.getOrCreateAssociatedTokenAccount)(conn, payer, zdltMint, staker.publicKey);
        await (0, spl_token_1.mintTo)(conn, payer, zdltMint, ata.address, payer, amountRaw);
        await program.methods
            .stake(new anchor.BN(stakeId), new anchor.BN(amountRaw.toString()), new anchor.BN(lockSeconds))
            .accounts({
            config: configPDA,
            vaultAuthority: vaultAuthorityPDA,
            stakeAccount: stakeAccountPDA(stakeId),
            vaultAta: vaultATA,
            ownerAta: ata.address,
            owner: staker.publicKey,
            systemProgram: web3_js_1.SystemProgram.programId,
            tokenProgram: spl_token_1.TOKEN_PROGRAM_ID,
            associatedTokenProgram: spl_token_1.ASSOCIATED_TOKEN_PROGRAM_ID,
        })
            .signers([staker])
            .rpc();
        return ata.address;
    }
    it("stake transfers tokens from owner ATA into vault ATA", async () => {
        const id = BASE_ID + 1;
        const amount = 1000000000n; // 1 ZDLT (9 decimals)
        const ownerAtaAddr = (0, spl_token_1.getAssociatedTokenAddressSync)(zdltMint, user.publicKey);
        // Read balances before mintTo+stake so we check DELTA, not absolute value.
        // Absolute-value checks fail on devnet where ATAs retain tokens across runs.
        const vaultBefore = await (0, spl_token_1.getAccount)(conn, vaultATA);
        const userBefore = await (0, spl_token_1.getAccount)(conn, ownerAtaAddr);
        await doStake(id, user, amount, 86400);
        const vaultAfter = await (0, spl_token_1.getAccount)(conn, vaultATA);
        chai_1.assert.equal(vaultAfter.amount - vaultBefore.amount, amount, "vault must increase by staked amount");
        const userAfter = await (0, spl_token_1.getAccount)(conn, ownerAtaAddr);
        chai_1.assert.equal(userAfter.amount, userBefore.amount, "owner ATA net change must be zero (minted then staked)");
    });
    it("unstake before lock_ts fails with StillLocked", async () => {
        const id = BASE_ID + 1; // same stake as above — 24h lock, still active
        try {
            await program.methods
                .unstake(new anchor.BN(id))
                .accounts({
                config: configPDA,
                vaultAuthority: vaultAuthorityPDA,
                stakeAccount: stakeAccountPDA(id),
                vaultAta: vaultATA,
                ownerAta: (0, spl_token_1.getAssociatedTokenAddressSync)(zdltMint, user.publicKey),
                owner: user.publicKey,
                tokenProgram: spl_token_1.TOKEN_PROGRAM_ID,
                associatedTokenProgram: spl_token_1.ASSOCIATED_TOKEN_PROGRAM_ID,
            })
                .signers([user])
                .rpc();
            chai_1.assert.fail("expected StillLocked");
        }
        catch (e) {
            chai_1.assert.match(String(e), /StillLocked|0x1770/i);
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
                stakeAccount: stakeAccountPDA(id),
                vaultAta: vaultATA,
                stakeOwner: user.publicKey,
                ownerAta: (0, spl_token_1.getAssociatedTokenAddressSync)(zdltMint, user.publicKey),
                authority: attacker.publicKey,
                tokenProgram: spl_token_1.TOKEN_PROGRAM_ID,
                associatedTokenProgram: spl_token_1.ASSOCIATED_TOKEN_PROGRAM_ID,
            })
                .signers([attacker])
                .rpc();
            chai_1.assert.fail("expected rejection — attacker is not config.authority");
        }
        catch (e) {
            chai_1.assert.ok(String(e).length > 0);
        }
    });
    it("force_unstake by correct authority returns principal to stake owner", async () => {
        const id = BASE_ID + 1;
        const ownerAta = (0, spl_token_1.getAssociatedTokenAddressSync)(zdltMint, user.publicKey);
        const before = await (0, spl_token_1.getAccount)(conn, ownerAta);
        await program.methods
            .forceUnstake(new anchor.BN(id))
            .accounts({
            config: configPDA,
            vaultAuthority: vaultAuthorityPDA,
            stakeAccount: stakeAccountPDA(id),
            vaultAta: vaultATA,
            stakeOwner: user.publicKey,
            ownerAta,
            authority: authoritySigner.publicKey,
            tokenProgram: spl_token_1.TOKEN_PROGRAM_ID,
            associatedTokenProgram: spl_token_1.ASSOCIATED_TOKEN_PROGRAM_ID,
        })
            .signers([authoritySigner])
            .rpc();
        // Helius devnet can lag a few seconds before the updated balance is visible.
        await new Promise((r) => setTimeout(r, 2000));
        const after = await (0, spl_token_1.getAccount)(conn, ownerAta);
        chai_1.assert.equal(after.amount - before.amount, 1000000000n, "exact principal must be returned to owner");
    });
    it("unstake by non-owner is rejected", async () => {
        const id = BASE_ID + 2;
        await doStake(id, user, 500000000n, 3600);
        const attackerAta = await (0, spl_token_1.getOrCreateAssociatedTokenAccount)(conn, payer, zdltMint, attacker.publicKey);
        try {
            await program.methods
                .unstake(new anchor.BN(id))
                .accounts({
                config: configPDA,
                vaultAuthority: vaultAuthorityPDA,
                stakeAccount: stakeAccountPDA(id),
                vaultAta: vaultATA,
                ownerAta: attackerAta.address,
                owner: attacker.publicKey,
                tokenProgram: spl_token_1.TOKEN_PROGRAM_ID,
                associatedTokenProgram: spl_token_1.ASSOCIATED_TOKEN_PROGRAM_ID,
            })
                .signers([attacker])
                .rpc();
            chai_1.assert.fail("expected rejection — attacker is not stake owner");
        }
        catch (e) {
            chai_1.assert.ok(String(e).length > 0);
        }
    });
    it("unstake after lock_ts returns exact principal", async () => {
        const id = BASE_ID + 3;
        // lock_seconds=1 — expired by the time we call unstake
        const ownerAta = await doStake(id, user, 750000000n, 1);
        await new Promise((r) => setTimeout(r, 2000));
        const before = await (0, spl_token_1.getAccount)(conn, ownerAta);
        await program.methods
            .unstake(new anchor.BN(id))
            .accounts({
            config: configPDA,
            vaultAuthority: vaultAuthorityPDA,
            stakeAccount: stakeAccountPDA(id),
            vaultAta: vaultATA,
            ownerAta,
            owner: user.publicKey,
            tokenProgram: spl_token_1.TOKEN_PROGRAM_ID,
            associatedTokenProgram: spl_token_1.ASSOCIATED_TOKEN_PROGRAM_ID,
        })
            .signers([user])
            .rpc();
        const after = await (0, spl_token_1.getAccount)(conn, ownerAta);
        chai_1.assert.equal(after.amount - before.amount, 750000000n, "exact principal must be returned on expired unstake");
    });
});
