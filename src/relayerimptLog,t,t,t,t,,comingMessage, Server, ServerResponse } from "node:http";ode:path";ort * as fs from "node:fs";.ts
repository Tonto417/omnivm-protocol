ToAccount } from "viem/accounts";
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

function loadDotEnvFiles(): void {
  const candidates = [".env.local", ".env"];
  for (const file of candidates) {
    const fullPath = path.resolve(process.cwd(), file);
    if (!fs.existsSync(fullPath)) continue;

    const content = fs.readFileSync(fullPath, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;

      const match = line.match(/^([\w.-]+)\s*=\s*(.*)?$/);
      if (!match) continue;

      const key = match[1];
      let val = (match[2] || "").trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      } else {
        const commentIdx = val.indexOf(" #");
        if (commentIdx !== -1) val = val.slice(0, commentIdx).trim();
      }

      if (process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  }
}

loadDotEnvFiles();
console.log("[Relayer] Environment initialized, loading configuration...");

const DEAD_ADDRESS = "0x000000000000000000000000000000000000dead";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MAX_BODY_BYTES = 1_000_000;
const RECEIPT_TIMEOUT_MS = 120_000;

const VIEM_CHAINS_BY_ID: Record<number, Chain> = {
  [mainnet.id]: mainnet,
  [arbitrum.id]: arbitrum,
  [optimism.id]: optimism,
  [base.id]: base,
  [sepolia.id]: sepolia,
  [arbitrumSepolia.id]: arbitrumSepolia,
};

function resolveRpcUrl(chainId: number): string | undefined {
  switch (chainId) {
    case 1:
      return process.env.ETH_RPC_URL || process.env.NEXT_PUBLIC_ETH_RPC_URL;
    case 42161:
      return (
        process.env.ARBITRUM_RPC_URL || process.env.NEXT_PUBLIC_ARBITRUM_RPC_URL
      );
    case 10:
      return (
        process.env.OPTIMISM_RPC_URL || process.env.NEXT_PUBLIC_OPTIMISM_RPC_URL
      );
    case 8453:
      return process.env.BASE_RPC_URL || process.env.NEXT_PUBLIC_BASE_RPC_URL;
    case 11155111:
      return (
        process.env.SEPOLIA_RPC_URL || process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL
      );
    case 421614:
      return (
        process.env.ARB_SEPOLIA_RPC_URL ||
        process.env.NEXT_PUBLIC_ARB_SEPOLIA_RPC_URL
      );
    default:
      return undefined;
  }
}

function parseUintString(value: unknown, fieldName: string): bigint {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`Invalid ${fieldName}: expected integer string in wei.`);
  }
  const str = String(value).trim();
  if (!/^\d+$/.test(str)) {
    throw new Error(
      `Invalid ${fieldName} ("${str}"): must be a non-negative integer string in wei (not a decimal).`
    );
  }
  return BigInt(str);
}

function isConfiguredContractAddress(addr: string | undefined): addr is Address {
  if (!addr || !isAddress(addr)) return false;
  const lower = addr.toLowerCase();
  return lower !== DEAD_ADDRESS && lower !== ZERO_ADDRESS;
}

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
  private httpServer?: Server;

  constructor(policy?: Partial<RelayerPolicyConfig>) {
    const pk = (policy?.relayerPrivateKey ||
      process.env.RELAYER_PRIVATE_KEY ||
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80") as
      | Hex
      | undefined;

    if (!pk || !isHex(pk) || pk.length !== 66) {
      throw new Error(
        "Missing or invalid RELAYER_PRIVATE_KEY (expected 32-byte 0x-prefixed hex string)."
      );
    }

    this.policy = {
      relayerPrivateKey: pk,
      feeBufferBps: policy?.feeBufferBps ?? 250,
      maxRelayValueWei:
        policy?.maxRelayValueWei ??
        parseEther(process.env.MAX_RELAY_ETH || "0.5"),
      httpPort: policy?.httpPort ?? Number(process.env.RELAYER_PORT || 8787),
    };

    this.account = privateKeyToAccount(this.policy.relayerPrivateKey);

    for (const cfg of SUPPORTED_CHAINS) {
      const viemChain = VIEM_CHAINS_BY_ID[cfg.chainId];
      if (!viemChain) continue;

      const rpcUrl = resolveRpcUrl(cfg.chainId);
      const transport = rpcUrl
        ? http(rpcUrl, { retryCount: 3, timeout: 15_000 })
        : http(undefined, { retryCount: 2, timeout: 15_000 });

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

    const chained = previous.then(() => current);
    this.chainLocks.set(srcEid, chained);

    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.chainLocks.get(srcEid) === chained) {
        this.chainLocks.delete(srcEid);
      }
    }
  }

  public async getSenderNonce(srcEid: number, sender: Address): Promise<bigint> {
    const srcConfig = this.chainConfigs.get(Number(srcEid));
    if (!srcConfig) {
      throw new Error(`Unsupported source EID: ${srcEid}`);
    }
    if (!isConfiguredContractAddress(srcConfig.omniVmAddress)) {
      throw new Error(
        `OmniVM contract address is not configured for ${srcConfig.name} (EID ${srcEid}).`
      );
    }
    if (!isAddress(sender)) {
      throw new Error(`Invalid sender address: ${sender}`);
    }

    const publicClient = this.publicClients.get(srcConfig.lzEid)!;
    return await publicClient.readContract({
      address: srcConfig.omniVmAddress,
      abi: OMNI_VM_ABI,
      functionName: "nonces",
      args: [sender],
    });
  }

  public async relaySignedIntent(
    payload: SignedIntentPayload
  ): Promise<RelayExecutionReceipt> {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid request body: expected JSON object.");
    }

    const srcEid = Number(payload.srcEid);
    const dstEid = Number(payload.dstEid);

    if (!Number.isInteger(srcEid) || !Number.isInteger(dstEid)) {
      throw new Error("srcEid and dstEid must be valid integers.");
    }
    if (srcEid === dstEid) {
      throw new Error(
        `InvalidRoute: srcEid (${srcEid}) and dstEid (${dstEid}) cannot be identical.`
      );
    }

    const srcConfig = this.chainConfigs.get(srcEid);
    const dstConfig = this.chainConfigs.get(dstEid);

    if (!srcConfig || !dstConfig) {
      throw new Error(
        `Unsupported LayerZero route: srcEid=${srcEid} -> dstEid=${dstEid}`
      );
    }

    if (!isConfiguredContractAddress(srcConfig.omniVmAddress)) {
      throw new Error(
        `Source OmniVM contract is not deployed/configured on ${srcConfig.name} (EID ${srcEid}).`
      );
    }
    if (!isConfiguredContractAddress(dstConfig.omniVmAddress)) {
      throw new Error(
        `Destination OmniVM peer is not deployed/configured on ${dstConfig.name} (EID ${dstEid}).`
      );
    }

    if (!isAddress(payload.sender)) {
      throw new Error(`Invalid sender address: ${payload.sender}`);
    }
    if (!isAddress(payload.refundRecipient)) {
      throw new Error(
        `Invalid refundRecipient address: ${payload.refundRecipient}`
      );
    }
    if (!Array.isArray(payload.instructions) || payload.instructions.length === 0) {
      throw new Error("Batch must contain at least one instruction.");
    }
    if (!isHex(payload.options)) {
      throw new Error("Invalid options: expected 0x-prefixed hex string.");
    }
    if (!isHex(payload.signature)) {
      throw new Error("Invalid signature: expected 0x-prefixed hex string.");
    }

    const instructions = payload.instructions.map((inst, idx) => {
      if (!inst || !isAddress(inst.target)) {
        throw new Error(`Instruction[${idx}] has an invalid target address.`);
      }
      if (!isHex(inst.payload)) {
        throw new Error(
          `Instruction[${idx}] payload must be a 0x-prefixed hex string.`
        );
      }
      return {
        target: inst.target,
        value: parseUintString(inst.value, `instructions[${idx}].value`),
        payload: inst.payload,
      };
    });

    const intent: BatchDispatchIntentMessage = {
      sender: payload.sender,
      refundRecipient: payload.refundRecipient,
      srcEid,
      dstEid,
      instructions,
      totalNativeValue: parseUintString(
        payload.totalNativeValue,
        "totalNativeValue"
      ),
      options: payload.options,
      nonce: parseUintString(payload.nonce, "nonce"),
      deadline: parseUintString(payload.deadline, "deadline"),
    };

    assertValidBatchIntent(intent);

    const publicClient = this.publicClients.get(srcConfig.lzEid)!;
    const walletClient = this.walletClients.get(srcConfig.lzEid)!;
    const viemChain = VIEM_CHAINS_BY_ID[srcConfig.chainId]!;

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
      const onChainNonce = await publicClient.readContract({
        address: srcConfig.omniVmAddress,
        abi: OMNI_VM_ABI,
        functionName: "nonces",
        args: [intent.sender],
      });

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

      const relayerBalance = await publicClient.getBalance({
        address: this.account.address,
      });

      if (relayerBalance < quote.bufferedNativeFee) {
        throw new Error(
          `RelayerInsufficientBalance: relayer ${
            this.account.address
          } on ${srcConfig.name} has ${formatEther(
            relayerBalance
          )} ETH, but ${formatEther(
            quote.bufferedNativeFee
          )} ETH is required to cover LayerZero fee + value drop.`
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
        timeout: RECEIPT_TIMEOUT_MS,
      });

      if (receipt.status !== "success") {
        throw new Error(
          `TransactionReverted: dispatchBatchWithSig reverted on-chain (txHash: ${txHash}).`
        );
      }

      let dispatchedGuid: Hex =
        (simulatedGuid as Hex | undefined) ??
        ("0x0000000000000000000000000000000000000000000000000000000000000000" as Hex);

      for (const log of receipt.logs) {
        if (
          log.address.toLowerCase() !== srcConfig.omniVmAddress.toLowerCase()
        ) {
          continue;
        }
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
          // Ignore non-matching logs
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
      if (!isConfiguredContractAddress(cfg.omniVmAddress)) {
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

  private static readRequestBody(req: IncomingMessage): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let data = "";
      let aborted = false;

      req.on("data", (chunk: Buffer | string) => {
        if (aborted) return;
        data += chunk.toString();
        if (data.length > MAX_BODY_BYTES) {
          aborted = true;
          req.destroy();
          reject(new Error("Payload too large (exceeds 1 MB limit)."));
        }
      });

      req.on("end", () => {
        if (!aborted) resolve(data);
      });

      req.on("error", (err) => {
        if (!aborted) {
          aborted = true;
          reject(err);
        }
      });
    });
  }

  public startHttpServer(): Server {
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

        const parsedUrl = new URL(
          req.url || "/",
          `http://${req.headers.host || "localhost"}`
        );

        if (req.method === "GET" && parsedUrl.pathname === "/health") {
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

        if (req.method === "GET" && parsedUrl.pathname === "/nonce") {
          try {
            const srcEid = Number(parsedUrl.searchParams.get("srcEid"));
            const sender = parsedUrl.searchParams.get("sender") as Address;
            if (!srcEid || !sender) {
              throw new Error(
                "Missing required query parameters: ?srcEid=<eid>&sender=<address>"
              );
            }
            const nonce = await this.getSenderNonce(srcEid, sender);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, nonce: nonce.toString() }));
          } catch (err: any) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                ok: false,
                error:
                  err?.shortMessage || err?.message || "Failed to fetch nonce",
              })
            );
          }
          return;
        }

        if (req.method === "POST" && parsedUrl.pathname === "/relay") {
          try {
            const rawBody = await OmniVmRelayer.readRequestBody(req);
            let payload: SignedIntentPayload;
            try {
              payload = JSON.parse(rawBody) as SignedIntentPayload;
            } catch {
              throw new Error("Malformed JSON request body.");
            }

            const receipt = await this.relaySignedIntent(payload);

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, receipt }));
          } catch (err: any) {
            console.error(
              "[Relayer Error]",
              err?.shortMessage || err?.message || err
            );
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
        res.end(JSON.stringify({ ok: false, error: "Not Found" }));
      }
    );

    console.log("[Relayer] Attempting to bind HTTP server...");
    server.listen(this.policy.httpPort, "0.0.0.0", () => {
      console.log(
        `[Relayer] HTTP Intent Ingestion API listening on http://0.0.0.0:${this.policy.httpPort}/relay (Relayer EOA: ${this.relayerAddress})`
      );
    });

    this.httpServer = server;
    return server;
  }

  public stop(): Promise<void> {
    for (const unwatch of this.unwatchFns.splice(0)) {
      try {
        unwatch();
      } catch {
        // Ignore unwatch cleanup errors
      }
    }
    return new Promise((resolve) => {
      if (!this.httpServer) {
        resolve();
        return;
      }
      this.httpServer.close(() => resolve());
    });
  }
}

const relayer = new OmniVmRelayer();
relayer.startHttpServer();
relayer.startOnChainEventWatchers();

const shutdown = async (signal: string) => {
  console.log(`\n[Relayer] Received ${signal}, shutting down gracefully...`);
  await relayer.stop();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
	

