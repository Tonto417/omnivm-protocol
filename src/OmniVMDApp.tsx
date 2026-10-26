"use client";

import React, { useState } from "react";
import { SUPPORTED_CHAINS, buildLzReceiveOptions } from "./omniVmConfig";
import { parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export default function OmniVMDApp() {
  const [address, setAddress] = useState<string>("");
  const [privateKey, setPrivateKey] = useState<string>("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
  const [srcEid, setSrcEid] = useState<number>(SUPPORTED_CHAINS[0].lzEid);
  const [dstEid, setDstEid] = useState<number>(SUPPORTED_CHAINS[1].lzEid);
  const [recipient, setRecipient] = useState<string>("");
  const [inputAmount, setInputAmount] = useState<string>("0.1");
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

      const account = privateKeyToAccount(privateKey as `0x${string}`);
      const targetRecipient = recipient || address;
      const options = buildLzReceiveOptions(250000n, parseEther(inputAmount));

      const srcConfig = SUPPORTED_CHAINS.find((c) => c.lzEid === srcEid);
      if (!srcConfig) throw new Error("Invalid source chain configuration");

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
          target: targetRecipient as `0x${string}`,
          value: parseEther(inputAmount),
          payload: "0x" as `0x${string}`,
        },
      ];

      const message = {
        sender: address as `0x${string}`,
        refundRecipient: targetRecipient as `0x${string}`,
        srcEid: Number(srcEid),
        dstEid: Number(dstEid),
        instructions,
        totalNativeValue: parseEther(inputAmount),
        options: options as `0x${string}`,
        nonce: 0n,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
      };

      const signature = await account.signTypedData({
        domain,
        types,
        primaryType: "BatchDispatchIntent",
        message,
      });

      const payload = {
        sender: address,
        refundRecipient: targetRecipient,
        srcEid,
        dstEid,
        instructions: instructions.map((i) => ({
          target: i.target,
          value: i.value.toString(),
          payload: i.payload,
        })),
        totalNativeValue: parseEther(inputAmount).toString(),
        options,
        nonce: "0",
        deadline: message.deadline.toString(),
        signature,
      };

      setStatus("Sending payload to relayer daemon...");
      const res = await fetch("http://localhost:8787/relay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Relay request failed");
      setStatus(`Success! TxHash: ${data.receipt.txHash}`);
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
            <label className="block text-xs text-slate-400">Test Account Private Key</label>
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
            <span className="text-emerald-400 truncate">Connected: {address}</span>
            <button onClick={() => setAddress("")} className="text-red-400 underline ml-2">
              Disconnect
            </button>
           </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs text-slate-400 mb-1">Source EID</label>
            <select
              value={srcEid}
              onChange={(e) => setSrcEid(Number(e.target.value))}
              className="w-full bg-slate-800 p-2 rounded text-xs text-slate-200"
            >
              {SUPPORTED_CHAINS.map((c) => (
                <option key={c.lzEid} value={c.lzEid}>{c.shortName} ({c.lzEid})</option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="block text-xs text-slate-400 mb-1">Recipient Address</label>
          <input
            type="text"
            placeholder="0x... (defaults to self)"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            className="w-full bg-slate-800 p-2 rounded text-xs text-slate-200"
          />
        </div>

        <div>
          <label className="block text-xs text-slate-400 mb-1">Input Amount (ETH)</label>
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
        {status && <p className="text-xs text-amber-300 break-words mt-2">{status}</p>}
      </div>
    </main>
  );
}
