// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { OApp, MessagingFee, Origin } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oapp/OApp.sol";
import { MessagingReceipt } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oapp/OAppSender.sol";
import { OptionsBuilder } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oapp/libs/OptionsBuilder.sol";
import { ReentrancyGuardTransient } from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { Nonces } from "@openzeppelin/contracts/utils/Nonces.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract OmniVM is OApp, ReentrancyGuardTransient, EIP712, Nonces {
    using OptionsBuilder for bytes;
    using SafeERC20 for IERC20;

    struct Instruction {
        address target;
        uint256 value;
        bytes payload;
    }

    struct OmniOutcomeIntent {
        address sender;
        address recipient;
        uint32 srcEid;
        uint32 dstEid;
        address inputToken;
        uint256 inputAmount;
        address outputToken;
        uint256 minOutputAmount;
        address postHookTarget;
        uint256 postHookValue;
        bytes postHookPayload;
        uint256 nonce;
        uint256 deadline;
    }

    struct EscrowRecord {
        address sender;
        address token;
        uint256 amount;
        uint256 deadline;
        bool settled;
    }

    uint256 public constant MAX_INSTRUCTIONS = 32;
    uint256 private constant REFUND_GAS_STIPEND = 30_000;
    address public constant NATIVE_ETH_SENTINEL = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    uint256 private constant SENDER_SLOT = 0x8b67ef996227095c7eb9fa3b25a34e5e68b44755160fb9d8e5c0958bd268f418;
    uint256 private constant ORIGIN_SLOT = 0x4a297233a6ef889778b73915a3f316d0c00e55f91009911653b82d69f756a813;

    bytes32 public constant INSTRUCTION_TYPEHASH = keccak256(
        "Instruction(address target,uint256 value,bytes payload)"
    );

    bytes32 public constant BATCH_DISPATCH_INTENT_TYPEHASH = keccak256(
        "BatchDispatchIntent(address sender,address refundRecipient,uint32 srcEid,uint32 dstEid,Instruction[] instructions,uint256 totalNativeValue,bytes options,uint256 nonce,uint256 deadline)Instruction(address target,uint256 value,bytes payload)"
    );

    mapping(bytes32 => address) public fulfilledIntents;
    mapping(bytes32 => EscrowRecord) public intentEscrows;

    event BatchDispatched(
        uint32 indexed dstEid,
        bytes32 indexed guid,
        address indexed sender,
        address refundRecipient,
        uint256 instructionCount,
        uint256 totalNativeValue
    );
    event BatchExecuted(
        uint32 indexed srcEid,
        bytes32 indexed guid,
        address indexed originalSender,
        uint256 instructionCount
    );
    event OutcomeIntentFulfilled(
        bytes32 indexed intentId,
        address indexed solver,
        address indexed recipient,
        address outputToken,
        uint256 amountDelivered,
        bytes32 settlementGuid
    );
    event IntentEscrowSettled(
        bytes32 indexed intentId,
        address indexed solver,
        address token,
        uint256 amount
    );
    event StuckNativeRescued(address indexed owner, uint256 amount);

    error RestrictedTarget(address target);
    error InsufficientPayment(uint256 required, uint256 provided);
    error InvalidBatchSize(uint256 count, uint256 max);
    error ValueExceedsUint128(uint256 value);
    error InsufficientMsgValue(uint256 required, uint256 remaining);
    error InvalidRefundRecipient();
    error SignatureExpired(uint256 deadline, uint256 currentTimestamp);
    error InvalidIntentSignature();
    error IntentAlreadyFulfilled(bytes32 intentId);
    error InsufficientSolverOutput(uint256 received, uint256 required);
    error TransferFailed();

    constructor(
        address _endpoint,
        address _owner
    ) OApp(_endpoint, _owner) Ownable(_owner) EIP712("OmniVM", "1") {}

    function xMsgSender() external view returns (address sender) {
        assembly {
            sender := tload(SENDER_SLOT)
        }
    }

    function xMsgOrigin() external view returns (uint32 originEid) {
        assembly {
            originEid := tload(ORIGIN_SLOT)
        }
    }

    function quoteBatch(
        uint32 _dstEid,
        address _refundRecipient,
        Instruction[] calldata _instructions,
        bytes calldata _options,
        bool _payInLzToken
    ) external view returns (MessagingFee memory fee) {
        uint256 len = _instructions.length;
        if (len == 0 || len > MAX_INSTRUCTIONS) {
            revert InvalidBatchSize(len, MAX_INSTRUCTIONS);
        }

        uint256 totalInstValue = 0;
        for (uint256 i = 0; i < len; ) {
            totalInstValue += _instructions[i].value;
            unchecked {
                ++i;
            }
        }

        if (totalInstValue > type(uint128).max) {
            revert ValueExceedsUint128(totalInstValue);
        }

        bytes memory message = abi.encode(msg.sender, _refundRecipient, _instructions);
        bytes memory finalOptions = _options.length == 0
            ? OptionsBuilder.newOptions().addExecutorLzReceiveOption(200_000, 0)
            : _options;
        if (totalInstValue > 0) {
            finalOptions = finalOptions.addExecutorLzReceiveOption(0, uint128(totalInstValue));
        }

        return _quote(_dstEid, message, finalOptions, _payInLzToken);
    }

    function dispatchBatch(
        uint32 _dstEid,
        address _refundRecipient,
        Instruction[] calldata _instructions,
        bytes calldata _options
    ) external payable nonReentrant returns (bytes32 guid) {
        return _validateAndDispatch(msg.sender, _refundRecipient, _dstEid, _instructions, _options);
    }

    function dispatchBatchWithSig(
        address _sender,
        address _refundRecipient,
        uint32 _dstEid,
        Instruction[] calldata _instructions,
        bytes calldata _options,
        uint256 _deadline,
        bytes calldata _signature
    ) external payable nonReentrant returns (bytes32 guid) {
        if (block.timestamp > _deadline) {
            revert SignatureExpired(_deadline, block.timestamp);
        }

        uint256 len = _instructions.length;
        if (len == 0 || len > MAX_INSTRUCTIONS) {
            revert InvalidBatchSize(len, MAX_INSTRUCTIONS);
        }

        bytes32[] memory instHashes = new bytes32[](len);
        uint256 totalInstValue = 0;

        for (uint256 i = 0; i < len; ) {
            Instruction calldata inst = _instructions[i];
            totalInstValue += inst.value;
            instHashes[i] = keccak256(
                abi.encode(
                    INSTRUCTION_TYPEHASH,
                    inst.target,
                    inst.value,
                    keccak256(inst.payload)
                )
            );
            unchecked {
                ++i;
            }
        }

        uint256 currentNonce = _useNonce(_sender);

        bytes32 structHash = keccak256(
            abi.encode(
                BATCH_DISPATCH_INTENT_TYPEHASH,
                _sender,
                _refundRecipient,
                endpoint.eid(),
                _dstEid,
                keccak256(abi.encodePacked(instHashes)),
                totalInstValue,
                keccak256(_options),
                currentNonce,
                _deadline
            )
        );

        bytes32 digest = _hashTypedDataV4(structHash);
        if (!SignatureChecker.isValidSignatureNow(_sender, digest, _signature)) {
            revert InvalidIntentSignature();
        }

        return _validateAndDispatch(_sender, _refundRecipient, _dstEid, _instructions, _options);
    }

    function _validateAndDispatch(
        address _sender,
        address _refundRecipient,
        uint32 _dstEid,
        Instruction[] calldata _instructions,
        bytes calldata _options
    ) internal returns (bytes32 guid) {
        uint256 len = _instructions.length;
        if (len == 0 || len > MAX_INSTRUCTIONS) {
            revert InvalidBatchSize(len, MAX_INSTRUCTIONS);
        }
        if (_refundRecipient == address(0)) {
            revert InvalidRefundRecipient();
        }

        uint256 totalInstValue = 0;
        address lzEndpoint = address(endpoint);

        for (uint256 i = 0; i < len; ) {
            address target = _instructions[i].target;
            if (target == address(this) || target == lzEndpoint || target == address(0)) {
                revert RestrictedTarget(target);
            }
            totalInstValue += _instructions[i].value;
            unchecked {
                ++i;
            }
        }

        if (totalInstValue > type(uint128).max) {
            revert ValueExceedsUint128(totalInstValue);
        }

        bytes memory message = abi.encode(_sender, _refundRecipient, _instructions);

        bytes memory finalOptions = _options.length == 0
            ? OptionsBuilder.newOptions().addExecutorLzReceiveOption(200_000, 0)
            : _options;
        if (totalInstValue > 0) {
            finalOptions = finalOptions.addExecutorLzReceiveOption(0, uint128(totalInstValue));
        }

        MessagingFee memory fee = _quote(_dstEid, message, finalOptions, false);
        if (msg.value < fee.nativeFee) {
            revert InsufficientPayment(fee.nativeFee, msg.value);
        }

        MessagingReceipt memory receipt = _lzSend(
            _dstEid,
            message,
            finalOptions,
            MessagingFee(msg.value, 0),
            payable(msg.sender)
        );

        emit BatchDispatched(_dstEid, receipt.guid, _sender, _refundRecipient, len, totalInstValue);
        return receipt.guid;
    }

    function fulfillOutcomeIntent(
        OmniOutcomeIntent calldata _intent,
        Instruction[] calldata _solverRouteInstructions,
        bytes calldata _settlementOptions
    ) external payable nonReentrant returns (bytes32 settlementGuid) {
        if (block.timestamp > _intent.deadline) {
            revert SignatureExpired(_intent.deadline, block.timestamp);
        }

        uint256 len = _solverRouteInstructions.length;
        if (len == 0 || len > MAX_INSTRUCTIONS) {
            revert InvalidBatchSize(len, MAX_INSTRUCTIONS);
        }

        bytes32 intentId = keccak256(
            abi.encode(
                _intent.sender,
                _intent.recipient,
                _intent.srcEid,
                _intent.dstEid,
                _intent.inputToken,
                _intent.inputAmount,
                _intent.outputToken,
                _intent.minOutputAmount,
                _intent.postHookTarget,
                _intent.postHookValue,
                keccak256(_intent.postHookPayload),
                _intent.nonce,
                _intent.deadline
            )
        );

        if (fulfilledIntents[intentId] != address(0)) {
            revert IntentAlreadyFulfilled(intentId);
        }
        fulfilledIntents[intentId] = msg.sender;

        bool isNativeOutput = (
            _intent.outputToken == address(0) ||
            _intent.outputToken == NATIVE_ETH_SENTINEL
        );

        uint256 balanceBefore = isNativeOutput
            ? _intent.recipient.balance
            : IERC20(_intent.outputToken).balanceOf(_intent.recipient);

        address intentSender = _intent.sender;
        uint32 intentSrcEid = _intent.srcEid;

        assembly {
            tstore(SENDER_SLOT, intentSender)
            tstore(ORIGIN_SLOT, intentSrcEid)
        }

        address lzEndpoint = address(endpoint);
        for (uint256 i = 0; i < len; ) {
            Instruction calldata inst = _solverRouteInstructions[i];
            if (inst.target == address(this) || inst.target == lzEndpoint || inst.target == address(0)) {
                revert RestrictedTarget(inst.target);
            }
            (bool success, bytes memory returnData) = inst.target.call{value: inst.value}(inst.payload);
            if (!success) {
                assembly {
                    revert(add(returnData, 32), mload(returnData))
                }
            }
            unchecked {
                ++i;
            }
        }

        assembly {
            tstore(SENDER_SLOT, 0)
            tstore(ORIGIN_SLOT, 0)
        }

        uint256 balanceAfter = isNativeOutput
            ? _intent.recipient.balance
            : IERC20(_intent.outputToken).balanceOf(_intent.recipient);

        uint256 received = balanceAfter > balanceBefore ? (balanceAfter - balanceBefore) : 0;
        if (received < _intent.minOutputAmount) {
            revert InsufficientSolverOutput(received, _intent.minOutputAmount);
        }

        bytes memory settlementPayload = abi.encode(intentId, msg.sender);
        bytes memory finalOptions = _settlementOptions.length == 0
            ? OptionsBuilder.newOptions().addExecutorLzReceiveOption(120_000, 0)
            : _settlementOptions;

        MessagingFee memory fee = _quote(_intent.srcEid, settlementPayload, finalOptions, false);
        if (msg.value < _intent.postHookValue) {
            revert InsufficientPayment(_intent.postHookValue, msg.value);
        }
        uint256 remainingMsgValue = msg.value - _intent.postHookValue;
        if (remainingMsgValue < fee.nativeFee) {
            revert InsufficientPayment(fee.nativeFee, remainingMsgValue);
        }

        MessagingReceipt memory receipt = _lzSend(
            _intent.srcEid,
            settlementPayload,
            finalOptions,
            MessagingFee(remainingMsgValue, 0),
            payable(msg.sender)
        );

        emit OutcomeIntentFulfilled(
            intentId,
            msg.sender,
            _intent.recipient,
            _intent.outputToken,
            received,
            receipt.guid
        );

        return receipt.guid;
    }

    function _lzReceive(
        Origin calldata _origin,
        bytes32 _guid,
        bytes calldata _message,
        address /*_executor*/,
        bytes calldata /*_extraData*/
    ) internal override nonReentrant {
        if (_message.length == 64) {
            (bytes32 intentId, address solver) = abi.decode(_message, (bytes32, address));
            EscrowRecord storage escrow = intentEscrows[intentId];
            if (!escrow.settled && escrow.amount > 0) {
                escrow.settled = true;
                if (escrow.token == address(0) || escrow.token == NATIVE_ETH_SENTINEL) {
                    (bool ok, ) = solver.call{value: escrow.amount}("");
                    if (!ok) revert TransferFailed();
                } else {
                    IERC20(escrow.token).safeTransfer(solver, escrow.amount);
                }
                emit IntentEscrowSettled(intentId, solver, escrow.token, escrow.amount);
            }
            return;
        }

        (
            address originalSender,
            address refundRecipient,
            Instruction[] memory instructions
        ) = abi.decode(_message, (address, address, Instruction[]));

        uint32 srcEid = _origin.srcEid;

        assembly {
            tstore(SENDER_SLOT, originalSender)
            tstore(ORIGIN_SLOT, srcEid)
        }

        uint256 remainingValue = msg.value;
        uint256 len = instructions.length;
        address lzEndpoint = address(endpoint);

        for (uint256 i = 0; i < len; ) {
            Instruction memory inst = instructions[i];

            if (inst.target == address(this) || inst.target == lzEndpoint || inst.target == address(0)) {
                revert RestrictedTarget(inst.target);
            }

            if (inst.value > 0) {
                if (remainingValue < inst.value) {
                    revert InsufficientMsgValue(inst.value, remainingValue);
                }
                unchecked {
                    remainingValue -= inst.value;
                }
            }

            (bool success, bytes memory returnData) = inst.target.call{value: inst.value}(inst.payload);

            if (!success) {
                assembly {
                    revert(add(returnData, 32), mload(returnData))
                }
            }
            unchecked {
                ++i;
            }
        }

        assembly {
            tstore(SENDER_SLOT, 0)
            tstore(ORIGIN_SLOT, 0)
        }

        emit BatchExecuted(srcEid, _guid, originalSender, len);

        if (remainingValue > 0 && refundRecipient != address(0)) {
            uint256 stipend = REFUND_GAS_STIPEND;
            assembly {
                pop(call(stipend, refundRecipient, remainingValue, 0, 0, 0, 0))
            }
        }
    }

    function rescueStuckNative() external onlyOwner {
        uint256 balance = address(this).balance;
        if (balance == 0) revert TransferFailed();
        (bool success, ) = owner().call{value: balance}("");
        if (!success) revert TransferFailed();
        emit StuckNativeRescued(owner(), balance);
    }

    receive() external payable {}
}
