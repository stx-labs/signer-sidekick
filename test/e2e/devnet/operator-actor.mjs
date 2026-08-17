import { createNetwork } from "@stacks/network";
import {
  broadcastTransaction,
  Cl,
  ClarityVersion,
  fetchNonce,
  getAddressFromPrivateKey,
  hexToCV,
  makeContractCall,
  makeContractDeploy,
  PostConditionMode,
  privateKeyToPublic,
} from "@stacks/transactions";

export const DEVNET_ACCOUNTS = Object.freeze({
  deployer: {
    address: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM",
    privateKey: "753b7cc01a1a2e86221266a154af739463fce51219d97e4f856cd7200c3bd2a601",
  },
  staker1: {
    address: "ST2NEB84ASENDXKYGJPQW86YXQCEFEX2ZQPG87ND",
    privateKey: "f9d7206a47f14d2870c163ebab4bf3e70d18f5d14ce1031f3902fbbc894fe4c701",
  },
  staker2: {
    address: "ST2REHHS5J3CERCRBEPMGH7921Q6PYKAADT7JP2VB",
    privateKey: "3eccc5dac8056590432db6a35d52b9896876a3d5cbdea53b72400bc9c2099fe801",
  },
  staker3: {
    address: "ST3AM1A56AK2C1XAFJ4115ZSV26EB49BVQ10MGCS0",
    privateKey: "7036b29cb5e235e5fd9b09ae3e8eec4404e44906814d5d01cbca968a60ed4bfb01",
  },
});

export const DEVNET_MANAGER_PRINCIPAL = `${DEVNET_ACCOUNTS.deployer.address}.signer-manager`;
export const DEVNET_POX5_PRINCIPAL = "ST000000000000000000002AMW42H.pox-5";

function splitContract(principal) {
  const separator = principal.indexOf(".");
  if (separator < 1) throw new Error(`Expected a contract principal, got ${principal}`);
  return {
    address: principal.slice(0, separator),
    name: principal.slice(separator + 1),
  };
}

function transactionError(result) {
  return "txid" in result ? null : `${result.error}: ${result.reason}`;
}

export function createOperatorActor(options = {}) {
  const nodeUrl = options.nodeUrl ?? "http://127.0.0.1:20443";
  const apiUrl = options.apiUrl ?? "http://127.0.0.1:3999";
  const bitcoinUrl = options.bitcoinUrl ?? "http://127.0.0.1:18443";
  const bitcoinAuth = options.bitcoinAuth ?? "devnet:devnet";
  const minerAddress = options.minerAddress ?? "mqVnk6NPRdhntvfm4hh9vvjiRkFDUuSYsH";
  const fee = BigInt(options.fee ?? 100_000);
  const network = createNetwork({ network: "devnet", client: { baseUrl: nodeUrl } });

  async function json(url, init) {
    const response = await fetch(url, init);
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    return await response.json();
  }

  async function nodeInfo() {
    return await json(`${nodeUrl}/v2/info`);
  }

  async function apiStatus() {
    return await json(`${apiUrl}/extended/v1/status`);
  }

  async function bitcoinRpc(method, parameters = []) {
    const response = await fetch(bitcoinUrl, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(bitcoinAuth).toString("base64")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "1.0", id: "sidekick-e2e", method, params: parameters }),
    });
    const body = await response.json();
    if (!response.ok || body.error) {
      throw new Error(`Bitcoin RPC ${method} failed: ${JSON.stringify(body.error ?? body)}`);
    }
    return body.result;
  }

  async function waitFor(predicate, label, timeoutMs = 90_000) {
    const started = Date.now();
    let lastError;
    while (Date.now() - started < timeoutMs) {
      try {
        const value = await predicate();
        if (value) return value;
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
  }

  async function waitForTip(targetBurnHeight) {
    const info = await waitFor(async () => {
      const current = await nodeInfo();
      return current.burn_block_height >= targetBurnHeight ? current : null;
    }, `stacks-node burn height ${targetBurnHeight}`);
    await waitFor(async () => {
      const status = await apiStatus();
      return status.chain_tip.burn_block_height >= info.burn_block_height ? status : null;
    }, `Stacks API burn height ${info.burn_block_height}`);
    return info;
  }

  async function mineBurnBlock() {
    const before = await nodeInfo();
    await bitcoinRpc("generatetoaddress", [1, minerAddress]);
    return await waitForTip(before.burn_block_height + 1);
  }

  async function waitForTransaction(txid, timeoutMs = 120_000) {
    const started = Date.now();
    let lastStatus = "not indexed";
    while (Date.now() - started < timeoutMs) {
      const response = await fetch(`${apiUrl}/extended/v1/tx/0x${txid.replace(/^0x/, "")}`);
      if (response.ok) {
        const transaction = await response.json();
        if (transaction.tx_status === "success") return transaction;
        lastStatus = transaction.tx_status ?? "unknown";
        if (String(transaction.tx_status).startsWith("abort")) {
          throw new Error(
            `Transaction ${txid} aborted: ${transaction.tx_result?.repr ?? "unknown"}`,
          );
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(
      `Transaction ${txid} did not confirm within ${timeoutMs}ms (last status: ${lastStatus})`,
    );
  }

  async function submit(transaction) {
    const result = await broadcastTransaction({ transaction, network });
    const error = transactionError(result);
    if (error) throw new Error(`Transaction broadcast rejected: ${error}`);
    const confirmed = await waitForTransaction(result.txid);
    return { txid: result.txid, confirmed };
  }

  async function deployContract(
    contractName,
    source,
    clarityVersion,
    account = DEVNET_ACCOUNTS.deployer,
  ) {
    const address = getAddressFromPrivateKey(account.privateKey, "testnet");
    if (address !== account.address)
      throw new Error("Devnet account fixture does not derive correctly");
    const principal = `${account.address}.${contractName}`;
    const existing = await fetch(
      `${nodeUrl}/v2/contracts/source/${account.address}/${contractName}?proof=0`,
    );
    if (existing.ok) return { skipped: true, principal };
    const nonce = await fetchNonce({ address: account.address, network });
    const transaction = await makeContractDeploy({
      contractName,
      codeBody: source,
      clarityVersion,
      senderKey: account.privateKey,
      fee,
      nonce,
      postConditionMode: PostConditionMode.Allow,
      network,
    });
    return { ...(await submit(transaction)), principal };
  }

  async function deployManager(
    source,
    account = DEVNET_ACCOUNTS.deployer,
    contractName = "signer-manager",
  ) {
    return await deployContract(contractName, source, ClarityVersion.Clarity6, account);
  }

  async function registerManager(grant, account = DEVNET_ACCOUNTS.deployer) {
    const manager = splitContract(grant.signerManager);
    const nonce = await fetchNonce({ address: account.address, network });
    const transaction = await makeContractCall({
      contractAddress: manager.address,
      contractName: manager.name,
      functionName: "register-self",
      functionArgs: [
        Cl.principal(grant.signerManager),
        Cl.bufferFromHex(grant.signerKey.replace(/^0x/, "")),
        Cl.uint(BigInt(grant.authId)),
        Cl.bufferFromHex(grant.signerSignature.replace(/^0x/, "")),
      ],
      senderKey: account.privateKey,
      fee,
      nonce,
      postConditionMode: PostConditionMode.Allow,
      network,
    });
    return await submit(transaction);
  }

  async function updateFees(newFees, account = DEVNET_ACCOUNTS.deployer) {
    const manager = splitContract(DEVNET_MANAGER_PRINCIPAL);
    const nonce = await fetchNonce({ address: account.address, network });
    const transaction = await makeContractCall({
      contractAddress: manager.address,
      contractName: manager.name,
      functionName: "update-fees",
      functionArgs: [Cl.uint(BigInt(newFees))],
      senderKey: account.privateKey,
      fee,
      nonce,
      postConditionMode: PostConditionMode.Allow,
      network,
    });
    return await submit(transaction);
  }

  async function browserWalletRequest(method, parameters = {}) {
    const account = DEVNET_ACCOUNTS.deployer;
    if (method === "getAddresses" || method === "stx_getAddresses") {
      return {
        addresses: [
          {
            symbol: "STX",
            address: account.address,
            publicKey: privateKeyToPublic(account.privateKey),
          },
        ],
      };
    }
    if (method !== "stx_callContract") {
      throw new Error(`Controlled Devnet wallet does not implement ${method}`);
    }
    const functionArgs = Array.isArray(parameters.functionArgs) ? parameters.functionArgs : [];
    const postConditions = Array.isArray(parameters.postConditions)
      ? parameters.postConditions
      : [];
    if (
      parameters.address !== account.address ||
      parameters.network !== "devnet" ||
      parameters.contract !== DEVNET_MANAGER_PRINCIPAL ||
      parameters.functionName !== "update-fees" ||
      parameters.sponsored !== false ||
      parameters.postConditionMode !== "deny" ||
      functionArgs.length !== 1 ||
      typeof functionArgs[0] !== "string" ||
      postConditions.length !== 0
    ) {
      throw new Error(
        `Controlled Devnet wallet rejected an unexpected request: ${JSON.stringify(parameters)}`,
      );
    }
    const nonce = await fetchNonce({ address: account.address, network });
    const transaction = await makeContractCall({
      contractAddress: splitContract(DEVNET_MANAGER_PRINCIPAL).address,
      contractName: splitContract(DEVNET_MANAGER_PRINCIPAL).name,
      functionName: parameters.functionName,
      functionArgs: functionArgs.map(hexToCV),
      senderKey: account.privateKey,
      fee,
      nonce,
      sponsored: false,
      postConditionMode: PostConditionMode.Deny,
      postConditions: [],
      network,
    });
    const confirmed = await submit(transaction);
    return { txid: confirmed.txid };
  }

  async function stake(
    account,
    { managerPrincipal = DEVNET_MANAGER_PRINCIPAL, amountUstx = 60_000_000_000n, cycles = 2 } = {},
  ) {
    const pox = await json(`${nodeUrl}/v2/pox`);
    const nonce = await fetchNonce({ address: account.address, network });
    const transaction = await makeContractCall({
      contractAddress: splitContract(DEVNET_POX5_PRINCIPAL).address,
      contractName: splitContract(DEVNET_POX5_PRINCIPAL).name,
      functionName: "stake",
      functionArgs: [
        Cl.principal(managerPrincipal),
        Cl.uint(amountUstx),
        Cl.uint(cycles),
        Cl.uint(pox.current_burnchain_block_height),
        Cl.none(),
      ],
      senderKey: account.privateKey,
      fee,
      nonce,
      postConditionMode: PostConditionMode.Allow,
      network,
    });
    return await submit(transaction);
  }

  async function stakeUpdate(
    account,
    {
      managerPrincipal = DEVNET_MANAGER_PRINCIPAL,
      cyclesToExtend = 1,
      amountIncrease = 1_000_000n,
    } = {},
  ) {
    const pox5 = splitContract(DEVNET_POX5_PRINCIPAL);
    const nonce = await fetchNonce({ address: account.address, network });
    const transaction = await makeContractCall({
      contractAddress: pox5.address,
      contractName: pox5.name,
      functionName: "stake-update",
      functionArgs: [
        Cl.principal(managerPrincipal),
        Cl.principal(managerPrincipal),
        Cl.uint(cyclesToExtend),
        Cl.uint(amountIncrease),
        Cl.none(),
      ],
      senderKey: account.privateKey,
      fee,
      nonce,
      postConditionMode: PostConditionMode.Allow,
      network,
    });
    return await submit(transaction);
  }

  async function unstake(account, managerPrincipal = DEVNET_MANAGER_PRINCIPAL) {
    const pox5 = splitContract(DEVNET_POX5_PRINCIPAL);
    const nonce = await fetchNonce({ address: account.address, network });
    const transaction = await makeContractCall({
      contractAddress: pox5.address,
      contractName: pox5.name,
      functionName: "unstake",
      functionArgs: [Cl.principal(managerPrincipal)],
      senderKey: account.privateKey,
      fee,
      nonce,
      postConditionMode: PostConditionMode.Allow,
      network,
    });
    return await submit(transaction);
  }

  return {
    apiStatus,
    browserWalletRequest,
    deployContract,
    deployManager,
    mineBurnBlock,
    nodeInfo,
    registerManager,
    stake,
    stakeUpdate,
    unstake,
    updateFees,
    waitFor,
    waitForTip,
    waitForTransaction,
  };
}
