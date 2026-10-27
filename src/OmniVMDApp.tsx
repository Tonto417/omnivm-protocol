"use client";

import React, { useState } from "react";
import {
  SUPPORTED_CHAINS,
  OMNI_VM_ABI,
  buildLzReceiveOptions,
} from "./omniVmConfig";
import { Chain, createPublicClient, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  mainnet,
  arbitrum,
  optimism,
  base,
  sepolia,
  arbitrumSepolia,
} from "viem/chains";

const VIEM_CHAINS_BY_ID: Record<number, Chain> = {
  [mainnet.id]: mainnet,
  [arbitrum.id]: arbitrum,
  [optimism.id]: optimism,
  [base.id]: base,
  [sepolia.id]: sepolia,
  [arbitrumSepolia.id]: arbitrumSepolia,
};

export default function OmniVMDApp() {
  const [address, setAddress] = useState<string>("");
  const [privateKey, setPrivateKey] = useState<string>(
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
  );
  const [srcEid, setSrcEid] = useState<number>(SUPPORTED_CHAINS[0].lzEid);
  const [dstEid, setDstEid] = useState<number>(SUPPORTED_CHAINS[1].lzEid);
  const [recipient, setRecipient] = useState<string>("");
  const [inputAmount, setInputAmount] = useState<string>("0.001");
  const [status, setStatus] = useState<string>("");

  const connectTestWallet = () => {
    try {
      const account = privateKeyToAccount(privateKey as `0x${string}`);
      setAddress(account.address);
      setStatus("Test wallet connected successfully!");
    } catch (err: any) {
      setStatus(`Invalid private key: ${err.message}`);
    }
  };

  const handleRelay = async () => {
    try {
      setStatus("Preparing and signing intent message...");
      if (!address || !privateKey) throw new Error("Wallet not connected");
      if (srcEid === dstEid) {
        throw new Error("Source and Destination chains must be different");
      }

      const account = privateKeyToAccount(privateKey as `0x${string}`);
      const targetRecipient = (recipient || address) as `0x${string}`;
      const valueWei = parseEther(inputAmount);

      // Pass 0n for nativeValue here because OmniVM.sol automatically appends
      // addExecutorLzReceiveOption(0, uint128(totalInstValue)) on-chain!
      const options = buildLzReceiveOptions(250000n, 0n);

      const srcConfig = SUPPORTED_CHAINS.find((c) => c.lzEid === srcEid);
      if (!srcConfig) throw new Error("Invalid source chain configuration");

      const viemChain = VIEM_CHAINS_BY_ID[srcConfig.chainId];
      if (!viemChain) throw new Error("Unsupported Viem chain");

      const publicClient = createPublicClient({
        chain: viemChain,
        transport: http(),
      });

      let currentNonce = 0n;
      try {
        currentNonce = (await publicClient.readContract({
        address: srcConfig.omniVmAddress,
        abi: OMNI_VM_ABI,
        functionName: "nonces",
        args: [account.address],
      })) as bigint;
      } catch {
        currentNonce = 0n;
      }

      const domain = {
        name: "OmniVM",
        version: "1",
        chainId: srcConfig.chainId,
        verifyingContract: srcConfig.omniVmAddress,
      };

      const types = {
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
        Instruction: [
          { name: "target", type: "address" },
          { name: "value", type: "uint256" },
          { name: "payload", type: "bytes" },
        ],
      };

      const instructions = [
        {
          target: targetRecipient,
          value: valueWei,
          payload: "0x" as `0x${string}`,
        },
      ];

      const message = {
        sender: account.address,
        refundRecipient: targetRecipient,
        srcEid: Number(srcEid),
        dstEid: Number(dstEid),
        instructions,
        totalNativeValue: valueWei,
        options: options as `0x${string}`,
        nonce: currentNonce,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
      };

      const signature = await account.signTypedData({
        domain,
        types,
        primaryType: "BatchDispatchIntent",
        message,
      });

      const payload = {
        sender: account.address,
        refundRecipient: targetRecipient,
        srcEid,
        dstEid,
        instructions: instructions.map((i) => ({
          target: i.target,
          value: i.value.toString(),
          payload: i.payload,
        })),
        totalNativeValue: valueWei.toString(),
        options,
        nonce: currentNonce.toString(),
        deadline: message.deadline.toString(),
        signature,
      };

      setStatus(
        `Sending payload (nonce: ${currentNonce.toString()}) to relayer daemon...`
      );
      const res = await fetch("http://localhost:8787/relay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Relay request failed");
      setStatus(
        `Success! TxHash: ${data.receipt.txHash} | GUID: ${data.receipt.guid}`
      );
    } catch (err: any) {
      setStatus(`Error: ${err?.message || err}`);
    }
  };

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 p-6 font-mono max-w-xl mx-auto space-y-4">
      <h1 className="text-xl font-bold text-emerald-400">
        OmniVM Execution Console
      </h1>
      <div className="bg-slate-900 p-4 rounded-lg border border-slate-800 space-y-3">
        {!address ? (
          <div className="space-y-2">
            <label className="block text-xs text-slate-400">
              Test Account Private Key
            </label>
            <input
              type="text"
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              className="w-full bg-slate-800 p-2 rounded text-xs text-slate-200"
            />
            <button
              onClick={connectTestWallet}
              className="w-full bg-emerald-600 hover:bg-emerald-500 py-2 rounded font-bold text-sm text-white"
            >
              Load Test Wallet
            </button>
          </div>
        ) : (
          <div className="flex justify-between items-center text-xs bg-slate-800 p-2 rounded">
            <span className="text-emerald-400 truncate">
              Connected: {address}
            </span>
            <button
              onClick={() => setAddress("")}
              className="text-red-400 underline ml-2"
            >
              Disconnect
            </button>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs text-slate-400 mb-1">
              Source EID
            </label>
            <select
              value={srcEid}
              onChange={(e) => setSrcEid(Number(e.target.value))}
              className="w-full bg-slate-800 p-2 rounded text-xs text-slate-200"
            >
              {SUPPORTED_CHAINS.map((c) => (
                <option key={c.lzEid} value={c.lzEid}>
                  {c.shortName} ({c.lzEid})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs text-slate-400 mb-1">
              Destination EID
            </label>
            <select
              value={dstEid}
              onChange={(e) => setDstEid(Number(e.target.value))}
              className="w-full bg-slate-800 p-2 rounded text-xs text-slate-200"
            >
              {SUPPORTED_CHAINS.map((c) => (
                <option key={c.lzEid} value={c.lzEid}>
                  {c.shortName} ({c.lzEid})
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="block text-xs text-slate-400 mb-1">
            Recipient Address
          </label>
          <input
            type="text"
            placeholder="0x... (defaults to self)"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            className="w-full bg-slate-800 p-2 rounded text-xs text-slate-200"
          />
        </div>

        <div>
          <label className="block text-xs text-slate-400 mb-1">
            Input Amount (ETH)
          </label>
          <input
            type="text"
            value={inputAmount}
            onChange={(e) => setInputAmount(e.target.value)}
            className="w-full bg-slate-800 p-2 rounded text-xs text-slate-200"
          />
        </div>

        <button
          onClick={handleRelay}
          className="w-full bg-blue-600 hover:bg-blue-500 py-2 rounded font-bold text-sm text-white"
        >
          Sign & Dispatch to Relayer
        </button>
        {status && (
          <p className="text-xs text-amber-300 break-words mt-2">{status}</p>
        )}
      </div>
    </main>
  );
}

