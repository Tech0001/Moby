import { createHash, createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import { base58, bech32 } from '@scure/base';
import { Wallet, Mnemonic, HDNodeWallet } from 'ethers';
import * as bitcoin from 'bitcoinjs-lib';
import ECPairFactory from 'ecpair';
import * as ecc from 'tiny-secp256k1';
import { Wallet as XrpWallet } from 'xrpl';
import { Keypair as StellarKeypair } from '@stellar/stellar-sdk';
import algosdk from 'algosdk';
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
  mnemonic?: string; // Seed phrase (if available for the chain)
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
  // Generate from mnemonic so we have both seed phrase and private key
  const mnemonic = Mnemonic.fromEntropy(Wallet.createRandom().privateKey);
  const wallet = HDNodeWallet.fromMnemonic(mnemonic);
  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
    mnemonic: mnemonic.phrase,
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

export function solanaWalletFromSeed(seed: Uint8Array): GeneratedWallet {
  if (seed.length !== 32) throw new Error('An Ed25519 seed must have 32 bytes');
  // RFC 8410 PKCS#8 wraps the Ed25519 seed; OpenSSL derives the matching public key.
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(key).export({ format: 'jwk' });
  const publicBytes = Buffer.from(publicKey.x!, 'base64url');
  return { address: base58.encode(publicBytes), privateKey: Buffer.concat([Buffer.from(seed), publicBytes]).toString('hex') };
}

function generateSolanaWallet(): GeneratedWallet {
  return solanaWalletFromSeed(randomBytes(32));
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
    privateKey: Buffer.from(account.sk).toString('hex'),
    mnemonic: algosdk.secretKeyToMnemonic(account.sk),
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

export function luncWalletFromMnemonic(mnemonic: string): GeneratedWallet {
  // Terra Classic's existing derivation path and compressed-key address format.
  const wallet = HDNodeWallet.fromPhrase(mnemonic, '', "m/44'/330'/0'/0/0");
  const sha = createHash('sha256').update(Buffer.from(wallet.publicKey.slice(2), 'hex')).digest();
  const addressBytes = createHash('ripemd160').update(sha).digest();
  return { address: bech32.encode('terra', bech32.toWords(addressBytes)), privateKey: wallet.privateKey.slice(2), mnemonic };
}

function generateLuncWallet(): GeneratedWallet {
  return luncWalletFromMnemonic(Mnemonic.fromEntropy(randomBytes(32)).phrase);
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
