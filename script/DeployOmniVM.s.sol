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

        vm.startBroadcast(deployerPk);

        omniVm = new OmniVM{salt: DEPLOY_SALT}(endpoint, deployer);
        console2.log("OmniVM deployed deterministically at:", address(omniVm));

        uint32 remoteEid = uint32(vm.envOr("REMOTE_EID", uint256(0)));
        address remotePeer = vm.envOr("REMOTE_PEER", address(0));
        if (remoteEid != 0 && remotePeer != address(0)) {
            omniVm.setPeer(remoteEid, bytes32(uint256(uint160(remotePeer))));
            console2.log("Wired remote peer EID:", remoteEid, "->", remotePeer);
        }

        vm.stopBroadcast();
    }
}
