# OmniVM Protocol

A production-ready LayerZero V2 omnichain execution environment featuring EIP-712 cryptographic intent batch dispatching, an automated Node.js/TypeScript backend relayer daemon, and a Next.js frontend execution console.

---

## Architecture & Features

* **LayerZero V2 Integration**: Leverages LayerZero endpoints and ultra-light-node messaging to securely route cross-chain payloads and manage destination peer configurations.
* **EIP-712 Intent Signing**: Cryptographically secures batch dispatch execution requests using structured typed data verification (`BatchDispatchIntent`), preventing unauthorized transaction relaying.
* **Backend Relayer Daemon**: Automates on-chain fee quoting, nonce tracking, and transaction broadcasting on testnets.
* **Next.js Frontend Console**: Provides a web-based dashboard for connecting test wallets, specifying source/destination EIDs, adjusting native drop values, and dispatching signed cross-chain batches.

---

## Tech Stack

* **Smart Contracts**: Solidity, Foundry, LayerZero V2 Contracts (`lib/devtools`, `lib/forge-std`)
* **Backend Relayer**: TypeScript, Viem, Node.js (`tsx`)
* **Frontend DApp**: Next.js (App Router), React, Tailwind CSS, Viem

---

## Project Structure

```text
├── script/                  # Foundry deployment scripts (DeployOmniVM.s.sol)
├── src/
│   ├── OmniVM.sol           # Core omnichain execution contract
│   ├── OmniVMDApp.tsx       # Next.js frontend execution console component
│   ├── relayer.ts           # Backend HTTP intent ingestion and broadcast daemon
│   ├── signer.ts            # EIP-712 signing utilities and message hashing
│   └── omniVmConfig.ts      # Chain configuration and LayerZero options builder
├── test/                    # Foundry and TypeScript test suites
├── foundry.toml             # Foundry configuration
└── package.json             # Node.js dependencies and build scripts

Getting Started
​
 Prerequisites
​  
  •Node.js (v18+)
  •​Foundry (Forge / Cast)
 ​
 Installation

  1. Clone the repository:
   
     git clone [https://github.com/YOUR_GITHUB_USERNAME/omnivm-protocol.git](https://github.com/YOUR_GITHUB_USERNAME/omnivm-protocol.git)
     cd omnivm-protocol

  2. Install dependencies:

     npm install
     forge install
 
  3. Configure environment variables:
     Create a .env file in the root directory based on .env.example:

     RELAYER_PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE

Running the Application
  ​1. Start the Backend Relayer Daemon

     npm run relayer
   
     Listens for incoming signed intent payloads on http://0.0.0.0:8787/relay.
​  
  2. Launch the Frontend Development Server
  
     npm run dev

Access the execution console in your browser at http://localhost:3000.
​
  Testing
​
   Run smart contract unit and integration tests using Foundry:

   forge test

License
​  This project is licensed under the MIT License.
