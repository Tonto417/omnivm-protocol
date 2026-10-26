// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { OmniVM } from "../src/OmniVM.sol";
import { Origin, MessagingFee } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oapp/OApp.sol";
import { MessagingParams, MessagingReceipt } from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";

contract MockEndpointV2 {
    uint32 public eid;
    address public delegate;
    uint256 public mockNativeFee = 0.001 ether;
    uint256 private _nonce;

    constructor(uint32 _eid) {
        eid = _eid;
    }

    function setDelegate(address _delegate) external {
        delegate = _delegate;
    }

    function quote(
        MessagingParams calldata,
        address
    ) external view returns (MessagingFee memory) {
        return MessagingFee({ nativeFee: mockNativeFee, lzTokenFee: 0 });
    }

    function send(
        MessagingParams calldata _params,
        address _refundAddress
    ) external payable returns (MessagingReceipt memory) {
        require(msg.value >= mockNativeFee, "MockEndpoint: insufficient fee");
        uint256 excess = msg.value - mockNativeFee;
        if (excess > 0) {
            (bool ok, ) = _refundAddress.call{value: excess}("");
            require(ok, "MockEndpoint: refund failed");
        }
        ++_nonce;
        return MessagingReceipt({
            guid: keccak256(abi.encodePacked(eid, _params.dstEid, _nonce)),
            nonce: uint64(_nonce),
            fee: MessagingFee({ nativeFee: mockNativeFee, lzTokenFee: 0 })
        });
    }
}

contract ContextEchoTarget {
    address public lastXSender;
    uint32 public lastXOrigin;
    uint256 public recordedValue;

    function executeWithContext(address _omniVm, uint256 _val) external payable {
        lastXSender = OmniVM(payable(_omniVm)).xMsgSender();
        lastXOrigin = OmniVM(payable(_omniVm)).xMsgOrigin();
        recordedValue = _val;
    }
}

contract OmniVMTest is Test {
    receive() external payable {}
    uint32 internal constant SRC_EID = 40161;
    uint32 internal constant DST_EID = 40231;

    MockEndpointV2 internal endpoint;
    OmniVM internal omniVm;
    ContextEchoTarget internal target;

    uint256 internal alicePk = 0xA11CE;
    address internal alice;

    function setUp() public {
        alice = vm.addr(alicePk);
        vm.deal(alice, 100 ether);

        endpoint = new MockEndpointV2(SRC_EID);
        omniVm = new OmniVM(address(endpoint), address(this));
        omniVm.setPeer(DST_EID, bytes32(uint256(uint160(address(omniVm)))));
        omniVm.setPeer(SRC_EID, bytes32(uint256(uint160(address(omniVm)))));

        target = new ContextEchoTarget();
    }

    function test_TransientContextMountedAndClearedOnLzReceive() public {
        OmniVM.Instruction[] memory insts = new OmniVM.Instruction[](1);
        insts[0] = OmniVM.Instruction({
            target: address(target),
            value: 0.5 ether,
            payload: abi.encodeCall(
                ContextEchoTarget.executeWithContext,
                (address(omniVm), 42)
            )
        });

        bytes memory message = abi.encode(alice, alice, insts);
        Origin memory origin = Origin({
            srcEid: SRC_EID,
            sender: bytes32(uint256(uint160(address(omniVm)))),
            nonce: 1
        });

        vm.deal(address(endpoint), 2 ether);
        vm.prank(address(endpoint));
        omniVm.lzReceive{value: 0.6 ether}(
            origin,
            keccak256("guid-1"),
            message,
            address(this),
            ""
        );

        assertEq(target.lastXSender(), alice);
        assertEq(target.lastXOrigin(), SRC_EID);
        assertEq(target.recordedValue(), 42);

        assertEq(omniVm.xMsgSender(), address(0));
        assertEq(omniVm.xMsgOrigin(), 0);
    }

    function test_RevertOnRestrictedTargetInDispatchAndQuote() public {
        OmniVM.Instruction[] memory insts = new OmniVM.Instruction[](1);
        insts[0] = OmniVM.Instruction({
            target: address(endpoint),
            value: 0,
            payload: ""
        });

        vm.expectRevert(
            abi.encodeWithSelector(OmniVM.RestrictedTarget.selector, address(endpoint))
        );
        omniVm.quoteBatch(DST_EID, alice, insts, "", false);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(OmniVM.RestrictedTarget.selector, address(endpoint))
        );
        omniVm.dispatchBatch{value: 0.01 ether}(DST_EID, alice, insts, "");
    }

    function test_DispatchBatchWithSigValidatesEIP712() public {
        OmniVM.Instruction[] memory insts = new OmniVM.Instruction[](1);
        insts[0] = OmniVM.Instruction({
            target: address(target),
            value: 0,
            payload: abi.encodeCall(
                ContextEchoTarget.executeWithContext,
                (address(omniVm), 99)
            )
        });

        bytes memory options = "";
        uint256 deadline = block.timestamp + 3600;
        uint256 nonce = omniVm.nonces(alice);

        bytes32 instHash = keccak256(
            abi.encode(
                omniVm.INSTRUCTION_TYPEHASH(),
                insts[0].target,
                insts[0].value,
                keccak256(insts[0].payload)
            )
        );
        bytes32[] memory instHashes = new bytes32[](1);
        instHashes[0] = instHash;

        bytes32 structHash = keccak256(
            abi.encode(
                omniVm.BATCH_DISPATCH_INTENT_TYPEHASH(),
                alice,
                alice,
                SRC_EID,
                DST_EID,
                keccak256(abi.encodePacked(instHashes)),
                0,
                keccak256(options),
                nonce,
                deadline
            )
        );

        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("OmniVM")),
                keccak256(bytes("1")),
                block.chainid,
                address(omniVm)
            )
        );

        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", domainSeparator, structHash)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(alicePk, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        bytes32 guid = omniVm.dispatchBatchWithSig{value: 0.005 ether}(
            alice,
            alice,
            DST_EID,
            insts,
            options,
            deadline,
            sig
        );

        assertTrue(guid != bytes32(0));
        assertEq(omniVm.nonces(alice), 1);
    }
}
-	
	
