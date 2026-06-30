import * as anchor from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";

const PROGRAM_ID = new PublicKey("ZDLT3oh8VxZJcSTxi1LgG4GqMsiF4jFrQho6hnJj5Gy");
const ZDLT_MINT = new PublicKey("4PX31xRA1BaAyb2Js45ZKYp92VGWGp47yWeVs5CGVKbf");
const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

async function main() {
  const keypairPath = process.env.KEYPAIR ?? os.homedir() + "/.config/solana/mainnet-authority.json";
  const secret = Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf8")));
  const payer = Keypair.fromSecretKey(secret);

  const rpcUrl = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const connection = new anchor.web3.Connection(rpcUrl, "confirmed");
  const wallet = new anchor.Wallet(payer);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const IDL = JSON.parse(fs.readFileSync(__dirname + "/../target/idl/zdlt_seeker_staking.json", "utf8"));
  const program = new anchor.Program(IDL, provider);

  const [configPDA] = PublicKey.findProgramAddressSync([Buffer.from("vault_config")], PROGRAM_ID);
  const [vaultAuthorityPDA] = PublicKey.findProgramAddressSync([Buffer.from("vault_authority")], PROGRAM_ID);
  const [programDataPDA] = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], BPF_LOADER_UPGRADEABLE);
  const vaultATA = getAssociatedTokenAddressSync(ZDLT_MINT, vaultAuthorityPDA, true);

  // authority = backend API wallet (gates force_unstake), intentionally
  // separate from the upgrade authority wallet (payer) above.
  const authority = new PublicKey("EHBbdoqVs7KYXCXWDxyue8iKZifcvAxPQL7xSyEHdxDe");

  console.log("Payer (upgrade authority):", payer.publicKey.toBase58());
  console.log("Config PDA:               ", configPDA.toBase58());
  console.log("Vault authority PDA:      ", vaultAuthorityPDA.toBase58());
  console.log("Vault ATA:                ", vaultATA.toBase58());
  console.log("ZDLT Mint:                ", ZDLT_MINT.toBase58());
  console.log("Program data:             ", programDataPDA.toBase58());
  console.log("Authority (config):       ", authority.toBase58());
  console.log("");

  const existing = await connection.getAccountInfo(configPDA);
  if (existing) {
    console.log("VaultConfig sudah ada — initialize tidak perlu diulang.");
    return;
  }

  console.log("Memanggil initialize...");
  const sig = await program.methods
    .initialize(authority)
    .accounts({
      config: configPDA,
      vaultAuthority: vaultAuthorityPDA,
      vaultAta: vaultATA,
      zdltMint: ZDLT_MINT,
      payer: payer.publicKey,
      programData: programDataPDA,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    })
    .rpc();

  console.log("Berhasil! Signature:", sig);
  console.log("Vault ATA:", vaultATA.toBase58());
}

main().catch((e) => { console.error(e); process.exit(1); });
