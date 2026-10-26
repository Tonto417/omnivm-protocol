import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  Address,
  Hex,
  PublicClient,
  WalletClient,
  createPublicClient,
  createWalletClient,
  http,
  pad,
  parseEther,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { execa, ExecaChildProcess } from "execa";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OmniVmSolverEngine,
  OmniOutcomeIntent,
  OMNI_VM_SOLVER_ABI,
  computeOutcomeIntentId,
} from "../src/solver";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ANVIL_PORT = Number(process.env.ANVIL_TEST_PORT || 8555);
const ANVIL_RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;
const ARB_SEPOLIA_FORK_URL =
  process.env.ARB_SEPOLIA_RPC_URL || "https://sepolia-rollup.arbitrum.io/rpc";

const SEPOLIA_EID = 40161;
const ARB_SEPOLIA_EID = 40231;

const SOLVER_PK =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const USER_PK =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;

const SOLVER_ACCOUNT = privateKeyToAccount(SOLVER_PK);
const USER_ACCOUNT = privateKeyToAccount(USER_PK);

const ARB_SEPOLIA_WETH =
  "0x980B62Da83eFf3D4576C647993b0c1D7faf17c73" as Address;
const ARB_SEPOLIA_ENDPOINT =
  "0x6EDCE65403992e310A62460808c4b910D972f10f" as Address;

const WETH_ERC20_ABI = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "payable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const OAPP_ADMIN_ABI = [
  {
    type: "function",
    name: "setPeer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_eid", type: "uint32" },
      { name: "_peer", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

describe("OmniVmSolverEngine End-to-End Anvil Fork Suite", () => {
  let anvilProcess: ExecaChildProcess | undefined;
  let publicClient: PublicClient;
  let walletClient: WalletClient;
  let solverEngine: OmniVmSolverEngine;
  let omniVmAddress: Address;

  beforeAll(async () => {
    const artifactPath = join(__dirname, "../out/OmniVM.sol/OmniVM.json");
    if (!existsSync(artifactPath)) {
      throw new Error(
        `Missing Foundry artifact at ${artifactPath}. Run "forge build" before running Vitest.`
      );
    }
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));

    anvilProcess = execa("anvil", [
      "--fork-url",
      ARB_SEPOLIA_FORK_URL,
      "--port",
      String(ANVIL_PORT),
      "--chain-id",
      "421614",
      "--hardfork",
      "cancun",
    ]);

    publicClient = createPublicClient({
      chain: arbitrumSepolia,
      transport: http(ANVIL_RPC_URL),
    });

    let isOnline = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        await publicClient.getBlockNumber();
        isOnline = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (!isOnline) {
      throw new Error(`Anvil failed to bind to ${ANVIL_RPC_URL} within 10s.`);
    }

    walletClient = createWalletClient({
      account: SOLVER_ACCOUNT,
      chain: arbitrumSepolia,
      transport: http(ANVIL_RPC_URL),
    });

    await publicClient.request({
      method: "anvil_setBalance" as any,
      params: [SOLVER_ACCOUNT.address, "0x1158E460913D00000"],
    });

    const deployHash = await walletClient.deployContract({
      chain: arbitrumSepolia,
      account: SOLVER_ACCOUNT,
      abi: artifact.abi,
      bytecode: artifact.bytecode.object as Hex,
      args: [ARB_SEPOLIA_ENDPOINT, SOLVER_ACCOUNT.address],
    });

    const deployReceipt = await publicClient.waitForTransactionReceipt({
      hash: deployHash,
    });
    if (!deployReceipt.contractAddress) {
      throw new Error("OmniVM deployment did not return a contractAddress.");
    }
    omniVmAddress = deployReceipt.contractAddress;

    const peerBytes32 = pad(omniVmAddress, { size: 32 });
    const setPeerHash = await walletClient.writeContract({
      chain: arbitrumSepolia,
      account: SOLVER_ACCOUNT,
      address: omniVmAddress,
      abi: OAPP_ADMIN_ABI,
      functionName: "setPeer",
      args: [SEPOLIA_EID, peerBytes32],
    });
    await publicClient.waitForTransactionReceipt({ hash: setPeerHash });

    const wrapHash = await walletClient.writeContract({
      chain: arbitrumSepolia,
      account: SOLVER_ACCOUNT,
      address: ARB_SEPOLIA_WETH,
      abi: WETH_ERC20_ABI,
      functionName: "deposit",
      value: parseEther("5"),
    });
    await publicClient.waitForTransactionReceipt({ hash: wrapHash });

    solverEngine = new OmniVmSolverEngine({
      solverPrivateKey: SOLVER_PK,
      minNetProfitWei: 0n,
      rpcUrlOverrides: {
        [ARB_SEPOLIA_EID]: ANVIL_RPC_URL,
      },
      omniVmAddressOverrides: {
        [SEPOLIA_EID]: omniVmAddress,
        [ARB_SEPOLIA_EID]: omniVmAddress,
      },
    });
  }, 60_000);

  afterAll(async () => {
    if (anvilProcess) {
      anvilProcess.kill("SIGKILL");
      await anvilProcess.catch(() => undefined);
    }
  });

  it("discovers the optimal route, verifies positive spread, and fulfills the intent on-chain", async () => {
    const recipientBalanceBefore = await publicClient.readContract({
      address: ARB_SEPOLIA_WETH,
      abi: WETH_ERC20_ABI,
      functionName: "balanceOf",
      args: [USER_ACCOUNT.address],
    });

    const minOutputAmount = parseEther("0.10");
    const solverMaxSpendAmount = parseEther("0.105");

    const intent: OmniOutcomeIntent = {
      sender: USER_ACCOUNT.address,
      recipient: USER_ACCOUNT.address,
      srcEid: SEPOLIA_EID,
      dstEid: ARB_SEPOLIA_EID,
      inputToken: zeroAddress,
      inputAmount: parseEther("0.11"),
      outputToken: ARB_SEPOLIA_WETH,
      minOutputAmount,
      postHookTarget: zeroAddress,
      postHookValue: 0n,
      postHookPayload: "0x",
      nonce: 1n,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    };

    const expectedIntentId = computeOutcomeIntentId(intent);

    const route = await solverEngine.findOptimalDestinationRoute({
      intent,
      solverSpendToken: ARB_SEPOLIA_WETH,
      solverMaxSpendAmount,
    });

    expect(route.venue).toBe("DIRECT_INVENTORY");
    expect(route.expectedAmountOut).toBe(solverMaxSpendAmount);
    expect(route.surplusOut).toBe(parseEther("0.005"));

    const profitReport = await solverEngine.evaluateProfitability({
      intent,
      chosenRoute: route,
      outputTokenToWeiRate: parseEther("1"),
    });

    expect(profitReport.intentId).toBe(expectedIntentId);
    expect(profitReport.grossSurplusOutputToken).toBe(parseEther("0.005"));
    expect(profitReport.isProfitable).toBe(true);

    const execution = await solverEngine.solveAndFulfillIntent({
      intent,
      solverSpendToken: ARB_SEPOLIA_WETH,
      solverMaxSpendAmount,
      outputTokenToWeiRate: parseEther("1"),
    });

    const receipt = await publicClient.waitForTransactionReceipt({
      hash: execution.txHash,
    });
    expect(receipt.status).toBe("success");
    expect(execution.settlementGuid).not.toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000000"
    );

    const recipientBalanceAfter = await publicClient.readContract({
      address: ARB_SEPOLIA_WETH,
      abi: WETH_ERC20_ABI,
      functionName: "balanceOf",
      args: [USER_ACCOUNT.address],
    });
    expect(recipientBalanceAfter - recipientBalanceBefore).toBeGreaterThanOrEqual(
      minOutputAmount
    );

    const recordedSolver = await publicClient.readContract({
      address: omniVmAddress,
      abi: OMNI_VM_SOLVER_ABI,
      functionName: "fulfilledIntents",
      args: [expectedIntentId],
    });
    expect(recordedSolver.toLowerCase()).toBe(
      SOLVER_ACCOUNT.address.toLowerCase()
    );

    await expect(
      solverEngine.solveAndFulfillIntent({
        intent,
        solverSpendToken: ARB_SEPOLIA_WETH,
        solverMaxSpendAmount,
        outputTokenToWeiRate: parseEther("1"),
      })
    ).rejects.toThrow();
  });
});
