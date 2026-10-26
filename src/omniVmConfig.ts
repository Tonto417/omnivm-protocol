import { Address, Hex, concatHex, pad, toHex, http } from "viem";
import { createConfig } from "wagmi";
import {
  mainnet,
  arbitrum,
  optimism,
  base,
  sepolia,
  arbitrumSepolia,
} from "viem/chains";

export interface OmniChainConfig {
  chainId: number;
  lzEid: number;
  name: string;
  shortName: string;
  endpointV2: Address;
  omniVmAddress: Address;
  blockExplorerUrl: string;
}

export const SUPPORTED_CHAINS: OmniChainConfig[] = [
  {
    chainId: sepolia.id,
    lzEid: 40161,
    name: "Ethereum Sepolia",
    shortName: "SEP",
    endpointV2: "0x6EDCE65403992e310A62460808c4b910D972f10f",
    omniVmAddress: "0x13AA82fEB41Af5f3955b059273E96174cd9392D8" as Address,
    blockExplorerUrl: "https://sepolia.etherscan.io",
  },
  {
    chainId: arbitrumSepolia.id,
    lzEid: 40231,
    name: "Arbitrum Sepolia",
    shortName: "ARB-SEP",
    endpointV2: "0x6EDCE65403992e310A62460808c4b910D972f10f",
    omniVmAddress: "0x13AA82fEB41Af5f3955b059273E96174cd9392D8" as Address,
    blockExplorerUrl: "https://sepolia.arbiscan.io",
  },
  {
    chainId: mainnet.id,
    lzEid: 30101,
    name: "Ethereum Mainnet",
    shortName: "ETH",
    endpointV2: "0x1a44076050125825900e736c501f859c50fE728c",
    omniVmAddress: "0x000000000000000000000000000000000000dEaD" as Address,
    blockExplorerUrl: "https://etherscan.io",
  },
  {
    chainId: arbitrum.id,
    lzEid: 30110,
    name: "Arbitrum One",
    shortName: "ARB",
    endpointV2: "0x1a44076050125825900e736c501f859c50fE728c",
    omniVmAddress: "0x000000000000000000000000000000000000dEaD" as Address,
    blockExplorerUrl: "https://arbiscan.io",
  },
  {
    chainId: optimism.id,
    lzEid: 30111,
    name: "Optimism",
    shortName: "OP",
    endpointV2: "0x1a44076050125825900e736c501f859c50fE728c",
    omniVmAddress: "0x000000000000000000000000000000000000dEaD" as Address,
    blockExplorerUrl: "https://optimistic.etherscan.io",
  },
  {
    chainId: base.id,
    lzEid: 30184,
    name: "Base",
    shortName: "BASE",
    endpointV2: "0x1a44076050125825900e736c501f859c50fE728c",
    omniVmAddress: "0x000000000000000000000000000000000000dEaD" as Address,
    blockExplorerUrl: "https://basescan.org",
  },
];

export function buildLzReceiveOptions(
  gasLimit: bigint,
  nativeValue: bigint = 0n
): Hex {
  const type3Header = "0x0003" as Hex;
  const workerId = "0x01" as Hex;
  const optionTypeLzReceive = "0x01" as Hex;
  const gasHex = pad(toHex(gasLimit), { size: 16 });

  if (nativeValue === 0n) {
    const lengthHex = pad(toHex(17), { size: 2 });
    return concatHex([
      type3Header,
      workerId,
      lengthHex,
      optionTypeLzReceive,
      gasHex,
    ]);
  }

  const valueHex = pad(toHex(nativeValue), { size: 16 });
  const lengthHex = pad(toHex(33), { size: 2 });
  return concatHex([
    type3Header,
    workerId,
    lengthHex,
    optionTypeLzReceive,
    gasHex,
    valueHex,
  ]);
}

export const LZ_ENDPOINT_V2_ABI = [
  {
    type: "function",
    name: "quote",
    stateMutability: "view",
    inputs: [
      {
        name: "_params",
        type: "tuple",
        components: [
          { name: "dstEid", type: "uint32" },
          { name: "receiver", type: "bytes32" },
          { name: "message", type: "bytes" },
          { name: "options", type: "bytes" },
          { name: "payInLzToken", type: "bool" },
        ],
      },
      { name: "_sender", type: "address" },
    ],
    outputs: [
      {
        name: "fee",
        type: "tuple",
        components: [
          { name: "nativeFee", type: "uint256" },
          { name: "lzTokenFee", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "eid",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint32" }],
  },
] as const;

export const OMNI_VM_ABI = [
  {
    type: "function",
    name: "xMsgSender",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "sender", type: "address" }],
  },
  {
    type: "function",
    name: "xMsgOrigin",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "origin", type: "uint32" }],
  },
  {
    type: "function",
    name: "nonces",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "quoteBatch",
    stateMutability: "view",
    inputs: [
      { name: "_dstEid", type: "uint32" },
      { name: "_refundRecipient", type: "address" },
      {
        name: "_instructions",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "value", type: "uint256" },
          { name: "payload", type: "bytes" },
        ],
      },
      { name: "_options", type: "bytes" },
      { name: "_payInLzToken", type: "bool" },
    ],
    outputs: [
      {
        name: "fee",
        type: "tuple",
        components: [
          { name: "nativeFee", type: "uint256" },
          { name: "lzTokenFee", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "dispatchBatch",
    stateMutability: "payable",
    inputs: [
      { name: "_dstEid", type: "uint32" },
      { name: "_refundRecipient", type: "address" },
      {
        name: "_instructions",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "value", type: "uint256" },
          { name: "payload", type: "bytes" },
        ],
      },
      { name: "_options", type: "bytes" },
    ],
    outputs: [{ name: "guid", type: "bytes32" }],
  },
  {
    type: "function",
    name: "dispatchBatchWithSig",
    stateMutability: "payable",
    inputs: [
      { name: "_sender", type: "address" },
      { name: "_refundRecipient", type: "address" },
      { name: "_dstEid", type: "uint32" },
      {
        name: "_instructions",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "value", type: "uint256" },
          { name: "payload", type: "bytes" },
        ],
      },
      { name: "_options", type: "bytes" },
      { name: "_deadline", type: "uint256" },
      { name: "_signature", type: "bytes" },
    ],
    outputs: [{ name: "guid", type: "bytes32" }],
  },
  {
    type: "event",
    name: "BatchDispatched",
    inputs: [
      { name: "dstEid", type: "uint32", indexed: true },
      { name: "guid", type: "bytes32", indexed: true },
      { name: "sender", type: "address", indexed: true },
      { name: "refundRecipient", type: "address", indexed: false },
      { name: "instructionCount", type: "uint256", indexed: false },
      { name: "totalNativeValue", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "BatchExecuted",
    inputs: [
      { name: "srcEid", type: "uint32", indexed: true },
      { name: "guid", type: "bytes32", indexed: true },
      { name: "originalSender", type: "address", indexed: true },
      { name: "instructionCount", type: "uint256", indexed: false },
    ],
  },
  { type: "error", name: "RestrictedTarget", inputs: [{ name: "target", type: "address" }] },
  { type: "error", name: "InsufficientPayment", inputs: [{ name: "required", type: "uint256" }, { name: "provided", type: "uint256" }] },
  { type: "error", name: "InvalidBatchSize", inputs: [{ name: "count", type: "uint256" }, { name: "max", type: "uint256" }] },
  { type: "error", name: "ValueExceedsUint128", inputs: [{ name: "value", type: "uint256" }] },
  { type: "error", name: "InsufficientMsgValue", inputs: [{ name: "required", type: "uint256" }, { name: "remaining", type: "uint256" }] },
  { type: "error", name: "InvalidRefundRecipient", inputs: [] },
  { type: "error", name: "SignatureExpired", inputs: [{ name: "deadline", type: "uint256" }, { name: "currentTimestamp", type: "uint256" }] },
  { type: "error", name: "InvalidIntentSignature", inputs: [] },
  { type: "error", name: "IntentAlreadyFulfilled", inputs: [{ name: "intentId", type: "bytes32" }] },
  { type: "error", name: "IntentAlreadyExists", inputs: [{ name: "intentId", type: "bytes32" }] },
  { type: "error", name: "InvalidEndpointId", inputs: [{ name: "expected", type: "uint32" }, { name: "provided", type: "uint32" }] },
  { type: "error", name: "InvalidEscrowState", inputs: [{ name: "intentId", type: "bytes32" }] },
  { type: "error", name: "EscrowNotExpired", inputs: [{ name: "deadline", type: "uint256" }, { name: "currentTimestamp", type: "uint256" }] },
  { type: "error", name: "InsufficientSolverOutput", inputs: [{ name: "received", type: "uint256" }, { name: "required", type: "uint256" }] },
  { type: "error", name: "TransferFailed", inputs: [] },
  { type: "error", name: "NoPeer", inputs: [{ name: "eid", type: "uint32" }] },
] as const;

export const wagmiConfig = createConfig({
  chains: [sepolia, arbitrumSepolia, mainnet, arbitrum, optimism, base],
  transports: {
    [sepolia.id]: http(),
    [arbitrumSepolia.id]: http(),
    [mainnet.id]: http(),
    [arbitrum.id]: http(),
    [optimism.id]: http(),
    [base.id]: http(),
  },
});

