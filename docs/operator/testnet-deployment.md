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

Run `connection check`, start Sidekick, and test only the required manager operations. Record the
Sidekick, node, and signer versions plus transaction IDs and verification heights. Use the support
bundle for failures.
