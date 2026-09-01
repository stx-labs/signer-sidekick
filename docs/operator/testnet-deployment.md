# Testnet

The Stacks testnet uses chain ID `0x80000000`.

Follow the [mainnet installation](deployment.md) with `.env.testnet.example`. Set:

```dotenv
SIDEKICK_NETWORK=testnet
STACKS_API_URL=https://api.testnet.hiro.so
STACKS_NODE_RPC_URL=http://NODE:20443
SIDEKICK_MANAGER_PRINCIPAL=ST_ADDRESS.contract-name
SIDEKICK_AUTH_TOKEN=REPLACE_ME
```

Leave `SIDEKICK_NETWORK_ID` unset. For Leather, add a custom network named `testnet` with the
same API URL. The wallet must expose the manager admin's `ST_ADDRESS`.

## Migrating from the retired PoX-5 testnet

A Sidekick database created against the retired `pox5-testnet` network is bound to chain ID
`0x80000005` and is blocked with `deployment-identity-mismatch` on the standard testnet. Start with
a fresh database and Docker volume, and prepare new wallet intents; intents prepared under the old
chain identity do not revalidate.

Run `connection check`, start Sidekick, and test only the required manager operations. Record the
Sidekick, node, and signer versions plus transaction IDs and verification heights. Use the support
bundle for failures.
