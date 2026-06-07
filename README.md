# Survey DApp

> [!WARNING]
> The following is a prototype, reference implementation, and proof-of-concept. This open source code is provided for research, experimentation, and developer education only. This code has not been audited, is actively experimental, and may contain bugs, vulnerabilities, or incomplete features. Use at your own risk.

Decentralized survey application on Polkadot. Create surveys, collect responses, and view results — all on-chain.

## How it works

- **Surveys** are stored as JSON on the Bulletin Chain and get a content-addressed CID.
- A **smart contract** on Asset Hub indexes survey CIDs and links response CIDs to them.
- **Responses** are also stored on Bulletin, with their CIDs recorded in the contract.
- To view results, the app reads all response CIDs from the contract, fetches the data from Bulletin, and aggregates the answers.

## Setup

```bash
npm install
npm run dev
```

> Deploying **your own copy** (own contract, own `.dot` name, published to the
> playground)? Follow the step-by-step [DEPLOYMENT.md](./DEPLOYMENT.md).





## Security

See [SECURITY.md](./SECURITY.md) for how to report bugs or vulnerabilities.

## License

Licensed under the [GNU General Public License v3.0](./LICENSE) (GPL-3.0-only).
