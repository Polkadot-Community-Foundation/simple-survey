# Survey DApp

Decentralized survey application on Polkadot. Create surveys, collect responses, and view results — all on-chain.

## How it works

- **Surveys** are stored as JSON on the Bulletin Chain and get a content-addressed CID.
- A **smart contract** on Asset Hub indexes survey CIDs and links response CIDs to them.
- **Responses** are also stored on Bulletin, with their CIDs recorded in the contract.
- To view results, the app reads all response CIDs from the contract, fetches the data from Bulletin, and aggregates the answers.

## Stack

- **Smart contract** — PVM (PolkaVM) on Paseo Asset Hub, managed via [CDM](https://github.com/paritytech/contract-dependency-manager)
- **Bulletin Chain** — decentralized data storage via [@polkadot-apps/bulletin](https://github.com/nicosama-tech/polkadot-apps)
- **Account management** — [@polkadot-apps/signer](https://github.com/nicosama-tech/polkadot-apps) (Host API, browser extensions, dev accounts)
- **Frontend** — React + Vite

## Setup

```bash
npm install
npm run dev
```

> Deploying **your own copy** (own contract, own `.dot` name, published to the
> playground)? Follow the step-by-step [DEPLOYMENT.md](./DEPLOYMENT.md).

### Deploy contract (first time only)

```bash
cdm build
cdm deploy -n paseo
cdm install @example/surveys -n paseo
```

### Build & deploy frontend

```bash
npm run build:frontend
bulletin-deploy ./dist <your-domain>.dot
```
