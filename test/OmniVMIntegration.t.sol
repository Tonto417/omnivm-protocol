// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { OmniVM } from "../src/OmniVM.sol";
import { MockEndpointV2, ContextEchoTarget } from "./OmniVM.t.sol";
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
    }

    function test_CrossChainOutcomeFulfillmentAndPostHookContext() public {
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

        OmniVM.Instruction[] memory route = new OmniVM.Instruction[](2);
        route[0] = OmniVM.Instruction({
            target: address(weth),
            value: 0,
            payload: abi.encodeCall(weth.transferFrom, (solver, user, 1 ether))
        });
        route[1] = OmniVM.Instruction({
            target: intent.postHookTarget,
            value: intent.postHookValue,
            payload: intent.postHookPayload
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
        assertEq(hookTarget.lastXSender(), user);
        assertEq(hookTarget.lastXOrigin(), SRC_EID);
        assertEq(hookTarget.recordedValue(), 777);
    }
}
