import * as fs from "fs";
if (fs.existsSync(".env")) {
  for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = (m[2] || "").replace(/^["']|["']$/g, "");
  }
}
console.log("[Relayer] Module loaded, initializing...");
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import {
  Address,
  Chain,
  Hex,
  PublicClient,
  WalletClient,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  formatEther,
  http,
  isHex,
  parseEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  mainnet,
  arbitrum,
  optimism,
  base,
  sepolia,
  arbitrumSepolia,
} from "viem/chains";
import {
  OMNI_VM_ABI,
  SUPPORTED_CHAINS,
  OmniChainConfig,
} from "./omniVmConfig";
import {
  BatchDispatchIntentMessage,
  assertValidBatchIntent,
  quoteOmniVmBatch,
  verifyOmniVmBatchSignature,
} from "./signer";

const VIEM_CHAINS_BY_ID: Record<number, Chain> = {
  [mainnet.id]: mainnet,
  [arbitrum.id]: arbitrum,
  [optimism.id]: optimism,
  [base.id]: base,
  [sepolia.id]: sepolia,
  [arbitrumSepolia.id]: arbitrumSepolia,
};

const RPC_ENV_BY_CHAIN_ID: Record<number, string | undefined> = {
  1: process.env.NEXT_PUBLIC_ETH_RPC_URL,
  42161: process.env.NEXT_PUBLIC_ARBITRUM_RPC_URL,
  10: process.env.NEXT_PUBLIC_OPTIMISM_RPC_URL,
  8453: process.env.NEXT_PUBLIC_BASE_RPC_URL,
  11155111: process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL,
  421614: process.env.NEXT_PUBLIC_ARB_SEPOLIA_RPC_URL,
};

export interface RelayerPolicyConfig {
  relayerPrivateKey: Hex;
  feeBufferBps: number;
  maxRelayValueWei: bigint;
  httpPort: number;
}

export interface SerializedInstruction {
  target: Address;
  value: string;
  payload: Hex;
}

export interface SignedIntentPayload {
  sender: Address;
  refundRecipient: Address;
  srcEid: number;
  dstEid: number;
  instructions: SerializedInstruction[];
  totalNativeValue: string;
  options: Hex;
  nonce: string;
  deadline: string;
  signature: Hex;
}

export interface RelayExecutionReceipt {
  srcChain: string;
  dstChain: string;
  txHash: Hex;
  guid: Hex;
  layerZeroScanUrl: string;
  quotedFeeWei: string;
  paidFeeWei: string;
}

export class OmniVmRelayer {
  private readonly policy: RelayerPolicyConfig;
  private readonly account;
  private readonly publicClients = new Map<number, PublicClient>();
  private readonly walletClients = new Map<number, WalletClient>();
  private readonly chainConfigs = new Map<number, OmniChainConfig>();
  private readonly chainLocks = new Map<number, Promise<void>>();
  private readonly unwatchFns: Array<() => void> = [];

  constructor(policy?: Partial<RelayerPolicyConfig>) {
    const pk = (policy?.relayerPrivateKey ||
      (process.env.RELAYER_PRIVATE_KEY || "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")) as Hex | undefined;

    if (!pk || !isHex(pk) || pk.length !== 66) {
      throw new Error(
        "Missing or invalid RELAYER_PRIVATE_KEY (expected 32-byte 0x-prefixed hex string)."
      );
    }

    this.policy = {
      relayerPrivateKey: pk,
      feeBufferBps: policy?.feeBufferBps ?? 250,
      maxRelayValueWei:
        policy?.maxRelayValueWei ?? parseEther(process.env.MAX_RELAY_ETH || "0.5"),
      httpPort: policy?.httpPort ?? Number(process.env.RELAYER_PORT || 8787),
    };

    this.account = privateKeyToAccount(this.policy.relayerPrivateKey);

    for (const cfg of SUPPORTED_CHAINS) {
      const viemChain = VIEM_CHAINS_BY_ID[cfg.chainId];
      if (!viemChain) continue;

      const rpcUrl = RPC_ENV_BY_CHAIN_ID[cfg.chainId];
      const transport = rpcUrl ? http(rpcUrl) : http();

      this.chainConfigs.set(cfg.lzEid, cfg);
      this.publicClients.set(
        cfg.lzEid,
        createPublicClient({ chain: viemChain, transport })
      );
      this.walletClients.set(
        cfg.lzEid,
        createWalletClient({
          account: this.account,
          chain: viemChain,
          transport,
        })
      );
    }
  }

  public get relayerAddress(): Address {
    return this.account.address;
  }

  private async withChainLock<T>(
    srcEid: number,
    task: () => Promise<T>
  ): Promise<T> {
    const previous = this.chainLocks.get(srcEid) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.chainLocks.set(
      srcEid,
      previous.then(() => current)
    );

    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }

  public async relaySignedIntent(
    payload: SignedIntentPayload
  ): Promise<RelayExecutionReceipt> {
    const srcConfig = this.chainConfigs.get(Number(payload.srcEid));
    const dstConfig = this.chainConfigs.get(Number(payload.dstEid));

    if (!srcConfig || !dstConfig) {
      throw new Error(
        `Unsupported LayerZero route: srcEid=${payload.srcEid} -> dstEid=${payload.dstEid}`
      );
    }

    const publicClient = this.publicClients.get(srcConfig.lzEid)!;
    const walletClient = this.walletClients.get(srcConfig.lzEid)!;
    const viemChain = VIEM_CHAINS_BY_ID[srcConfig.chainId]!;

    const instructions = payload.instructions.map((inst) => ({
      target: inst.target,
      value: BigInt(inst.value),
      payload: inst.payload,
    }));

    const intent: BatchDispatchIntentMessage = {
      sender: payload.sender,
      refundRecipient: payload.refundRecipient,
      srcEid: Number(payload.srcEid),
      dstEid: Number(payload.dstEid),
      instructions,
      totalNativeValue: BigInt(payload.totalNativeValue),
      options: payload.options,
      nonce: BigInt(payload.nonce),
      deadline: BigInt(payload.deadline),
    };

    assertValidBatchIntent(intent);

    const { isValid } = await verifyOmniVmBatchSignature({
      chainId: srcConfig.chainId,
      verifyingContract: srcConfig.omniVmAddress,
      intent,
      signature: payload.signature,
      publicClient,
    });

    if (!isValid) {
      throw new Error(
        `InvalidIntentSignature: EIP-712 signature verification failed for sender ${intent.sender}.`
      );
    }

    return this.withChainLock(srcConfig.lzEid, async () => {
      const onChainNonce = (await (async () => { try { return await publicClient.readContract({
        address: srcConfig.omniVmAddress,
        abi: OMNI_VM_ABI,
        functionName: "nonces",
        args: [intent.sender],
      }); } catch { return 0n; } })());

      if (onChainNonce !== intent.nonce) {
        throw new Error(
          `NonceMismatch: signed nonce (${intent.nonce}) !== on-chain nonce (${onChainNonce}) for ${intent.sender}.`
        );
      }

      const quote = await quoteOmniVmBatch({
        publicClient,
        srcOmniVm: srcConfig.omniVmAddress,
        dstOmniVmPeer: dstConfig.omniVmAddress,
        endpointV2: srcConfig.endpointV2,
        dstEid: intent.dstEid,
        sender: intent.sender,
        refundRecipient: intent.refundRecipient,
        instructions: intent.instructions,
        baseOptions: intent.options,
        feeBufferBps: this.policy.feeBufferBps,
      });

      if (quote.bufferedNativeFee > this.policy.maxRelayValueWei) {
        throw new Error(
          `RelayFeeExceedsPolicyCap: required ${formatEther(
            quote.bufferedNativeFee
          )} ETH exceeds relayer cap of ${formatEther(
            this.policy.maxRelayValueWei
          )} ETH.`
        );
      }

      const { request, result: simulatedGuid } =
        await publicClient.simulateContract({
          account: this.account,
          chain: viemChain,
          address: srcConfig.omniVmAddress,
          abi: OMNI_VM_ABI,
          functionName: "dispatchBatchWithSig",
          args: [
            intent.sender,
            intent.refundRecipient,
            intent.dstEid,
            intent.instructions,
            intent.options,
            intent.deadline,
            payload.signature,
          ],
          value: quote.bufferedNativeFee,
        });

      const txHash = await walletClient.writeContract(request);
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
      });

      let dispatchedGuid: Hex = simulatedGuid;
      for (const log of receipt.logs) {
        try {
          const decoded = decodeEventLog({
            abi: OMNI_VM_ABI,
            data: log.data,
            topics: log.topics,
          });
          if (decoded.eventName === "BatchDispatched") {
            dispatchedGuid = decoded.args.guid;
            break;
          }
        } catch {
          // Ignore non-OmniVM logs
        }
      }

      const layerZeroScanUrl = `https://layerzeroscan.com/tx/${dispatchedGuid}`;

      return {
        srcChain: srcConfig.name,
        dstChain: dstConfig.name,
        txHash,
        guid: dispatchedGuid,
        layerZeroScanUrl,
        quotedFeeWei: quote.nativeFee.toString(),
        paidFeeWei: quote.bufferedNativeFee.toString(),
      };
    });
  }

  public startOnChainEventWatchers(): void {
    for (const cfg of SUPPORTED_CHAINS) {
      if (
        cfg.omniVmAddress.toLowerCase() ===
        "0x000000000000000000000000000000000000dead"
      ) {
        continue;
      }

      const publicClient = this.publicClients.get(cfg.lzEid);
      if (!publicClient) continue;

      const unwatchDispatched = publicClient.watchContractEvent({
        address: cfg.omniVmAddress,
        abi: OMNI_VM_ABI,
        eventName: "BatchDispatched",
        onLogs: (logs) => {
          for (const log of logs) {
            const { guid, sender, dstEid, instructionCount, totalNativeValue } =
              log.args;
            console.log(
              `[Telemetry:Dispatched] [${cfg.shortName} -> EID ${dstEid}] GUID=${guid} sender=${sender} count=${instructionCount} value=${formatEther(
                totalNativeValue ?? 0n
              )} ETH`
            );
          }
        },
        onError: (err) =>
          console.error(`[Telemetry Error: ${cfg.shortName}]`, err.message),
      });

      const unwatchExecuted = publicClient.watchContractEvent({
        address: cfg.omniVmAddress,
        abi: OMNI_VM_ABI,
        eventName: "BatchExecuted",
        onLogs: (logs) => {
          for (const log of logs) {
            const { guid, srcEid, originalSender, instructionCount } = log.args;
            console.log(
              `[Telemetry:Executed] [EID ${srcEid} -> ${cfg.shortName}] GUID=${guid} originalSender=${originalSender} count=${instructionCount}`
            );
          }
        },
        onError: (err) =>
          console.error(`[Telemetry Error: ${cfg.shortName}]`, err.message),
      });

      this.unwatchFns.push(unwatchDispatched, unwatchExecuted);
    }
  }

  public startHttpServer() {
    const server = createServer(
      async (req: IncomingMessage, res: ServerResponse) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");

        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        if (req.method === "GET" && req.url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "ok",
              relayerAddress: this.relayerAddress,
              supportedEids: Array.from(this.chainConfigs.keys()),
            })
          );
          return;
        }

        if (req.method === "POST" && req.url === "/relay") {
          try {
            const rawBody = await new Promise<string>((resolve, reject) => {
              let data = "";
              req.on("data", (chunk) => {
                data += chunk;
                if (data.length > 1_000_000) {
                  reject(new Error("Payload too large"));
                }
              });
              req.on("end", () => resolve(data));
              req.on("error", reject);
            });

            const payload = JSON.parse(rawBody) as SignedIntentPayload;
            const receipt = await this.relaySignedIntent(payload);

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, receipt }));
          } catch (err: any) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                ok: false,
                error: err?.shortMessage || err?.message || "Relay failed",
              })
            );
          }
          return;
        }

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not Found" }));
      }
    );

    console.log("[Relayer] Attempting to bind HTTP server...");
    server.listen(this.policy.httpPort, () => {
      console.log(
        `[Relayer] HTTP Intent Ingestion API listening on http://0.0.0.0:${this.policy.httpPort}/relay (Relayer EOA: ${this.relayerAddress})`
      );
    });

    return server;
  }
}

const relayer = new OmniVmRelayer();
relayer.startHttpServer();
