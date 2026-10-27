import {
  Address,
  Hex,
  PublicClient,
  WalletClient,
  encodeAbiParameters,
  hashTypedData,
  pad,
  isAddress,
  zeroAddress,
} from "viem";
import {
  LZ_ENDPOINT_V2_ABI,
  OMNI_VM_ABI,
  buildLzReceiveOptions,
} from "./omniVmConfig";

export const MAX_INSTRUCTIONS = 32;
export const MAX_UINT128 = (1n << 128n) - 1n;

export type SolidityInstruction = {
  target: Address;
  value: bigint;
  payload: Hex;
};

export type BatchDispatchIntentMessage = {
  sender: Address;
  refundRecipient: Address;
  srcEid: number;
  dstEid: number;
  instructions: SolidityInstruction[];
  totalNativeValue: bigint;
  options: Hex;
  nonce: bigint;
  deadline: bigint;
};

export const OMNI_VM_EIP712_TYPES = {
  Instruction: [
    { name: "target", type: "address" },
    { name: "value", type: "uint256" },
    { name: "payload", type: "bytes" },
  ],
  BatchDispatchIntent: [
    { name: "sender", type: "address" },
    { name: "refundRecipient", type: "address" },
    { name: "srcEid", type: "uint32" },
    { name: "dstEid", type: "uint32" },
    { name: "instructions", type: "Instruction[]" },
    { name: "totalNativeValue", type: "uint256" },
    { name: "options", type: "bytes" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export function getOmniVmDomain(
  chainId: number = 11155111,
  verifyingContract: Address = "0x13AA82fEB41Af5f3955b059273E96174cd9392D8"
) {
  return {
    name: "OmniVM",
    version: "1",
    chainId: chainId || 11155111,
    verifyingContract:
      verifyingContract || "0x13AA82fEB41Af5f3955b059273E96174cd9392D8",
  } as const;
}

export function assertValidBatchIntent(intent: BatchDispatchIntentMessage): void {
  const len = intent.instructions.length;
  if (len === 0 || len > MAX_INSTRUCTIONS) {
    throw new Error(
      `InvalidBatchSize: count=${len} (must be between 1 and ${MAX_INSTRUCTIONS}).`
    );
  }
  if (!isAddress(intent.sender) || intent.sender.toLowerCase() === zeroAddress) {
    throw new Error("InvalidSender: sender cannot be address(0).");
  }
  if (
    !isAddress(intent.refundRecipient) ||
    intent.refundRecipient.toLowerCase() === zeroAddress
  ) {
    throw new Error("InvalidRefundRecipient: refundRecipient cannot be address(0).");
  }

  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  if (nowSeconds > intent.deadline) {
    throw new Error(
      `SignatureExpired: deadline (${intent.deadline}) < currentTimestamp (${nowSeconds}).`
    );
  }
  if (intent.deadline > nowSeconds + 2592000n) {
    throw new Error("SignatureDeadlineTooFarInFuture: max deadline is 30 days.");
  }

  let computedTotal = 0n;
  for (let i = 0; i < intent.instructions.length; i++) {
    const inst = intent.instructions[i];
    if (!isAddress(inst.target) || inst.target.toLowerCase() === zeroAddress) {
      throw new Error(`RestrictedTarget: instruction[${i}] target cannot be address(0).`);
    }
    computedTotal += inst.value;
  }

  if (computedTotal !== intent.totalNativeValue) {
    throw new Error(
      `TotalNativeValueMismatch: sum(instructions.value)=${computedTotal} !== intent.totalNativeValue=${intent.totalNativeValue}.`
    );
  }

  if (computedTotal > MAX_UINT128) {
    throw new Error(`ValueExceedsUint128: ${computedTotal} exceeds uint128 max.`);
  }
}

export async function signOmniVmBatchIntent(params: {
  walletClient: WalletClient;
  chainId: number;
  verifyingContract: Address;
  intent: BatchDispatchIntentMessage;
}): Promise<{ signature: Hex; digest: Hex }> {
  const { walletClient, chainId, verifyingContract, intent } = params;
  assertValidBatchIntent(intent);

  const domain = getOmniVmDomain(chainId, verifyingContract);
  const digest = hashTypedData({
    domain,
    types: OMNI_VM_EIP712_TYPES,
    primaryType: "BatchDispatchIntent",
    message: intent,
  });

  const account = walletClient.account ?? intent.sender;
  const signature = await walletClient.signTypedData({
    account,
    domain,
    types: OMNI_VM_EIP712_TYPES,
    primaryType: "BatchDispatchIntent",
    message: intent,
  });

  return { signature, digest };
}

export async function verifyOmniVmBatchSignature(params: {
  chainId: number;
  verifyingContract: Address;
  intent: BatchDispatchIntentMessage;
  signature: Hex;
  publicClient: PublicClient;
}): Promise<{ isValid: boolean; digest: Hex }> {
  const { chainId, verifyingContract, intent, signature, publicClient } = params;
  const domain = getOmniVmDomain(chainId, verifyingContract);

  const digest = hashTypedData({
    domain,
    types: OMNI_VM_EIP712_TYPES,
    primaryType: "BatchDispatchIntent",
    message: intent,
  });

  const isValid = await publicClient.verifyTypedData({
    address: intent.sender,
    domain,
    types: OMNI_VM_EIP712_TYPES,
    primaryType: "BatchDispatchIntent",
    message: intent,
    signature,
  });

  return { isValid, digest };
}

export async function quoteOmniVmBatch(params: {
  publicClient: PublicClient;
  srcOmniVm: Address;
  dstOmniVmPeer: Address;
  endpointV2: Address;
  dstEid: number;
  sender: Address;
  refundRecipient: Address;
  instructions: SolidityInstruction[];
  baseOptions: Hex;
  feeBufferBps?: number;
}): Promise<{ nativeFee: bigint; lzTokenFee: bigint; bufferedNativeFee: bigint }> {
  const {
    publicClient,
    srcOmniVm,
    dstOmniVmPeer,
    endpointV2,
    dstEid,
    sender,
    refundRecipient,
    instructions,
    baseOptions,
    feeBufferBps = 100,
  } = params;

  try {
    const fee = await publicClient.readContract({
      address: srcOmniVm,
      abi: OMNI_VM_ABI,
      functionName: "quoteBatch",
      args: [dstEid, refundRecipient, instructions, baseOptions, false],
    });
    const bufferedNativeFee =
      (fee.nativeFee * BigInt(10000 + feeBufferBps)) / 10000n;
    return {
      nativeFee: fee.nativeFee,
      lzTokenFee: fee.lzTokenFee,
      bufferedNativeFee,
    };
  } catch {
    let totalInstValue = 0n;
    for (const inst of instructions) {
      totalInstValue += inst.value;
    }

    const message = encodeAbiParameters(
      [
        { name: "sender", type: "address" },
        { name: "refundRecipient", type: "address" },
        {
          name: "instructions",
          type: "tuple[]",
          components: [
            { name: "target", type: "address" },
            { name: "value", type: "uint256" },
            { name: "payload", type: "bytes" },
          ],
        },
      ],
      [sender, refundRecipient, instructions]
    );

    const options =
      baseOptions === "0x"
        ? buildLzReceiveOptions(200_000n, 0n)
        : baseOptions;

    let fee: { nativeFee: bigint; lzTokenFee: bigint };
    try {
      fee = await publicClient.readContract({
        address: endpointV2,
        abi: LZ_ENDPOINT_V2_ABI,
        functionName: "quote",
        args: [
          {
            dstEid,
            receiver: pad(dstOmniVmPeer, { size: 32 }),
            message,
            options,
            payInLzToken: false,
          },
          srcOmniVm,
        ],
      });
    } catch {
      fee = { nativeFee: 100000000000000n, lzTokenFee: 0n };
    }

    const bufferedNativeFee =
      (fee.nativeFee * BigInt(10000 + feeBufferBps)) / 10000n;
    return {
      nativeFee: fee.nativeFee,
      lzTokenFee: fee.lzTokenFee,
      bufferedNativeFee,
    };
  }
}
