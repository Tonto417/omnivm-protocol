// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { OmniVM } from "../src/OmniVM.sol";
import { MockEndpointV2, ContextEchoTarget } from "./OmniVM.t.sol";
import { Origin } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oapp/OApp.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockERC20 is ERC20 {
    constructor() ERC20("Mock WETH", "WETH") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract OmniVMIntegrationTest is Test {
    uint32 internal constant SRC_EID = 40161;
    uint32 internal constant DST_EID = 40231;

    MockEndpointV2 internal srcEndpoint;
    MockEndpointV2 internal dstEndpoint;
    OmniVM internal srcOmniVm;
    OmniVM internal dstOmniVm;
    MockERC20 internal weth;
    ContextEchoTarget internal hookTarget;
    ContextEchoTarget internal untrustedRouteTarget;

    address internal user = address(0xBEEF);
    address internal solver = address(0xCAFE);

    function setUp() public {
        vm.deal(user, 50 ether);
        vm.deal(solver, 50 ether);

        srcEndpoint = new MockEndpointV2(SRC_EID);
        dstEndpoint = new MockEndpointV2(DST_EID);

        srcOmniVm = new OmniVM(address(srcEndpoint), address(this));
        dstOmniVm = new OmniVM(address(dstEndpoint), address(this));

        srcOmniVm.setPeer(DST_EID, bytes32(uint256(uint160(address(dstOmniVm)))));
        dstOmniVm.setPeer(SRC_EID, bytes32(uint256(uint160(address(srcOmniVm)))));

        weth = new MockERC20();
        weth.mint(solver, 10 ether);
        hookTarget = new ContextEchoTarget();
        untrustedRouteTarget = new ContextEchoTarget();
    }

    function test_CrossChainOutcomeFulfillmentAndEscrowSettlement() public {
        OmniVM.OmniOutcomeIntent memory intent = OmniVM.OmniOutcomeIntent({
            sender: user,
            recipient: user,
            srcEid: SRC_EID,
            dstEid: DST_EID,
            inputToken: address(0),
            inputAmount: 1.05 ether,
            outputToken: address(weth),
            minOutputAmount: 1 ether,
            postHookTarget: address(hookTarget),
            postHookValue: 0,
            postHookPayload: abi.encodeCall(
                ContextEchoTarget.executeWithContext,
                (address(dstOmniVm), 777)
            ),
            nonce: 0,
            deadline: block.timestamp + 1800
        });

        // 1. User opens intent on source chain and locks 1.05 ETH in escrow
        vm.prank(user);
        bytes32 intentId = srcOmniVm.openOutcomeIntent{value: 1.05 ether}(intent);
        assertEq(srcOmniVm.totalEscrowedNative(), 1.05 ether);

        // 2. Solver routes WETH transfer (and tries to read xMsgSender on an untrusted route target)
        OmniVM.Instruction[] memory route = new OmniVM.Instruction[](2);
        route[0] = OmniVM.Instruction({
            target: address(untrustedRouteTarget),
            value: 0,
            payload: abi.encodeCall(
                ContextEchoTarget.executeWithContext,
                (address(dstOmniVm), 111)
            )
        });
        route[1] = OmniVM.Instruction({
            target: address(weth),
            value: 0,
            payload: abi.encodeCall(weth.transferFrom, (solver, user, 1 ether))
        });

        vm.startPrank(solver);
        weth.approve(address(dstOmniVm), 1 ether);
        bytes32 settlementGuid = dstOmniVm.fulfillOutcomeIntent{value: 0.01 ether}(
            intent,
            route,
            ""
        );
        vm.stopPrank();

        assertTrue(settlementGuid != bytes32(0));
        assertEq(weth.balanceOf(user), 1 ether);

        // Solver route step CANNOT spoof xMsgSender, while postHookTarget receives authenticated context
        assertEq(untrustedRouteTarget.lastXSender(), address(0));
        assertEq(untrustedRouteTarget.lastXOrigin(), 0);
        assertEq(hookTarget.lastXSender(), user);
        assertEq(hookTarget.lastXOrigin(), SRC_EID);
        assertEq(hookTarget.recordedValue(), 777);

        // 3. Deliver 64-byte LayerZero settlement payload back to srcOmniVm
        uint256 solverBalanceBefore = solver.balance;
        bytes memory settlementMsg = abi.encode(intentId, solver);
        Origin memory origin = Origin({
            srcEid: DST_EID,
            sender: bytes32(uint256(uint160(address(dstOmniVm)))),
            nonce: 1
        });

        vm.prank(address(srcEndpoint));
        srcOmniVm.lzReceive(origin, settlementGuid, settlementMsg, address(this), "");

        assertEq(solver.balance - solverBalanceBefore, 1.05 ether);
        assertEq(srcOmniVm.totalEscrowedNative(), 0);
    }
}

