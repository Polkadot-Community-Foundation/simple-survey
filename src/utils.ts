import { useState, useRef, useEffect } from "react";
import { createClient, type PolkadotClient, type PolkadotSigner, Binary } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/web";
import { withPolkadotSdkCompat } from "polkadot-api/polkadot-sdk-compat";
import { createInkSdk, type InkSdk } from "@polkadot-api/sdk-ink";
import { getPolkadotSigner } from "polkadot-api/signer";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import {
    entropyToMiniSecret,
    mnemonicToEntropy,
    ss58Encode,
    ss58Decode,
} from "@polkadot-labs/hdkd-helpers";
import { bulletin } from "@polkadot-api/descriptors";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import type { MultihashDigest } from "multiformats/hashes/interface";
import { blake2b } from "@noble/hashes/blake2.js";

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

export type Signer = PolkadotSigner;

export interface Wallet {
    signer: Signer;
    address: string;
}

export function deriveWallet(mnemonic: string): Wallet {
    const entropy = mnemonicToEntropy(mnemonic);
    const miniSecret = entropyToMiniSecret(entropy);
    const derive = sr25519CreateDerive(miniSecret);
    const kp = derive("//0");
    return {
        signer: getPolkadotSigner(kp.publicKey, "Sr25519", kp.sign),
        address: ss58Encode(kp.publicKey, 42),
    };
}

// ---------------------------------------------------------------------------
// Host API (Polkadot Browser / Desktop)
// ---------------------------------------------------------------------------

export interface HostAccount {
    name: string;
    address: string;
    ethAddress: string;
    signer: PolkadotSigner;
}

export function isInHost(): boolean {
    if (typeof window === "undefined") return false;
    if ((window as any).__HOST_WEBVIEW_MARK__ === true) return true;
    try {
        if (window !== window.top) return true;
    } catch {
        return true;
    }
    return false;
}

let _spektrReady = false;

async function connectToHost(maxRetries = 10, delayMs = 500): Promise<boolean> {
    if (!isInHost()) return false;
    if (_spektrReady) return true;

    const { injectSpektrExtension } = await import("@novasamatech/product-sdk");

    for (let i = 0; i < maxRetries; i++) {
        try {
            console.log(`[HostAPI] Connect attempt ${i + 1}/${maxRetries}...`);
            const ready = await injectSpektrExtension();
            if (ready) {
                _spektrReady = true;
                console.log("[HostAPI] Spektr extension injected");
                return true;
            }
        } catch (e: any) {
            console.log(`[HostAPI] Attempt ${i + 1} error:`, e?.message || e);
        }
        if (i < maxRetries - 1) {
            await new Promise(r => setTimeout(r, delayMs));
        }
    }
    console.log("[HostAPI] Failed to connect after all retries");
    return false;
}

async function getHostAccounts(): Promise<HostAccount[]> {
    const { SpektrExtensionName } = await import("@novasamatech/product-sdk");
    const { connectInjectedExtension } = await import("polkadot-api/pjs-signer");

    const injected = (window as any).injectedWeb3;
    if (!injected?.[SpektrExtensionName]) {
        console.log("[HostAPI] Spektr not found in injectedWeb3");
        return [];
    }

    const extension = await Promise.race([
        connectInjectedExtension(SpektrExtensionName),
        new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Timed out after 15s")), 15000)
        ),
    ]);

    console.log("[HostAPI] Extension connected:", extension.name);
    const accounts = extension.getAccounts();
    console.log(`[HostAPI] Got ${accounts.length} account(s)`);

    return accounts.map(acc => {
        const ethAddress = ss58ToEthAddress(acc.address);
        console.log("[HostAPI] Account:", acc.name, "SS58:", acc.address, "ETH:", ethAddress);
        return {
            name: acc.name || "Host Account",
            address: acc.address,
            ethAddress,
            signer: acc.polkadotSigner,
        };
    });
}

export function useHostAccount(): { hostAccounts: HostAccount[]; loading: boolean } {
    const [hostAccounts, setHostAccounts] = useState<HostAccount[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!isInHost()) {
            console.log("[HostAPI] Not inside a container, skipping host account");
            setLoading(false);
            return;
        }

        (async () => {
            try {
                const connected = await connectToHost();
                if (!connected) { setLoading(false); return; }

                const accounts = await getHostAccounts();
                setHostAccounts(accounts);
            } catch (err) {
                console.warn("[HostAPI] Error:", err);
            } finally {
                setLoading(false);
            }
        })();
    }, []);

    return { hostAccounts, loading };
}

// ---------------------------------------------------------------------------
// Dev accounts (pre-funded on Paseo)
// ---------------------------------------------------------------------------

export const ACCOUNTS = [
    { name: "Alice",   mnemonic: "glimpse final adapt peanut entire ring lift eager mansion orchard silent grunt",   ethAddress: "0xbe1cc67438e4970ee97132721e4cec7738322fef" },
    { name: "Bob",     mnemonic: "match edit thunder foil inner tobacco drift exchange jealous short nuclear mandate",   ethAddress: "0x782f1d6bd00193565dae42a8c4cfcdc21257c564" },
    { name: "Charlie", mnemonic: "what reunion black exit find often month force envelope network connect oppose",      ethAddress: "0xdc9e7641f75f1fb3c4047da5513c33828d00b8b2" },
    { name: "Dave",    mnemonic: "novel soup ginger cereal toilet paper merge upset pottery void impulse visit",        ethAddress: "0x53e4ad30596ae0c00cf17837802fc35112bb3804" },
    { name: "Eve",     mnemonic: "reform lamp logic rare cup hood face caution sun park prison wall",                   ethAddress: "0x63de7f7d9e75a6923c1b470966e049321c2aba86" },
];

// ---------------------------------------------------------------------------
// Chain clients — host provider in container, direct WS standalone
// ---------------------------------------------------------------------------

const ASSET_HUB_URL = "wss://asset-hub-paseo-rpc.n.dwellir.com";
const BULLETIN_URL = "wss://paseo-bulletin-rpc.polkadot.io";
const PASEO_ASSET_HUB_GENESIS = "0xd6eec26135305a8ad257a20d003357284c8aa03d0bdb2b357ab0a22371e11ef2" as `0x${string}`;
const BULLETIN_GENESIS = "0x744960c32e3a3df5440e1ecd4d34096f1ce2230d7016a5ada8a765d5a622b4ea" as `0x${string}`;

let _assetHubClient: PolkadotClient | null = null;
let _bulletinClient: PolkadotClient | null = null;
let _inkSdk: InkSdk | null = null;

export async function getAssetHubClient(): Promise<PolkadotClient> {
    if (_assetHubClient) return _assetHubClient;
    if (isInHost()) {
        const { createPapiProvider } = await import("@novasamatech/product-sdk");
        _assetHubClient = createClient(createPapiProvider(PASEO_ASSET_HUB_GENESIS));
        console.log("[Chain] Asset Hub client via host provider");
    } else {
        _assetHubClient = createClient(withPolkadotSdkCompat(getWsProvider(ASSET_HUB_URL)));
        console.log("[Chain] Asset Hub client via direct WS");
    }
    return _assetHubClient;
}

async function getBulletinClient(): Promise<PolkadotClient> {
    if (_bulletinClient) return _bulletinClient;
    // Bulletin chain is not supported by host provider — always use direct WS
    _bulletinClient = createClient(getWsProvider(BULLETIN_URL));
    console.log("[Chain] Bulletin client via direct WS");
    return _bulletinClient;
}

export async function getInkSdk(): Promise<InkSdk> {
    if (_inkSdk) return _inkSdk;
    const client = await getAssetHubClient();
    _inkSdk = createInkSdk(client);
    console.log("[Chain] InkSdk created");
    return _inkSdk;
}

// ---------------------------------------------------------------------------
// Contract — survey contract handle via InkSdk
// ---------------------------------------------------------------------------

import cdmJson from "../cdm.json";

const CONTRACT_ADDRESS = cdmJson.contracts["acc2c3b5e912b762"]["@example/surveys"].address.toLowerCase();
const CONTRACT_ABI = cdmJson.contracts["acc2c3b5e912b762"]["@example/surveys"].abi;

let _surveyContract: any = null;

export async function getSurveyContract(): Promise<any> {
    if (_surveyContract) return _surveyContract;
    const sdk = await getInkSdk();
    _surveyContract = sdk.getContract({ abi: CONTRACT_ABI } as any, CONTRACT_ADDRESS as `0x${string}`);
    console.log("[Chain] Survey contract handle created at", CONTRACT_ADDRESS);
    return _surveyContract;
}

// ---------------------------------------------------------------------------
// Bulletin upload
// ---------------------------------------------------------------------------

// Calculate CID locally (same as chain does — blake2b-256 + CIDv1 raw)
function calculateCID(bytes: Uint8Array): string {
    const BLAKE2B_256_CODE = 0xb220;
    const hash = blake2b(bytes, { dkLen: 32 });

    function encodeVarint(value: number): Uint8Array {
        const buf: number[] = [];
        let n = value;
        while (n >= 0x80) { buf.push((n & 0x7f) | 0x80); n >>= 7; }
        buf.push(n & 0x7f);
        return new Uint8Array(buf);
    }

    const codeBytes = encodeVarint(BLAKE2B_256_CODE);
    const lengthBytes = encodeVarint(hash.length);
    const multihashBytes = new Uint8Array(codeBytes.length + lengthBytes.length + hash.length);
    multihashBytes.set(codeBytes, 0);
    multihashBytes.set(lengthBytes, codeBytes.length);
    multihashBytes.set(hash, codeBytes.length + lengthBytes.length);

    const digest: MultihashDigest = {
        code: BLAKE2B_256_CODE,
        size: hash.length,
        bytes: multihashBytes,
        digest: hash,
    };

    return CID.createV1(raw.code, digest).toString();
}

export async function publishBlob(bytes: Uint8Array, signer: Signer): Promise<string> {
    console.log("[Bulletin] Starting upload, %d bytes...", bytes.length);

    // Calculate CID locally first (deterministic — same result as chain)
    const cid = calculateCID(bytes);
    console.log("[Bulletin] Computed CID locally:", cid);

    if (isInHost()) {
        // Use host preimage API — host handles signing + chain connection
        console.log("[Bulletin] Uploading via host preimage API...");
        const { preimageManager } = await import("@novasamatech/product-sdk");
        const hashKey = await preimageManager.submit(bytes);
        console.log("[Bulletin] Preimage submitted, hash:", hashKey);
        console.log("[Bulletin] Upload complete. CID:", cid);
        return cid;
    }

    // Direct WebSocket + signer for standalone mode
    console.log("[Bulletin] Uploading via direct WS...");
    const client = await getBulletinClient();
    const api = client.getTypedApi(bulletin);

    const result = await api.tx.TransactionStorage.store({
        data: Binary.fromBytes(bytes),
    }).signAndSubmit(signer);
    console.log("[Bulletin] Transaction submitted, events:", result.events?.length);

    const stored = api.event.TransactionStorage.Stored.filter(result.events);
    if (!stored.length || !stored[0].cid) {
        console.error("[Bulletin] Upload failed — no Stored event found");
        throw new Error("Upload failed");
    }
    const chainCid = CID.decode(stored[0].cid.asBytes()).toString();
    console.log("[Bulletin] Upload complete. CID:", chainCid);
    return chainCid;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const IPFS_GATEWAY = "https://paseo-ipfs.polkadot.io/ipfs/";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const short = (addr: string) => addr.slice(0, 6) + "..." + addr.slice(-4);

export function ss58ToEthAddress(ss58Address: string): string {
    const publicKey = ss58Decode(ss58Address)[0];
    const evmBytes = publicKey.slice(0, 20);
    return "0x" + [...evmBytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

export function useIntersectionObserver(
    onIntersect: () => void,
    enabled: boolean,
) {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const el = ref.current;
        if (!el || !enabled) return;
        const observer = new IntersectionObserver(
            ([entry]) => { if (entry.isIntersecting) onIntersect(); },
            { threshold: 0.1 },
        );
        observer.observe(el);
        return () => observer.disconnect();
    }, [onIntersect, enabled]);

    return ref;
}
