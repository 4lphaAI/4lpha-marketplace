// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/**
 * A small balance guard around the opaque aggregator call used by the
 * tokenized-stock route.
 *
 * The router and token approval target are immutable deployment facts.  The
 * caller supplies the pair and opaque bytes, but the pair has exactly one side
 * equal to the immutable settlement token and the opaque call has one pinned
 * entry selector.  The worker binds the stock identity and the quote evidence
 * before it asks a wallet to call this contract; this contract supplies the
 * atomic balance and refund boundary.
 */
interface TradFiSwapGuardIERC20 {
    function allowance(address owner, address spender) external view returns (uint256);
}

contract TradFiSwapGuard {
    /// Binance Flash's reviewed opaque wrapper selector.  Its arguments are
    /// deliberately not decoded here; the provider ABI is not verified.
    bytes4 public constant PINNED_ROUTER_SELECTOR = 0xad43f73d;

    /// Match the proxy's local quote-validity window (R2.6). The guard never
    /// re-times opaque provider bytes or extends an embedded maker expiry.
    uint256 public constant MAX_DEADLINE_WINDOW = 15;

    address public immutable router;
    address public immutable spender;
    address public immutable canonicalUSDT;

    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _status = _NOT_ENTERED;

    struct SwapState {
        address caller;
        uint256 inputBefore;
        uint256 outputBefore;
        uint256 callerInputBefore;
        uint256 callerOutputBefore;
        uint256 inputAfterRouter;
        uint256 outputAfterRouter;
        uint256 newOutput;
        uint256 inputRefund;
    }

    error InvalidAddress();
    error InvalidPair();
    error InvalidAmount();
    error DeadlineOutOfBounds();
    error UnsupportedCall();
    error TokenCallFailed();
    error InputFundingMismatch();
    error InputBalanceChanged();
    error OutputShortfall();
    error OutputTransferMismatch();
    error ReentrantCall();
    error RouterCallFailed();

    event SwapExecuted(
        address indexed caller,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        bytes32 calldataHash
    );

    constructor(address router_, address spender_, address canonicalUSDT_) {
        if (router_ == address(0) || spender_ == address(0) || canonicalUSDT_ == address(0)) {
            revert InvalidAddress();
        }
        if (router_ == canonicalUSDT_ || spender_ == canonicalUSDT_) {
            revert InvalidAddress();
        }
        router = router_;
        spender = spender_;
        canonicalUSDT = canonicalUSDT_;
    }

    /**
     * Pull an exact settlement amount, make one opaque router call, and return
     * only balances created by this invocation to the caller.
     *
     * No native value is accepted because the entry point is nonpayable.  A
     * token's optional-return ERC-20 methods are accepted, but every relevant
     * balance and allowance is measured so a false/short/taxed transfer cannot
     * be treated as a successful fill.
     */
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        uint256 deadline,
        bytes calldata data
    ) external nonReentrant {
        if (tokenIn == address(0) || tokenOut == address(0) || tokenIn == tokenOut) {
            revert InvalidPair();
        }
        if ((tokenIn == canonicalUSDT) == (tokenOut == canonicalUSDT)) {
            revert InvalidPair();
        }
        if (amountIn == 0 || minOut == 0) revert InvalidAmount();
        if (deadline < block.timestamp || deadline > block.timestamp + MAX_DEADLINE_WINDOW) {
            revert DeadlineOutOfBounds();
        }
        if (data.length < 4 || _selector(data) != PINNED_ROUTER_SELECTOR) {
            revert UnsupportedCall();
        }

        SwapState memory state;
        state.caller = msg.sender;
        state.inputBefore = _balanceOf(tokenIn, address(this));
        state.outputBefore = _balanceOf(tokenOut, address(this));
        state.callerInputBefore = _balanceOf(tokenIn, state.caller);
        state.callerOutputBefore = _balanceOf(tokenOut, state.caller);

        _callOptionalReturn(
            tokenIn,
            abi.encodeWithSelector(
                bytes4(keccak256("transferFrom(address,address,uint256)")),
                state.caller,
                address(this),
                amountIn
            )
        );
        uint256 inputAfterPull = _balanceOf(tokenIn, address(this));
        if (inputAfterPull < state.inputBefore || inputAfterPull - state.inputBefore != amountIn) {
            revert InputFundingMismatch();
        }
        uint256 callerInputAfterPull = _balanceOf(tokenIn, state.caller);
        if (state.callerInputBefore < amountIn
            || state.callerInputBefore - callerInputAfterPull != amountIn) {
            revert InputFundingMismatch();
        }

        state.inputAfterRouter = _callRouter(tokenIn, amountIn, data);
        if (state.inputAfterRouter < state.inputBefore
            || state.inputAfterRouter - state.inputBefore > amountIn) {
            revert InputBalanceChanged();
        }
        state.outputAfterRouter = _balanceOf(tokenOut, address(this));
        if (state.outputAfterRouter < state.outputBefore) revert OutputShortfall();
        state.newOutput = state.outputAfterRouter - state.outputBefore;
        if (state.newOutput < minOut) revert OutputShortfall();

        _finalizeSwap(tokenIn, tokenOut, amountIn, minOut, data, state);
    }

    modifier nonReentrant() {
        if (_status == _ENTERED) revert ReentrantCall();
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }

    function _selector(bytes calldata data) private pure returns (bytes4 value) {
        assembly {
            value := calldataload(data.offset)
        }
    }

    function _balanceOf(address token, address account) private view returns (uint256 value) {
        (bool ok, bytes memory result) = token.staticcall(
            abi.encodeWithSelector(bytes4(keccak256("balanceOf(address)")), account)
        );
        if (!ok || result.length != 32) revert TokenCallFailed();
        value = abi.decode(result, (uint256));
    }

    function _allowance(address token) private view returns (uint256 value) {
        (bool ok, bytes memory result) = token.staticcall(
            abi.encodeWithSelector(
                TradFiSwapGuardIERC20.allowance.selector,
                address(this),
                spender
            )
        );
        if (!ok || result.length != 32) revert TokenCallFailed();
        value = abi.decode(result, (uint256));
    }

    function _approve(address token, uint256 amount) private {
        _callOptionalReturn(
            token,
            abi.encodeWithSelector(bytes4(keccak256("approve(address,uint256)")), spender, amount)
        );
    }

    function _callRouter(address tokenIn, uint256 amountIn, bytes calldata data)
        private
        returns (uint256 inputAfterRouter)
    {
        _approve(tokenIn, 0);
        _approve(tokenIn, amountIn);
        if (_allowance(tokenIn) != amountIn) revert TokenCallFailed();

        (bool ok,) = router.call(data);
        if (!ok) revert RouterCallFailed();

        // The clear is before the caller refund and remains inside the outer
        // reentrancy lock.  A failed clear reverts the whole transaction.
        _approve(tokenIn, 0);
        if (_allowance(tokenIn) != 0) revert TokenCallFailed();
        inputAfterRouter = _balanceOf(tokenIn, address(this));
    }

    function _finalizeSwap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        bytes calldata data,
        SwapState memory state
    ) private {
        state.inputRefund = state.inputAfterRouter - state.inputBefore;
        if (state.inputRefund != 0) {
            _transfer(tokenIn, state.caller, state.inputRefund);
        }
        _transfer(tokenOut, state.caller, state.newOutput);

        uint256 inputAfterRefund = _balanceOf(tokenIn, address(this));
        uint256 outputAfterRefund = _balanceOf(tokenOut, address(this));
        if (inputAfterRefund < state.inputBefore || outputAfterRefund < state.outputBefore) {
            revert InputBalanceChanged();
        }

        uint256 callerInputAfter = _balanceOf(tokenIn, state.caller);
        uint256 callerOutputAfter = _balanceOf(tokenOut, state.caller);
        if (callerInputAfter != state.callerInputBefore - amountIn + state.inputRefund) {
            revert OutputTransferMismatch();
        }
        if (callerOutputAfter < state.callerOutputBefore
            || callerOutputAfter - state.callerOutputBefore != state.newOutput
            || callerOutputAfter - state.callerOutputBefore < minOut) {
            revert OutputTransferMismatch();
        }

        emit SwapExecuted(
            state.caller,
            tokenIn,
            tokenOut,
            amountIn - state.inputRefund,
            state.newOutput,
            keccak256(data)
        );
    }

    function _transfer(address token, address to, uint256 amount) private {
        _callOptionalReturn(
            token,
            abi.encodeWithSelector(bytes4(keccak256("transfer(address,uint256)")), to, amount)
        );
    }

    function _callOptionalReturn(address token, bytes memory callData) private {
        (bool ok, bytes memory result) = token.call(callData);
        if (!ok || (result.length != 0 && (result.length != 32 || !abi.decode(result, (bool))))) {
            revert TokenCallFailed();
        }
    }
}
