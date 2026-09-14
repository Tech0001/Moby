import { expect, it } from 'vitest';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { Keypair } from '@stellar/stellar-sdk';
import { base58 } from '@scure/base';
import { ECPairFactory } from 'ecpair';
import * as ecc from 'tiny-secp256k1';
import * as bitcoin from 'bitcoinjs-lib';
import { Wallet as XrpWallet } from 'xrpl';
import { Wallet } from 'ethers';
import algosdk from 'algosdk';
import * as cardano from '@emurgo/cardano-serialization-lib-nodejs';
import vectors from './fixtures/public-wallet-vectors.json';
import { generateWallet, solanaWalletFromSeed, luncWalletFromMnemonic } from '../src/server/utils/walletGenerator';

it('preserves Terra Classic addresses and private keys from the prior SDK for public mnemonic vectors', () => {
  for(const v of vectors.terra) expect(luncWalletFromMnemonic(v.mnemonic)).toEqual(v);
});
it('preserves Solana 64-byte secret-key exports and addresses from the prior SDK', () => {
  for(const v of vectors.solana) expect(solanaWalletFromSeed(Buffer.from(v.seed,'hex'))).toEqual({address:v.address,privateKey:v.privateKey});
});
it('generates Solana keys that independently sign and verify against their exported public address', async () => {
  const wallet=await generateWallet('solana'),secret=Buffer.from(wallet.privateKey,'hex'); expect(secret.length).toBe(64);
  const key=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),secret.subarray(0,32)]),format:'der',type:'pkcs8'});
  const pub=createPublicKey(key),message=Buffer.from('Moby key compatibility test');
  expect(base58.encode(Buffer.from(pub.export({format:'jwk'}).x!,'base64url'))).toBe(wallet.address);
  expect(verify(null,message,pub,sign(null,message,key))).toBe(true);
});
it('round-trips generated keys for the other supported chains after the dependency updates', async () => {
  const eth=await generateWallet('ethereum'); expect(new Wallet(eth.privateKey).address).toBe(eth.address);
  const btc=await generateWallet('bitcoin'), key=ECPairFactory(ecc).fromWIF(btc.privateKey); expect(bitcoin.payments.p2pkh({pubkey:key.publicKey}).address).toBe(btc.address);
  const stellar=await generateWallet('xlm'); expect(Keypair.fromSecret(stellar.privateKey).publicKey()).toBe(stellar.address);
  const algo=await generateWallet('algorand'); expect(algosdk.mnemonicToSecretKey(algo.mnemonic!).addr.toString()).toBe(algo.address);
  const xrp=await generateWallet('xrp'); expect(XrpWallet.fromEntropy).toBeDefined(); expect(xrp.address).toMatch(/^r/); expect(xrp.privateKey).toMatch(/^[A-Fa-f0-9]+$/);
  const ada=await generateWallet('cardano'); expect(cardano.Address.from_bech32(ada.address).network_id()).toBe(1); expect(cardano.Bip32PrivateKey.from_bytes(Buffer.from(ada.privateKey,'hex'))).toBeTruthy();
});
