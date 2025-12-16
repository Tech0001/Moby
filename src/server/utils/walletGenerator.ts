import { Wallet } from 'ethers';
import * as bitcoin from 'bitcoinjs-lib';
import ECPairFactory from 'ecpair';
import * as ecc from 'tiny-secp256k1';
import { Keypair as SolanaKeypair } from '@solana/web3.js';
import { Wallet as XrpWallet } from 'xrpl';
import { Keypair as StellarKeypair } from '@stellar/stellar-sdk';
import algosdk from 'algosdk';
import { MnemonicKey } from '@terra-money/terra.js';
import type { WalletChain } from '../db/repositories.js';

// Dynamic import for Cardano (it's a native module)
let CardanoWasm: typeof import('@emurgo/cardano-serialization-lib-nodejs') | null = null;
async function getCardanoWasm() {
  if (!CardanoWasm) {
    CardanoWasm = await import('@emurgo/cardano-serialization-lib-nodejs');
  }
  return CardanoWasm;
}

const ECPair = ECPairFactory(ecc);

export interface GeneratedWallet {
  address: string;
  privateKey: string;
}

/**
 * Generate a wallet for the specified blockchain
 */
export async function generateWallet(chain: WalletChain): Promise<GeneratedWallet> {
  switch (chain) {
    case 'ethereum':
      return generateEthereumWallet();
    case 'bitcoin':
      return generateBitcoinWallet();
    case 'solana':
      return generateSolanaWallet();
    case 'xrp':
      return generateXrpWallet();
    case 'xlm':
      return generateStellarWallet();
    case 'algorand':
      return generateAlgorandWallet();
    case 'cardano':
      return generateCardanoWallet();
    case 'lunc':
      return generateLuncWallet();
    default:
      throw new Error(`Unsupported chain: ${chain}`);
  }
}

function generateEthereumWallet(): GeneratedWallet {
  const wallet = Wallet.createRandom();
  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
  };
}

function generateBitcoinWallet(): GeneratedWallet {
  const keyPair = ECPair.makeRandom();
  const { address } = bitcoin.payments.p2pkh({ pubkey: Buffer.from(keyPair.publicKey) });

  if (!address) {
    throw new Error('Failed to generate Bitcoin address');
  }

  return {
    address,
    privateKey: keyPair.toWIF(),
  };
}

function generateSolanaWallet(): GeneratedWallet {
  const keypair = SolanaKeypair.generate();
  return {
    address: keypair.publicKey.toBase58(),
    privateKey: Buffer.from(keypair.secretKey).toString('hex'),
  };
}

function generateXrpWallet(): GeneratedWallet {
  const wallet = XrpWallet.generate();
  return {
    address: wallet.classicAddress,
    privateKey: wallet.privateKey,
  };
}

function generateStellarWallet(): GeneratedWallet {
  const keypair = StellarKeypair.random();
  return {
    address: keypair.publicKey(),
    privateKey: keypair.secret(),
  };
}

function generateAlgorandWallet(): GeneratedWallet {
  const account = algosdk.generateAccount();
  return {
    address: account.addr.toString(),
    privateKey: algosdk.secretKeyToMnemonic(account.sk),
  };
}

async function generateCardanoWallet(): Promise<GeneratedWallet> {
  const wasm = await getCardanoWasm();

  // Generate entropy and create root key
  const entropy = wasm.Bip32PrivateKey.generate_ed25519_bip32();

  // Derive account key using standard Cardano derivation path
  // m/1852'/1815'/0' (purpose/coin_type/account)
  const accountKey = entropy
    .derive(harden(1852))
    .derive(harden(1815))
    .derive(harden(0));

  // Derive external chain (receiving addresses) m/1852'/1815'/0'/0/0
  const utxoPubKey = accountKey
    .derive(0)
    .derive(0)
    .to_public();

  // Derive staking key for base address
  const stakePubKey = accountKey
    .derive(2)
    .derive(0)
    .to_public();

  // Create base address (mainnet)
  const baseAddr = wasm.BaseAddress.new(
    wasm.NetworkInfo.mainnet().network_id(),
    wasm.Credential.from_keyhash(utxoPubKey.to_raw_key().hash()),
    wasm.Credential.from_keyhash(stakePubKey.to_raw_key().hash())
  );

  return {
    address: baseAddr.to_address().to_bech32(),
    privateKey: Buffer.from(entropy.as_bytes()).toString('hex'),
  };
}

// Helper for Cardano hardened derivation
function harden(num: number): number {
  return 0x80000000 + num;
}

function generateLuncWallet(): GeneratedWallet {
  // Generate a new mnemonic key for Terra/LUNC
  const mk = new MnemonicKey();

  return {
    address: mk.accAddress, // Terra Classic address (property, not method)
    privateKey: mk.mnemonic, // Store mnemonic as private key
  };
}

/**
 * Check if a chain is supported for wallet generation
 */
export function isChainSupported(chain: WalletChain): boolean {
  const supported: WalletChain[] = ['ethereum', 'bitcoin', 'solana', 'xrp', 'xlm', 'algorand', 'cardano', 'lunc'];
  return supported.includes(chain);
}

/**
 * Get list of supported chains
 */
export function getSupportedChains(): WalletChain[] {
  return ['ethereum', 'bitcoin', 'solana', 'xrp', 'xlm', 'algorand', 'cardano', 'lunc'];
}
