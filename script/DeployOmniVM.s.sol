// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script, console2 } from "forge-std/Script.sol";
import { OmniVM } from "../src/OmniVM.sol";

contract DeployOmniVM is Script {
    bytes32 public constant DEPLOY_SALT = keccak256("OMNIVM_V1_CREATE2_SALT");

    function run() external returns (OmniVM omniVm) {
        uint256 deployerPk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPk);
        address endpoint = vm.envOr(
            "LZ_ENDPOINT_V2",
            address(0x6EDCE65403992e310A62460808c4b910D972f10f)
        );

        // Precompute CREATE2 address for verification
        bytes memory creationCode = type(OmniVM).creationCode;
        bytes memory encodedCtor = abi.encode(endpoint, deployer);
        bytes32 initCodeHash = keccak256(abi.encodePacked(creationCode, encodedCtor));
        address predictedAddress = vm.computeCreate2Address(DEPLOY_SALT, initCodeHash, address(this));

        console2.log("=========================================");
        console2.log("OmniVM Deterministic Deployment (CREATE2)");
        console2.log("=========================================");
        console2.log("Deployer / Owner:", deployer);
        console2.log("LayerZero Endpoint V2:", endpoint);
        console2.log("Predicted CREATE2 Address:", predictedAddress);
        console2.log("=========================================");

        vm.startBroadcast(deployerPk);

        omniVm = new OmniVM{salt: DEPLOY_SALT}(endpoint, deployer);
        
        require(address(omniVm) == predictedAddress, "Deployment address mismatch");
        console2.log("OmniVM successfully deployed at:", address(omniVm));

        // Wire primary remote peer if provided
        uint32 remoteEid = uint32(vm.envOr("REMOTE_EID", uint256(0)));
        address remotePeer = vm.envOr("REMOTE_PEER", address(0));
        if (remoteEid != 0 && remotePeer != address(0)) {
            omniVm.setPeer(remoteEid, bytes32(uint256(uint160(remotePeer))));
            console2.log("Wired remote peer EID:", remoteEid, "->", remotePeer);
        }

        vm.stopBroadcast();
    }
}
