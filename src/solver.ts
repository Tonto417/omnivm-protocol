import {
  Address,
  Chain,
  Hex,
  PublicClient,
  WalletClient,
  concatHex,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  formatEther,
  http,
  isHex,
  keccak256,
  pad,
  parseEther,
  toHex,
  zeroAddress,
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
  SUPPORTED_CHAINS,
  OmniChainConfig,
  buildLzReceiveOptions,
  LZ_ENDPOINT_V2_ABI,
} from "./omniVmConfig";
import { SolidityInstruction } from "./signer";

export const NATIVE_ETH_SENTINEL =
  "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address;

export interface OmniOutcomeIntent {
  sender: Address;
  recipient: Address;
  srcEid: number;
  dstEid: number;
  inputToken: Address;
  inputAmount: bigint;
  outputToken: Address;
  minOutputAmount: bigint;
  postHookTarget: Address;
  postHookValue: bigint;
  postHookPayload: Hex;
  nonce: bigint;
  deadline: bigint;
}

export const OMNI_OUTCOME_EIP712_TYPES = {
  OmniOutcomeIntent: [
    { name: "sender", type: "address" },
    { name: "recipient", type: "address" },
    { name: "srcEid", type: "uint32" },
    { name: "dstEid", type: "uint32" },
    { name: "inputToken", type: "address" },
    { name: "inputAmount", type: "uint256" },
    { name: "outputToken", type: "address" },
    { name: "minOutputAmount", type: "uint256" },
    { name: "postHookTarget", type: "address" },
    { name: "postHookValue", type: "uint256" },
    { name: "postHookPayload", type: "bytes" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const OMNI_VM_SOLVER_ABI = [
  {
    type: "function",
    name: "fulfillOutcomeIntent",
    stateMutability: "payable",
    inputs: [
      {
        name: "_intent",
        type: "tuple",
        components: [
          { name: "sender", type: "address" },
          { name: "recipient", type: "address" },
          { name: "srcEid", type: "uint32" },
          { name: "dstEid", type: "uint32" },
          { name: "inputToken", type: "address" },
          { name: "inputAmount", type: "uint256" },
          { name: "outputToken", type: "address" },
          { name: "minOutputAmount", type: "uint256" },
          { name: "postHookTarget", type: "address" },
          { name: "postHookValue", type: "uint256" },
          { name: "postHookPayload", type: "bytes" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      {
        name: "_solverRouteInstructions",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "value", type: "uint256" },
          { name: "payload", type: "bytes" },
        ],
      },
      { name: "_settlementOptions", type: "bytes" },
    ],
    outputs: [{ name: "settlementGuid", type: "bytes32" }],
  },
  {
    type: "function",
    name: "fulfilledIntents",
    stateMutability: "view",
    inputs: [{ name: "intentId", type: "bytes32" }],
    outputs: [{ name: "solver", type: "address" }],
  },
] as const;

const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "transferFrom",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const WETH_ABI = [
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [{ name: "wad", type: "uint256" }],
    outputs: [],
  },
] as const;

const UNISWAP_V3_QUOTER_V2_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "quoteExactInput",
    stateMutability: "nonpayable",
    inputs: [
      { name: "path", type: "bytes" },
      { name: "amountIn", type: "uint256" },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96AfterList", type: "uint160[]" },
      { name: "initializedTicksCrossedList", type: "uint32[]" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

const UNISWAP_V3_ROUTER_ABI = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "exactInput",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "path", type: "bytes" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

export interface ChainDexInfrastructure {
  quoterV2: Address;
  swapRouter02: Address;
  weth: Address;
  usdc: Address;
}

export const DEX_INFRA_BY_CHAIN_ID: Record<number, ChainDexInfrastructure> = {
  1: {
    quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    swapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
  42161: {
    quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    swapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  },
  10: {
    quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    swapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    weth: "0x4200000000000000000000000000000000000006",
    usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  },
  8453: {
    quoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    swapRouter02: "0x2626664c2603336E57B271c5C0b26F421741e481",
    weth: "0x4200000000000000000000000000000000000006",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  11155111: {
    quoterV2: "0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3",
    swapRouter02: "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E",
    weth: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
    usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  },
  421614: {
    quoterV2: "0x2779a0CC1c3e0E44D2542EC3e79e3864Ae93Ef0B",
    swapRouter02: "0x101F443B4d1b059569D643917553c771E1b9663E",
    weth: "0x980B62Da83eFf3D4576C647993b0c1D7faf17c73",
    usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
  },
};

const V3_FEE_TIERS = [100, 500, 3000, 10000] as const;

export type RouteVenue =
  | "DIRECT_INVENTORY"
  | "UNIV3_SINGLE_HOP"
  | "UNIV3_MULTI_HOP_WETH"
  | "0X_AGGREGATOR"
  | "ODOS_AGGREGATOR";

export interface CandidateRoute {
  venue: RouteVenue;
  description: string;
  solverTokenIn: Address;
  solverAmountIn: bigint;
  expectedAmountOut: bigint;
  surplusOut: bigint;
  estimatedSwapGas: bigint;
  routeInstructions: SolidityInstruction[];
}

export interface SolverProfitabilityReport {
  isProfitable: boolean;
  intentId: Hex;
  chosenRoute: CandidateRoute;
  grossSurplusOutputToken: bigint;
  grossSurplusWeiEquivalent: bigint;
  dstExecutionGasWei: bigint;
  lzSettlementFeeWei: bigint;
  netProfitWei: bigint;
  reason?: string;
}

export interface AggregatorApiConfig {
  zeroXApiKey?: string;
  odosBaseUrl?: string;
  zeroXBaseUrl?: string;
}

const ZERO_X_CHAIN_SLUGS: Record<number, string> = {
  1: "ethereum",
  42161: "arbitrum",
  10: "optimism",
  8453: "base",
  11155111: "sepolia",
  421614: "arbitrum-sepolia",
};

const ODOS_CHAIN_IDS: Record<number, number> = {
  1: 1,
  42161: 42161,
  10: 10,
  8453: 8453,
};

export function encodeUniswapV3Path(tokens: Address[], fees: number[]): Hex {
  if (tokens.length < 2 || fees.length !== tokens.length - 1) {
    throw new Error("Invalid Uniswap V3 path arrays.");
  }
  const segments: Hex[] = [];
  for (let i = 0; i < fees.length; i++) {
    segments.push(tokens[i]);
    segments.push(pad(toHex(fees[i]), { size: 3 }));
  }
  segments.push(tokens[tokens.length - 1]);
  return concatHex(segments);
}

export function computeOutcomeIntentId(intent: OmniOutcomeIntent): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { name: "sender", type: "address" },
        { name: "recipient", type: "address" },
        { name: "srcEid", type: "uint32" },
        { name: "dstEid", type: "uint32" },
        { name: "inputToken", type: "address" },
        { name: "inputAmount", type: "uint256" },
        { name: "outputToken", type: "address" },
        { name: "minOutputAmount", type: "uint256" },
        { name: "postHookTarget", type: "address" },
        { name: "postHookValue", type: "uint256" },
        { name: "postHookPayloadHash", type: "bytes32" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
      [
        intent.sender,
        intent.recipient,
        intent.srcEid,
        intent.dstEid,
        intent.inputToken,
        intent.inputAmount,
        intent.outputToken,
        intent.minOutputAmount,
        intent.postHookTarget,
        intent.postHookValue,
        keccak256(intent.postHookPayload),
        intent.nonce,
        intent.deadline,
      ]
    )
  );
}

const VIEM_CHAINS_BY_ID: Record<number, Chain> = {
  [mainnet.id]: mainnet,
  [arbitrum.id]: arbitrum,
  [optimism.id]: optimism,
  [base.id]: base,
  [sepolia.id]: sepolia,
  [arbitrumSepolia.id]: arbitrumSepolia,
};

export interface SolverEngineConfig {
  solverPrivateKey: Hex;
  minNetProfitWei: bigint;
  settlementGasLimit: bigint;
  rpcUrlOverrides?: Partial<Record<number, string>>;
  omniVmAddressOverrides?: Partial<Record<number, Address>>;
}
export class OmniVmSolverEngine {
  private readonly account;
  private readonly config: SolverEngineConfig;
  private readonly publicClients = new Map<number, PublicClient>();
  private readonly walletClients = new Map<number, WalletClient>();
  private readonly chainConfigs = new Map<number, OmniChainConfig>();

  constructor(config: Partial<SolverEngineConfig> & { solverPrivateKey: Hex }) {
    if (!isHex(config.solverPrivateKey) || config.solverPrivateKey.length !== 66) {
      throw new Error("Invalid solverPrivateKey (expected 32-byte 0x hex).");
    }

    this.account = privateKeyToAccount(config.solverPrivateKey);
    this.config = {
      solverPrivateKey: config.solverPrivateKey,
      minNetProfitWei: config.minNetProfitWei ?? parseEther("0.0005"),
      settlementGasLimit: config.settlementGasLimit ?? 120_000n,
      rpcUrlOverrides: config.rpcUrlOverrides,
      omniVmAddressOverrides: config.omniVmAddressOverrides,
    };

    for (const baseCfg of SUPPORTED_CHAINS) {
      const viemChain = VIEM_CHAINS_BY_ID[baseCfg.chainId];
      if (!viemChain) continue;

      const cfg: OmniChainConfig = {
        ...baseCfg,
        omniVmAddress:
          config.omniVmAddressOverrides?.[baseCfg.lzEid] ??
          baseCfg.omniVmAddress,
      };

      const customRpcUrl = config.rpcUrlOverrides?.[cfg.lzEid];
      const transport = customRpcUrl ? http(customRpcUrl) : http();

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

  public get solverAddress(): Address {
    return this.account.address;
  }

  public async findOptimalDestinationRoute(params: {
    intent: OmniOutcomeIntent;
    solverSpendToken: Address;
    solverMaxSpendAmount: bigint;
    aggregatorConfig?: AggregatorApiConfig;
  }): Promise<CandidateRoute> {
    const { intent, solverSpendToken, solverMaxSpendAmount, aggregatorConfig } =
      params;
    const dstConfig = this.chainConfigs.get(intent.dstEid);
    if (!dstConfig) {
      throw new Error(`Unsupported destination EID: ${intent.dstEid}`);
    }

    const publicClient = this.publicClients.get(intent.dstEid)!;
    const dex = DEX_INFRA_BY_CHAIN_ID[dstConfig.chainId];
    if (!dex) {
      throw new Error(`No DEX infrastructure configured for ${dstConfig.name}`);
    }

    const results = await Promise.allSettled([
      Promise.resolve().then(() => {
        const isOutputMatch =
          intent.outputToken.toLowerCase() === solverSpendToken.toLowerCase() ||
          (intent.outputToken.toLowerCase() ===
            NATIVE_ETH_SENTINEL.toLowerCase() &&
            solverSpendToken.toLowerCase() === dex.weth.toLowerCase());

        if (isOutputMatch && solverMaxSpendAmount >= intent.minOutputAmount) {
          return {
            venue: "DIRECT_INVENTORY" as const,
            description: "Direct Solver Inventory Transfer",
            solverTokenIn: solverSpendToken,
            solverAmountIn: intent.minOutputAmount,
            expectedAmountOut: solverMaxSpendAmount,
            surplusOut: solverMaxSpendAmount - intent.minOutputAmount,
            estimatedSwapGas: 45_000n,
            routeInstructions: this.buildDirectInventoryInstructions(
              intent,
              dstConfig.omniVmAddress,
              dex.weth
            ),
          };
        }
        return null;
      }),

      this.queryUniswapV3Venues(
        intent,
        solverSpendToken,
        solverMaxSpendAmount,
        dstConfig.omniVmAddress,
        dex,
        publicClient
      ),

      this.queryZeroXApiQuote({
        intent,
        solverSpendToken,
        solverMaxSpendAmount,
        dstOmniVm: dstConfig.omniVmAddress,
        chainId: dstConfig.chainId,
        wethAddress: dex.weth,
        config: aggregatorConfig,
      }),

      this.queryOdosApiQuote({
        intent,
        solverSpendToken,
        solverMaxSpendAmount,
        dstOmniVm: dstConfig.omniVmAddress,
        chainId: dstConfig.chainId,
        wethAddress: dex.weth,
        config: aggregatorConfig,
      }),
    ]);

    const allCandidates: CandidateRoute[] = [];
    for (const res of results) {
      if (res.status === "fulfilled" && res.value !== null) {
        if (Array.isArray(res.value)) {
          allCandidates.push(...res.value);
        } else {
          allCandidates.push(res.value);
        }
      }
    }

    const validCandidates = allCandidates.filter(
      (r) => r !== null && r.expectedAmountOut >= intent.minOutputAmount
    );

    if (validCandidates.length === 0) {
      throw new Error(
        `NoFulfillableRoute: No venue or aggregator can satisfy minOutputAmount (${intent.minOutputAmount}).`
      );
    }

    validCandidates.sort((a, b) => {
      if (b.surplusOut !== a.surplusOut) {
        return b.surplusOut > a.surplusOut ? 1 : -1;
      }
      return a.estimatedSwapGas < b.estimatedSwapGas ? -1 : 1;
    });

    return validCandidates[0];
  }

  private async queryUniswapV3Venues(
    intent: OmniOutcomeIntent,
    solverSpendToken: Address,
    solverMaxSpendAmount: bigint,
    dstOmniVm: Address,
    dex: ChainDexInfrastructure,
    publicClient: PublicClient
  ): Promise<CandidateRoute[]> {
    const routes: CandidateRoute[] = [];

    const targetOutputToken =
      intent.outputToken.toLowerCase() === NATIVE_ETH_SENTINEL.toLowerCase()
        ? dex.weth
        : intent.outputToken;

    if (solverSpendToken.toLowerCase() === targetOutputToken.toLowerCase()) {
      return routes;
    }

    for (const fee of V3_FEE_TIERS) {
      try {
        const { result } = await publicClient.simulateContract({
          address: dex.quoterV2,
          abi: UNISWAP_V3_QUOTER_V2_ABI,
          functionName: "quoteExactInputSingle",
          args: [
            {
              tokenIn: solverSpendToken,
              tokenOut: targetOutputToken,
              amountIn: solverMaxSpendAmount,
              fee,
              sqrtPriceLimitX96: 0n,
            },
          ],
        });

        const [amountOut, , , gasEstimate] = result;
        if (amountOut >= intent.minOutputAmount) {
          const routeInstructions = this.buildSingleHopSwapInstructions({
            intent,
            dstOmniVm,
            swapRouter: dex.swapRouter02,
            tokenIn: solverSpendToken,
            amountIn: solverMaxSpendAmount,
            fee,
            wethAddress: dex.weth,
          });
          routes.push({
            venue: "UNIV3_SINGLE_HOP",
            description: `Uniswap V3 Single-Hop (fee=${fee / 10000}%)`,
            solverTokenIn: solverSpendToken,
            solverAmountIn: solverMaxSpendAmount,
            expectedAmountOut: amountOut,
            surplusOut: amountOut - intent.minOutputAmount,
            estimatedSwapGas: gasEstimate > 0n ? gasEstimate : 135_000n,
            routeInstructions,
          });
        }
      } catch {
        // Ignore uninitialized pool fee tier
      }
    }

    if (
      dex.weth.toLowerCase() !== solverSpendToken.toLowerCase() &&
      dex.weth.toLowerCase() !== targetOutputToken.toLowerCase()
    ) {
      const encodedPath = encodeUniswapV3Path(
        [solverSpendToken, dex.weth, targetOutputToken],
        [500, 500]
      );
      try {
        const { result } = await publicClient.simulateContract({
          address: dex.quoterV2,
          abi: UNISWAP_V3_QUOTER_V2_ABI,
          functionName: "quoteExactInput",
          args: [encodedPath, solverMaxSpendAmount],
        });

        const [amountOut, , , gasEstimate] = result;
        if (amountOut >= intent.minOutputAmount) {
          const routeInstructions = this.buildMultiHopSwapInstructions({
            intent,
            dstOmniVm,
            swapRouter: dex.swapRouter02,
            tokenIn: solverSpendToken,
            amountIn: solverMaxSpendAmount,
            encodedPath,
            wethAddress: dex.weth,
          });
          routes.push({
            venue: "UNIV3_MULTI_HOP_WETH",
            description: "Uniswap V3 Multi-Hop via WETH",
            solverTokenIn: solverSpendToken,
            solverAmountIn: solverMaxSpendAmount,
            expectedAmountOut: amountOut,
            surplusOut: amountOut - intent.minOutputAmount,
            estimatedSwapGas: gasEstimate > 0n ? gasEstimate : 195_000n,
            routeInstructions,
          });
        }
      } catch {
        // Ignore if multi-hop unavailable
      }
    }

    return routes;
  }

  private async queryZeroXApiQuote(params: {
    intent: OmniOutcomeIntent;
    solverSpendToken: Address;
    solverMaxSpendAmount: bigint;
    dstOmniVm: Address;
    chainId: number;
    wethAddress: Address;
    config?: AggregatorApiConfig;
  }): Promise<CandidateRoute | null> {
    const {
      intent,
      solverSpendToken,
      solverMaxSpendAmount,
      dstOmniVm,
      chainId,
      wethAddress,
      config,
    } = params;
    const chainSlug = ZERO_X_CHAIN_SLUGS[chainId];
    if (!chainSlug) return null;

    try {
      const targetBuyToken =
        intent.outputToken.toLowerCase() === NATIVE_ETH_SENTINEL.toLowerCase()
          ? wethAddress
          : intent.outputToken;

      if (solverSpendToken.toLowerCase() === targetBuyToken.toLowerCase()) {
        return null;
      }

      const baseUrl = config?.zeroXBaseUrl || `https://${chainSlug}.api.0x.org`;
      const url = new URL(`${baseUrl}/swap/v1/quote`);
      url.searchParams.append("sellToken", solverSpendToken);
      url.searchParams.append("buyToken", targetBuyToken);
      url.searchParams.append("sellAmount", solverMaxSpendAmount.toString());
      url.searchParams.append("takerAddress", dstOmniVm);

      const headers: Record<string, string> = {};
      if (config?.zeroXApiKey) {
        headers["0x-api-key"] = config.zeroXApiKey;
      }

      const res = await fetch(url.toString(), { headers });
      if (!res.ok) return null;

      const data = (await res.json()) as any;
      const buyAmount = BigInt(data.buyAmount || "0");
      if (buyAmount < intent.minOutputAmount) return null;

      const routerAddress = data.to as Address;
      const swapCalldata = data.data as Hex;
      if (!routerAddress || !isHex(swapCalldata)) return null;

      const estimatedGas = BigInt(data.estimatedGas || "180000");

      const routeInstructions = this.buildAggregatedSwapInstructions({
        intent,
        dstOmniVm,
        routerAddress,
        swapCalldata,
        swapValue: BigInt(data.value || "0"),
        solverTokenIn: solverSpendToken,
        solverAmountIn: solverMaxSpendAmount,
        wethAddress,
      });

      return {
        venue: "0X_AGGREGATOR",
        description: "0x API Aggregator Smart Order Route",
        solverTokenIn: solverSpendToken,
        solverAmountIn: solverMaxSpendAmount,
        expectedAmountOut: buyAmount,
        surplusOut: buyAmount - intent.minOutputAmount,
        estimatedSwapGas: estimatedGas,
        routeInstructions,
      };
    } catch {
      return null;
    }
  }

  private async queryOdosApiQuote(params: {
    intent: OmniOutcomeIntent;
    solverSpendToken: Address;
    solverMaxSpendAmount: bigint;
    dstOmniVm: Address;
    chainId: number;
    wethAddress: Address;
    config?: AggregatorApiConfig;
  }): Promise<CandidateRoute | null> {
    const {
      intent,
      solverSpendToken,
      solverMaxSpendAmount,
      dstOmniVm,
      chainId,
      wethAddress,
      config,
    } = params;
    const odosChainId = ODOS_CHAIN_IDS[chainId];
    if (!odosChainId) return null;

    try {
      const targetBuyToken =
        intent.outputToken.toLowerCase() === NATIVE_ETH_SENTINEL.toLowerCase()
          ? wethAddress
          : intent.outputToken;

      if (solverSpendToken.toLowerCase() === targetBuyToken.toLowerCase()) {
        return null;
      }

      const baseUrl = config?.odosBaseUrl || "https://api.odos.xyz";

      const quoteRes = await fetch(`${baseUrl}/sor/quote/v2`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chainId: odosChainId,
          inputTokens: [
            {
              tokenAddress: solverSpendToken,
              amount: solverMaxSpendAmount.toString(),
            },
          ],
          outputTokens: [{ tokenAddress: targetBuyToken, proportion: 1 }],
          slippageLimitPercent: 1.0,
          userAddr: dstOmniVm,
          pathViz: false,
        }),
      });

      if (!quoteRes.ok) return null;
      const quoteData = (await quoteRes.json()) as any;
      const outAmounts = quoteData.outAmounts?.[0];
      const buyAmount = outAmounts ? BigInt(outAmounts) : 0n;
      if (buyAmount < intent.minOutputAmount) return null;

      const pathId = quoteData.pathId;

      const assembleRes = await fetch(`${baseUrl}/sor/assemble`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userAddr: dstOmniVm,
          pathId,
          simulate: false,
        }),
      });

      if (!assembleRes.ok) return null;
      const assembleData = (await assembleRes.json()) as any;
      const transaction = assembleData.transaction;
      const routerAddress = transaction.to as Address;
      const swapCalldata = transaction.data as Hex;
      if (!routerAddress || !isHex(swapCalldata)) return null;

      const estimatedGas = BigInt(transaction.gas || "200000");

      const routeInstructions = this.buildAggregatedSwapInstructions({
        intent,
        dstOmniVm,
        routerAddress,
        swapCalldata,
        swapValue: BigInt(transaction.value || "0"),
        solverTokenIn: solverSpendToken,
        solverAmountIn: solverMaxSpendAmount,
        wethAddress,
      });

      return {
        venue: "ODOS_AGGREGATOR",
        description: "Odos API Aggregator Smart Order Route",
        solverTokenIn: solverSpendToken,
        solverAmountIn: solverMaxSpendAmount,
        expectedAmountOut: buyAmount,
        surplusOut: buyAmount - intent.minOutputAmount,
        estimatedSwapGas: estimatedGas,
        routeInstructions,
      };
    } catch {
      return null;
    }
  }

  private buildDirectInventoryInstructions(
    intent: OmniOutcomeIntent,
    _dstOmniVm: Address,
    wethAddress: Address
  ): SolidityInstruction[] {
    const isNativeEth =
      intent.outputToken.toLowerCase() === NATIVE_ETH_SENTINEL.toLowerCase();
    const targetToken = isNativeEth ? wethAddress : intent.outputToken;
    const finalRecipient = isNativeEth ? _dstOmniVm : intent.recipient;

    const instructions: SolidityInstruction[] = [
      {
        target: targetToken,
        value: 0n,
        payload: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "transferFrom",
          args: [this.solverAddress, finalRecipient, intent.minOutputAmount],
        }),
      },
    ];

    if (isNativeEth) {
      instructions.push({
        target: wethAddress,
        value: 0n,
        payload: encodeFunctionData({
          abi: WETH_ABI,
          functionName: "withdraw",
          args: [intent.minOutputAmount],
        }),
      });
      instructions.push({
        target: intent.recipient,
        value: intent.minOutputAmount,
        payload: "0x",
      });
    }

    if (intent.postHookTarget !== zeroAddress) {
      instructions.push({
        target: intent.postHookTarget,
        value: intent.postHookValue,
        payload: intent.postHookPayload,
      });
    }

    return instructions;
  }

  private buildSingleHopSwapInstructions(params: {
    intent: OmniOutcomeIntent;
    dstOmniVm: Address;
    swapRouter: Address;
    tokenIn: Address;
    amountIn: bigint;
    fee: number;
    wethAddress: Address;
  }): SolidityInstruction[] {
    const {
      intent,
      dstOmniVm,
      swapRouter,
      tokenIn,
      amountIn,
      fee,
      wethAddress,
    } = params;
    const isNativeEth =
      intent.outputToken.toLowerCase() === NATIVE_ETH_SENTINEL.toLowerCase();
    const tokenOut = isNativeEth ? wethAddress : intent.outputToken;
    const swapRecipient = isNativeEth ? dstOmniVm : intent.recipient;

    const instructions: SolidityInstruction[] = [
      {
        target: tokenIn,
        value: 0n,
        payload: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "transferFrom",
          args: [this.solverAddress, dstOmniVm, amountIn],
        }),
      },
      {
        target: tokenIn,
        value: 0n,
        payload: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "approve",
          args: [swapRouter, amountIn],
        }),
      },
      {
        target: swapRouter,
        value: 0n,
        payload: encodeFunctionData({
          abi: UNISWAP_V3_ROUTER_ABI,
          functionName: "exactInputSingle",
          args: [
            {
              tokenIn,
              tokenOut,
              fee,
              recipient: swapRecipient,
              amountIn,
              amountOutMinimum: intent.minOutputAmount,
              sqrtPriceLimitX96: 0n,
            },
          ],
        }),
      },
    ];

    if (isNativeEth) {
      instructions.push({
        target: wethAddress,
        value: 0n,
        payload: encodeFunctionData({
          abi: WETH_ABI,
          functionName: "withdraw",
          args: [intent.minOutputAmount],
        }),
      });
      instructions.push({
        target: intent.recipient,
        value: intent.minOutputAmount,
        payload: "0x",
      });
    }

    if (intent.postHookTarget !== zeroAddress) {
      instructions.push({
        target: intent.postHookTarget,
        value: intent.postHookValue,
        payload: intent.postHookPayload,
      });
    }

    return instructions;
  }

  private buildMultiHopSwapInstructions(params: {
    intent: OmniOutcomeIntent;
    dstOmniVm: Address;
    swapRouter: Address;
    tokenIn: Address;
    amountIn: bigint;
    encodedPath: Hex;
    wethAddress: Address;
  }): SolidityInstruction[] {
    const {
      intent,
      dstOmniVm,
      swapRouter,
      tokenIn,
      amountIn,
      encodedPath,
      wethAddress,
    } = params;
    const isNativeEth =
      intent.outputToken.toLowerCase() === NATIVE_ETH_SENTINEL.toLowerCase();
    const swapRecipient = isNativeEth ? dstOmniVm : intent.recipient;

    const instructions: SolidityInstruction[] = [
      {
        target: tokenIn,
        value: 0n,
        payload: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "transferFrom",
          args: [this.solverAddress, dstOmniVm, amountIn],
        }),
      },
      {
        target: tokenIn,
        value: 0n,
        payload: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "approve",
          args: [swapRouter, amountIn],
        }),
      },
      {
        target: swapRouter,
        value: 0n,
        payload: encodeFunctionData({
          abi: UNISWAP_V3_ROUTER_ABI,
          functionName: "exactInput",
          args: [
            {
              path: encodedPath,
              recipient: swapRecipient,
              amountIn,
              amountOutMinimum: intent.minOutputAmount,
            },
          ],
        }),
      },
    ];

    if (isNativeEth) {
      instructions.push({
        target: wethAddress,
        value: 0n,
        payload: encodeFunctionData({
          abi: WETH_ABI,
          functionName: "withdraw",
          args: [intent.minOutputAmount],
        }),
      });
      instructions.push({
        target: intent.recipient,
        value: intent.minOutputAmount,
        payload: "0x",
      });
    }

    if (intent.postHookTarget !== zeroAddress) {
      instructions.push({
        target: intent.postHookTarget,
        value: intent.postHookValue,
        payload: intent.postHookPayload,
      });
    }

    return instructions;
  }

  private buildAggregatedSwapInstructions(params: {
    intent: OmniOutcomeIntent;
    dstOmniVm: Address;
    routerAddress: Address;
    swapCalldata: Hex;
    swapValue: bigint;
    solverTokenIn: Address;
    solverAmountIn: bigint;
    wethAddress: Address;
  }): SolidityInstruction[] {
    const {
      intent,
      dstOmniVm,
      routerAddress,
      swapCalldata,
      swapValue,
      solverTokenIn,
      solverAmountIn,
      wethAddress,
    } = params;

    const isNativeEth =
      intent.outputToken.toLowerCase() === NATIVE_ETH_SENTINEL.toLowerCase();

    const instructions: SolidityInstruction[] = [
      {
        target: solverTokenIn,
        value: 0n,
        payload: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "transferFrom",
          args: [this.solverAddress, dstOmniVm, solverAmountIn],
        }),
      },
      {
        target: solverTokenIn,
        value: 0n,
        payload: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "approve",
          args: [routerAddress, solverAmountIn],
        }),
      },
      {
        target: routerAddress,
        value: swapValue,
        payload: swapCalldata,
      },
    ];

    if (isNativeEth) {
      instructions.push({
        target: wethAddress,
        value: 0n,
        payload: encodeFunctionData({
          abi: WETH_ABI,
          functionName: "withdraw",
          args: [intent.minOutputAmount],
        }),
      });
      instructions.push({
        target: intent.recipient,
        value: intent.minOutputAmount,
        payload: "0x",
      });
    }

    if (intent.postHookTarget !== zeroAddress) {
      instructions.push({
        target: intent.postHookTarget,
        value: intent.postHookValue,
        payload: intent.postHookPayload,
      });
    }

    return instructions;
  }

  public async evaluateProfitability(params: {
    intent: OmniOutcomeIntent;
    chosenRoute: CandidateRoute;
    outputTokenToWeiRate: bigint;
  }): Promise<SolverProfitabilityReport> {
    const { intent, chosenRoute, outputTokenToWeiRate } = params;
    const dstConfig = this.chainConfigs.get(intent.dstEid)!;
    const srcConfig = this.chainConfigs.get(intent.srcEid)!;
    const dstPublicClient = this.publicClients.get(intent.dstEid)!;

    const intentId = computeOutcomeIntentId(intent);

    const settlementOptions = buildLzReceiveOptions(
      this.config.settlementGasLimit,
      0n
    );
    const settlementMessage = encodeAbiParameters(
      [
        { name: "intentId", type: "bytes32" },
        { name: "solver", type: "address" },
      ],
      [intentId, this.solverAddress]
    );

    let lzSettlementFeeWei = parseEther("0.0004");
    try {
      const quote = await dstPublicClient.readContract({
        address: dstConfig.endpointV2,
        abi: LZ_ENDPOINT_V2_ABI,
        functionName: "quote",
        args: [
          {
            dstEid: srcConfig.lzEid,
            receiver: pad(srcConfig.omniVmAddress, { size: 32 }),
            message: settlementMessage,
            options: settlementOptions,
            payInLzToken: false,
          },
          dstConfig.omniVmAddress,
        ],
      });
      lzSettlementFeeWei = (quote.nativeFee * 10200n) / 10000n;
    } catch {
      // Use fallback estimate
    }

    const gasPrice = await dstPublicClient.getGasPrice();
    const totalEstimatedGas = chosenRoute.estimatedSwapGas + 110_000n;
    const dstExecutionGasWei = (totalEstimatedGas * gasPrice * 125n) / 100n;

    const grossSurplusWeiEquivalent =
      (chosenRoute.surplusOut * outputTokenToWeiRate) / 10n ** 18n;

    const netProfitWei =
      grossSurplusWeiEquivalent - dstExecutionGasWei - lzSettlementFeeWei;
    const isProfitable = netProfitWei >= this.config.minNetProfitWei;

    return {
      isProfitable,
      intentId,
      chosenRoute,
      grossSurplusOutputToken: chosenRoute.surplusOut,
      grossSurplusWeiEquivalent,
      dstExecutionGasWei,
      lzSettlementFeeWei,
      netProfitWei,
      reason: isProfitable
        ? undefined
        : `Net profit (${formatEther(
            netProfitWei
          )} ETH) below minimum threshold (${formatEther(
            this.config.minNetProfitWei
          )} ETH).`,
    };
  }

  public async solveAndFulfillIntent(params: {
    intent: OmniOutcomeIntent;
    solverSpendToken: Address;
    solverMaxSpendAmount: bigint;
    outputTokenToWeiRate?: bigint;
    aggregatorConfig?: AggregatorApiConfig;
  }): Promise<{
    txHash: Hex;
    settlementGuid: Hex;
    route: CandidateRoute;
    profitReport: SolverProfitabilityReport;
  }> {
    const {
      intent,
      solverSpendToken,
      solverMaxSpendAmount,
      outputTokenToWeiRate = 10n ** 18n,
      aggregatorConfig,
    } = params;

    const dstConfig = this.chainConfigs.get(intent.dstEid);
    if (!dstConfig) {
      throw new Error(`Unsupported destination EID: ${intent.dstEid}`);
    }

    const dstPublicClient = this.publicClients.get(intent.dstEid)!;
    const dstWalletClient = this.walletClients.get(intent.dstEid)!;
    const viemChain = VIEM_CHAINS_BY_ID[dstConfig.chainId]!;

    const route = await this.findOptimalDestinationRoute({
      intent,
      solverSpendToken,
      solverMaxSpendAmount,
      aggregatorConfig,
    });

    const profitReport = await this.evaluateProfitability({
      intent,
      chosenRoute: route,
      outputTokenToWeiRate,
    });

    if (!profitReport.isProfitable) {
      throw new Error(`UnprofitableIntent: ${profitReport.reason}`);
    }

    const currentAllowance = await dstPublicClient.readContract({
      address: route.solverTokenIn,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [this.solverAddress, dstConfig.omniVmAddress],
    });

    if (currentAllowance < route.solverAmountIn) {
      const { request: approveReq } = await dstPublicClient.simulateContract({
        account: this.account,
        chain: viemChain,
        address: route.solverTokenIn,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [dstConfig.omniVmAddress, route.solverAmountIn],
      });
      const approveHash = await dstWalletClient.writeContract(approveReq);
      await dstPublicClient.waitForTransactionReceipt({ hash: approveHash });
    }

    const settlementOptions = buildLzReceiveOptions(
      this.config.settlementGasLimit,
      0n
    );
    const totalMsgValue =
      profitReport.lzSettlementFeeWei + intent.postHookValue;

    const { request: fulfillReq, result: settlementGuid } =
      await dstPublicClient.simulateContract({
        account: this.account,
        chain: viemChain,
        address: dstConfig.omniVmAddress,
        abi: OMNI_VM_SOLVER_ABI,
        functionName: "fulfillOutcomeIntent",
        args: [intent, route.routeInstructions, settlementOptions],
        value: totalMsgValue,
      });

    const txHash = await dstWalletClient.writeContract(fulfillReq);

    return {
      txHash,
      settlementGuid,
      route,
      profitReport,
    };
  }
}
