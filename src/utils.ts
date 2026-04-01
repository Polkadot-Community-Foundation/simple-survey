import { useState, useEffect } from "react";
import { SignerManager, type SignerState } from "@polkadot-apps/signer";

// ---------------------------------------------------------------------------
// Signer Manager — identical pattern to playground-app
// ---------------------------------------------------------------------------

export const signerManager = new SignerManager({ dappName: "survey-dapp" });

export function useSignerState(): SignerState {
    const [state, setState] = useState<SignerState>(signerManager.getState());
    useEffect(() => signerManager.subscribe(setState), []);
    return state;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const IPFS_GATEWAY = "https://paseo-ipfs.polkadot.io/ipfs/";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const short = (addr: string) => addr.slice(0, 6) + "..." + addr.slice(-4);
