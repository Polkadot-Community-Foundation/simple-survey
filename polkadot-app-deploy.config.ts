// SPDX-License-Identifier: GPL-3.0-only
//
// Product manifest for `@polkadot-community-foundation/polkadot-app-deploy`
// (the Bulletin app-deploy CLI). The tool auto-discovers this file by name
// (`polkadot-app-deploy.config.{ts,js,mjs}`, walking up from the build dir)
// and reads the default export to publish the product manifest (display name,
// description, icon) alongside the content upload. A file named anything else
// is silently ignored — manifest publish skipped, no error.
//
// `defineConfig` is vendored as an identity function rather than imported from
// the deploy CLI: the tool is a global/npx CLI, not a package.json dependency,
// so importing from it would make config resolution fragile.
const defineConfig = <T>(config: T): T => config;

declare const process: { env?: Record<string, string | undefined> };

// APP_DOTNS_DOMAIN lets CI/preview deploys override the bare label; defaults to
// the production label. MUST match the domain the CLI is invoked with.
const domain = process.env?.APP_DOTNS_DOMAIN ?? "survey";
const label = domain.toLowerCase().replace(/\.dot$/, "");

export default defineConfig({
  domain: `${label}.dot`,
  displayName: "Surveys",
  description:
    "A decentralized survey app on Polkadot. Create surveys, collect responses, and view results — surveys and responses live on Bulletin, indexed by an Asset Hub contract.",
  icon: { path: "./assets/icon.png", format: "png" },
  executables: [
    {
      kind: "app",
      path: "./dist",
      appVersion: [0, 1, 0],
    },
  ],
});
