import { useState, useEffect } from "react";
import {
    createAccountsProvider,
    preimageManager,
    requestPermission,
    createPapiProvider,
    sandboxTransport,
    type ProductAccount,
} from "@novasamatech/host-api-wrapper";
import { RequestCredentialsErr } from "@novasamatech/host-api";
import { ContractManager, ensureContractAccountMapped } from "@parity/product-sdk-contracts";
import { summit_asset_hub } from "@parity/product-sdk-descriptors/summit-asset-hub";
import { ss58ToH160 } from "@parity/product-sdk-address";
import { createClient, AccountId, type PolkadotSigner } from "polkadot-api";
import { getWsProvider } from "@polkadot-api/ws-provider";
import { blake2b } from "@noble/hashes/blake2.js";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import type { MultihashDigest } from "multiformats/hashes/interface";

const CONTRACT_KEY = "@polkadot/surveys";

// Summit Asset Hub (W3S) — the CDM registry and this contract live here.
// Genesis + RPC per guides/CDM_DEPLOYMENT_GUIDE.md; descriptor = summit_asset_hub.
const SUMMIT_ASSET_HUB_GENESIS = "0xf388dc6d6cdf6fb77eac3c4a91f31bc0c8642b142f1a757512ab7849f9f70660" as const;
const SUMMIT_ASSET_HUB_WS = "wss://summit-asset-hub-rpc.polkadot.io";

// ---------------------------------------------------------------------------
// Permissions (RFC-0002)
// ---------------------------------------------------------------------------

const _grantedPermissions = new Set<string>();

async function ensurePermission(tag: "ChainSubmit" | "PreimageSubmit" | "StatementSubmit") {
    if (_grantedPermissions.has(tag)) return;
    try {
        const result = await requestPermission({ tag, value: undefined });
        if (result.isOk() && result.value) {
            _grantedPermissions.add(tag);
            console.log(`[Permission] ${tag} granted`);
        } else {
            console.warn(`[Permission] ${tag} denied`, result.isErr() ? result.error : "user rejected");
        }
    } catch (err) {
        console.warn(`[Permission] ${tag} request failed:`, err);
    }
}

// ---------------------------------------------------------------------------
// Account flow — direct against product-sdk (matches t3rminal / RPS pattern).
// ---------------------------------------------------------------------------

const accountsProvider = createAccountsProvider(sandboxTransport);
const accountIdCodec = AccountId();

/**
 * Identifier the host uses to scope our product. Polkadot Desktop ≥ 0.7.5
 * accepts the raw `window.location.host` for both `.dot` domains and
 * `localhost:PORT`; the signing permission check matches the identifier
 * against that same host context, so we use it verbatim.
 */
function getProductIdentifier(): string | null {
    if (typeof window === "undefined") return null;
    return window.location.host || null;
}

export function getAppAccountId(): [string, number] {
    const identifier = getProductIdentifier() ?? "survey.dot";
    return [identifier, 0];
}

export interface AppAccount {
    /** SS58 string derived from the host's product public key. */
    address: string;
    /** EVM-style H160 (keccak256(publicKey).slice(12)) — what Revive + bytes20/address args expect. */
    h160Address: string;
    /** 32-byte sr25519 public key. */
    publicKey: Uint8Array;
    name: string | null;
    signer: PolkadotSigner;
    productAccountId: [string, number];
    productAccount: ProductAccount;
    getSigner(): PolkadotSigner;
}

interface AccountState {
    status: "idle" | "connecting" | "ready" | "signed-out" | "error";
    account: AppAccount | null;
    error?: string;
}

let _state: AccountState = { status: "idle", account: null };
const _listeners = new Set<(s: AccountState) => void>();

function setState(next: AccountState) {
    _state = next;
    for (const cb of _listeners) cb(next);
}

export function useAccountState(): AccountState {
    const [state, set] = useState<AccountState>(_state);
    useEffect(() => {
        const cb = (s: AccountState) => set(s);
        _listeners.add(cb);
        return () => { _listeners.delete(cb); };
    }, []);
    return state;
}

export async function connectAccount(): Promise<void> {
    if (_state.status === "connecting") return;
    setState({ status: "connecting", account: null });

    try {
        const [identifier, derivationIndex] = getAppAccountId();
        console.log(`[Account] Requesting product account ${identifier}#${derivationIndex}`);

        const result = await accountsProvider.getProductAccount(identifier, derivationIndex);
        if (result.isErr()) {
            if (result.error instanceof RequestCredentialsErr.NotConnected) {
                setState({ status: "signed-out", account: null });
                return;
            }
            const errMsg = `${(result.error as any)?.tag ?? "Unknown"}: ${(result.error as any)?.value?.reason ?? String(result.error)}`;
            console.warn("[Account] getProductAccount error:", errMsg);
            setState({ status: "error", account: null, error: errMsg });
            return;
        }

        const { publicKey } = result.value;
        const productAccount: ProductAccount = { dotNsIdentifier: identifier, derivationIndex, publicKey };
        // "createTransaction" signerType routes through the host's
        // `host_create_transaction` RPC, the only path that signs Summit Asset Hub's
        // pallet-revive signed extensions (AsPgas, AsRingAlias, …).
        const signer = accountsProvider.getProductAccountSigner(productAccount, "createTransaction");
        const ss58 = accountIdCodec.dec(publicKey);
        const h160Address = ss58ToH160(ss58 as never) as `0x${string}`;

        let displayName: string | null = null;
        try {
            const userIdResult = await accountsProvider.getUserId();
            if (userIdResult.isOk()) {
                displayName = (userIdResult.value as any).primaryUsername ?? null;
            }
        } catch { /* optional */ }

        const account: AppAccount = {
            address: ss58,
            h160Address,
            publicKey,
            name: displayName,
            signer,
            productAccountId: [identifier, derivationIndex],
            productAccount,
            getSigner: () => signer,
        };

        // Wire signer + origin defaults so queries don't fall back to the dev
        // origin and tx calls don't need an explicit `{ signer }`.
        if (_contractManager) {
            _contractManager.setDefaults({ origin: ss58, signer });
        }

        console.log(`[Account] Ready — ${ss58} (h160 ${h160Address}) (${displayName ?? identifier})`);
        setState({ status: "ready", account });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[Account] Connect failed:", msg);
        setState({ status: "error", account: null, error: msg });
    }
}

/** Open dotli's sign-in UI and refresh the account on success. */
export async function signIn(): Promise<void> {
    await accountsProvider.requestLogin("Sign in to use Surveys");
    await connectAccount();
}

// ---------------------------------------------------------------------------
// Bulletin upload — host preimage path (works in dev mode)
// ---------------------------------------------------------------------------

const BLAKE2B_256_CODE = 0xb220;

function encodeVarint(value: number): Uint8Array {
    const bytes: number[] = [];
    let num = value;
    while (num >= 0x80) {
        bytes.push((num & 0x7f) | 0x80);
        num >>= 7;
    }
    bytes.push(num & 0x7f);
    return new Uint8Array(bytes);
}

export function calculateCID(bytes: Uint8Array): string {
    const hash = blake2b(bytes, { dkLen: 32 });
    const codeBytes = encodeVarint(BLAKE2B_256_CODE);
    const lengthBytes = encodeVarint(hash.length);
    const multihash = new Uint8Array(codeBytes.length + lengthBytes.length + hash.length);
    multihash.set(codeBytes, 0);
    multihash.set(lengthBytes, codeBytes.length);
    multihash.set(hash, codeBytes.length + lengthBytes.length);
    const digest: MultihashDigest = {
        code: BLAKE2B_256_CODE,
        size: hash.length,
        bytes: multihash,
        digest: hash,
    };
    return CID.createV1(raw.code, digest).toString();
}

export async function uploadToBulletin(bytes: Uint8Array): Promise<string> {
    await ensurePermission("PreimageSubmit");
    const cid = calculateCID(bytes);
    console.log("[Bulletin] Submitting preimage via host, size:", bytes.length, "expected CID:", cid);
    await preimageManager.submit(bytes);
    console.log("[Bulletin] Preimage stored.");
    return cid;
}

// ---------------------------------------------------------------------------
// Contract — @parity/product-sdk-contracts ContractManager.
// Lazy init: the Asset Hub chain client (with its chain-head follow) only spins
// up on the first contract call, so Bulletin preimage submits at startup don't
// compete with a chain follow.
// ---------------------------------------------------------------------------

let _contractManager: ContractManager | null = null;
let _contract: any = null;
let _polkadotClient: ReturnType<typeof createClient> | null = null;
let _cdmJson: any = null;
let _contractInitPromise: Promise<void> | null = null;

/** Stage cdm.json without opening the Asset Hub chain client yet. */
export function stageCdmJson(cdmJson: any): void {
    _cdmJson = cdmJson;
}

export async function initContracts(cdmJson: any): Promise<void> {
    stageCdmJson(cdmJson);
}

/**
 * Wake the Asset Hub chain follow before a contract call. The host container
 * tears down the follow when the tab is backgrounded; the first request after
 * wake bails with "No active follow for this chain" until we touch the client.
 */
export async function wakeChainFollow(): Promise<void> {
    if (!_polkadotClient) return;
    try {
        await _polkadotClient.getBestBlocks();
    } catch (err) {
        console.warn("[CDM] wakeChainFollow failed:", err);
    }
}

const NO_FOLLOW_RE = /no active follow/i;

function withFollowRetry<T extends Record<string, any>>(method: T): T {
    const wrap = <Fn extends (...a: any[]) => Promise<any>>(fn: Fn): Fn =>
        (async (...args: any[]) => {
            await wakeChainFollow();
            try {
                return await fn(...args);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (!NO_FOLLOW_RE.test(msg)) throw err;
                console.warn("[CDM] follow lost mid-call, retrying once:", msg);
                await wakeChainFollow();
                return await fn(...args);
            }
        }) as Fn;

    return new Proxy(method, {
        get(target, prop) {
            const v = target[prop as keyof T];
            if (typeof v === "function") return wrap(v.bind(target));
            return v;
        },
    });
}

function wrapContract(contract: any): any {
    return new Proxy(contract, {
        get(target, prop) {
            const m = target[prop];
            if (m && typeof m === "object" && ("query" in m || "tx" in m)) {
                return withFollowRetry(m);
            }
            return m;
        },
    });
}

async function ensureContractsReady(): Promise<void> {
    if (_contractManager || !_cdmJson) return;
    if (_contractInitPromise) return _contractInitPromise;
    _contractInitPromise = (async () => {
        await ensurePermission("ChainSubmit");

        // Asset Hub access:
        //  - In dev (localhost) the host refuses to open a chain follow for the
        //    unregistered domain, so `createPapiProvider` traps and the WS
        //    fallback never fires. Bypass and go straight to WS.
        //  - In a deployed `*.dot` app the host owns the follow; route through
        //    `createPapiProvider` so signing/permissions stay coordinated.
        const isDevHost =
            typeof window !== "undefined" && /^localhost(:\d+)?$/.test(window.location.host);

        const provider = isDevHost
            ? getWsProvider(SUMMIT_ASSET_HUB_WS)
            : createPapiProvider(SUMMIT_ASSET_HUB_GENESIS, getWsProvider(SUMMIT_ASSET_HUB_WS));
        console.log(`[CDM] Asset Hub provider: ${isDevHost ? "direct WS (dev)" : "host with WS fallback (prod)"}`);
        _polkadotClient = createClient(provider);

        console.log("[CDM] Waking Asset Hub chain follow...");
        await _polkadotClient.getChainSpecData();
        await _polkadotClient.getBestBlocks();
        console.log("[CDM] Chain follow active.");

        _contractManager = ContractManager.fromClient(
            _cdmJson,
            _polkadotClient,
            summit_asset_hub,
            _state.account
                ? { defaultOrigin: _state.account.address as never, defaultSigner: _state.account.signer }
                : undefined,
        );
        _contract = wrapContract(_contractManager.getContract(CONTRACT_KEY));
        console.log("[CDM] Contract manager ready");
    })();
    return _contractInitPromise;
}

/**
 * Lazy contract handle. The chain client doesn't spin up until a method is
 * actually called. `getContract().method.query(...)` returns `{ success, value }`;
 * `.tx(...)` submits with the account defaults set on connect.
 */
export function getContract(): any {
    if (!_cdmJson) return null;
    return new Proxy({}, {
        get(_target, prop) {
            return new Proxy({} as any, {
                get(_t, methodProp) {
                    if (methodProp !== "query" && methodProp !== "tx") return undefined;
                    return async (...args: any[]) => {
                        await ensureContractsReady();
                        if (!_contract) throw new Error("Contract init failed");
                        const real = _contract[prop as string];
                        if (!real) throw new Error(`Unknown method: ${String(prop)}`);
                        return real[methodProp](...args);
                    };
                },
            });
        },
    });
}

// ---------------------------------------------------------------------------
// Account mapping (Revive). pallet-revive on Summit Asset Hub requires every SS58
// origin that calls a contract to have an explicit Revive.map_account() entry.
// Idempotent — first call costs one signature, subsequent calls short-circuit.
// ---------------------------------------------------------------------------

const _mappedAccounts = new Set<string>();

export async function ensureMapping(account: AppAccount): Promise<void> {
    if (_mappedAccounts.has(account.address)) return;
    await ensureContractsReady();
    if (!_contractManager) throw new Error("Contract manager not ready");
    try {
        const mapped = await ensureContractAccountMapped(
            _contractManager.getRuntime(),
            account.address as never,
            account.signer,
        );
        if (mapped === null) {
            console.log(`[Revive] Account ${account.address} already mapped`);
        } else {
            console.log(`[Revive] Account mapped in block #${mapped.block.number}`);
        }
        _mappedAccounts.add(account.address);
    } catch (err) {
        console.error("[Revive] ensureContractAccountMapped failed:", err);
        if (err && typeof err === "object" && "cause" in err) {
            console.error("[Revive] underlying cause:", (err as any).cause);
        }
        throw err;
    }
}

// ---------------------------------------------------------------------------
// Bulletin reads via public IPFS gateways
// ---------------------------------------------------------------------------

const GATEWAYS = [
    "https://summit-ipfs.polkadot.io/ipfs/",
    "https://dweb.link/ipfs/",
    "https://ipfs.io/ipfs/",
    "https://nftstorage.link/ipfs/",
] as const;

export const IPFS_GATEWAY = GATEWAYS[0];

export async function fetchFromGateway(cid: string, timeoutMs = 30000): Promise<Uint8Array> {
    const master = new AbortController();
    const timer = setTimeout(() => master.abort(), timeoutMs);
    try {
        const winner = await Promise.any(
            GATEWAYS.map(async gw => {
                const resp = await fetch(gw + cid, { signal: master.signal });
                if (!resp.ok) throw new Error(`${gw} -> ${resp.status}`);
                return new Uint8Array(await resp.arrayBuffer());
            }),
        );
        master.abort();
        return winner;
    } finally {
        clearTimeout(timer);
    }
}

export async function fetchJsonFromBulletin<T = unknown>(cid: string): Promise<T> {
    const bytes = await fetchFromGateway(cid);
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const short = (addr: string) => (addr ? addr.slice(0, 6) + "..." + addr.slice(-4) : "");

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
        promise,
        new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
        ),
    ]);
}
