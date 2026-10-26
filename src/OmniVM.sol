-	& escrow.amount > 0) {
                escrow.settled = true;
                uint256 amount = escrow.amount;
                if (escrow.token == address(0) || escrow.token == NATIVE_ETH_SENTINEL) {
                    totalEscrowedNative -= amount;
                    uint256 stipend = REFUND_GAS_STIPEND;
                    bool ok;
                    assembly {
                        ok := call(stipend, solver, amount, 0, 0, 0, 0)
                    }
                    if (!ok) {
                        claimableNative[solver] += amount;
                        totalClaimableNative += amount;
                        emit NativeClaimQueued(solver, amount);
                    }
                } else {
                    IERC20(escrow.token).safeTransfer(solver, amount);
                }
                emit IntentEscrowSettled(intentId, solver, escrow.token, amount);
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
            bool ok;
            assembly {
                ok := call(stipend, refundRecipient, remainingValue, 0, 0, 0, 0)
            }
            if (!ok) {
                claimableNative[refundRecipient] += remainingValue;
                totalClaimableNative += remainingValue;
                emit NativeClaimQueued(refundRecipient, remainingValue);
            }
        }
    }

    function claimNative() external nonReentrant {
        uint256 amount = claimableNative[msg.sender];
        if (amount == 0) revert TransferFailed();
        claimableNative[msg.sender] = 0;
        totalClaimableNative -= amount;

        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit NativeClaimed(msg.sender, amount);
    }

    function rescueStuckNative() external onlyOwner nonReentrant {
        uint256 reserved = totalEscrowedNative + totalClaimableNative;
        uint256 balance = address(this).balance;
        if (balance <= reserved) revert TransferFailed();

        uint256 rescuable = balance - reserved;
        (bool success, ) = owner().call{value: rescuable}("");
        if (!success) revert TransferFailed();
        emit StuckNativeRescued(owner(), rescuable);
    }

    receive() external payable {}
}

	
