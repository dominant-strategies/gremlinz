// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title RevenueSplitter
 * @notice One per gremlin, deployed by the gremlin. Splits revenue between the gremlin and a fixed recipient
 * (typically the maker): `bps`/10000 to the recipient, the rest to the gremlin. Rounding always favours the
 * gremlin (the recipient's share is rounded down).
 *
 * Native QUAI is split into accrued balances (pull payments). Any balance that arrives without running
 * receive() (e.g. forced sends or a credit that does not execute code) is picked up by `sync()`, which every
 * state-changing function calls first. `release()` pushes both accrued balances; a payee that reverts only
 * keeps its own balance accrued and never blocks the other payee.
 *
 * ERC20: `distribute(token)` splits the contract's unaccounted token balance by the current bps and tries to
 * transfer each share; a failed transfer is accrued for that payee and can be retried with
 * `withdrawToken(token, payee)`.
 *
 * `gremlin` and `recipient` are immutable. `bps` can only be lowered, and only by the recipient. No admin.
 */
contract RevenueSplitter is ReentrancyGuard {
    uint16 public constant MAX_BPS = 10_000;

    address public immutable gremlin;
    address public immutable recipient;
    uint16 public bps;

    /// Accrued, unpaid native balances.
    uint256 public owedGremlin;
    uint256 public owedRecipient;

    /// Accrued, unpaid token balances: token => payee => amount; and the per-token total.
    mapping(address => mapping(address => uint256)) public owedToken;
    mapping(address => uint256) public accountedToken;

    event Received(address indexed from, uint256 amount);
    event Split(uint256 amount, uint256 toRecipient, uint256 toGremlin, uint16 bps);
    event Paid(address indexed payee, uint256 amount);
    event PaymentFailed(address indexed payee, uint256 amount);
    event BpsLowered(uint16 oldBps, uint16 newBps);
    event TokenSplit(address indexed token, uint256 amount, uint256 toRecipient, uint256 toGremlin, uint16 bps);
    event TokenPaid(address indexed token, address indexed payee, uint256 amount);
    event TokenPaymentFailed(address indexed token, address indexed payee, uint256 amount);

    error InvalidBps();
    error ZeroAddress();
    error SameAddress();
    error NotRecipient();
    error NotPayee();
    error NothingOwed();
    error TransferFailed();

    constructor(address gremlin_, address recipient_, uint16 bps_) {
        if (gremlin_ == address(0) || recipient_ == address(0)) revert ZeroAddress();
        if (gremlin_ == recipient_) revert SameAddress();
        if (bps_ == 0 || bps_ > MAX_BPS) revert InvalidBps();
        gremlin = gremlin_;
        recipient = recipient_;
        bps = bps_;
    }

    // ------------------------------------------------------------------------------------------------------
    // Native QUAI
    // ------------------------------------------------------------------------------------------------------

    /// @notice Accepts QUAI and splits it into the accrued balances. No external calls.
    receive() external payable {
        emit Received(msg.sender, msg.value);
        _sync();
    }

    /// @notice Splits any native balance not yet accounted for (e.g. forced sends) at the current bps.
    function sync() external {
        _sync();
    }

    /// @notice Pays out both accrued native balances. Callable by anyone. A reverting payee keeps its balance
    /// accrued (PaymentFailed) and does not affect the other payee.
    function release() external nonReentrant {
        _sync();
        _tryPay(gremlin, true);
        _tryPay(recipient, false);
    }

    /// @notice Pays one payee's accrued native balance; reverts if that transfer fails.
    function withdraw(address payee) external nonReentrant {
        _sync();
        bool isGremlin = payee == gremlin;
        if (!isGremlin && payee != recipient) revert NotPayee();
        if ((isGremlin ? owedGremlin : owedRecipient) == 0) revert NothingOwed();
        if (!_tryPay(payee, isGremlin)) revert TransferFailed();
    }

    /// @notice Native balance that has arrived but has not been split yet.
    function unaccounted() public view returns (uint256) {
        return address(this).balance - owedGremlin - owedRecipient;
    }

    // ------------------------------------------------------------------------------------------------------
    // bps
    // ------------------------------------------------------------------------------------------------------

    /// @notice The recipient may lower (never raise) its share. 0 waives it entirely. Native funds received
    /// before the change are split at the old rate first. Undistributed token balances are split at the rate in
    /// force when `distribute` is called, so the recipient should distribute tokens first if it cares.
    function lowerBps(uint16 newBps) external {
        if (msg.sender != recipient) revert NotRecipient();
        uint16 old = bps;
        if (newBps >= old) revert InvalidBps();
        _sync();
        bps = newBps;
        emit BpsLowered(old, newBps);
    }

    // ------------------------------------------------------------------------------------------------------
    // ERC20
    // ------------------------------------------------------------------------------------------------------

    /// @notice Splits `token`'s unaccounted balance by the current bps and pays both shares. A failed
    /// transfer is accrued for that payee instead of reverting.
    function distribute(IERC20 token) external nonReentrant {
        address t = address(token);
        uint256 amount = token.balanceOf(address(this)) - accountedToken[t];
        if (amount == 0) return;
        uint16 b = bps;
        uint256 toRecipient = (amount * b) / MAX_BPS;
        uint256 toGremlin = amount - toRecipient;
        emit TokenSplit(t, amount, toRecipient, toGremlin, b);
        _payToken(token, gremlin, toGremlin);
        _payToken(token, recipient, toRecipient);
    }

    /// @notice Retry an accrued token payment for `payee`. Reverts if it fails again.
    function withdrawToken(IERC20 token, address payee) external nonReentrant {
        if (payee != gremlin && payee != recipient) revert NotPayee();
        address t = address(token);
        uint256 amount = owedToken[t][payee];
        if (amount == 0) revert NothingOwed();
        owedToken[t][payee] = 0;
        accountedToken[t] -= amount;
        if (!_trySendToken(token, payee, amount)) revert TransferFailed();
        emit TokenPaid(t, payee, amount);
    }

    // ------------------------------------------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------------------------------------------

    function _sync() private {
        uint256 amount = unaccounted();
        if (amount == 0) return;
        uint16 b = bps;
        uint256 toRecipient = (amount * b) / MAX_BPS;
        uint256 toGremlin = amount - toRecipient;
        owedRecipient += toRecipient;
        owedGremlin += toGremlin;
        emit Split(amount, toRecipient, toGremlin, b);
    }

    /// Checks-effects-interactions: zero the balance, call, restore on failure.
    function _tryPay(address payee, bool isGremlin) private returns (bool ok) {
        uint256 amount = isGremlin ? owedGremlin : owedRecipient;
        if (amount == 0) return true;
        if (isGremlin) owedGremlin = 0;
        else owedRecipient = 0;
        // Assembly call: no returndata copy, so a "return bomb" cannot make the caller run out of gas.
        assembly {
            ok := call(gas(), payee, amount, 0, 0, 0, 0)
        }
        if (ok) {
            emit Paid(payee, amount);
        } else {
            if (isGremlin) owedGremlin += amount;
            else owedRecipient += amount;
            emit PaymentFailed(payee, amount);
        }
    }

    function _payToken(IERC20 token, address payee, uint256 amount) private {
        if (amount == 0) return;
        if (_trySendToken(token, payee, amount)) {
            emit TokenPaid(address(token), payee, amount);
        } else {
            owedToken[address(token)][payee] += amount;
            accountedToken[address(token)] += amount;
            emit TokenPaymentFailed(address(token), payee, amount);
        }
    }

    /// SafeERC20-style transfer that reports failure instead of reverting (handles tokens that return nothing).
    function _trySendToken(IERC20 token, address to, uint256 amount) private returns (bool) {
        (bool ok, bytes memory ret) = address(token).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok) return false;
        if (ret.length == 0) return address(token).code.length > 0;
        return ret.length >= 32 && uint256(bytes32(ret)) == 1;
    }
}
